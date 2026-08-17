import { describe, expect, it } from 'vitest';
import request from 'supertest';
import { Router } from 'express';
import { createApp } from '../../../src/http/app.js';
import { API_PREFIX } from '../../../src/http/routes.js';
import { buildOpenApiSpec } from '../../../src/docs/openapi.js';
import { ErrorCode } from '../../../src/config/constants.js';
import { healthRoutes } from '../../../src/modules/health/health.routes.js';
import { metricsRoutes } from '../../../src/modules/health/metrics.routes.js';
import { authRoutes } from '../../../src/modules/auth/auth.routes.js';
import { documentRoutes } from '../../../src/modules/documents/document.routes.js';
import { jobRoutes } from '../../../src/modules/jobs/job.routes.js';
import { chatRoutes } from '../../../src/modules/chat/chat.routes.js';

const app = createApp();
const spec = buildOpenApiSpec();

/**
 * The real route inventory, read from the module routers themselves.
 *
 * Express 5 replaced the layer `regexp` with opaque matchers, so walking the
 * app to recover mount prefixes is fragile. Reading each router's own stack and
 * pairing it with the mount declared in src/http/routes.js is stable, and a new
 * route inside an existing module is still picked up automatically.
 */
const MOUNTS = [
  ['', healthRoutes()],
  ['', metricsRoutes()],
  [API_PREFIX, apiRoot()],
  [`${API_PREFIX}/auth`, authRoutes()],
  [`${API_PREFIX}/documents`, documentRoutes()],
  [`${API_PREFIX}/jobs`, jobRoutes()],
  [`${API_PREFIX}/chat`, chatRoutes()],
];

/** The bare `GET /api/v1` handler lives inline in the route table. */
function apiRoot() {
  const router = Router();
  router.get('/', (_req, res) => res.json({}));
  return router;
}

function registeredRoutes() {
  return MOUNTS.flatMap(([mount, router]) =>
    router.stack
      .filter((layer) => layer.route)
      .flatMap((layer) => {
        const path = layer.route.path === '/' ? '' : layer.route.path;
        const full = `${mount}${path}` || '/';
        return Object.keys(layer.route.methods).map((method) => `${method.toUpperCase()} ${full}`);
      }),
  );
}

/** OpenAPI uses `{id}`; Express uses `:id`. */
const toExpressStyle = (path) => path.replaceAll(/\{(\w+)\}/g, ':$1');

const specOperations = Object.entries(spec.paths).flatMap(([path, methods]) =>
  Object.keys(methods).map((method) => `${method.toUpperCase()} ${toExpressStyle(path)}`),
);

describe('spec covers the implementation', () => {
  it('documents every route the app registers', () => {
    const undocumented = registeredRoutes().filter((route) => !specOperations.includes(route));

    expect(undocumented, `undocumented routes: ${undocumented.join(', ')}`).toEqual([]);
  });

  it('describes no route the app does not have', () => {
    const routes = registeredRoutes();
    const phantom = specOperations.filter((operation) => !routes.includes(operation));

    expect(phantom, `documented but missing: ${phantom.join(', ')}`).toEqual([]);
  });
});

describe('spec shape', () => {
  it('is served as JSON', async () => {
    const response = await request(app).get('/api/v1/openapi.json');

    expect(response.status).toBe(200);
    expect(response.body.openapi).toBe('3.1.0');
    expect(response.body.info.title).toBe('AskPDF API');
  });

  it('renders Swagger UI', async () => {
    const response = await request(app).get('/api/v1/docs/');

    expect(response.status).toBe(200);
    expect(response.text).toContain('swagger-ui');
  });

  it('relaxes the CSP only for the docs page', async () => {
    const docs = await request(app).get('/api/v1/docs/');
    const api = await request(app).get('/api/v1');

    expect(docs.headers['content-security-policy']).toContain("script-src 'self' 'unsafe-inline'");
    expect(api.headers['content-security-policy']).toContain("default-src 'none'");
  });

  it('declares every error code the service can return', () => {
    const declared = spec.components.schemas.Error.properties.error.properties.code.enum;

    expect(declared.sort()).toEqual(Object.values(ErrorCode).sort());
  });

  it('marks authenticated operations as requiring a bearer token', () => {
    const upload = spec.paths['/api/v1/documents'].post;
    const login = spec.paths['/api/v1/auth/login'].post;

    expect(upload.security).toEqual([{ bearerAuth: [] }]);
    expect(login.security).toBeUndefined();
  });

  it('documents upload as 202, and its rejection codes', () => {
    const responses = spec.paths['/api/v1/documents'].post.responses;

    expect(Object.keys(responses)).toEqual(
      expect.arrayContaining(['202', '413', '415', '401', '429']),
    );
    expect(responses['201']).toBeUndefined();
  });

  it('documents the refusal path on chat', () => {
    expect(spec.paths['/api/v1/chat'].post.responses['422']).toBeDefined();
  });
});
