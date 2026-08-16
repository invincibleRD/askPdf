import { createLogger } from './logger.js';

/**
 * Anything holding a connection registers here, which gives readiness a real
 * signal and shutdown a defined order.
 */

const log = createLogger('lifecycle');

/**
 * @typedef {object} Resource
 * @property {string} name
 * @property {() => Promise<void> | void} [close]
 * @property {() => Promise<boolean> | boolean} [check]
 * @property {boolean} [critical] When false, a failed check degrades rather
 *   than fails readiness. Defaults to true.
 */

/** @type {Resource[]} */
const resources = [];

let draining = false;

export function isDraining() {
  return draining;
}

export function setDraining(value) {
  draining = value;
}

export function registerResource(resource) {
  if (resources.some((existing) => existing.name === resource.name)) {
    throw new Error(`Resource "${resource.name}" is already registered`);
  }
  resources.push({ critical: true, ...resource });
}

/** Test-only; production registers once per process. */
export function resetResources() {
  resources.length = 0;
  draining = false;
}

export function listResources() {
  return [...resources];
}

/** Checks run concurrently and are raced against a timeout so one hang can't block readiness. */
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
 * Reverse registration order, so the queue consumer closes before the Redis
 * client it uses. Failures are swallowed — shutdown must reach the end.
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
