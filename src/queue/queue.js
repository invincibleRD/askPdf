import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { getRedis } from '../infra/redis/connection.js';
import {
  queueDepth as queueDepthGauge,
  registerScrapeCollector,
} from '../infra/metrics/registry.js';
import { queueKeys } from './keys.js';

const log = createLogger('queue');

/**
 * The ingestion queue.
 *
 * A Redis list holds what is ready to run and a sorted set holds retries that
 * are waiting out their backoff. Redis is only the delivery mechanism —
 * the Job document in MongoDB is the source of truth, which is what lets a
 * worker that dies mid-job be recovered by the reaper rather than losing the
 * work.
 */

/** @param {{ jobId: string, documentId: string, ownerId: string, requestId?: string }} job */
export async function enqueue(job) {
  const payload = JSON.stringify({ ...job, enqueuedAt: Date.now() });

  await getRedis().lpush(queueKeys.ready(), payload);
  log.info({ jobId: job.jobId, documentId: job.documentId }, 'job enqueued');
}

/**
 * Blocks until a job is available or the timeout expires.
 *
 * Returns null on timeout so the consumer loop can check whether it is
 * shutting down instead of parking forever on a connection.
 *
 * @param {import('ioredis').Redis} client A client dedicated to blocking reads.
 * @param {number} [timeoutSec]
 */
export async function dequeue(client, timeoutSec = env.QUEUE_BLOCK_TIMEOUT_SEC) {
  const result = await client.brpop(queueKeys.ready(), timeoutSec);

  if (!result) {
    return null;
  }

  const [, payload] = result;

  try {
    return JSON.parse(payload);
  } catch (error) {
    // A payload we cannot parse can never succeed; park it rather than
    // spinning on it forever.
    log.error({ err: error, payload }, 'discarding unparseable job payload');
    await getRedis().lpush(queueKeys.dead(), payload);
    return null;
  }
}

/** Returns an already-parsed payload to the front of the queue, unchanged. */
export async function requeuePayload(payload) {
  await getRedis().rpush(queueKeys.ready(), JSON.stringify(payload));
  log.warn({ jobId: payload.jobId }, 'job returned to the queue during shutdown');
}

/**
 * Schedules a retry.
 *
 * Exponential backoff with jitter — without the jitter, a batch of jobs that
 * failed together on a rate limit would all come back at the same instant and
 * trip it again.
 */
export async function scheduleRetry(job, attempt) {
  const base = env.QUEUE_BACKOFF_BASE_MS * 2 ** Math.max(0, attempt - 1);
  const delay = Math.min(base, 300_000);
  const jitter = Math.floor(Math.random() * (delay * 0.25));
  const readyAt = Date.now() + delay + jitter;

  await getRedis().zadd(queueKeys.delayed(), readyAt, JSON.stringify({ ...job, attempt }));

  log.info({ jobId: job.jobId, attempt, delayMs: delay + jitter }, 'retry scheduled');
  return readyAt;
}

/**
 * Moves due retries back onto the ready list.
 *
 * The Lua script makes the read and the removal atomic, so two workers running
 * this concurrently cannot promote the same job twice.
 */
const PROMOTE_SCRIPT = `
  local due = redis.call('ZRANGEBYSCORE', KEYS[1], '-inf', ARGV[1], 'LIMIT', 0, tonumber(ARGV[2]))
  if #due == 0 then return 0 end
  for i = 1, #due do
    redis.call('LPUSH', KEYS[2], due[i])
    redis.call('ZREM', KEYS[1], due[i])
  end
  return #due
`;

export async function promoteDueRetries({ limit = 50 } = {}) {
  const promoted = await getRedis().eval(
    PROMOTE_SCRIPT,
    2,
    queueKeys.delayed(),
    queueKeys.ready(),
    String(Date.now()),
    String(limit),
  );

  if (promoted > 0) {
    log.info({ promoted }, 'due retries returned to the queue');
  }

  return promoted;
}

/** Parks a job that can never succeed. Drained by an operator, not automatically. */
export async function sendToDeadLetter(job, reason) {
  await getRedis().lpush(
    queueKeys.dead(),
    JSON.stringify({ ...job, reason, deadAt: new Date().toISOString() }),
  );

  log.error({ jobId: job.jobId, documentId: job.documentId, reason }, 'job sent to dead letter');
}

/**
 * Mirrors job state into a hash for polling.
 *
 * A client checking progress every second would otherwise hit MongoDB on every
 * poll; this keeps that traffic off the primary. The TTL means a finished
 * job's status evicts itself.
 */
export async function setJobStatus(jobId, fields) {
  const key = queueKeys.status(jobId);
  const flat = Object.entries(fields)
    .filter(([, value]) => value !== undefined && value !== null)
    .flatMap(([field, value]) => [field, String(value)]);

  if (flat.length === 0) {
    return;
  }

  await getRedis()
    .multi()
    .hset(key, ...flat)
    .expire(key, env.JOB_STATUS_TTL_SEC)
    .exec();
}

/** @returns {Promise<Record<string, string> | null>} */
export async function getJobStatus(jobId) {
  const status = await getRedis().hgetall(queueKeys.status(jobId));
  return Object.keys(status).length > 0 ? status : null;
}

export async function queueDepth() {
  const redis = getRedis();
  const [ready, delayed, dead] = await Promise.all([
    redis.llen(queueKeys.ready()),
    redis.zcard(queueKeys.delayed()),
    redis.llen(queueKeys.dead()),
  ]);

  return { ready, delayed, dead };
}

/** Test helper: clears every queue key. */
export async function drainQueue() {
  const redis = getRedis();
  await redis.del(queueKeys.ready(), queueKeys.delayed(), queueKeys.dead());
}

// Read when Prometheus asks rather than pushed on every enqueue: a gauge
// updated locally drifts the moment another process consumes a job.
registerScrapeCollector(async () => {
  const { ready, delayed, dead } = await queueDepth();

  queueDepthGauge.set({ state: 'ready' }, ready);
  queueDepthGauge.set({ state: 'delayed' }, delayed);
  queueDepthGauge.set({ state: 'dead' }, dead);
});
