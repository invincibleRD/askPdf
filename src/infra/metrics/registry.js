import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from 'prom-client';
import { env } from '../../config/env.js';

/**
 * A dedicated registry rather than the global default, so tests can build an
 * isolated one and metric names can't collide across imports.
 */
export const registry = new Registry();

registry.setDefaultLabels({ service: env.SERVICE_NAME, env: env.NODE_ENV });

// Heap, event-loop lag, GC pauses, open handles. Event-loop lag in particular
// is what tells you the process is CPU-bound rather than waiting on I/O.
collectDefaultMetrics({ register: registry, prefix: 'nodejs_' });

const PREFIX = 'askpdf_';

/**
 * Latency buckets in seconds.
 *
 * Tuned for this service rather than left at the default: an HTTP request is
 * expected in tens of milliseconds, so the low buckets need resolution there.
 */
const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Ingestion is seconds to minutes, so the buckets are far coarser. */
const PIPELINE_BUCKETS = [0.1, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300];

export const httpRequestDuration = new Histogram({
  name: `${PREFIX}http_request_duration_seconds`,
  help: 'HTTP request duration in seconds',
  // `route` is the registered pattern, never the raw path — labelling with
  // /documents/<id> would create a new series per document.
  labelNames: ['method', 'route', 'status'],
  buckets: HTTP_BUCKETS,
  registers: [registry],
});

export const httpRequestsInFlight = new Gauge({
  name: `${PREFIX}http_requests_in_flight`,
  help: 'Requests currently being served',
  registers: [registry],
});

export const documentsUploaded = new Counter({
  name: `${PREFIX}documents_uploaded_total`,
  help: 'Documents accepted for processing',
  labelNames: ['outcome'],
  registers: [registry],
});

export const pipelineStageDuration = new Histogram({
  name: `${PREFIX}ingest_stage_duration_seconds`,
  help: 'Duration of each ingestion stage',
  labelNames: ['stage'],
  buckets: PIPELINE_BUCKETS,
  registers: [registry],
});

export const pipelineDuration = new Histogram({
  name: `${PREFIX}ingest_duration_seconds`,
  help: 'End-to-end ingestion duration',
  labelNames: ['outcome'],
  buckets: PIPELINE_BUCKETS,
  registers: [registry],
});

export const pipelineFailures = new Counter({
  name: `${PREFIX}ingest_failures_total`,
  help: 'Ingestion failures by stage and retryability',
  labelNames: ['stage', 'retryable'],
  registers: [registry],
});

export const jobOutcomes = new Counter({
  name: `${PREFIX}job_outcomes_total`,
  help: 'Terminal and intermediate job outcomes',
  labelNames: ['outcome'],
  registers: [registry],
});

export const chunksIndexed = new Counter({
  name: `${PREFIX}chunks_indexed_total`,
  help: 'Chunks written with embeddings',
  registers: [registry],
});

/**
 * The series that makes the similarity floor tunable from real traffic
 * instead of a fixture corpus.
 */
export const retrievalScore = new Histogram({
  name: `${PREFIX}retrieval_score`,
  help: 'Best cosine similarity per question',
  labelNames: ['outcome'],
  buckets: [0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.65, 0.7, 0.75, 0.8, 0.9, 1],
  registers: [registry],
});

export const chatOutcomes = new Counter({
  name: `${PREFIX}chat_outcomes_total`,
  help: 'Questions answered versus refused for lack of relevant context',
  labelNames: ['outcome'],
  registers: [registry],
});

export const aiRequestDuration = new Histogram({
  name: `${PREFIX}ai_request_duration_seconds`,
  help: 'Upstream model call duration',
  labelNames: ['provider', 'operation'],
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60],
  registers: [registry],
});

export const aiErrors = new Counter({
  name: `${PREFIX}ai_errors_total`,
  help: 'Upstream model call failures',
  labelNames: ['provider', 'operation', 'retryable'],
  registers: [registry],
});

export const embeddedTexts = new Counter({
  name: `${PREFIX}embedded_texts_total`,
  help: 'Texts sent to the embedding model — a proxy for spend',
  registers: [registry],
});

/**
 * Queue depth is read at scrape time rather than pushed.
 *
 * A gauge updated on every enqueue would drift the moment a different process
 * consumed a job; asking Redis when Prometheus asks keeps it truthful.
 */
export const queueDepth = new Gauge({
  name: `${PREFIX}queue_depth`,
  help: 'Jobs waiting, by queue state',
  labelNames: ['state'],
  registers: [registry],
});

/**
 * Registers a callback invoked on every scrape.
 *
 * @param {() => Promise<void>} collect
 */
export function registerScrapeCollector(collect) {
  scrapeCollectors.add(collect);
}

const scrapeCollectors = new Set();

/** Renders the exposition format, running scrape-time collectors first. */
export async function collectMetrics() {
  await Promise.all(
    [...scrapeCollectors].map((collect) =>
      // A collector that throws must not blank the whole scrape.
      Promise.resolve()
        .then(collect)
        .catch(() => undefined),
    ),
  );

  return registry.metrics();
}

export const metricsContentType = registry.contentType;

/** Test helper. */
export function resetMetrics() {
  registry.resetMetrics();
  scrapeCollectors.clear();
}
