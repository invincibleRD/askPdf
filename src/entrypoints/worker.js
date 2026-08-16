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

const log = createLogger('entrypoint:worker');

async function main() {
  log.info(
    { nodeEnv: env.NODE_ENV, concurrency: env.WORKER_CONCURRENCY, queue: env.QUEUE_NAME },
    'starting worker',
  );

  /** @type {{ stop: () => Promise<void> } | null} */
  let consumer = null;

  registerShutdownHandlers({
    forceExitMs: env.SHUTDOWN_TIMEOUT_MS + 5_000,
    onShutdown: async () => {
      // Stop claiming new jobs first, then let the in-flight one finish
      // before the clients it needs are closed.
      await consumer?.stop();
      await closeResources();
    },
  });

  await Promise.resolve();
  log.info('worker ready');

  // Keep the event loop alive until a signal arrives. The queue consumer will
  // take over this role once it is blocking on BRPOP.
  await new Promise(() => {});
}

main().catch((error) => {
  log.fatal({ err: error }, 'failed to start worker');
  process.exit(1);
});
