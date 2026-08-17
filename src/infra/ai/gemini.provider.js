import { GoogleGenAI } from '@google/genai';
import { env } from '../../config/env.js';
import { createLogger } from '../../core/logger.js';
import { UpstreamError } from '../../core/errors.js';
import { withRetry, withTimeout } from './retry.js';

const log = createLogger('ai:gemini');

export function createGeminiProvider({
  apiKey = env.GEMINI_API_KEY,
  embeddingModel = env.GEMINI_EMBEDDING_MODEL,
  chatModel = env.GEMINI_CHAT_MODEL,
  dimensions = env.EMBEDDING_DIMENSIONS,
} = {}) {
  const client = new GoogleGenAI({ apiKey });

  /**
   * Embeds a batch of texts.
   *
   * Document chunks and search queries have to be embedded with different
   * task types — Gemini places them in the same space but optimises each
   * side, and mixing them measurably degrades retrieval.
   *
   * @param {string[]} texts
   * @param {{ taskType?: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' }} [options]
   */
  async function embed(texts, { taskType = 'RETRIEVAL_DOCUMENT' } = {}) {
    if (texts.length === 0) {
      return [];
    }

    const response = await withRetry(
      () =>
        withTimeout(
          client.models.embedContent({
            model: embeddingModel,
            contents: texts,
            config: { taskType, outputDimensionality: dimensions },
          }),
          env.AI_REQUEST_TIMEOUT_MS,
          'embedContent',
        ),
      { label: 'embedContent' },
    );

    const vectors = (response.embeddings ?? []).map((item) => item.values);

    if (vectors.length !== texts.length) {
      throw new UpstreamError(
        'gemini',
        `Embedding count mismatch: sent ${String(texts.length)}, received ${String(vectors.length)}`,
      );
    }

    for (const vector of vectors) {
      if (!Array.isArray(vector) || vector.length !== dimensions) {
        throw new UpstreamError(
          'gemini',
          `Expected ${String(dimensions)}-dimension vectors, got ${String(vector?.length)}`,
        );
      }
    }

    return vectors;
  }

  /** @param {{ system?: string, prompt: string, temperature?: number }} params */
  async function generate({ system, prompt, temperature = 0.2 }) {
    const response = await withRetry(
      () =>
        withTimeout(
          client.models.generateContent({
            model: chatModel,
            contents: prompt,
            config: {
              temperature,
              ...(system ? { systemInstruction: system } : {}),
            },
          }),
          env.AI_REQUEST_TIMEOUT_MS,
          'generateContent',
        ),
      { label: 'generateContent' },
    );

    return response.text ?? '';
  }

  /** Yields text deltas so the API can forward them over SSE. */
  async function* generateStream({ system, prompt, temperature = 0.2 }) {
    const stream = await withRetry(
      () =>
        client.models.generateContentStream({
          model: chatModel,
          contents: prompt,
          config: {
            temperature,
            ...(system ? { systemInstruction: system } : {}),
          },
        }),
      { label: 'generateContentStream' },
    );

    for await (const chunk of stream) {
      const text = chunk.text;
      if (text) {
        yield text;
      }
    }
  }

  async function healthCheck() {
    try {
      const [vector] = await embed(['health check'], { taskType: 'RETRIEVAL_QUERY' });
      return vector.length === dimensions;
    } catch (error) {
      log.warn({ err: error }, 'gemini health check failed');
      return false;
    }
  }

  return {
    name: 'gemini',
    dimensions,
    embeddingModel,
    chatModel,
    embed,
    generate,
    generateStream,
    healthCheck,
  };
}
