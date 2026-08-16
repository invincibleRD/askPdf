import { Schema, model } from 'mongoose';
import { DocumentStatus, PIPELINE_STAGES } from '../../config/constants.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

/** Why a document failed, kept for the API and for debugging a retry. */
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
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    /** Name as uploaded. Display only — never used to build a storage path. */
    filename: {
      type: String,
      required: true,
      trim: true,
      maxlength: 255,
    },

    /**
     * Opaque key in the storage backend. Generated server-side so a crafted
     * filename cannot escape the storage prefix.
     */
    storageKey: {
      type: String,
      required: true,
      unique: true,
    },

    /**
     * SHA-256 of the file bytes. Lets a re-upload of the same PDF reuse the
     * existing embeddings instead of paying for them twice.
     */
    contentHash: {
      type: String,
      required: true,
      length: 64,
    },

    byteSize: { type: Number, required: true, min: 1 },
    pageCount: { type: Number, min: 0, default: 0 },
    chunkCount: { type: Number, min: 0, default: 0 },

    status: {
      type: String,
      enum: Object.values(DocumentStatus),
      default: DocumentStatus.PENDING,
      required: true,
    },

    /** Current pipeline stage while status is `processing`. */
    stage: { type: String, enum: PIPELINE_STAGES, default: null },

    failure: { type: failureSchema, default: null },

    /** Extracted title and metadata from the PDF, when present. */
    title: { type: String, trim: true, maxlength: 500 },

    processingStartedAt: { type: Date },
    processedAt: { type: Date },
    deletedAt: { type: Date, default: null },
  },
  baseSchemaOptions(),
);

/** The library listing: a user's documents, newest first. */
documentSchema.index({ ownerId: 1, createdAt: -1 });

/**
 * Deduplication is per owner, not global — two users uploading the same
 * public PDF each get their own document. Partial so soft-deleted rows do not
 * block a re-upload.
 */
documentSchema.index(
  { ownerId: 1, contentHash: 1 },
  {
    unique: true,
    partialFilterExpression: { deletedAt: null },
    name: 'owner_content_unique',
  },
);

/** Used by the stuck-document reaper, which scans by status and age. */
documentSchema.index({ status: 1, processingStartedAt: 1 });

/** True once the pipeline has finished and questions can be answered. */
documentSchema.virtual('isReady').get(function isReady() {
  return this.status === DocumentStatus.READY;
});

export const Document = model('Document', documentSchema);
