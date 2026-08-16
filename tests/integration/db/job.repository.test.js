import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../helpers/db.js';
import { createTestDocument, createTestUser } from '../../helpers/factories.js';
import {
  claimJob,
  completeJob,
  createJob,
  failJob,
  findAbandonedJobs,
  findJobForOwner,
  findLiveJobForDocument,
  heartbeatJob,
  listJobsForOwner,
  requeueJob,
  updateJobStage,
} from '../../../src/modules/jobs/job.repository.js';
import { Job } from '../../../src/modules/jobs/job.model.js';
import { JobStatus, PipelineStage } from '../../../src/config/constants.js';

useTestDatabase();

let owner;
let document;

beforeEach(async () => {
  owner = await createTestUser();
  document = await createTestDocument(owner.id);
});

/** @param {object} [overrides] */
const newJob = (overrides = {}) =>
  createJob({ documentId: document.id, ownerId: owner.id, maxAttempts: 3, ...overrides });

describe('createJob', () => {
  it('queues a job for a document', async () => {
    const { job, created } = await newJob();

    expect(created).toBe(true);
    expect(job).toMatchObject({ status: JobStatus.QUEUED, attempts: 0, progress: 0 });
  });

  it('carries the correlation id of the request that created it', async () => {
    const { job } = await newJob({ requestId: 'req-abc-123' });

    expect(job.requestId).toBe('req-abc-123');
  });

  it('is idempotent while a job is live', async () => {
    const first = await newJob();
    const second = await newJob();

    // A client retrying the upload must not spawn a second pipeline run.
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    await expect(Job.countDocuments({ documentId: document.id })).resolves.toBe(1);
  });

  it('allows a new job once the previous one finished', async () => {
    const first = await newJob();
    await claimJob(first.job.id, 'worker-1');
    await completeJob(first.job.id);

    const second = await newJob();

    expect(second.created).toBe(true);
    expect(second.job.id).not.toBe(first.job.id);
  });
});

