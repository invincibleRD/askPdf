import { Router } from 'express';
import { healthRoutes } from '../modules/health/health.routes.js';

/** Prefix every versioned endpoint shares. */
export const API_PREFIX = '/api/v1';

/**
 * Route table.
 *
 * The single place that knows which module owns which path. Feature modules
 * export a router and stay unaware of where they are mounted, so moving a
 * resource or cutting a v2 is an edit to this file rather than a sweep.
 */
export function registerRoutes(app) {
  // Unversioned operational endpoints.
  app.use(healthRoutes());

  const api = Router();

  api.get('/', (_req, res) => {
    res.json({
      service: 'askpdf',
      version: 'v1',
      docs: `${API_PREFIX}/docs`,
    });
  });

  app.use(API_PREFIX, api);
}
