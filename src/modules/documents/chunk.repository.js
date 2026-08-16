import { Chunk } from './chunk.model.js';
import { serializeMany, toObjectId } from '../../infra/mongo/schema-helpers.js';

/**
 * Chunk persistence.
 *
 * The largest collection in the service, and the one on the read path of
 * every question. Reads here avoid loading embeddings unless the caller
 * actually needs them — a 768-double vector is roughly 6 KB, so pulling a
 * thousand of them to render a citation list would move 6 MB for nothing.
 */

/** Fields needed to build an answer; deliberately excludes the vector. */
const TEXT_PROJECTION = {
  embedding: 0,
};

/**
 * Writes a document's chunks.
 *
 * Split into batches because a single insert of thousands of vectors can
 * exceed the 16 MB command limit.
 *
 * `ordered: false` keeps one rejected row from abandoning the rest of the
 * batch, but on its own it also makes Mongoose *skip* invalid documents and
 * resolve normally — a document would be marked ready with chunks silently
 * missing. `throwOnValidationError` restores the loud failure, and the count
 * check catches a short write for any other reason.
 *
 * @param {Array<object>} chunks
 * @param {{ batchSize?: number }} [options]
 * @returns {Promise<number>} Number inserted.
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

/**
 * Removes every chunk belonging to a document.
 *
 * The compensating action when ingestion fails part-way, and the first step
 * of a re-index. Without it a retry would collide with the unique
 * `{documentId, index}` index.
 *
 * @param {string} documentId
 * @returns {Promise<number>} Number removed.
 */
export async function deleteChunksForDocument(documentId) {
  const id = toObjectId(documentId);
  if (!id) {
    return 0;
  }

  const result = await Chunk.deleteMany({ documentId: id }).exec();
  return result.deletedCount;
}

/**
 * Chunks in document order, without their vectors.
 *
 * @param {string} documentId
 * @param {{ limit?: number, skip?: number }} [options]
 */
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

/**
 * Specific chunks by position, used to expand a retrieval hit into context.
 *
 * @param {string} documentId
 * @param {number[]} indexes
 */
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

/**
 * Loads chunks *with* their embeddings for in-process similarity scoring.
 *
 * This is the fallback path when Atlas Vector Search is unavailable. It is
 * bounded by `limit` on purpose: scoring in the application is fine for a
 * single document, and would be the wrong tool for a corpus-wide search.
 *
 * @param {{ documentId: string, ownerId: string, limit?: number }} filter
 */
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

/**
 * @param {string} documentId
 */
export async function countChunksForDocument(documentId) {
  const id = toObjectId(documentId);
  if (!id) {
    return 0;
  }

  return Chunk.countDocuments({ documentId: id }).exec();
}

/**
 * Removes chunks for documents that no longer exist.
 *
 * A safety net for the case where a delete succeeded on the document but its
 * cascade did not — cheaper than a foreign key the database does not have.
 *
 * @param {string[]} documentIds
 */
export async function deleteChunksForDocuments(documentIds) {
  const ids = documentIds.map((id) => toObjectId(id)).filter(Boolean);
  if (ids.length === 0) {
    return 0;
  }

  const result = await Chunk.deleteMany({ documentId: { $in: ids } }).exec();
  return result.deletedCount;
}
