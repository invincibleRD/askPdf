import { createHash, randomUUID } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { createUser } from '../../src/modules/users/user.repository.js';
import { createDocument } from '../../src/modules/documents/document.repository.js';
import { insertChunks } from '../../src/modules/documents/chunk.repository.js';

// Each factory fills everything but the field a test actually cares about.

let sequence = 0;
const nextId = () => {
  sequence += 1;
  return sequence;
};

export function buildUser(overrides = {}) {
  const n = nextId();
  return {
    email: `user${String(n)}-${randomUUID().slice(0, 8)}@example.com`,
    name: `Test User ${String(n)}`,
    // Real bcrypt shape, so nothing downstream chokes on the format.
    passwordHash: '$2b$12$abcdefghijklmnopqrstuvwxyz012345678901234567890123456',
    ...overrides,
  };
}

export async function createTestUser(overrides = {}) {
  return createUser(buildUser(overrides));
}

export function buildDocument(ownerId, overrides = {}) {
  const n = nextId();
  const filename = overrides.filename ?? `document-${String(n)}.pdf`;

  return {
    ownerId,
    filename,
    storageKey: `documents/${ownerId}/${randomUUID()}.pdf`,
    contentHash: createHash('sha256').update(`${filename}-${randomUUID()}`).digest('hex'),
    byteSize: 1024 * (n + 1),
    ...overrides,
  };
}

export async function createTestDocument(ownerId, overrides = {}) {
  return createDocument(buildDocument(ownerId, overrides));
}

/** Deterministic unit vector — same seed, same vector. */
export function buildEmbedding(seed, dimensions = env.EMBEDDING_DIMENSIONS) {
  const values = Array.from({ length: dimensions }, (_unused, i) => Math.sin((i + 1) * seed));
  const magnitude = Math.hypot(...values);
  return values.map((value) => value / magnitude);
}

export function buildChunks({ documentId, ownerId, count = 3, seed = 1 }) {
  return Array.from({ length: count }, (_unused, index) => ({
    documentId,
    ownerId,
    index,
    text: `Chunk ${String(index)} of document ${documentId}. Seed ${String(seed)}.`,
    tokenCount: 24,
    pageStart: index + 1,
    pageEnd: index + 1,
    embedding: buildEmbedding(seed + index),
  }));
}

export async function createTestChunks(params) {
  const chunks = buildChunks(params);
  await insertChunks(chunks);
  return chunks;
}
