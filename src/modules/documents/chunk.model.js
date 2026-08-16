import { Schema, model } from 'mongoose';
import { env } from '../../config/env.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

const chunkSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },

    // Denormalised from the document: retrieval filters by owner on every
    // query, and this avoids a join on the hottest path.
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },

    /** Position in the document, 0-based. Defines citation order. */
    index: { type: Number, required: true, min: 0 },

    text: { type: String, required: true, maxlength: 32_000 },
    tokenCount: { type: Number, required: true, min: 1 },

    pageStart: { type: Number, min: 1 },
    pageEnd: { type: Number, min: 1 },

    // Plain array of doubles — the layout both Atlas Vector Search and the
    // in-process scorer expect. A wrong length would produce garbage scores
    // rather than an error, so it's validated.
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
    // Chunks are written once, so updatedAt would be dead weight on every row.
    timestamps: { createdAt: true, updatedAt: false },
  },
);

chunkSchema.index({ documentId: 1, index: 1 }, { unique: true });
chunkSchema.index({ ownerId: 1, documentId: 1 });

/** Atlas search indexes aren't modelled by Mongoose; created by npm run db:indexes. */
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
