import Redis from 'ioredis';
import { env } from '../../config/env.js';
import { registerResource } from '../../core/lifecycle.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('redis');

/** @type {import('ioredis').Redis | null} */
let sharedClient = null;

const clients = new Set();

/**
 * A connection parked in BRPOP can't serve other commands, so the queue
 * consumer gets its own client rather than sharing.
 *
 * @param {{ role?: string, blocking?: boolean }} [options]
 */
export function createRedisClient({ role = 'shared', blocking = false } = {}) {
  const client = new Redis(env.REDIS_URL, {
    connectionName: `${env.SERVICE_NAME}:${role}`,
    maxRetriesPerRequest: blocking ? null : 3,
    enableReadyCheck: true,
    retryStrategy(attempt) {
      const delay = Math.min(attempt * 200, 3_000);
      log.warn({ attempt, delay, role }, 'redis reconnecting');
      return delay;
    },
    reconnectOnError(error) {
      // A promoted replica reports READONLY; reconnecting picks up the new
      // topology instead of failing writes until someone restarts the pod.
      return error.message.includes('READONLY');
    },
  });

  client.on('error', (error) => {
    log.warn({ err: error, role }, 'redis client error');
  });

  client.on('ready', () => {
    log.info({ role }, 'redis ready');
  });

  clients.add(client);
  return client;
}

export function getRedis() {
  if (!sharedClient) {
    sharedClient = createRedisClient({ role: 'shared' });
    registerResource({ name: 'redis', check: pingRedis, close: closeRedis });
  }

  return sharedClient;
}

export async function pingRedis() {
  if (!sharedClient) {
    return false;
  }

  return (await sharedClient.ping()) === 'PONG';
}

export async function closeRedis() {
  const closing = [...clients].map(async (client) => {
    try {
      // A client blocked in BRPOP won't answer QUIT, so cap the wait.
      await Promise.race([
        client.quit(),
        new Promise((resolve) => {
          const timer = setTimeout(resolve, 2_000);
          timer.unref();
        }),
      ]);
    } catch {
      // Already closing or gone.
    } finally {
      client.disconnect();
    }
  });

  await Promise.all(closing);
  clients.clear();
  sharedClient = null;
}

// Applied explicitly rather than via ioredis keyPrefix, which doesn't reach
// keys named inside Lua scripts or passed to third-party stores.
export function redisKey(...parts) {
  return [env.REDIS_KEY_PREFIX, ...parts].join(':');
}
