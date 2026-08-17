import { env } from '../config/env.js';
import { closeResources } from '../core/lifecycle.js';
import { createLogger } from '../core/logger.js';
import { registerShutdownHandlers } from '../core/shutdown.js';
import { connectMongo } from '../infra/mongo/connection.js';
import { getRedis } from '../infra/redis/connection.js';
import { getStorage } from '../infra/storage/index.js';

const log = createLogger('entrypoint:worker');

async function main() {
  log.info(
    { nodeEnv: env.NODE_ENV, concurrency: env.WORKER_CONCURRENCY, queue: env.QUEUE_NAME },
    'starting worker',
  );

  await connectMongo();
  getRedis();
  // Eager, so readiness reports storage from the first probe rather than
  // only after something happens to use it.
  getStorage();

  registerShutdownHandlers({
    forceExitMs: env.SHUTDOWN_TIMEOUT_MS + 5_000,
    onShutdown: async () => {
      await closeResources();
    },
  });

  log.info('worker ready');

  // The queue consumer takes over keeping the loop alive.
  await new Promise(() => {});
}

main().catch((error) => {
  log.fatal({ err: error }, 'failed to start worker');
  process.exit(1);
});
