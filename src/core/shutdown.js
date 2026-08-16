import { isOperationalError } from './errors.js';
import { createLogger } from './logger.js';
import { setDraining } from './lifecycle.js';

const log = createLogger('shutdown');

/**
 * Process-level lifecycle handling.
 *
 * Installs the signal and crash handlers every long-running Node process
 * needs, and guarantees the shutdown routine runs exactly once no matter how
 * many signals arrive.
 *
 * @param {object} params
 * @param {(reason: string) => Promise<void>} params.onShutdown Release resources.
 * @param {number} [params.drainMs] Pause between failing readiness and closing
 *   connections, giving the load balancer time to stop routing new work.
 * @param {number} [params.forceExitMs] Hard deadline before `process.exit`.
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

    // Readiness fails first so traffic stops arriving while we are still able
    // to serve what is already in flight.
    setDraining(true);

    // A watchdog in case a close handler hangs; the orchestrator would send
    // SIGKILL eventually, but exiting on our own terms keeps the logs honest.
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

  // An uncaught exception leaves the process in an unknown state. The only
  // safe response is to log it and restart; the orchestrator will replace us.
  process.on('uncaughtException', (error) => {
    log.fatal({ err: error }, 'uncaught exception');
    void shutdown('uncaughtException', 1);
  });

  // A rejected promise from an expected failure (a 404 that nobody awaited)
  // is a bug worth logging but not worth cycling the pod for. Anything else
  // is treated like an uncaught exception.
  process.on('unhandledRejection', (reason) => {
    if (isOperationalError(reason)) {
      log.error({ err: reason }, 'unhandled rejection of an operational error');
      return;
    }
    log.fatal({ err: reason }, 'unhandled rejection');
    void shutdown('unhandledRejection', 1);
  });

  return { shutdown };
}

/** @param {number} ms */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
