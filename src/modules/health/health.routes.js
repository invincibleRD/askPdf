import { Router } from 'express';
import { liveness, readiness } from './health.controller.js';

// Unversioned: orchestrators and uptime checks expect stable paths.
export function healthRoutes() {
  const router = Router();

  router.get('/healthz', liveness);
  router.get('/readyz', readiness);

  return router;
}
