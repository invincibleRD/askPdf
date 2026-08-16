import { Router } from 'express';
import { healthRoutes } from '../modules/health/health.routes.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { documentRoutes } from '../modules/documents/document.routes.js';

export const API_PREFIX = '/api/v1';

/** The only place that knows which module owns which path. */
export function registerRoutes(app) {
  app.use(healthRoutes());

  const api = Router();

  api.get('/', (_req, res) => {
    res.json({ service: 'askpdf', version: 'v1', docs: `${API_PREFIX}/docs` });
  });

  api.use('/auth', authRoutes());
  api.use('/documents', documentRoutes());

  app.use(API_PREFIX, api);
}
