import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../helpers/db.js';
import {
  buildChunks,
  buildEmbedding,
  createTestChunks,
  createTestDocument,
  createTestUser,
} from '../../helpers/factories.js';
import {
  countChunksForDocument,
  deleteChunksForDocument,
  deleteChunksForDocuments,
  findChunksByIndex,
  findChunksForDocument,
  findChunksWithEmbeddings,
  insertChunks,
} from '../../../src/modules/documents/chunk.repository.js';
import { env } from '../../../src/config/env.js';

useTestDatabase();

let owner;
let document;

beforeEach(async () => {
  owner = await createTestUser();
  document = await createTestDocument(owner.id);
});

describe('insertChunks', () => {
  it('writes a batch and reports the count', async () => {
    const chunks = buildChunks({ documentId: document.id, ownerId: owner.id, count: 5 });

    await expect(insertChunks(chunks)).resolves.toBe(5);
    await expect(countChunksForDocument(document.id)).resolves.toBe(5);
  });

  it('handles an empty batch without touching the database', async () => {
    await expect(insertChunks([])).resolves.toBe(0);
  });

  it('splits a large batch into several commands', async () => {
    const chunks = buildChunks({ documentId: document.id, ownerId: owner.id, count: 450 });

    await expect(insertChunks(chunks, { batchSize: 100 })).resolves.toBe(450);
    await expect(countChunksForDocument(document.id)).resolves.toBe(450);
  });

  it('rejects a vector of the wrong dimensionality', async () => {
    const [chunk] = buildChunks({ documentId: document.id, ownerId: owner.id, count: 1 });
    chunk.embedding = [0.1, 0.2, 0.3];

    // A short vector would silently produce meaningless similarity scores, so
    // the schema refuses it at write time.
    await expect(insertChunks([chunk])).rejects.toThrow(
      new RegExp(`${String(env.EMBEDDING_DIMENSIONS)} dimensions`),
    );
  });

  it('refuses two chunks at the same position in one document', async () => {
    const chunks = buildChunks({ documentId: document.id, ownerId: owner.id, count: 2 });
    chunks[1].index = chunks[0].index;

    await expect(insertChunks(chunks)).rejects.toThrow();
  });

  it('allows the same position in different documents', async () => {
    const second = await createTestDocument(owner.id);

    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 3 });
    await createTestChunks({ documentId: second.id, ownerId: owner.id, count: 3 });

    await expect(countChunksForDocument(second.id)).resolves.toBe(3);
  });
});

describe('findChunksForDocument', () => {
  beforeEach(async () => {
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 6 });
  });

  it('returns chunks in document order', async () => {
    const chunks = await findChunksForDocument(document.id);

    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('omits the embedding so a listing does not move megabytes of vectors', async () => {
    const [chunk] = await findChunksForDocument(document.id);

    expect(chunk.embedding).toBeUndefined();
    expect(chunk.text).toBeTruthy();
  });

  it('paginates', async () => {
    const page = await findChunksForDocument(document.id, { limit: 2, skip: 2 });

    expect(page.map((chunk) => chunk.index)).toEqual([2, 3]);
  });

  it('returns nothing for a malformed id', async () => {
    await expect(findChunksForDocument('nope')).resolves.toEqual([]);
  });
});

describe('findChunksByIndex', () => {
  it('fetches specific positions for citation expansion', async () => {
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 10 });

    const chunks = await findChunksByIndex(document.id, [7, 2, 4]);

    expect(chunks.map((chunk) => chunk.index)).toEqual([2, 4, 7]);
  });

  it('returns nothing when asked for no positions', async () => {
    await expect(findChunksByIndex(document.id, [])).resolves.toEqual([]);
  });
});

describe('findChunksWithEmbeddings', () => {
  it('includes the vectors needed for in-process scoring', async () => {
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 3 });

    const chunks = await findChunksWithEmbeddings({
      documentId: document.id,
      ownerId: owner.id,
    });

    expect(chunks).toHaveLength(3);
    expect(chunks[0].embedding).toHaveLength(env.EMBEDDING_DIMENSIONS);
  });

  it('will not return another user chunks', async () => {
    const other = await createTestUser();
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 3 });

    // Ownership is a query filter, not a post-hoc check.
    await expect(
      findChunksWithEmbeddings({ documentId: document.id, ownerId: other.id }),
    ).resolves.toEqual([]);
  });

  it('respects the scan limit', async () => {
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 20 });

    const chunks = await findChunksWithEmbeddings({
      documentId: document.id,
      ownerId: owner.id,
      limit: 5,
    });

    expect(chunks).toHaveLength(5);
  });
});

describe('deleteChunksForDocument', () => {
  it('removes every chunk and reports how many', async () => {
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 4 });

    await expect(deleteChunksForDocument(document.id)).resolves.toBe(4);
    await expect(countChunksForDocument(document.id)).resolves.toBe(0);
  });

  it('leaves other documents untouched', async () => {
    const second = await createTestDocument(owner.id);
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 3 });
    await createTestChunks({ documentId: second.id, ownerId: owner.id, count: 3 });

    await deleteChunksForDocument(document.id);

    await expect(countChunksForDocument(second.id)).resolves.toBe(3);
  });

  it('makes a re-index possible after a partial failure', async () => {
    // A run that died after writing half the chunks must not collide with the
    // unique {documentId, index} on retry.
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 3 });
    await deleteChunksForDocument(document.id);

    await expect(
      insertChunks(buildChunks({ documentId: document.id, ownerId: owner.id, count: 6 })),
    ).resolves.toBe(6);
  });
});

describe('deleteChunksForDocuments', () => {
  it('removes chunks for several documents at once', async () => {
    const second = await createTestDocument(owner.id);
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 2 });
    await createTestChunks({ documentId: second.id, ownerId: owner.id, count: 3 });

    await expect(deleteChunksForDocuments([document.id, second.id])).resolves.toBe(5);
  });

  it('ignores malformed ids rather than failing the sweep', async () => {
    await createTestChunks({ documentId: document.id, ownerId: owner.id, count: 2 });

    await expect(deleteChunksForDocuments(['garbage', document.id])).resolves.toBe(2);
  });

  it('does nothing when given no ids', async () => {
    await expect(deleteChunksForDocuments([])).resolves.toBe(0);
  });
});

describe('buildEmbedding fixture', () => {
  it('produces unit vectors, so cosine similarity is a plain dot product', () => {
    const vector = buildEmbedding(3);

    expect(vector).toHaveLength(env.EMBEDDING_DIMENSIONS);
    expect(Math.hypot(...vector)).toBeCloseTo(1, 10);
  });

  it('is deterministic for a seed and distinct across seeds', () => {
    expect(buildEmbedding(7)).toEqual(buildEmbedding(7));
    expect(buildEmbedding(7)).not.toEqual(buildEmbedding(8));
  });
});
