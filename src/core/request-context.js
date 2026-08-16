import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Ambient per-request (or per-job) context.
 *
 * Carries the correlation id and the authenticated user id so that any code
 * — a repository, a retry helper, the AI client — can log with the right
 * identifiers without threading a context argument through every signature.
 *
 * The worker uses the same store, seeded with the request id captured when
 * the job was enqueued, which is what lets a single id follow an upload from
 * the HTTP request all the way through embedding.
 */
const storage = new AsyncLocalStorage();

/**
 * Runs `fn` with the given context bound for its entire async subtree.
 *
 * @template T
 * @param {{ requestId?: string, userId?: string, jobId?: string }} context
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithContext(context, fn) {
  return storage.run({ requestId: context.requestId ?? randomUUID(), ...context }, fn);
}

/**
 * The active context, or an empty object outside any bound scope.
 *
 * @returns {{ requestId?: string, userId?: string, jobId?: string }}
 */
export function getContext() {
  return storage.getStore() ?? {};
}

/** @returns {string | undefined} */
export function getRequestId() {
  return getContext().requestId;
}

/**
 * Merges fields into the active context.
 *
 * Used when a value is only known part-way through — the user id, for
 * example, exists once auth middleware has run, not when the request began.
 * A no-op outside a bound scope.
 *
 * @param {Record<string, string>} fields
 */
export function setContext(fields) {
  const store = storage.getStore();
  if (store) {
    Object.assign(store, fields);
  }
}

/** Generates a correlation id for a request that arrived without one. */
export function newRequestId() {
  return randomUUID();
}
