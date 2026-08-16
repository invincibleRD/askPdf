import { createHash, randomUUID } from 'node:crypto';
import { env } from '../../src/config/env.js';
import { createUser } from '../../src/modules/users/user.repository.js';
import { createDocument } from '../../src/modules/documents/document.repository.js';
import { insertChunks } from '../../src/modules/documents/chunk.repository.js';

/**
 * Test data factories.
 *
 * Every factory takes overrides and fills the rest with something valid and
 * unique, so a test only states the field it actually cares about. That keeps
 * the assertion visible instead of buried in twelve lines of setup.
 */

let sequence = 0;
const nextId = () => {
  sequence += 1;
  return sequence;
};

/**
 * @param {Partial<{ email: string, name: string, passwordHash: string, role: string }>} [overrides]
 */
export function buildUser(overrides = {}) {
  const n = nextId();
  return {
    email: `user${String(n)}-${randomUUID().slice(0, 8)}@example.com`,
    name: `Test User ${String(n)}`,
    // A real bcrypt hash shape, so nothing downstream chokes on the format.
    passwordHash: '$2b$12$abcdefghijklmnopqrstuvwxyz012345678901234567890123456',
    ...overrides,
  };
}

/**
 * @param {Partial<object>} [overrides]
 */
export async function createTestUser(overrides = {}) {
  return createUser(buildUser(overrides));
}

/**
 * @param {string} ownerId
 * @param {Partial<object>} [overrides]
 */
export function buildDocument(ownerId, overrides = {}) {
  const n = nextId();
  const filename = overrides.filename ?? `document-${String(n)}.pdf`;

  return {
    ownerId,
    filename,
    storageKey: `documents/${ownerId}/${randomUUID()}.pdf`,
    // Unique per document unless a test is deliberately exercising dedupe.
    contentHash: createHash('sha256').update(`${filename}-${randomUUID()}`).digest('hex'),
    byteSize: 1024 * (n + 1),
    ...overrides,
  };
}

/**
 * @param {string} ownerId
 * @param {Partial<object>} [overrides]
 */
export async function createTestDocument(ownerId, overrides = {}) {
  return createDocument(buildDocument(ownerId, overrides));
}

/**
 * A deterministic unit vector of the configured dimensionality.
 *
 * Derived from a seed so two calls with the same seed produce identical
 * vectors and different seeds produce different ones — enough to assert that
 * similarity ordering works without involving a real embedding model.
 *
 * @param {number} seed
 * @param {number} [dimensions]
 */
export function buildEmbedding(seed, dimensions = env.EMBEDDING_DIMENSIONS) {
  const values = Array.from({ length: dimensions }, (_unused, i) => Math.sin((i + 1) * seed));
  const magnitude = Math.hypot(...values);
  return values.map((value) => value / magnitude);
}

/**
 * @param {{ documentId: string, ownerId: string, count?: number, seed?: number }} params
 */
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

/**
 * @param {{ documentId: string, ownerId: string, count?: number, seed?: number }} params
 */
export async function createTestChunks(params) {
  const chunks = buildChunks(params);
  await insertChunks(chunks);
  return chunks;
}
