import { createLogger } from './logger.js';

/**
 * Resource registry.
 *
 * Anything with a connection — MongoDB, Redis, the queue consumer — registers
 * here once at startup. That gives the process two things for free:
 *
 *   - a readiness probe that reflects real dependencies rather than a
 *     hard-coded `{ status: "ok" }`, and
 *   - a shutdown sequence that closes resources in reverse registration
 *     order, so the queue consumer stops before the Redis client it uses.
 */

const log = createLogger('lifecycle');

/**
 * @typedef {object} Resource
 * @property {string} name
 * @property {() => Promise<void> | void} [close]        Release the connection.
 * @property {() => Promise<boolean> | boolean} [check]  Is it usable right now?
 * @property {boolean} [critical] When false, a failed check degrades rather
 *   than fails readiness. Defaults to true.
 */

/** @type {Resource[]} */
const resources = [];

/**
 * Set the moment SIGTERM arrives, before connections are closed.
 *
 * Readiness starts failing immediately while the server keeps serving
 * in-flight work, which is how a rolling deploy drains a pod without dropping
 * requests: the load balancer removes it from rotation, then it exits.
 */
let draining = false;

/** @returns {boolean} */
export function isDraining() {
  return draining;
}

/** @param {boolean} value */
export function setDraining(value) {
  draining = value;
}

/**
 * Registers a resource for health reporting and ordered shutdown.
 *
 * @param {Resource} resource
 */
export function registerResource(resource) {
  if (resources.some((existing) => existing.name === resource.name)) {
    throw new Error(`Resource "${resource.name}" is already registered`);
  }
  resources.push({ critical: true, ...resource });
}

/** Drops all registrations. Test-only; production registers once per process. */
export function resetResources() {
  resources.length = 0;
  draining = false;
}

/** @returns {readonly Resource[]} */
export function listResources() {
  return [...resources];
}

/**
 * Runs every registered check concurrently.
 *
 * A check that throws or returns false is reported as down; a check that
 * hangs would block readiness forever, so each is raced against a timeout.
 *
 * @param {{ timeoutMs?: number }} [options]
 * @returns {Promise<{ healthy: boolean, checks: Record<string, {status: string, durationMs: number, error?: string}> }>}
 */
export async function checkResources({ timeoutMs = 2_000 } = {}) {
  const entries = await Promise.all(
    resources
      .filter((resource) => typeof resource.check === 'function')
      .map(async (resource) => {
        const startedAt = performance.now();

        try {
          const ok = await withTimeout(resource.check(), timeoutMs, resource.name);
          return [
            resource.name,
            {
              status: ok ? 'up' : 'down',
              durationMs: Math.round(performance.now() - startedAt),
              critical: resource.critical,
            },
          ];
        } catch (error) {
          return [
            resource.name,
            {
              status: 'down',
              durationMs: Math.round(performance.now() - startedAt),
              critical: resource.critical,
              error: error instanceof Error ? error.message : String(error),
            },
          ];
        }
      }),
  );

  const checks = Object.fromEntries(entries);
  const healthy = Object.values(checks).every(
    (check) => check.status === 'up' || check.critical === false,
  );

  return { healthy, checks };
}

/**
 * Closes every resource in reverse registration order.
 *
 * Failures are logged and swallowed: shutdown must reach the end even if one
 * client is already broken, otherwise the process hangs until the
 * orchestrator sends SIGKILL.
 */
export async function closeResources() {
  for (const resource of [...resources].reverse()) {
    if (typeof resource.close !== 'function') {
      continue;
    }

    try {
      await resource.close();
      log.info({ resource: resource.name }, 'resource closed');
    } catch (error) {
      log.error({ resource: resource.name, err: error }, 'failed to close resource');
    }
  }
}

/**
 * @template T
 * @param {Promise<T> | T} promise
 * @param {number} ms
 * @param {string} label
 * @returns {Promise<T>}
 */
function withTimeout(promise, ms, label) {
  return Promise.race([
    Promise.resolve(promise),
    new Promise((_resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`Health check for "${label}" timed out after ${String(ms)}ms`));
      }, ms);
      timer.unref?.();
    }),
  ]);
}
