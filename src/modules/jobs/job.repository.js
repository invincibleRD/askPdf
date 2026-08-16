import { Job } from './job.model.js';
import { JobStatus, PIPELINE_STAGES } from '../../config/constants.js';
import {
  isDuplicateKeyError,
  serialize,
  serializeMany,
  toObjectId,
} from '../../infra/mongo/schema-helpers.js';

// Transitions are conditional updates, not read-modify-write: with several
// workers competing, check-then-set lets two of them both believe they won.

/** Idempotent — the partial unique index means a retried upload reuses the job. */
export async function createJob(input) {
  try {
    const job = await Job.create({
      documentId: toObjectId(input.documentId),
      ownerId: toObjectId(input.ownerId),
      maxAttempts: input.maxAttempts,
      requestId: input.requestId,
      status: JobStatus.QUEUED,
    });
    return { job: job.toJSON(), created: true };
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

export async function findJobById(id) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return null;
  }

  return serialize(await Job.findById(jobId).lean().exec());
}

export async function findJobForOwner(id, ownerId) {
  const [jobId, owner] = [toObjectId(id), toObjectId(ownerId)];
  if (!jobId || !owner) {
    return null;
  }

  return serialize(await Job.findOne({ _id: jobId, ownerId: owner }).lean().exec());
}

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

/** Exactly one worker wins, even if the queue delivered the message twice. */
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

/** Refreshes the lease during a long stage, so the reaper doesn't requeue it. */
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

/** Out of attempts, or a failure retrying can't fix, goes straight to dead. */
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

export async function requeueJob(id) {
  const jobId = toObjectId(id);
  if (!jobId) {
    return null;
  }

  const job = await Job.findOneAndUpdate(
    { _id: jobId, status: { $in: [JobStatus.FAILED, JobStatus.ACTIVE] } },
    {
      // attempts is not reset, so retries stay bounded.
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

/** Claims left behind by an evicted pod — what makes at-least-once hold. */
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

export async function listJobsForOwner(ownerId, { limit = 20 } = {}) {
  const owner = toObjectId(ownerId);
  if (!owner) {
    return [];
  }

  const jobs = await Job.find({ ownerId: owner }).sort({ _id: -1 }).limit(limit).lean().exec();
  return serializeMany(jobs);
}
