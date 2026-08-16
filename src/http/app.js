import express from 'express';
import { env } from '../config/env.js';
import { correlationId } from './middleware/correlation-id.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestLogger } from './middleware/request-logger.js';
import { requestTimeout } from './middleware/timeout.js';
import { registerRoutes } from './routes.js';

/**
 * Builds the Express application.
 *
 * Returns the app rather than starting a server, which keeps the HTTP surface
 * testable with supertest and keeps listening/shutdown concerns in the
 * entrypoint where they belong.
 *
 * Middleware order is deliberate:
 *
 *   1. correlation id  — everything after it can log with a request id
 *   2. access log      — sees the id, and still logs failed requests
 *   3. timeout         — starts the clock before any handler work
 *   4. body parsers    — bounded, so a huge JSON body is rejected early
 *   5. routes
 *   6. 404, then the error handler, which must be registered last
 */
export function createApp() {
  const app = express();

  // Behind an ingress or ALB, req.ip and req.protocol are only correct when
  // Express is told to trust the forwarding headers. Rate limiting keys off
  // req.ip, so getting this wrong buckets the whole world together.
  app.set('trust proxy', env.TRUST_PROXY);
  app.disable('x-powered-by');
  app.set('etag', false);

  app.use(correlationId());
  app.use(requestLogger());
  app.use(requestTimeout(env.REQUEST_TIMEOUT_MS));

  // 1 MB is ample for JSON here; PDF uploads take the multipart path, which
  // streams to storage instead of buffering.
  app.use(express.json({ limit: '1mb' }));
  app.use(express.urlencoded({ extended: false, limit: '1mb' }));

  registerRoutes(app);

  app.use(notFoundHandler());
  app.use(errorHandler());

  return app;
}
