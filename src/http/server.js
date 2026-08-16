import { createServer } from 'node:http';
import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('http:server');

export function startHttpServer(app, { port = env.PORT, host = env.HOST } = {}) {
  const server = createServer(app);

  // Keep-alive must outlive the load balancer's idle timeout, or the balancer
  // reuses a socket just as Node closes it and the client sees a 502.
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
 * server.close() alone hangs on keep-alive sockets, so idle ones are dropped
 * immediately and the rest get a deadline.
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

    server.closeIdleConnections();
  });
}
