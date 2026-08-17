import { env } from '../../config/env.js';
import { createLogger } from '../../core/logger.js';
import { createFakeProvider } from './fake.provider.js';
import { createGeminiProvider } from './gemini.provider.js';

const log = createLogger('ai');

let provider = null;

export function getAiProvider() {
  if (!provider) {
    provider = env.AI_PROVIDER === 'fake' ? createFakeProvider() : createGeminiProvider();
    log.info(
      { provider: provider.name, embeddingModel: provider.embeddingModel },
      'ai provider ready',
    );
  }

  return provider;
}

/** Test seam. */
export function setAiProvider(next) {
  provider = next;
}

/**
 * Embeds many texts in batches.
 *
 * A thousand chunks in one request would exceed the payload limit and lose
 * everything on a single failure, so this splits into batches the provider
 * accepts. Batches run in sequence: firing them all at once is the fastest
 * way to hit a rate limit.
 */
export async function embedBatched(
  texts,
  { batchSize = env.EMBEDDING_BATCH_SIZE, onProgress } = {},
) {
  const ai = getAiProvider();
  const vectors = [];

  for (let start = 0; start < texts.length; start += batchSize) {
    const batch = texts.slice(start, start + batchSize);
    const embedded = await ai.embed(batch, { taskType: 'RETRIEVAL_DOCUMENT' });

    vectors.push(...embedded);
    await onProgress?.(vectors.length, texts.length);
  }

  return vectors;
}

export { createFakeProvider, createGeminiProvider };
