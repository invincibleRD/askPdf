import { Document } from './document.model.js';
import { DocumentStatus } from '../../config/constants.js';
import {
  rethrowDuplicateKey,
  serializeMany,
  serialize,
  toObjectId,
} from '../../infra/mongo/schema-helpers.js';

// Every user-reachable read takes ownerId and applies it as a query filter,
// rather than checking ownership after the fact.

export async function createDocument(input) {
  try {
    const document = await Document.create({
      ...input,
      ownerId: toObjectId(input.ownerId),
      status: DocumentStatus.PENDING,
    });
    return document.toJSON();
  } catch (error) {
    rethrowDuplicateKey(error, 'This document has already been uploaded');
  }
}

/** Null for both "missing" and "not yours", so probing ids reveals nothing. */
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
 * Keyset pagination: skip degrades with offset and drops or repeats rows when
 * a document is created mid-scroll. ObjectIds are monotonic, so ordering by
 * _id matches ordering by createdAt.
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
    filter._id = { $lt: cursorId };
  }

  // One extra row tells us whether another page exists without a count query.
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

/** Conditional on current status, so two workers can't both claim it. */
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

export async function updateDocumentStage(id, stage) {
  const documentId = toObjectId(id);
  if (!documentId) {
    return;
  }

  await Document.updateOne({ _id: documentId }, { $set: { stage } }).exec();
}

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
 * Soft delete: the row stays so storage and chunks can be cleaned up async,
 * and the unique content hash is freed immediately for a re-upload.
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

/** Left behind by a worker that died mid-pipeline. */
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

export async function countDocumentsForOwner(ownerId) {
  const owner = toObjectId(ownerId);
  if (!owner) {
    return 0;
  }

  return Document.countDocuments({ ownerId: owner, deletedAt: null }).exec();
}
