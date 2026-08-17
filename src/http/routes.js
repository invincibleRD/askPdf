import { Router } from 'express';
import { healthRoutes } from '../modules/health/health.routes.js';
import { metricsRoutes } from '../modules/health/metrics.routes.js';
import { authRoutes } from '../modules/auth/auth.routes.js';
import { documentRoutes } from '../modules/documents/document.routes.js';
import { jobRoutes } from '../modules/jobs/job.routes.js';
import { chatRoutes } from '../modules/chat/chat.routes.js';
import { docsRoutes } from '../docs/docs.routes.js';

export const API_PREFIX = '/api/v1';

/** The only place that knows which module owns which path. */
export function registerRoutes(app) {
  app.use(healthRoutes());
  app.use(metricsRoutes());

  const api = Router();

  api.get('/', (_req, res) => {
    res.json({ service: 'askpdf', version: 'v1', docs: `${API_PREFIX}/docs` });
  });

  api.use('/auth', authRoutes());
  api.use('/documents', documentRoutes());
  api.use('/jobs', jobRoutes());
  api.use('/chat', chatRoutes());
  api.use(docsRoutes());

  app.use(API_PREFIX, api);
}
