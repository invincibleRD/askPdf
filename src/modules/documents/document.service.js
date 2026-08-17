import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';
import { DocumentStatus } from '../../config/constants.js';
import { NotFoundError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { getRequestId } from '../../core/request-context.js';
import { getStorage } from '../../infra/storage/index.js';
import { buildObjectKey } from '../../infra/storage/object-key.js';
import { createJob, findLiveJobForDocument } from '../jobs/job.repository.js';
import { enqueue } from '../../queue/queue.js';
import { documentsUploaded } from '../../infra/metrics/registry.js';
import { deleteChunksForDocument } from './chunk.repository.js';
import {
  createDocument,
  findDocumentByContentHash,
  findDocumentForOwner,
  listDocumentsForOwner,
  softDeleteDocument,
} from './document.repository.js';

const log = createLogger('documents');

/**
 * Accepts an upload and queues it for processing.
 *
 * Storage is written before the database row, so a crash between the two
 * leaves an orphaned object rather than a document pointing at nothing. The
 * former is reclaimable by a lifecycle rule; the latter is a broken record a
 * user can see.
 */
export async function ingestUpload({ ownerId, file }) {
  const contentHash = sha256(file.buffer);

  // Same bytes, same user: hand back the original rather than paying to embed
  // it twice.
  const existing = await findDocumentByContentHash(ownerId, contentHash);
  if (existing) {
    documentsUploaded.inc({ outcome: 'duplicate' });
    log.info({ documentId: existing.id, ownerId }, 'duplicate upload, reusing document');

    const job = await findLiveJobForDocument(existing.id);
    return { document: existing, job, duplicate: true };
  }

  const storage = getStorage();
  const storageKey = buildObjectKey(file.originalName, { prefix: env.GCS_PREFIX });

  await storage.put(storageKey, file.buffer, {
    contentType: file.mimeType,
    metadata: { ownerId, originalName: file.originalName, contentHash },
  });

  let document;
  try {
    document = await createDocument({
      ownerId,
      filename: file.originalName,
      storageKey,
      contentHash,
      byteSize: file.size,
    });
  } catch (error) {
    // Nothing references the object yet, so remove it rather than leaving a
    // paid-for orphan behind.
    await storage.delete(storageKey).catch((cleanupError) => {
      log.error({ err: cleanupError, storageKey }, 'failed to clean up orphaned object');
    });
    throw error;
  }

  const requestId = getRequestId();
  const { job, created } = await createJob({
    documentId: document.id,
    ownerId,
    maxAttempts: env.QUEUE_MAX_ATTEMPTS,
    requestId,
  });

  // Only publish for a job we actually created — enqueueing an existing one
  // would hand the same document to a second worker.
  if (created) {
    await enqueue({ jobId: job.id, documentId: document.id, ownerId, requestId });
  }

  documentsUploaded.inc({ outcome: 'accepted' });
  log.info(
    { documentId: document.id, jobId: job.id, bytes: file.size, storageKey },
    'document accepted for processing',
  );

  return { document, job, duplicate: false };
}

export async function getDocument(id, ownerId) {
  const document = await findDocumentForOwner(id, ownerId);

  if (!document) {
    throw new NotFoundError('Document');
  }

  return document;
}

export function listDocuments(ownerId, options) {
  return listDocumentsForOwner(ownerId, options);
}

/**
 * Deletes a document and everything derived from it.
 *
 * The row is soft-deleted first: it is the record the user can see, so it
 * disappears immediately. Chunks and the stored object follow, and a failure
 * on either is logged rather than surfaced — the delete has already
 * succeeded from the caller's point of view.
 */
export async function deleteDocument(id, ownerId) {
  const document = await findDocumentForOwner(id, ownerId);

  if (!document) {
    throw new NotFoundError('Document');
  }

  await softDeleteDocument(id, ownerId);

  const removedChunks = await deleteChunksForDocument(id).catch((error) => {
    log.error({ err: error, documentId: id }, 'failed to delete chunks');
    return 0;
  });

  await getStorage()
    .delete(document.storageKey)
    .catch((error) => {
      log.error({ err: error, storageKey: document.storageKey }, 'failed to delete object');
    });

  log.info({ documentId: id, ownerId, removedChunks }, 'document deleted');

  return { id, removedChunks };
}

/** Time-limited link to the original PDF. */
export async function getDownloadUrl(id, ownerId) {
  const document = await getDocument(id, ownerId);

  if (document.status === DocumentStatus.DELETED) {
    throw new NotFoundError('Document');
  }

  return getStorage().signedUrl(document.storageKey);
}

function sha256(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}
