import { Router } from 'express';
import { liveness, readiness } from './health.controller.js';

/**
 * Probe endpoints.
 *
 * Mounted at the root rather than under /api/v1 because orchestrators, load
 * balancers and uptime checks all expect unversioned paths that will never
 * change with the API surface.
 */
export function healthRoutes() {
  const router = Router();

  router.get('/healthz', liveness);
  router.get('/readyz', readiness);

  return router;
}
