import { env } from '../config/env.js';
import { closeResources } from '../core/lifecycle.js';
import { createLogger } from '../core/logger.js';
import { registerShutdownHandlers } from '../core/shutdown.js';
import { connectMongo } from '../infra/mongo/connection.js';
import { getRedis } from '../infra/redis/connection.js';
import { getStorage } from '../infra/storage/index.js';
import { getAiProvider } from '../infra/ai/index.js';
import { createConsumer } from '../queue/consumer.js';
import { startReaper } from '../queue/reaper.js';

const log = createLogger('entrypoint:worker');

async function main() {
  log.info(
    { nodeEnv: env.NODE_ENV, concurrency: env.WORKER_CONCURRENCY, queue: env.QUEUE_NAME },
    'starting worker',
  );

  await connectMongo();
  getRedis();
  getStorage();
  getAiProvider();

  const consumer = createConsumer();
  const stopReaper = startReaper();

  registerShutdownHandlers({
    forceExitMs: env.SHUTDOWN_TIMEOUT_MS + 5_000,
    onShutdown: async () => {
      // Stop claiming work and let the in-flight job reach a checkpoint before
      // the clients it depends on are closed.
      stopReaper();
      await consumer.stop();
      await closeResources();
    },
  });

  consumer.start();
  log.info({ workerId: consumer.workerId }, 'worker ready');
}

main().catch((error) => {
  log.fatal({ err: error }, 'failed to start worker');
  process.exit(1);
});
