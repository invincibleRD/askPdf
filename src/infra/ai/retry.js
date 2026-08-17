import { setTimeout as sleep } from 'node:timers/promises';
import { env } from '../../config/env.js';
import { createLogger } from '../../core/logger.js';
import { UpstreamError } from '../../core/errors.js';

const log = createLogger('ai:retry');

/** 429 and 5xx are worth retrying; a malformed request never will be. */
const RETRYABLE_STATUS = new Set([408, 429, 500, 502, 503, 504]);

export function isRetryableAiError(error) {
  const status = error?.status ?? error?.code ?? error?.response?.status;

  if (typeof status === 'number' && RETRYABLE_STATUS.has(status)) {
    return true;
  }

  const message = String(error?.message ?? '').toLowerCase();
  return (
    message.includes('rate limit') ||
    message.includes('quota') ||
    message.includes('timeout') ||
    message.includes('econnreset') ||
    message.includes('etimedout') ||
    message.includes('socket hang up') ||
    message.includes('overloaded')
  );
}

/**
 * Retries a call with exponential backoff and jitter.
 *
 * @param {() => Promise<T>} fn
 * @param {{ label: string, maxRetries?: number, baseDelayMs?: number }} options
 * @template T
 */
export async function withRetry(fn, { label, maxRetries = env.AI_MAX_RETRIES, baseDelayMs = 500 }) {
  let lastError;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      if (!isRetryableAiError(error) || attempt === maxRetries) {
        break;
      }

      const delay = baseDelayMs * 2 ** attempt + Math.floor(Math.random() * 250);
      log.warn(
        { label, attempt: attempt + 1, maxRetries, delayMs: delay, err: error },
        'retrying upstream call',
      );
      await sleep(delay);
    }
  }

  throw new UpstreamError('gemini', `${label} failed: ${lastError?.message}`, lastError);
}

/** Rejects if the promise has not settled in time, so one hung call can't stall a job. */
export async function withTimeout(promise, ms, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);

  try {
    return await Promise.race([
      promise,
      new Promise((_resolve, reject) => {
        controller.signal.addEventListener('abort', () => {
          reject(new Error(`${label} timed out after ${String(ms)}ms`));
        });
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
