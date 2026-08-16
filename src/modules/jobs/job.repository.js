import { Job } from './job.model.js';
import { JobStatus, PIPELINE_STAGES } from '../../config/constants.js';
import {
  isDuplicateKeyError,
  serialize,
  serializeMany,
  toObjectId,
} from '../../infra/mongo/schema-helpers.js';

/**
 * Job persistence.
 *
 * State transitions are written as conditional updates rather than
 * read-modify-write. With several workers competing for the same job, a
 * check-then-set would let two of them both believe they won.
 */

/**
 * Creates a job, or returns the live one if a document is already queued.
 *
 * The partial unique index makes this idempotent: a client that retries an
 * upload gets the original job back instead of a second one processing the
 * same document.
 *
 * @param {{ documentId: string, ownerId: string, maxAttempts: number, requestId?: string }} input
 */
export async function createJob(input) {
  try {
    const job = await Job.create({
      documentId: toObjectId(input.documentId),
      ownerId: toObjectId(input.ownerId),
      maxAttempts: input.maxAttempts,
      requestId: input.requestId,
      status: JobStatus.QUEUED,
    });
    return { job: serialize(job.toObject()), created: true };
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      const existing = await findLiveJobForDocument(input.documentId);
      if (existing) {
        return { job: existing, created: false };
      }
    }
    throw error;
  }
}

/**
 * @param {string} id
 */
export async function findJobById(id) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return null;
  }

  const job = await Job.findById(jobId).lean().exec();
  return serialize(job);
}

/**
 * Fetches a job a user is allowed to see.
 *
 * @param {string} id
 * @param {string} ownerId
 */
export async function findJobForOwner(id, ownerId) {
  const [jobId, owner] = [toObjectId(id), toObjectId(ownerId)];
  if (!jobId || !owner) {
    return null;
  }

  const job = await Job.findOne({ _id: jobId, ownerId: owner }).lean().exec();
  return serialize(job);
}

/**
 * @param {string} documentId
 */
export async function findLiveJobForDocument(documentId) {
  const id = toObjectId(documentId);
  if (!id) {
    return null;
  }

  const job = await Job.findOne({
    documentId: id,
    status: { $in: [JobStatus.QUEUED, JobStatus.ACTIVE] },
  })
    .lean()
    .exec();

  return serialize(job);
}

/**
 * Claims a job for a worker.
 *
 * Conditional on the job still being queued, so exactly one worker wins the
 * race even if the queue delivered the message twice.
 *
 * @param {string} id
 * @param {string} workerId
 * @returns {Promise<object | null>} The claimed job, or null if lost.
 */
export async function claimJob(id, workerId) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return null;
  }

  const now = new Date();
  const job = await Job.findOneAndUpdate(
    { _id: jobId, status: JobStatus.QUEUED },
    {
      $set: {
        status: JobStatus.ACTIVE,
        claimedBy: workerId,
        heartbeatAt: now,
        startedAt: now,
        progress: 0,
      },
      $inc: { attempts: 1 },
    },
    { new: true },
  )
    .lean()
    .exec();

  return serialize(job);
}

/**
 * Records stage progress and refreshes the lease.
 *
 * The heartbeat is what distinguishes "still working" from "the worker died",
 * so it is written on every stage transition rather than only at the end.
 *
 * @param {string} id
 * @param {string} stage
 */
export async function updateJobStage(id, stage) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return null;
  }

  const stageIndex = PIPELINE_STAGES.indexOf(stage);
  const progress =
    stageIndex < 0 ? 0 : Math.round(((stageIndex + 1) / PIPELINE_STAGES.length) * 100);

  const job = await Job.findOneAndUpdate(
    { _id: jobId },
    { $set: { stage, progress, heartbeatAt: new Date() } },
    { new: true },
  )
    .lean()
    .exec();

  return serialize(job);
}

/**
 * Refreshes the lease without changing the stage, for a long-running stage.
 *
 * @param {string} id
 */
export async function heartbeatJob(id) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return;
  }

  await Job.updateOne(
    { _id: jobId, status: JobStatus.ACTIVE },
    { $set: { heartbeatAt: new Date() } },
  ).exec();
}

/**
 * @param {string} id
 */
export async function completeJob(id) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return null;
  }

  const job = await Job.findOneAndUpdate(
    { _id: jobId },
    {
      $set: {
        status: JobStatus.COMPLETED,
        stage: null,
        progress: 100,
        finishedAt: new Date(),
        claimedBy: null,
        error: null,
      },
    },
    { new: true },
  )
    .lean()
    .exec();

  return serialize(job);
}

/**
 * Records a failure.
 *
 * A job that has exhausted its attempts, or failed for a reason retrying
 * cannot fix, goes to `dead` and stops consuming worker capacity.
 *
 * @param {string} id
 * @param {{ stage?: string, message: string, retryable?: boolean }} failure
 */
export async function failJob(id, { stage, message, retryable = true }) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return null;
  }

  const current = await Job.findById(jobId).lean().exec();
  if (!current) {
    return null;
  }

  const exhausted = current.attempts >= current.maxAttempts;
  const status = retryable && !exhausted ? JobStatus.FAILED : JobStatus.DEAD;

  const job = await Job.findOneAndUpdate(
    { _id: jobId },
    {
      $set: {
        status,
        error: { stage, message: message.slice(0, 2_000), retryable },
        finishedAt: new Date(),
        claimedBy: null,
      },
    },
    { new: true },
  )
    .lean()
    .exec();

  return serialize(job);
}

/**
 * Returns a failed job to the queue for another attempt.
 *
 * @param {string} id
 */
export async function requeueJob(id) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return null;
  }

  const job = await Job.findOneAndUpdate(
    { _id: jobId, status: { $in: [JobStatus.FAILED, JobStatus.ACTIVE] } },
    {
      $set: {
        status: JobStatus.QUEUED,
        stage: null,
        progress: 0,
        claimedBy: null,
        heartbeatAt: null,
      },
    },
    { new: true },
  )
    .lean()
    .exec();

  return serialize(job);
}

/**
 * Active jobs whose worker has stopped reporting.
 *
 * A pod evicted mid-job leaves its claim behind; the reaper finds them here
 * and requeues them, which is what makes at-least-once delivery hold even
 * when a worker dies without unwinding.
 *
 * @param {number} visibilityTimeoutMs
 * @param {number} [limit]
 */
export async function findAbandonedJobs(visibilityTimeoutMs, limit = 50) {
  const cutoff = new Date(Date.now() - visibilityTimeoutMs);

  const jobs = await Job.find({
    status: JobStatus.ACTIVE,
    heartbeatAt: { $lt: cutoff },
  })
    .limit(limit)
    .lean()
    .exec();

  return serializeMany(jobs);
}

/**
 * @param {string} ownerId
 * @param {{ limit?: number }} [options]
 */
export async function listJobsForOwner(ownerId, { limit = 20 } = {}) {
  const owner = toObjectId(ownerId);
  if (!owner) {
    return [];
  }

  const jobs = await Job.find({ ownerId: owner }).sort({ _id: -1 }).limit(limit).lean().exec();

  return serializeMany(jobs);
}
