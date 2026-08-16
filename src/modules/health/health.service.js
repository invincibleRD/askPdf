import { checkResources, isDraining } from '../../core/lifecycle.js';
import { env } from '../../config/env.js';

const startedAt = Date.now();
const VERSION = '0.1.0';

/**
 * Deliberately shallow — a liveness probe that consults MongoDB restarts every
 * pod during a database blip and turns a partial outage into a total one.
 */
export function getLiveness() {
  return {
    status: 'ok',
    service: env.SERVICE_NAME,
    version: VERSION,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
  };
}

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
