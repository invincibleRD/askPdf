import { Router } from 'express';
import { env } from '../../config/env.js';
import { collectMetrics, metricsContentType } from '../../infra/metrics/registry.js';

/**
 * Prometheus scrape endpoint.
 *
 * Unversioned like the health probes, and deliberately unauthenticated: it is
 * expected to be reachable only from inside the cluster, which is enforced by
 * a NetworkPolicy rather than by a token the scraper would have to carry.
 */
export function metricsRoutes() {
  const router = Router();

  if (!env.METRICS_ENABLED) {
    return router;
  }

  router.get(env.METRICS_PATH, async (_req, res) => {
    res.setHeader('Content-Type', metricsContentType);
    res.status(200).send(await collectMetrics());
  });

  return router;
}
