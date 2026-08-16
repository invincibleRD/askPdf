import { afterEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/http/app.js';
import { registerResource, resetResources, setDraining } from '../../../src/core/lifecycle.js';
import { ErrorCode, REQUEST_ID_HEADER } from '../../../src/config/constants.js';

const app = createApp();

afterEach(() => {
  resetResources();
});

describe('GET /healthz', () => {
  it('reports liveness without consulting dependencies', async () => {
    // A dependency that is down must not fail liveness, or a database blip
    // restarts every pod at once.
    registerResource({ name: 'mongo', check: () => false });

    const response = await request(app).get('/healthz');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ status: 'ok', service: 'askpdf' });
    expect(response.body.uptimeSeconds).toBeGreaterThanOrEqual(0);
  });
});

describe('GET /readyz', () => {
  it('returns 200 when every dependency is up', async () => {
    registerResource({ name: 'mongo', check: () => true });
    registerResource({ name: 'redis', check: async () => Promise.resolve(true) });

    const response = await request(app).get('/readyz');

    expect(response.status).toBe(200);
    expect(response.body.status).toBe('ok');
    expect(response.body.checks.mongo.status).toBe('up');
    expect(response.body.checks.redis.status).toBe('up');
  });

  it('returns 503 when a critical dependency is down', async () => {
    registerResource({ name: 'mongo', check: () => true });
    registerResource({ name: 'redis', check: () => false });

    const response = await request(app).get('/readyz');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('degraded');
    expect(response.body.checks.redis.status).toBe('down');
  });

  it('stays ready when a non-critical dependency is down', async () => {
    registerResource({ name: 'mongo', check: () => true });
    registerResource({ name: 's3', check: () => false, critical: false });

    const response = await request(app).get('/readyz');

    expect(response.status).toBe(200);
    expect(response.body.checks.s3.status).toBe('down');
  });

  it('surfaces the reason a check threw', async () => {
    registerResource({
      name: 'mongo',
      check: () => {
        throw new Error('connection refused');
      },
    });

    const response = await request(app).get('/readyz');

    expect(response.status).toBe(503);
    expect(response.body.checks.mongo.error).toBe('connection refused');
  });

  it('fails readiness while draining so the pod leaves rotation', async () => {
    registerResource({ name: 'mongo', check: () => true });
    setDraining(true);

    const response = await request(app).get('/readyz');

    expect(response.status).toBe(503);
    expect(response.body.status).toBe('draining');
  });
});

describe('correlation id', () => {
  it('mints one when the caller does not supply it', async () => {
    const response = await request(app).get('/healthz');

    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('echoes an id supplied by an upstream proxy', async () => {
    const response = await request(app).get('/healthz').set(REQUEST_ID_HEADER, 'trace-abc-123');

    expect(response.headers[REQUEST_ID_HEADER]).toBe('trace-abc-123');
  });

  it('replaces an id containing characters that would poison log files', async () => {
    const response = await request(app)
      .get('/healthz')
      .set(REQUEST_ID_HEADER, 'evil\\nINJECTED LOG LINE');

    expect(response.headers[REQUEST_ID_HEADER]).not.toContain('INJECTED');
    expect(response.headers[REQUEST_ID_HEADER]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('includes the request id in error responses', async () => {
    const response = await request(app).get('/nope').set(REQUEST_ID_HEADER, 'trace-xyz');

    expect(response.body.requestId).toBe('trace-xyz');
  });
});

describe('error envelope', () => {
  it('returns a structured 404 for an unknown route', async () => {
    const response = await request(app).get('/does-not-exist');

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe(ErrorCode.NOT_FOUND);
    expect(response.body.error.message).toContain('/does-not-exist');
  });

  it('turns malformed JSON into a 400 rather than a 500', async () => {
    const response = await request(app)
      .post('/api/v1')
      .set('content-type', 'application/json')
      .send('{"broken":');

    expect(response.status).toBe(400);
    expect(response.body.error.code).toBe(ErrorCode.VALIDATION_FAILED);
  });

  it('rejects a JSON body over the 1MB limit with 413', async () => {
    const response = await request(app)
      .post('/api/v1')
      .set('content-type', 'application/json')
      .send(JSON.stringify({ blob: 'x'.repeat(1_200_000) }));

    expect(response.status).toBe(413);
    expect(response.body.error.code).toBe(ErrorCode.PAYLOAD_TOO_LARGE);
  });
});

describe('hardening', () => {
  it('does not advertise the framework', async () => {
    const response = await request(app).get('/healthz');

    expect(response.headers['x-powered-by']).toBeUndefined();
  });
});

describe('GET /api/v1', () => {
  it('describes the API surface', async () => {
    const response = await request(app).get('/api/v1');

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({ service: 'askpdf', version: 'v1' });
  });
});
