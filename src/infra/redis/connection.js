import Redis from 'ioredis';
import { env } from '../../config/env.js';
import { registerResource } from '../../core/lifecycle.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('redis');

/**
 * Redis connection management.
 *
 * The service needs two kinds of client and the distinction matters:
 *
 *   - a *shared* client for ordinary commands (rate limit counters, job
 *     status hashes), reused everywhere so one process holds one connection;
 *   - *dedicated* clients for blocking reads. A connection parked in `BRPOP`
 *     cannot serve any other command until it returns, so the queue consumer
 *     must never share one.
 */

/** @type {import('ioredis').Redis | null} */
let sharedClient = null;

/** Every client this process opened, so shutdown can close them all. */
const clients = new Set();

/**
 * Builds a client.
 *
 * @param {{ role?: string, blocking?: boolean }} [options]
 * @returns {import('ioredis').Redis}
 */
export function createRedisClient({ role = 'shared', blocking = false } = {}) {
  const client = new Redis(env.REDIS_URL, {
    // Identifies the connection in `CLIENT LIST`, which is how you find the
    // consumer that is wedged at three in the morning.
    connectionName: `${env.SERVICE_NAME}:${role}`,
    // A blocking command legitimately takes longer than any request timeout,
    // so per-request retry limits have to be disabled on those connections.
    maxRetriesPerRequest: blocking ? null : 3,
    enableReadyCheck: true,
    retryStrategy(attempt) {
      // Back off to a 3s ceiling and keep trying: Redis coming back should
      // heal the process without an operator restarting it.
      const delay = Math.min(attempt * 200, 3_000);
      log.warn({ attempt, delay, role }, 'redis reconnecting');
      return delay;
    },
    reconnectOnError(error) {
      // A replica promoted to primary reports READONLY; reconnecting picks up
      // the new topology instead of failing every write until a restart.
      return error.message.includes('READONLY');
    },
  });

  client.on('error', (error) => {
    // ioredis emits on every failed reconnect; log at warn so a blip does not
    // read as an outage.
    log.warn({ err: error, role }, 'redis client error');
  });

  client.on('ready', () => {
    log.info({ role }, 'redis ready');
  });

  clients.add(client);
  return client;
}

/**
 * The process-wide client for ordinary commands.
 *
 * Created on first use and registered with the lifecycle registry so
 * readiness reflects it and shutdown closes it.
 *
 * @returns {import('ioredis').Redis}
 */
export function getRedis() {
  if (!sharedClient) {
    sharedClient = createRedisClient({ role: 'shared' });

    registerResource({
      name: 'redis',
      check: pingRedis,
      close: closeRedis,
    });
  }

  return sharedClient;
}

/**
 * Readiness probe for Redis.
 *
 * @returns {Promise<boolean>}
 */
export async function pingRedis() {
  if (!sharedClient) {
    return false;
  }

  const reply = await sharedClient.ping();
  return reply === 'PONG';
}

/**
 * Closes every client this process opened.
 *
 * `quit` waits for pending replies; a client blocked in `BRPOP` will not
 * answer it, so those are disconnected outright after a short grace period.
 */
export async function closeRedis() {
  const closing = [...clients].map(async (client) => {
    try {
      await Promise.race([
        client.quit(),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref();
        }),
      ]);
    } catch {
      // Already closing or already gone — nothing left to do.
    } finally {
      client.disconnect();
    }
  });

  await Promise.all(closing);
  clients.clear();
  sharedClient = null;
}

/**
 * Namespaces a key.
 *
 * Applied explicitly rather than through ioredis's `keyPrefix` option,
 * because that option does not reach keys named inside Lua scripts or passed
 * to a third-party store — a mismatch that is invisible until two features
 * disagree about where a key lives.
 *
 * @param {...string} parts
 * @returns {string}
 */
export function redisKey(...parts) {
  return [env.REDIS_KEY_PREFIX, ...parts].join(':');
}
