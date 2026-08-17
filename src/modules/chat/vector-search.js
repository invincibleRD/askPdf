import { env } from '../../config/env.js';
import { createLogger } from '../../core/logger.js';
import { Chunk } from '../documents/chunk.model.js';
import { findChunksWithEmbeddings } from '../documents/chunk.repository.js';
import { toObjectId } from '../../infra/mongo/schema-helpers.js';

const log = createLogger('search');

/**
 * Cosine similarity.
 *
 * Both providers normalise their vectors, so this reduces to a dot product —
 * but the magnitudes are divided out anyway, because a silently un-normalised
 * vector would otherwise produce scores above 1 and quietly break the
 * threshold.
 */
export function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let magA = 0;
  let magB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }

  const denominator = Math.sqrt(magA) * Math.sqrt(magB);
  return denominator === 0 ? 0 : dot / denominator;
}

/**
 * Scores every chunk of one document in the application process.
 *
 * Fine for a single document — a few thousand vectors is milliseconds — and it
 * means the service runs against a plain mongod with no Atlas dependency. It
 * would be the wrong tool for searching a whole corpus.
 */
async function memorySearch({ documentId, ownerId, queryVector, topK, candidates }) {
  const chunks = await findChunksWithEmbeddings({ documentId, ownerId, limit: candidates });

  const scored = chunks.map((chunk) => ({
    chunkId: String(chunk._id),
    index: chunk.index,
    text: chunk.text,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    score: cosineSimilarity(queryVector, chunk.embedding),
  }));

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, topK);
}

/**
 * Delegates ranking to Atlas Vector Search.
 *
 * The owner filter is part of the index definition rather than a later
 * `$match`, so another user's chunks are never candidates in the first place.
 */
async function atlasSearch({ documentId, ownerId, queryVector, topK, candidates }) {
  const results = await Chunk.aggregate([
    {
      $vectorSearch: {
        index: env.VECTOR_INDEX_NAME,
        path: 'embedding',
        queryVector,
        numCandidates: candidates,
        limit: topK,
        filter: {
          documentId: toObjectId(documentId),
          ownerId: toObjectId(ownerId),
        },
      },
    },
    {
      $project: {
        text: 1,
        index: 1,
        pageStart: 1,
        pageEnd: 1,
        score: { $meta: 'vectorSearchScore' },
      },
    },
  ]);

  return results.map((chunk) => ({
    chunkId: String(chunk._id),
    index: chunk.index,
    text: chunk.text,
    pageStart: chunk.pageStart,
    pageEnd: chunk.pageEnd,
    score: chunk.score,
  }));
}

/**
 * Ranks a document's chunks against a query vector.
 *
 * @param {{ documentId: string, ownerId: string, queryVector: number[],
 *   topK?: number, candidates?: number }} params
 */
export async function searchChunks({
  documentId,
  ownerId,
  queryVector,
  topK = env.RETRIEVAL_TOP_K,
  candidates = env.RETRIEVAL_CANDIDATES,
}) {
  const driver = env.VECTOR_SEARCH_DRIVER === 'atlas' ? atlasSearch : memorySearch;

  const startedAt = performance.now();
  const results = await driver({ documentId, ownerId, queryVector, topK, candidates });

  log.debug(
    {
      documentId,
      driver: env.VECTOR_SEARCH_DRIVER,
      returned: results.length,
      topScore: results[0]?.score,
      durationMs: Math.round(performance.now() - startedAt),
    },
    'vector search complete',
  );

  return results;
}

/**
 * Drops anything below the similarity floor.
 *
 * This is the hallucination guard. Retrieval always returns its best matches —
 * "best" is not the same as "relevant", and a model handed a weak passage will
 * answer from it anyway. The gate is what turns that into a refusal.
 *
 * @returns {{ passed: Array, bestScore: number, threshold: number }}
 */
export function applyThreshold(results, threshold = env.RETRIEVAL_MIN_SCORE) {
  const bestScore = results.length > 0 ? results[0].score : 0;
  const passed = results.filter((result) => result.score >= threshold);

  return { passed, bestScore, threshold };
}
