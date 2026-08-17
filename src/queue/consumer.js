import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import { JobStatus } from '../config/constants.js';
import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { runWithContext } from '../core/request-context.js';
import { createRedisClient } from '../infra/redis/connection.js';
import {
  claimJob,
  completeJob,
  failJob,
  findJobById,
  heartbeatJob,
  requeueJob,
  updateJobStage,
} from '../modules/jobs/job.repository.js';
import { findDocumentForOwner } from '../modules/documents/document.repository.js';
import { runPipeline } from '../pipeline/pipeline.js';
import { jobOutcomes } from '../infra/metrics/registry.js';
import {
  dequeue,
  enqueue,
  requeuePayload,
  promoteDueRetries,
  scheduleRetry,
  sendToDeadLetter,
  setJobStatus,
} from './queue.js';

const log = createLogger('worker');

/**
 * The queue consumer.
 *
 * Runs `concurrency` independent loops, each blocking on BRPOP against its own
 * Redis connection — a connection parked in a blocking read cannot serve
 * anything else, so they cannot be shared.
 *
 * @param {{ concurrency?: number, blockTimeoutSec?: number }} [options]
 */
export function createConsumer({
  concurrency = env.WORKER_CONCURRENCY,
  blockTimeoutSec = env.QUEUE_BLOCK_TIMEOUT_SEC,
} = {}) {
  const workerId = `${env.SERVICE_NAME}-${randomUUID().slice(0, 8)}`;
  const controller = new AbortController();
  const clients = [];

  let running = false;
  let loops = [];
  let scheduler = null;
  let inFlight = 0;

  async function processOne(payload) {
    const { jobId, documentId, ownerId, requestId } = payload;

    // Re-establishing the upload's correlation id here is what lets one id
    // span the API request and the worker that processes it minutes later.
    return runWithContext({ requestId, jobId, userId: ownerId }, async () => {
      const claimed = await claimJob(jobId, workerId);

      if (!claimed) {
        log.warn({ jobId }, 'job was already claimed, skipping');
        return;
      }

      await setJobStatus(jobId, {
        status: JobStatus.ACTIVE,
        progress: 0,
        attempts: claimed.attempts,
      });

      const document = await findDocumentForOwner(documentId, ownerId);
      if (!document) {
        // Deleted between enqueue and pickup; nothing to do and nothing to retry.
        log.warn({ jobId, documentId }, 'document no longer exists, discarding job');
        await failJob(jobId, { message: 'Document no longer exists', retryable: false });
        await setJobStatus(jobId, { status: JobStatus.DEAD, error: 'Document no longer exists' });
        return;
      }

      const heartbeat = startHeartbeat(jobId);

      try {
        await runPipeline(
          { documentId, ownerId, storageKey: document.storageKey },
          {
            signal: controller.signal,
            onStage: async (stage) => {
              const updated = await updateJobStage(jobId, stage);
              await setJobStatus(jobId, { stage, progress: updated?.progress ?? 0 });
            },
          },
        );

        await completeJob(jobId);
        jobOutcomes.inc({ outcome: 'completed' });
        await setJobStatus(jobId, { status: JobStatus.COMPLETED, progress: 100, stage: '' });
        log.info({ jobId, documentId }, 'job completed');
      } catch (error) {
        await handleFailure({ jobId, documentId, ownerId, requestId }, error, claimed.attempts);
      } finally {
        clearInterval(heartbeat);
      }
    });
  }

  async function handleFailure(payload, error, attempts) {
    const { jobId } = payload;
    // A malformed PDF cannot improve on retry; a rate limit can.
    const retryable = error?.retryable !== false;

    const job = await failJob(jobId, {
      stage: error?.stage,
      message: error?.message ?? 'Unknown failure',
      retryable,
    });

    if (job?.status === JobStatus.DEAD) {
      jobOutcomes.inc({ outcome: 'dead' });
      await sendToDeadLetter(payload, error?.message ?? 'unknown');
      await setJobStatus(jobId, { status: JobStatus.DEAD, error: error?.message ?? 'unknown' });
      log.error({ jobId, err: error, attempts }, 'job failed permanently');
      return;
    }

    // Back to QUEUED before the delayed entry becomes due: claimJob only
    // claims queued jobs, so leaving it FAILED would make the retry a no-op.
    jobOutcomes.inc({ outcome: 'retried' });
    await requeueJob(jobId);
    await scheduleRetry(payload, attempts);
    await setJobStatus(jobId, { status: JobStatus.QUEUED, error: error?.message ?? 'unknown' });
    log.warn({ jobId, err: error, attempts }, 'job failed, retry scheduled');
  }

  /**
   * Refreshes the job lease while a long stage runs, so the reaper does not
   * mistake a working process for a dead one.
   */
  function startHeartbeat(jobId) {
    const interval = Math.max(5_000, Math.floor(env.QUEUE_VISIBILITY_TIMEOUT_MS / 4));

    const timer = setInterval(() => {
      heartbeatJob(jobId).catch((error) => {
        log.warn({ err: error, jobId }, 'heartbeat failed');
      });
    }, interval);

    timer.unref();
    return timer;
  }

  async function loop(index) {
    const client = createRedisClient({ role: `consumer-${String(index)}`, blocking: true });
    clients.push(client);

    while (running) {
      try {
        const payload = await dequeue(client, blockTimeoutSec);

        if (!payload) {
          continue;
        }

        // BRPOP removed the message, so a job popped after shutdown began would
        // be lost: nothing left in Redis, and still QUEUED in Mongo, which the
        // abandoned-job reaper does not look at. Put it back and stop.
        if (!running) {
          await requeuePayload(payload);
          break;
        }

        inFlight += 1;
        try {
          await processOne(payload);
        } finally {
          inFlight -= 1;
        }
      } catch (error) {
        if (!running) {
          break;
        }
        // A loop that dies takes a share of throughput with it, so it must
        // survive anything the job or the connection throws.
        log.error({ err: error, loop: index }, 'consumer loop error, continuing');
        await sleep(1_000);
      }
    }

    log.info({ loop: index }, 'consumer loop stopped');
  }

  /** Moves due retries back onto the ready list. One timer, not one per loop. */
  function startScheduler() {
    return setInterval(() => {
      promoteDueRetries().catch((error) => {
        log.warn({ err: error }, 'retry promotion failed');
      });
    }, 1_000).unref();
  }

  return {
    workerId,

    start() {
      if (running) {
        return;
      }

      running = true;
      scheduler = startScheduler();
      loops = Array.from({ length: concurrency }, (_unused, index) => loop(index));

      log.info({ workerId, concurrency }, 'consumer started');
    },

    /**
     * Stops claiming new work and waits for what is in flight.
     *
     * The abort signal reaches the pipeline between stages, so a long job
     * unwinds at a checkpoint instead of being cut mid-write.
     */
    async stop({ timeoutMs = env.SHUTDOWN_TIMEOUT_MS } = {}) {
      if (!running) {
        return;
      }

      log.info({ workerId, inFlight }, 'consumer stopping');
      running = false;
      controller.abort();

      if (scheduler) {
        clearInterval(scheduler);
      }

      await Promise.race([
        Promise.allSettled(loops),
        sleep(timeoutMs).then(() => {
          log.warn({ inFlight }, 'consumer stop timed out');
        }),
      ]);

      // Blocking clients will not answer QUIT, so drop them outright.
      for (const client of clients) {
        client.disconnect();
      }

      log.info({ workerId }, 'consumer stopped');
    },

    get inFlight() {
      return inFlight;
    },
  };
}

/** Re-queues a job that already exists, used by the reaper and by retries. */
export async function requeueExistingJob(jobId) {
  const job = await findJobById(jobId);

  if (!job) {
    return false;
  }

  await enqueue({
    jobId: job.id,
    documentId: String(job.documentId),
    ownerId: String(job.ownerId),
    requestId: job.requestId,
  });

  return true;
}
