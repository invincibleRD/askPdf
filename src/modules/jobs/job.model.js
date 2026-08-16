import { Schema, model } from 'mongoose';
import { JobStatus, PIPELINE_STAGES } from '../../config/constants.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

/**
 * Durable record of an ingestion job.
 *
 * Redis holds the queue and a short-lived status hash for cheap polling; this
 * collection is the source of truth that survives a Redis flush and gives the
 * job an audit trail — how many attempts, which stage failed, how long it
 * took.
 */
const jobSchema = new Schema(
  {
    documentId: {
      type: Schema.Types.ObjectId,
      ref: 'Document',
      required: true,
    },

    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    status: {
      type: String,
      enum: Object.values(JobStatus),
      default: JobStatus.QUEUED,
      required: true,
    },

    stage: { type: String, enum: PIPELINE_STAGES, default: null },

    /** 0–100, derived from the stage index so clients can render a bar. */
    progress: { type: Number, min: 0, max: 100, default: 0 },

    attempts: { type: Number, min: 0, default: 0 },
    maxAttempts: { type: Number, min: 1, required: true },

    /**
     * Correlation id of the HTTP request that created this job.
     *
     * This is what lets one id follow an upload from the API log line through
     * to the worker that embeds it, minutes later and in another process.
     */
    requestId: { type: String, maxlength: 128 },

    /** Identifies which worker holds the job, for the abandoned-job reaper. */
    claimedBy: { type: String, maxlength: 128, default: null },
    heartbeatAt: { type: Date, default: null },

    error: {
      type: new Schema(
        {
          stage: { type: String, enum: PIPELINE_STAGES },
          message: { type: String, maxlength: 2_000 },
          retryable: { type: Boolean, default: true },
        },
        { _id: false },
      ),
      default: null,
    },

    startedAt: { type: Date },
    finishedAt: { type: Date },
  },
  baseSchemaOptions(),
);

/** One job at a time per document — enqueue is idempotent while it is live. */
jobSchema.index(
  { documentId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: [JobStatus.QUEUED, JobStatus.ACTIVE] } },
    name: 'one_live_job_per_document',
  },
);

/** The reaper scans active jobs whose heartbeat has gone stale. */
jobSchema.index({ status: 1, heartbeatAt: 1 });

/** Job history for a user, newest first. */
jobSchema.index({ ownerId: 1, createdAt: -1 });

/** Wall-clock duration once finished, for the metrics endpoint. */
jobSchema.virtual('durationMs').get(function durationMs() {
  if (!this.startedAt || !this.finishedAt) {
    return null;
  }
  return this.finishedAt.getTime() - this.startedAt.getTime();
});

export const Job = model('Job', jobSchema);
