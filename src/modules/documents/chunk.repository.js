import { Chunk } from './chunk.model.js';
import { serializeMany, toObjectId } from '../../infra/mongo/schema-helpers.js';

// A 768-double vector is ~6KB, so reads exclude it unless the caller needs it.
const TEXT_PROJECTION = { embedding: 0 };

/**
 * Batched because a single insert of thousands of vectors exceeds the 16MB
 * command limit. `ordered: false` alone would make Mongoose silently *skip*
 * invalid rows, so throwOnValidationError and the count check are load-bearing.
 */
export async function insertChunks(chunks, { batchSize = 200 } = {}) {
  if (chunks.length === 0) {
    return 0;
  }

  const documents = chunks.map((chunk) => ({
    ...chunk,
    documentId: toObjectId(chunk.documentId),
    ownerId: toObjectId(chunk.ownerId),
  }));

  let inserted = 0;

  for (let start = 0; start < documents.length; start += batchSize) {
    const batch = documents.slice(start, start + batchSize);

    const result = await Chunk.insertMany(batch, {
      ordered: false,
      throwOnValidationError: true,
    });

    if (result.length !== batch.length) {
      throw new Error(
        `Chunk insert wrote ${String(result.length)} of ${String(batch.length)} rows`,
      );
    }

    inserted += result.length;
  }

  return inserted;
}

/** Compensating action on failure, and the first step of a re-index. */
export async function deleteChunksForDocument(documentId) {
  const id = toObjectId(documentId);
  if (!id) {
    return 0;
  }

  const result = await Chunk.deleteMany({ documentId: id }).exec();
  return result.deletedCount;
}

export async function findChunksForDocument(documentId, { limit = 100, skip = 0 } = {}) {
  const id = toObjectId(documentId);
  if (!id) {
    return [];
  }

  const chunks = await Chunk.find({ documentId: id }, TEXT_PROJECTION)
    .sort({ index: 1 })
    .skip(skip)
    .limit(limit)
    .lean()
    .exec();

  return serializeMany(chunks);
}

/** Expands a retrieval hit into surrounding context. */
export async function findChunksByIndex(documentId, indexes) {
  const id = toObjectId(documentId);
  if (!id || indexes.length === 0) {
    return [];
  }

  const chunks = await Chunk.find({ documentId: id, index: { $in: indexes } }, TEXT_PROJECTION)
    .sort({ index: 1 })
    .lean()
    .exec();

  return serializeMany(chunks);
}

/** Fallback path when Atlas Vector Search isn't available. Bounded on purpose. */
export async function findChunksWithEmbeddings({ documentId, ownerId, limit = 5_000 }) {
  const [docId, owner] = [toObjectId(documentId), toObjectId(ownerId)];
  if (!docId || !owner) {
    return [];
  }

  return Chunk.find(
    { documentId: docId, ownerId: owner },
    { text: 1, index: 1, pageStart: 1, pageEnd: 1, embedding: 1 },
  )
    .limit(limit)
    .lean()
    .exec();
}

export async function countChunksForDocument(documentId) {
  const id = toObjectId(documentId);
  if (!id) {
    return 0;
  }

  return Chunk.countDocuments({ documentId: id }).exec();
}

export async function deleteChunksForDocuments(documentIds) {
  const ids = documentIds.map((id) => toObjectId(id)).filter(Boolean);
  if (ids.length === 0) {
    return 0;
  }

  const result = await Chunk.deleteMany({ documentId: { $in: ids } }).exec();
  return result.deletedCount;
}
