import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { env } from '../config/env.js';
import { buildOpenApiSpec } from './openapi.js';

/**
 * The spec and the page that renders it.
 *
 * Both are behind SWAGGER_ENABLED so a deployment can turn the docs off
 * without a rebuild.
 */
export function docsRoutes() {
  const router = Router();

  if (!env.SWAGGER_ENABLED) {
    return router;
  }

  const spec = buildOpenApiSpec();

  // The raw document, for client generators and contract tests.
  router.get('/openapi.json', (_req, res) => {
    res.status(200).json(spec);
  });

  // Swagger UI injects inline styles and scripts, which the API-wide CSP
  // forbids. Relaxing it for this one route keeps the strict policy everywhere
  // that actually returns data.
  router.use(
    '/docs',
    (_req, res, next) => {
      res.setHeader(
        'Content-Security-Policy',
        "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
          "script-src 'self' 'unsafe-inline'; connect-src 'self'",
      );
      next();
    },
    swaggerUi.serve,
    swaggerUi.setup(spec, {
      customSiteTitle: 'AskPDF API',
      swaggerOptions: { persistAuthorization: true, displayRequestDuration: true },
    }),
  );

  return router;
}
