import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/**
 * Carries the correlation id and user id so the logger can stamp them without
 * every function signature taking a context argument. The worker uses the same
 * store, seeded from the request that enqueued the job.
 */
const storage = new AsyncLocalStorage();

export function runWithContext(context, fn) {
  return storage.run({ requestId: context.requestId ?? randomUUID(), ...context }, fn);
}

export function getContext() {
  return storage.getStore() ?? {};
}

export function getRequestId() {
  return getContext().requestId;
}

/** Merges in values known later, like the user id after auth runs. */
export function setContext(fields) {
  const store = storage.getStore();
  if (store) {
    Object.assign(store, fields);
  }
}

export function newRequestId() {
  return randomUUID();
}
