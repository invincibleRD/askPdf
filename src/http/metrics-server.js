import express from 'express';
import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { collectMetrics, metricsContentType } from '../infra/metrics/registry.js';
import { getLiveness, getReadiness } from '../modules/health/health.service.js';

const log = createLogger('worker:metrics');

/**
 * A minimal HTTP surface for the worker.
 *
 * The worker serves no API traffic, but without this its pipeline timings and
 * queue depth are invisible to Prometheus, and Kubernetes has no probe to
 * decide whether the pod is alive. Deliberately separate from the API app: no
 * auth, no rate limiting, nothing that could be reached from outside.
 *
 * @param {{ port?: number }} [options]
 */
export function startMetricsServer({ port = env.WORKER_METRICS_PORT } = {}) {
  const app = express();

  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.status(200).json(getLiveness());
  });

  app.get('/readyz', async (_req, res) => {
    const { ready, body } = await getReadiness();
    res.status(ready ? 200 : 503).json(body);
  });

  if (env.METRICS_ENABLED) {
    app.get(env.METRICS_PATH, async (_req, res) => {
      res.setHeader('Content-Type', metricsContentType);
      res.status(200).send(await collectMetrics());
    });
  }

  return new Promise((resolve, reject) => {
    const server = app.listen(port, env.HOST, () => {
      log.info({ port }, 'worker metrics server listening');
      resolve(server);
    });

    server.once('error', reject);
  });
}

/** @param {import('node:http').Server} server */
export function stopMetricsServer(server) {
  return new Promise((resolve) => {
    server.close(() => {
      resolve();
    });
    server.closeIdleConnections();
  });
}
