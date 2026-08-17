import { DocumentStatus, JobStatus } from '../config/constants.js';
import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { deleteChunksForDocument } from '../modules/documents/chunk.repository.js';
import { markDocumentFailed } from '../modules/documents/document.repository.js';
import { findAbandonedJobs, requeueJob } from '../modules/jobs/job.repository.js';
import { requeueExistingJob } from './consumer.js';
import { setJobStatus } from './queue.js';

const log = createLogger('reaper');

/**
 * Recovers work left behind by a worker that died.
 *
 * An evicted pod leaves its job ACTIVE with a heartbeat that stops advancing.
 * Nothing else notices — the queue message is long gone, so without this the
 * document would sit in `processing` forever and the user would poll a job
 * that never finishes.
 *
 * Partial chunks are removed before requeueing, because the pipeline's unique
 * {documentId, index} index would reject the retry otherwise.
 */
export async function reapAbandonedJobs({
  visibilityTimeoutMs = env.QUEUE_VISIBILITY_TIMEOUT_MS,
  limit = 50,
} = {}) {
  const abandoned = await findAbandonedJobs(visibilityTimeoutMs, limit);

  if (abandoned.length === 0) {
    return { reaped: 0, requeued: 0, dead: 0 };
  }

  log.warn({ count: abandoned.length }, 'found abandoned jobs');

  let requeued = 0;
  let dead = 0;

  for (const job of abandoned) {
    const documentId = String(job.documentId);

    const removed = await deleteChunksForDocument(documentId).catch((error) => {
      log.error({ err: error, documentId }, 'failed to clear partial chunks');
      return 0;
    });

    if (job.attempts >= job.maxAttempts) {
      await markDocumentFailed(documentId, {
        message: `Abandoned after ${String(job.attempts)} attempts`,
      });
      await setJobStatus(job.id, { status: JobStatus.DEAD, error: 'abandoned' });
      dead += 1;
      log.error({ jobId: job.id, documentId, attempts: job.attempts }, 'abandoned job is dead');
      continue;
    }

    const restored = await requeueJob(job.id);
    if (!restored) {
      continue;
    }

    await requeueExistingJob(job.id);
    await setJobStatus(job.id, { status: JobStatus.QUEUED, progress: 0, stage: '' });
    requeued += 1;

    log.warn(
      { jobId: job.id, documentId, attempts: job.attempts, removedChunks: removed },
      'abandoned job requeued',
    );
  }

  return { reaped: abandoned.length, requeued, dead };
}

/**
 * Runs the reaper on an interval.
 *
 * Every worker runs one. They race harmlessly: `requeueJob` is a conditional
 * update, so only the first to reach a given job changes it.
 */
export function startReaper({ intervalMs = 60_000 } = {}) {
  const timer = setInterval(() => {
    reapAbandonedJobs().catch((error) => {
      log.error({ err: error }, 'reaper pass failed');
    });
  }, intervalMs);

  timer.unref();

  return () => {
    clearInterval(timer);
  };
}

/**
 * Fails documents stuck in `processing` with no live job behind them.
 *
 * A narrower safety net than the job reaper: it catches the case where the job
 * record itself was lost, which would otherwise leave a document that can
 * never be retried because `markDocumentProcessing` refuses to re-claim it.
 */
export async function failOrphanedDocuments(documents) {
  let failed = 0;

  for (const document of documents) {
    if (document.status !== DocumentStatus.PROCESSING) {
      continue;
    }

    await deleteChunksForDocument(document.id).catch(() => 0);
    await markDocumentFailed(document.id, { message: 'Processing was interrupted' });
    failed += 1;
  }

  if (failed > 0) {
    log.warn({ failed }, 'failed orphaned documents');
  }

  return failed;
}
