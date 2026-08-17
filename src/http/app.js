import express from 'express';
import { env } from '../config/env.js';
import { correlationId } from './middleware/correlation-id.js';
import { metricsMiddleware } from './middleware/metrics.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { globalRateLimit } from './middleware/rate-limit.js';
import { requestLogger } from './middleware/request-logger.js';
import { corsPolicy, securityHeaders } from './middleware/security.js';
import { requestTimeout } from './middleware/timeout.js';
import { registerRoutes } from './routes.js';

/** Returns the app without listening, so supertest can drive it directly. */
export function createApp() {
  const app = express();

  // Rate limiting keys off req.ip; behind an ingress that's only correct with
  // trust proxy set.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(correlationId());
  app.use(requestLogger());
  // Before the rest of the pipeline, so rejected requests are measured too.
  app.use(metricsMiddleware());
  app.use(securityHeaders());
  app.use(corsPolicy());
  app.use(requestTimeout(env.REQUEST_TIMEOUT_MS));
  app.use(globalRateLimit());

  // PDFs take the multipart path and stream to storage instead of buffering.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  registerRoutes(app);

  // Error handler must be last.
  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