describe('claimJob', () => {
  it('marks the job active and counts the attempt', async () => {
    const { job } = await newJob();

    const claimed = await claimJob(job.id, 'worker-1');

    expect(claimed).toMatchObject({ status: JobStatus.ACTIVE, attempts: 1, claimedBy: 'worker-1' });
    expect(claimed.startedAt).toBeInstanceOf(Date);
    expect(claimed.heartbeatAt).toBeInstanceOf(Date);
  });

  it('lets exactly one worker win a contested job', async () => {
    const { job } = await newJob();

    // Both workers saw the same queue message; only one may proceed.
    const results = await Promise.all([
      claimJob(job.id, 'worker-1'),
      claimJob(job.id, 'worker-2'),
      claimJob(job.id, 'worker-3'),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('refuses to claim a job that is not queued', async () => {
    const { job } = await newJob();
    await claimJob(job.id, 'worker-1');

    await expect(claimJob(job.id, 'worker-2')).resolves.toBeNull();
  });
});

describe('updateJobStage', () => {
  it('derives progress from the stage position', async () => {
    const { job } = await newJob();
    await claimJob(job.id, 'worker-1');

    const parse = await updateJobStage(job.id, PipelineStage.PARSE);
    const embed = await updateJobStage(job.id, PipelineStage.EMBED);
    const finalize = await updateJobStage(job.id, PipelineStage.FINALIZE);

    expect(parse.progress).toBe(20);
    expect(embed.progress).toBe(60);
    expect(finalize.progress).toBe(100);
  });

  it('refreshes the lease on every stage change', async () => {
    const { job } = await newJob();
    const claimed = await claimJob(job.id, 'worker-1');

    await new Promise((resolve) => setTimeout(resolve, 15));
    const updated = await updateJobStage(job.id, PipelineStage.CHUNK);

    expect(updated.heartbeatAt.getTime()).toBeGreaterThan(claimed.heartbeatAt.getTime());
  });
});

describe('heartbeatJob', () => {
  it('extends the lease of an active job', async () => {
    const { job } = await newJob();
    const claimed = await claimJob(job.id, 'worker-1');

    await new Promise((resolve) => setTimeout(resolve, 15));
    await heartbeatJob(job.id);

    const refreshed = await Job.findById(job.id).lean();
    expect(refreshed.heartbeatAt.getTime()).toBeGreaterThan(claimed.heartbeatAt.getTime());
  });

  it('ignores a job that is no longer active', async () => {
    const { job } = await newJob();

    await expect(heartbeatJob(job.id)).resolves.toBeUndefined();
    const stored = await Job.findById(job.id).lean();
    expect(stored.heartbeatAt).toBeNull();
  });
});

describe('completeJob', () => {
  it('finishes at full progress and releases the claim', async () => {
    const { job } = await newJob();
    await claimJob(job.id, 'worker-1');

    const completed = await completeJob(job.id);

    expect(completed).toMatchObject({
      status: JobStatus.COMPLETED,
      progress: 100,
      stage: null,
      claimedBy: null,
      error: null,
    });
    expect(completed.finishedAt).toBeInstanceOf(Date);
  });
});

describe('failJob', () => {
  it('stays retryable while attempts remain', async () => {
    const { job } = await newJob();
    await claimJob(job.id, 'worker-1');

    const failed = await failJob(job.id, {
      stage: PipelineStage.EMBED,
      message: 'gemini 429',
    });

    expect(failed.status).toBe(JobStatus.FAILED);
    expect(failed.error).toMatchObject({ stage: PipelineStage.EMBED, retryable: true });
  });

  it('goes dead once attempts are exhausted', async () => {
    const { job } = await newJob({ maxAttempts: 1 });
    await claimJob(job.id, 'worker-1');

    const failed = await failJob(job.id, { message: 'still failing' });

    expect(failed.status).toBe(JobStatus.DEAD);
  });

  it('goes dead immediately for a failure retrying cannot fix', async () => {
    const { job } = await newJob();
    await claimJob(job.id, 'worker-1');

    const failed = await failJob(job.id, {
      stage: PipelineStage.PARSE,
      message: 'pdf is password protected',
      retryable: false,
    });

    // Retrying an encrypted PDF three times just wastes worker capacity.
    expect(failed.status).toBe(JobStatus.DEAD);
  });

  it('truncates a runaway error message', async () => {
    const { job } = await newJob();
    await claimJob(job.id, 'worker-1');

    const failed = await failJob(job.id, { message: 'e'.repeat(9_000) });

    expect(failed.error.message).toHaveLength(2_000);
  });
});

describe('requeueJob', () => {
  it('returns a failed job to the queue with its state reset', async () => {
    const { job } = await newJob();
    await claimJob(job.id, 'worker-1');
    await updateJobStage(job.id, PipelineStage.CHUNK);
    await failJob(job.id, { message: 'transient' });

    const requeued = await requeueJob(job.id);

    expect(requeued).toMatchObject({
      status: JobStatus.QUEUED,
      stage: null,
      progress: 0,
      claimedBy: null,
      heartbeatAt: null,
    });
    // The attempt count survives, so retries remain bounded.
    expect(requeued.attempts).toBe(1);
  });

  it('will not resurrect a dead job', async () => {
    const { job } = await newJob({ maxAttempts: 1 });
    await claimJob(job.id, 'worker-1');
    await failJob(job.id, { message: 'fatal' });

    await expect(requeueJob(job.id)).resolves.toBeNull();
  });
});

describe('findAbandonedJobs', () => {
  it('finds active jobs whose worker stopped reporting', async () => {
    const abandoned = await newJob();
    await claimJob(abandoned.job.id, 'worker-that-died');

    const otherDocument = await createTestDocument(owner.id);
    const healthy = await createJob({
      documentId: otherDocument.id,
      ownerId: owner.id,
      maxAttempts: 3,
    });
    await claimJob(healthy.job.id, 'worker-alive');

    await Job.updateOne(
      { _id: abandoned.job.id },
      { $set: { heartbeatAt: new Date(Date.now() - 600_000) } },
    );

    const found = await findAbandonedJobs(300_000);

    expect(found.map((j) => j.id)).toEqual([abandoned.job.id]);
  });

  it('ignores queued jobs, which no worker holds', async () => {
    await newJob();

    await expect(findAbandonedJobs(0)).resolves.toEqual([]);
  });
});

describe('ownership', () => {
  it('does not return a job to another user', async () => {
    const other = await createTestUser();
    const { job } = await newJob();

    await expect(findJobForOwner(job.id, other.id)).resolves.toBeNull();
    await expect(findJobForOwner(job.id, owner.id)).resolves.toMatchObject({ id: job.id });
  });

  it('lists only that user jobs', async () => {
    const other = await createTestUser();
    const otherDocument = await createTestDocument(other.id);
    await newJob();
    await createJob({ documentId: otherDocument.id, ownerId: other.id, maxAttempts: 3 });

    const jobs = await listJobsForOwner(owner.id);

    expect(jobs).toHaveLength(1);
  });
});

describe('findLiveJobForDocument', () => {
  it('returns the queued job', async () => {
    const { job } = await newJob();

    await expect(findLiveJobForDocument(document.id)).resolves.toMatchObject({ id: job.id });
  });

  it('returns null once the job has finished', async () => {
    const { job } = await newJob();
    await claimJob(job.id, 'worker-1');
    await completeJob(job.id);

    await expect(findLiveJobForDocument(document.id)).resolves.toBeNull();
  });
});
