import { isOperationalError } from './errors.js';
import { createLogger } from './logger.js';
import { setDraining } from './lifecycle.js';

const log = createLogger('shutdown');

/**
 * @param {object} params
 * @param {(reason: string) => Promise<void>} params.onShutdown
 * @param {number} [params.drainMs] Pause between failing readiness and closing
 *   connections, so the load balancer stops routing first.
 * @param {number} [params.forceExitMs]
 */
export function registerShutdownHandlers({ onShutdown, drainMs = 0, forceExitMs = 30_000 }) {
  let shuttingDown = false;

  const shutdown = async (reason, exitCode) => {
    if (shuttingDown) {
      log.warn({ reason }, 'shutdown already in progress, ignoring signal');
      return;
    }
    shuttingDown = true;

    log.info({ reason }, 'shutting down');
    setDraining(true);

    const forceExit = setTimeout(() => {
      log.fatal({ reason }, 'graceful shutdown timed out, forcing exit');
      process.exit(1);
    }, forceExitMs);
    forceExit.unref();

    try {
      if (drainMs > 0) {
        await sleep(drainMs);
      }
      await onShutdown(reason);
      log.info({ reason }, 'shutdown complete');
      clearTimeout(forceExit);
      process.exit(exitCode);
    } catch (error) {
      log.error({ err: error, reason }, 'error during shutdown');
      clearTimeout(forceExit);
      process.exit(1);
    }
  };

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      void shutdown(signal, 0);
    });
  }

  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  process.on('unhandledRejection', (reason) => {
    // An unawaited 404 is a bug worth logging, not worth cycling the pod for.
    if (isOperationalError(reason)) {
      log.error({ err: reason }, 'unhandled rejection of an operational error');
      return;
    }
    log.fatal({ err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });

  return { shutdown };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
