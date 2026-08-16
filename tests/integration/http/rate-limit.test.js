import { describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';
import { authRateLimit } from '../../../src/http/middleware/rate-limit.js';
import { errorHandler } from '../../../src/http/middleware/error-handler.js';
import { ErrorCode } from '../../../src/config/constants.js';

/** A minimal app so the limiter is the only thing under test. */
function appWithLimit(max) {
  const app = express();
  app.use(authRateLimit({ max }));
  app.get('/healthz', (_req, res) => res.json({ status: 'ok' }));
  app.get('/', (_req, res) => res.json({ ok: true }));
  app.use(errorHandler());
  return app;
}

describe('rate limiting', () => {
  it('allows requests up to the limit, then returns 429', async () => {
    const app = appWithLimit(3);

    for (let i = 0; i < 3; i += 1) {
      expect((await request(app).get('/')).status).toBe(200);
    }

    const blocked = await request(app).get('/');

    expect(blocked.status).toBe(429);
    expect(blocked.body.error.code).toBe(ErrorCode.RATE_LIMITED);
  });

  it('tells the caller when to retry', async () => {
    const app = appWithLimit(1);
    await request(app).get('/');

    const blocked = await request(app).get('/');

    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(blocked.body.error.details.retryAfterSeconds).toBeGreaterThan(0);
  });

  it('never throttles the probes', async () => {
    const app = appWithLimit(1);
    await request(app).get('/');

    for (let i = 0; i < 5; i += 1) {
      expect((await request(app).get('/healthz')).status).toBe(200);
    }
  });
});
