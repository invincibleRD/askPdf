import { Schema, model } from 'mongoose';
import { JobStatus, PIPELINE_STAGES } from '../../config/constants.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

// Redis holds the queue and a short-lived status hash for polling; this is the
// durable record that survives a Redis flush and keeps the audit trail.
const jobSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    status: {
      type: String,
      enum: Object.values(JobStatus),
      default: JobStatus.QUEUED,
      required: true,
    },

    stage: { type: String, enum: PIPELINE_STAGES, default: null },
    progress: { type: Number, min: 0, max: 100, default: 0 },

    attempts: { type: Number, min: 0, default: 0 },
    maxAttempts: { type: Number, min: 1, required: true },

    /** Correlation id of the request that created the job, so one id spans both processes. */
    requestId: { type: String, maxlength: 128 },

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

/** One live job per document — makes enqueue idempotent. */
jobSchema.index(
  { documentId: 1 },
  {
    unique: true,
    partialFilterExpression: { status: { $in: [JobStatus.QUEUED, JobStatus.ACTIVE] } },
    name: 'one_live_job_per_document',
  },
);

jobSchema.index({ status: 1, heartbeatAt: 1 });
jobSchema.index({ ownerId: 1, createdAt: -1 });

jobSchema.virtual('durationMs').get(function durationMs() {
  if (!this.startedAt || !this.finishedAt) {
    return null;
  }
  return this.finishedAt.getTime() - this.startedAt.getTime();
});

export const Job = model('Job', jobSchema);
