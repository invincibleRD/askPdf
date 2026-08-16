import { checkResources, isDraining } from '../../core/lifecycle.js';
import { env } from '../../config/env.js';

const startedAt = Date.now();

/** Read from package.json at build time via the image label; falls back here. */
const VERSION = '0.1.0';

/**
 * Liveness: is this process functioning?
 *
 * Deliberately shallow. A liveness probe that consults MongoDB will restart
 * every pod in the fleet during a database blip, turning a partial outage
 * into a total one. Dependencies belong in readiness, not here.
 */
export function getLiveness() {
  return {
    status: 'ok',
    service: env.SERVICE_NAME,
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

/**
 * Readiness: should this process receive traffic?
 *
 * Fails while draining, and fails when any critical dependency is down.
 *
 * @returns {Promise<{ ready: boolean, body: object }>}
 */
export async function getReadiness() {
  if (isDraining()) {
    return {
      ready: false,
      body: { status: 'draining', service: env.SERVICE_NAME, checks: {} },
    };
  }

  const { healthy, checks } = await checkResources();

  return {
    ready: healthy,
    body: {
      status: healthy ? 'ok' : 'degraded',
      service: env.SERVICE_NAME,
      version: VERSION,
      checks,
    },
  };
}
