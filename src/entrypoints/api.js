import { env } from '../config/env.js';
import { closeResources } from '../core/lifecycle.js';
import { createLogger } from '../core/logger.js';
import { registerShutdownHandlers } from '../core/shutdown.js';
import { createApp } from '../http/app.js';
import { startHttpServer, stopHttpServer } from '../http/server.js';
import { connectMongo } from '../infra/mongo/connection.js';
import { getRedis } from '../infra/redis/connection.js';

const log = createLogger('entrypoint:api');

async function main() {
  log.info({ nodeEnv: env.NODE_ENV, version: process.version }, 'starting api');

  // Connect before binding the port: a pod that can't reach its dependencies
  // should crash-loop rather than serve 500s.
  await connectMongo();
  getRedis();

  const app = createApp();
  const server = await startHttpServer(app);

  registerShutdownHandlers({
    drainMs: env.SHUTDOWN_DRAIN_MS,
    forceExitMs: env.SHUTDOWN_TIMEOUT_MS + env.SHUTDOWN_DRAIN_MS + 5_000,
    onShutdown: async () => {
      await stopHttpServer(server);
      await closeResources();
    },
  });

  log.info('api ready');
}

main().catch((error) => {
  log.fatal({ err: error }, 'failed to start api');
  process.exit(1);
});
