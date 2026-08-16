import { Document } from './document.model.js';
import { DocumentStatus } from '../../config/constants.js';
import {
  rethrowDuplicateKey,
  serialize,
  serializeMany,
  toObjectId,
} from '../../infra/mongo/schema-helpers.js';

/**
 * Document persistence.
 *
 * Every read that a user could reach takes an `ownerId` and applies it as a
 * query filter rather than checking ownership after the fact. A missing
 * filter would be an access-control bug; making it a required parameter means
 * it cannot be forgotten silently.
 */

/**
 * @param {{ ownerId: string, filename: string, storageKey: string, contentHash: string,
 *   byteSize: number, title?: string }} input
 */
export async function createDocument(input) {
  try {
    const document = await Document.create({
      ...input,
      ownerId: toObjectId(input.ownerId),
      status: DocumentStatus.PENDING,
    });
    return serialize(document.toObject());
  } catch (error) {
    rethrowDuplicateKey(error, 'This document has already been uploaded');
  }
}

/**
 * Fetches a document a user is allowed to see.
 *
 * Returns null both when the id does not exist and when it belongs to someone
 * else — the caller turns that into a 404, so probing for other people's ids
 * reveals nothing.
 *
 * @param {string} id
 * @param {string} ownerId
 */
export async function findDocumentForOwner(id, ownerId) {
  const [documentId, owner] = [toObjectId(id), toObjectId(ownerId)];
  if (!documentId || !owner) {
    return null;
  }

  const document = await Document.findOne({
    _id: documentId,
    ownerId: owner,
    deletedAt: null,
  })
    .lean()
    .exec();

  return serialize(document);
}

/**
 * Finds an existing upload of the same bytes by the same user.
 *
 * Backs deduplication: re-uploading a PDF returns the original document
 * instead of paying to embed it a second time.
 *
 * @param {string} ownerId
 * @param {string} contentHash
 */
export async function findDocumentByContentHash(ownerId, contentHash) {
  const owner = toObjectId(ownerId);
  if (!owner) {
    return null;
  }

  const document = await Document.findOne({ ownerId: owner, contentHash, deletedAt: null })
    .lean()
    .exec();

  return serialize(document);
}

/**
 * Lists a user's documents, newest first.
 *
 * Keyset pagination rather than skip/limit: `skip` degrades linearly as the
 * offset grows, and it drops or repeats rows when a document is created
 * mid-scroll. The cursor is the last id seen, which the compound index on
 * `{ownerId, createdAt}` resolves directly.
 *
 * @param {string} ownerId
 * @param {{ limit?: number, cursor?: string, status?: string }} [options]
 */
export async function listDocumentsForOwner(ownerId, { limit = 20, cursor, status } = {}) {
  const owner = toObjectId(ownerId);
  if (!owner) {
    return { items: [], nextCursor: null };
  }

  const filter = { ownerId: owner, deletedAt: null };
  if (status) {
    filter.status = status;
  }

  const cursorId = cursor ? toObjectId(cursor) : null;
  if (cursorId) {
    // ObjectIds are monotonic by creation time, so ordering by _id matches
    // ordering by createdAt without needing a compound cursor.
    filter._id = { $lt: cursorId };
  }

  // Fetch one extra row to learn whether another page exists without a second
  // count query.
  const documents = await Document.find(filter)
    .sort({ _id: -1 })
    .limit(limit + 1)
    .lean()
    .exec();

  const hasMore = documents.length > limit;
  const page = hasMore ? documents.slice(0, limit) : documents;

  return {
    items: serializeMany(page),
    nextCursor: hasMore && page.length > 0 ? String(page[page.length - 1]._id) : null,
  };
}

/**
 * Moves a document into the processing state.
 *
 * Conditional on its current status so two workers racing on the same
 * document cannot both start; the loser gets null and drops its claim.
 *
 * @param {string} id
 */
export async function markDocumentProcessing(id) {
  const documentId = toObjectId(id);
  if (!documentId) {
    return null;
  }

  const document = await Document.findOneAndUpdate(
    { _id: documentId, status: { $in: [DocumentStatus.PENDING, DocumentStatus.FAILED] } },
    {
      $set: {
        status: DocumentStatus.PROCESSING,
        processingStartedAt: new Date(),
        stage: null,
        failure: null,
      },
    },
    { new: true },
  )
    .lean()
    .exec();

  return serialize(document);
}

/**
 * Records progress through the pipeline so a polling client sees movement.
 *
 * @param {string} id
 * @param {string} stage
 */
export async function updateDocumentStage(id, stage) {
  const documentId = toObjectId(id);
  if (!documentId) {
    return;
  }

  await Document.updateOne({ _id: documentId }, { $set: { stage } }).exec();
}

/**
 * @param {string} id
 * @param {{ pageCount: number, chunkCount: number, title?: string }} result
 */
export async function markDocumentReady(id, { pageCount, chunkCount, title }) {
  const documentId = toObjectId(id);
  if (!documentId) {
    return null;
  }

  const document = await Document.findOneAndUpdate(
    { _id: documentId },
    {
      $set: {
        status: DocumentStatus.READY,
        stage: null,
        failure: null,
        pageCount,
        chunkCount,
        processedAt: new Date(),
        ...(title ? { title } : {}),
      },
    },
    { new: true },
  )
    .lean()
    .exec();

  return serialize(document);
}

/**
 * @param {string} id
 * @param {{ stage?: string, message: string, attempts?: number }} failure
 */
export async function markDocumentFailed(id, { stage, message, attempts = 0 }) {
  const documentId = toObjectId(id);
  if (!documentId) {
    return null;
  }

  const document = await Document.findOneAndUpdate(
    { _id: documentId },
    {
      $set: {
        status: DocumentStatus.FAILED,
        stage: null,
        failure: { stage, message: message.slice(0, 2_000), at: new Date(), attempts },
      },
    },
    { new: true },
  )
    .lean()
    .exec();

  return serialize(document);
}

/**
 * Soft-deletes a document.
 *
 * The row stays so that the storage object and chunks can be cleaned up
 * asynchronously, and so the unique content hash is released immediately for
 * a fresh upload.
 *
 * @param {string} id
 * @param {string} ownerId
 * @returns {Promise<boolean>} Whether anything was deleted.
 */
export async function softDeleteDocument(id, ownerId) {
  const [documentId, owner] = [toObjectId(id), toObjectId(ownerId)];
  if (!documentId || !owner) {
    return false;
  }

  const result = await Document.updateOne(
    { _id: documentId, ownerId: owner, deletedAt: null },
    { $set: { deletedAt: new Date(), status: DocumentStatus.DELETED } },
  ).exec();

  return result.modifiedCount > 0;
}

/**
 * Documents stuck in `processing` past a deadline.
 *
 * A worker killed mid-pipeline leaves one behind; the reaper uses this to
 * fail or requeue them rather than letting a client poll forever.
 *
 * @param {number} olderThanMs
 * @param {number} [limit]
 */
export async function findStalledDocuments(olderThanMs, limit = 50) {
  const cutoff = new Date(Date.now() - olderThanMs);

  const documents = await Document.find({
    status: DocumentStatus.PROCESSING,
    processingStartedAt: { $lt: cutoff },
  })
    .limit(limit)
    .lean()
    .exec();

  return serializeMany(documents);
}

/**
 * @param {string} ownerId
 */
export async function countDocumentsForOwner(ownerId) {
  const owner = toObjectId(ownerId);
  if (!owner) {
    return 0;
  }

  return Document.countDocuments({ ownerId: owner, deletedAt: null }).exec();
}
