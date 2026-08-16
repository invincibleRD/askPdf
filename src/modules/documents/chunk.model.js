import { Schema, model } from 'mongoose';
import { env } from '../../config/env.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

/**
 * A passage of a document and its embedding.
 *
 * This is the collection retrieval reads and the one that grows fastest — a
 * 200-page PDF produces on the order of a thousand rows — so its shape is
 * tuned for reading many at once rather than for convenience.
 */
const chunkSchema = new Schema(
  {
    documentId: {
      type: Schema.Types.ObjectId,
      ref: 'Document',
      required: true,
    },

    /**
     * Denormalised from the parent document.
     *
     * Retrieval filters by owner on every query; carrying the id here avoids
     * a join (or a second round trip) on the hottest path in the service.
     */
    ownerId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
    },

    /** Position within the document, 0-based. Defines citation order. */
    index: { type: Number, required: true, min: 0 },

    text: { type: String, required: true, maxlength: 32_000 },

    tokenCount: { type: Number, required: true, min: 1 },

    /** Page span this chunk came from, for citations. */
    pageStart: { type: Number, min: 1 },
    pageEnd: { type: Number, min: 1 },

    /**
     * The embedding vector.
     *
     * Stored as a plain array of doubles: that is the layout both Atlas
     * Vector Search and the in-process cosine scorer expect. Length is
     * enforced because a mismatched vector would silently produce garbage
     * similarity scores rather than an error.
     */
    embedding: {
      type: [Number],
      required: true,
      validate: {
        validator: (value) => value.length === env.EMBEDDING_DIMENSIONS,
        message: (props) =>
          `embedding must have ${String(env.EMBEDDING_DIMENSIONS)} dimensions, got ${String(props.value.length)}`,
      },
    },
  },
  {
    ...baseSchemaOptions(),
    // Chunks are written once and never modified, so an updatedAt column
    // would be dead weight on every row.
    timestamps: { createdAt: true, updatedAt: false },
  },
);

/**
 * Rebuilding a document's chunks must never leave duplicates behind, and
 * ordered reads for citation assembly use the same key.
 */
chunkSchema.index({ documentId: 1, index: 1 }, { unique: true });

/** The retrieval filter: one owner's chunks within one document. */
chunkSchema.index({ ownerId: 1, documentId: 1 });

/**
 * Atlas Vector Search indexes are defined in the cluster, not by Mongoose —
 * `npm run db:indexes` creates it when VECTOR_SEARCH_DRIVER=atlas. Recorded
 * here so the definition lives next to the field it indexes.
 *
 * {
 *   "fields": [
 *     { "type": "vector", "path": "embedding",
 *       "numDimensions": 768, "similarity": "cosine" },
 *     { "type": "filter", "path": "documentId" },
 *     { "type": "filter", "path": "ownerId" }
 *   ]
 * }
 */
export const CHUNK_VECTOR_INDEX = Object.freeze({
  name: env.VECTOR_INDEX_NAME,
  type: 'vectorSearch',
  definition: {
    fields: [
      {
        type: 'vector',
        path: 'embedding',
        numDimensions: env.EMBEDDING_DIMENSIONS,
        similarity: 'cosine',
      },
      { type: 'filter', path: 'documentId' },
      { type: 'filter', path: 'ownerId' },
    ],
  },
});

export const Chunk = model('Chunk', chunkSchema);
