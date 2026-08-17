import { beforeAll, describe, expect, it } from 'vitest';
import { createGeminiProvider } from '../../../src/infra/ai/gemini.provider.js';
import { cosineSimilarity } from '../../../src/modules/chat/vector-search.js';
import { chunkPages } from '../../../src/pipeline/chunk.js';
import { CORPUS } from '../../fixtures/corpus.js';
import { DEFAULT_RETRIEVAL_MIN_SCORE } from '../../../src/config/constants.js';
import { env } from '../../../src/config/env.js';

/**
 * Retrieval *quality*, against live Gemini.
 *
 * The fake provider is bag-of-words: its on-topic and off-topic score
 * distributions overlap, so it can prove the gate is wired up but never that
 * the gate discriminates. That only holds for real embeddings, which need a
 * key and cost quota — so this suite is opt-in.
 *
 *   RUN_AI_TESTS=1 GEMINI_API_KEY=... npm test
 */
const enabled = process.env.RUN_AI_TESTS === '1' && Boolean(process.env.GEMINI_API_KEY);

// The production floor, not the lowered one tests/setup.js uses for the fake
// provider. This suite exists to prove that specific number is defensible.
const THRESHOLD = DEFAULT_RETRIEVAL_MIN_SCORE;

/** slug -> { chunks, vectors } */
const indexed = new Map();
let ai;

describe.runIf(enabled)('retrieval quality (live Gemini)', () => {
  beforeAll(async () => {
    ai = createGeminiProvider({ apiKey: process.env.GEMINI_API_KEY });

    for (const doc of CORPUS) {
      const pages = doc.pages.map((page, i) => ({
        page: i + 1,
        text: [page.heading, ...page.paragraphs].join('\n\n'),
      }));
      const chunks = chunkPages(pages, { chunkTokens: 48, overlapTokens: 8 });
      const vectors = await ai.embed(
        chunks.map((c) => c.text),
        {
          taskType: 'RETRIEVAL_DOCUMENT',
        },
      );

      indexed.set(doc.slug, { chunks, vectors });
    }
  }, 180_000);

  /** Ranked chunks of a document for a question, best first. */
  async function rank(slug, question) {
    const { chunks, vectors } = indexed.get(slug);
    const [queryVector] = await ai.embed([question], { taskType: 'RETRIEVAL_QUERY' });

    const scored = vectors.map((vector, i) => ({
      score: cosineSimilarity(queryVector, vector),
      text: chunks[i].text,
    }));

    return scored.sort((a, b) => b.score - a.score);
  }

  const bestMatch = async (slug, question) => (await rank(slug, question))[0];

  it('returns unit vectors, so cosine is well-defined', () => {
    for (const { vectors } of indexed.values()) {
      for (const vector of vectors) {
        expect(Math.hypot(...vector)).toBeCloseTo(1, 5);
      }
    }
  });

  it.each(CORPUS.flatMap((doc) => doc.probes.expected.map((p) => [doc.slug, p])))(
    '%s retrieves the passage that answers its own question',
    async (slug, probe) => {
      const ranked = await rank(slug, probe.question);

      expect(ranked[0].score).toBeGreaterThanOrEqual(THRESHOLD);

      // The answer-bearing passage must be inside the window the model
      // actually receives, not necessarily at rank 1 — a heading chunk often
      // scores highest while the figure sits in the paragraph below it.
      const context = ranked.slice(0, env.RETRIEVAL_TOP_K).filter((r) => r.score >= THRESHOLD);
      expect(context.map((r) => r.text).join('\n')).toMatch(probe.mustMatch);
    },
    60_000,
  );

  it.each(CORPUS.flatMap((doc) => doc.probes.offTopic.map((q) => [doc.slug, q])))(
    '%s scores below the floor for: %s',
    async (slug, question) => {
      const best = await bestMatch(slug, question);

      expect(best.score).toBeLessThan(THRESHOLD);
    },
    60_000,
  );

  it('separates on-topic from off-topic with margin either side of the floor', async () => {
    const onTopic = [];
    const offTopic = [];

    for (const doc of CORPUS) {
      for (const probe of doc.probes.expected) {
        onTopic.push((await bestMatch(doc.slug, probe.question)).score);
      }
      for (const question of doc.probes.offTopic) {
        offTopic.push((await bestMatch(doc.slug, question)).score);
      }
    }

    // The gap is what makes 0.7 a defensible choice rather than a guess.
    expect(Math.min(...onTopic)).toBeGreaterThan(THRESHOLD);
    expect(Math.max(...offTopic)).toBeLessThan(THRESHOLD);
  }, 180_000);
});
