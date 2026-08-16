import { Schema, model } from 'mongoose';
import { DocumentStatus, PIPELINE_STAGES } from '../../config/constants.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

const failureSchema = new Schema(
  {
    stage: { type: String, enum: PIPELINE_STAGES },
    message: { type: String, maxlength: 2_000 },
    at: { type: Date, default: Date.now },
    attempts: { type: Number, default: 0 },
  },
  { _id: false },
);

const documentSchema = new Schema(
  {
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** As uploaded. Display only — never used to build a storage path. */
    filename: { type: String, required: true, trim: true, maxlength: 255 },

    /** Generated server-side, so a crafted filename can't escape the prefix. */
    storageKey: { type: String, required: true, unique: true },

    /** SHA-256 of the bytes, so a re-upload reuses existing embeddings. */
    contentHash: { type: String, required: true, length: 64 },

    byteSize: { type: Number, required: true, min: 1 },
    pageCount: { type: Number, min: 0, default: 0 },
    chunkCount: { type: Number, min: 0, default: 0 },

    status: {
      type: String,
      enum: Object.values(DocumentStatus),
      default: DocumentStatus.PENDING,
      required: true,
    },

    stage: { type: String, enum: PIPELINE_STAGES, default: null },
    failure: { type: failureSchema, default: null },

    title: { type: String, trim: true, maxlength: 500 },

    processingStartedAt: { type: Date },
    processedAt: { type: Date },
    deletedAt: { type: Date, default: null },
  },
  baseSchemaOptions(),
);

documentSchema.index({ ownerId: 1, createdAt: -1 });

/** Dedupe is per owner, and partial so a delete frees the hash for re-upload. */
documentSchema.index(
  { ownerId: 1, contentHash: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    name: 'owner_content_unique',
  },
);

documentSchema.index({ status: 1, processingStartedAt: 1 });

documentSchema.virtual('isReady').get(function isReady() {
  return this.status === DocumentStatus.READY;
});

export const Document = model('Document', documentSchema);
