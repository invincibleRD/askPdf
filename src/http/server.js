import { createServer } from 'node:http';
import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('http:server');

/**
 * Binds the application to a port.
 *
 * @param {import('express').Express} app
 * @param {{ port?: number, host?: string }} [options]
 * @returns {Promise<import('node:http').Server>}
 */
export function startHttpServer(app, { port = env.PORT, host = env.HOST } = {}) {
  const server = createServer(app);

  // Keep-alive must outlive the load balancer's idle timeout, otherwise the
  // balancer can reuse a socket at the instant Node closes it and the client
  // sees a spurious 502. Headers timeout must exceed keep-alive.
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;
  server.requestTimeout = env.REQUEST_TIMEOUT_MS + 5_000;

  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener('listening', onListening);
      reject(error);
    };

    const onListening = () => {
      server.removeListener('error', onError);
      const address = server.address();
      log.info(
        { host, port: typeof address === 'object' && address ? address.port : port },
        'http server listening',
      );
      resolve(server);
    };

    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, host);
  });
}

/**
 * Stops accepting connections and waits for in-flight requests.
 *
 * `server.close()` alone can hang indefinitely on keep-alive sockets, so idle
 * connections are closed immediately and the rest are given a deadline before
 * being cut. Without this a rolling deploy stalls until SIGKILL.
 *
 * @param {import('node:http').Server} server
 * @param {number} timeoutMs
 * @returns {Promise<void>}
 */
export function stopHttpServer(server, timeoutMs = env.SHUTDOWN_TIMEOUT_MS) {
  if (!server.listening) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve();
      }
    };

    const timer = setTimeout(() => {
      log.warn({ timeoutMs }, 'shutdown deadline reached, closing remaining connections');
      server.closeAllConnections();
      finish();
    }, timeoutMs);
    timer.unref();

    server.close(() => {
      log.info('http server closed');
      finish();
    });

    // Sockets sitting idle in a keep-alive pool have no request to drain.
    server.closeIdleConnections();
  });
}
