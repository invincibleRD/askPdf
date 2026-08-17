import { createHash } from 'node:crypto';
import { env } from '../../config/env.js';

/**
 * Offline provider for tests and local development.
 *
 * Embeddings are derived from the text's own tokens, so semantically similar
 * strings score higher than unrelated ones. That is enough to exercise
 * ranking, the similarity threshold and citation assembly without spending
 * quota or requiring network access — but it is a bag-of-words model, not a
 * language model, so it proves the plumbing rather than retrieval quality.
 */
export function createFakeProvider({ dimensions = env.EMBEDDING_DIMENSIONS } = {}) {
  function embedOne(text) {
    const vector = new Array(dimensions).fill(0);

    for (const token of tokenize(text)) {
      // Hash each token to a fixed set of dimensions; shared vocabulary then
      // produces overlapping vectors.
      const digest = createHash('sha256').update(token).digest();

      for (let i = 0; i < 4; i += 1) {
        const slot = digest.readUInt32BE(i * 4) % dimensions;
        const sign = (digest[16 + i] & 1) === 0 ? 1 : -1;
        vector[slot] += sign;
      }
    }

    return normalise(vector);
  }

  return {
    name: 'fake',
    dimensions,
    embeddingModel: 'fake-embedding',
    chatModel: 'fake-chat',

    embed(texts) {
      return Promise.resolve(texts.map((text) => embedOne(text)));
    },

    generate({ prompt }) {
      return Promise.resolve(fakeAnswer(prompt));
    },

    async *generateStream({ prompt }) {
      for (const word of fakeAnswer(prompt).split(' ')) {
        yield `${word} `;
      }
    },

    healthCheck() {
      return Promise.resolve(true);
    },
  };
}

function tokenize(text) {
  return String(text)
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((token) => token.length > 2);
}

function normalise(vector) {
  const magnitude = Math.hypot(...vector);

  if (magnitude === 0) {
    // An all-zero vector has no direction; give it a fixed one so cosine
    // similarity stays defined.
    const fallback = new Array(vector.length).fill(0);
    fallback[0] = 1;
    return fallback;
  }

  return vector.map((value) => value / magnitude);
}

/** Echoes back a sentence of the supplied context, so grounding is observable. */
function fakeAnswer(prompt) {
  const context = /Context:\n([\s\S]*?)\n\nQuestion:/.exec(prompt)?.[1] ?? '';
  const firstSentence = context.split(/(?<=\.)\s/)[0] ?? '';

  return firstSentence
    ? `Based on the document: ${firstSentence.trim()}`
    : 'The document does not contain an answer to that question.';
}
