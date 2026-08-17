import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import request from 'supertest';
import { createApp } from '../../../src/http/app.js';
import { resetResources } from '../../../src/core/lifecycle.js';
import {
  chatOutcomes,
  documentsUploaded,
  registry,
  retrievalScore,
} from '../../../src/infra/metrics/registry.js';

const app = createApp();

beforeEach(() => {
  registry.resetMetrics();
});

afterEach(() => {
  resetResources();
});

/** @returns {Promise<string>} the exposition text */
const scrape = async () => (await request(app).get('/metrics')).text;

describe('GET /metrics', () => {
  it('serves the prometheus exposition format', async () => {
    const response = await request(app).get('/metrics');

    expect(response.status).toBe(200);
    expect(response.headers['content-type']).toMatch(/text\/plain/);
    expect(response.text).toMatch(/^# HELP/m);
  });

  it('includes node process metrics, which reveal event-loop starvation', async () => {
    const text = await scrape();

    expect(text).toContain('nodejs_eventloop_lag_seconds');
    expect(text).toContain('nodejs_heap_size_used_bytes');
  });

  it('labels every series with the service and environment', async () => {
    documentsUploaded.inc({ outcome: 'accepted' });

    expect(await scrape()).toMatch(/service="askpdf".*env="test"/);
  });
});

describe('http request metrics', () => {
  it('records duration and status for a served request', async () => {
    await request(app).get('/api/v1');

    const text = await scrape();
    expect(text).toContain('askpdf_http_request_duration_seconds_bucket');
    expect(text).toMatch(/status="200"/);
  });

  it('labels by route pattern, not the raw path', async () => {
    // Two different ids must land on one series, or cardinality explodes.
    await request(app).get('/api/v1/documents/6a82e7d118f6abe567c840b7');
    await request(app).get('/api/v1/documents/6a82e7d118f6abe567c840c9');

    const text = await scrape();
    expect(text).toContain('route="/api/v1/documents/:id"');
    expect(text).not.toContain('6a82e7d118f6abe567c840b7');
  });

  it('collapses unmatched paths into a single series', async () => {
    await request(app).get('/nope/one');
    await request(app).get('/nope/two');

    const text = await scrape();
    expect(text).toContain('route="<unmatched>"');
    expect(text).not.toContain('/nope/one');
  });

  it('keeps the mount prefix on requests rejected before the handler', async () => {
    // Express unwinds baseUrl on the way out, so this would read "/me".
    await request(app).get('/api/v1/auth/me');

    const text = await scrape();
    expect(text).toContain('route="/api/v1/auth/me",status="401"');
  });

  it('does not measure the scrape itself', async () => {
    await scrape();

    expect(await scrape()).not.toContain('route="/metrics"');
  });
});

describe('retrieval metrics', () => {
  it('buckets scores so the similarity floor can be tuned from real traffic', () => {
    retrievalScore.observe({ outcome: 'answered' }, 0.72);
    retrievalScore.observe({ outcome: 'refused' }, 0.44);
    chatOutcomes.inc({ outcome: 'answered' });
    chatOutcomes.inc({ outcome: 'refused' });

    return registry.getMetricsAsJSON().then((metrics) => {
      const scores = metrics.find((m) => m.name === 'askpdf_retrieval_score');
      const outcomes = metrics.find((m) => m.name === 'askpdf_chat_outcomes_total');

      expect(scores.values.some((v) => v.labels.outcome === 'refused')).toBe(true);
      expect(outcomes.values).toHaveLength(2);
    });
  });
});
