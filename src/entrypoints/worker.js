/**
 * Ingestion worker entrypoint.
 *
 * Runs the same image as the API but serves no HTTP traffic — it consumes the
 * ingestion queue. Splitting the two is what lets an upload return 202
 * immediately: the API only writes a job, and this process does the parsing
 * and embedding work that takes seconds to minutes.
 *
 * The queue consumer arrives with the pipeline milestone; for now the process
 * establishes the same lifecycle contract as the API so deployment topology
 * can be exercised end to end.
 */
import { env } from '../config/env.js';
import { closeResources } from '../core/lifecycle.js';
import { createLogger } from '../core/logger.js';
import { registerShutdownHandlers } from '../core/shutdown.js';
import { connectMongo } from '../infra/mongo/connection.js';

const log = createLogger('entrypoint:worker');

async function main() {
  log.info(
    { nodeEnv: env.NODE_ENV, concurrency: env.WORKER_CONCURRENCY, queue: env.QUEUE_NAME },
    'starting worker',
  );

  await connectMongo();

  registerShutdownHandlers({
    forceExitMs: env.SHUTDOWN_TIMEOUT_MS + 5_000,
    onShutdown: async () => {
      // The consumer stops claiming new jobs first, then the clients it needs
      // are closed. Registration order in the lifecycle registry enforces it.
      await closeResources();
    },
  });

  log.info('worker ready');

  // Keep the event loop alive until a signal arrives. The queue consumer will
  // take over this role once it is blocking on BRPOP.
  await new Promise(() => {});
}

main().catch((error) => {
  log.fatal({ err: error }, 'failed to start worker');
  process.exit(1);
});
