import { Schema, model } from 'mongoose';
import { MessageRole } from '../../config/constants.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

/** Where an answer came from, so a claim can be traced back to a page. */
const citationSchema = new Schema(
  {
    chunkIndex: { type: Number, required: true, min: 0 },
    pageStart: { type: Number, min: 1 },
    pageEnd: { type: Number, min: 1 },
    score: { type: Number, min: 0, max: 1 },
    snippet: { type: String, maxlength: 500 },
  },
  { _id: false },
);

const messageSchema = new Schema(
  {
    role: { type: String, enum: Object.values(MessageRole), required: true },
    content: { type: String, required: true, maxlength: 16_000 },
    citations: { type: [citationSchema], default: undefined },
    /** Recorded when the threshold rejected everything, for tuning it later. */
    refused: { type: Boolean, default: undefined },
    bestScore: { type: Number },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false },
);

const conversationSchema = new Schema(
  {
    documentId: { type: Schema.Types.ObjectId, ref: 'Document', required: true },
    ownerId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    title: { type: String, trim: true, maxlength: 200 },
    // Embedded rather than a separate collection: a conversation is always
    // read whole, and the cap keeps it well inside the 16MB document limit.
    messages: { type: [messageSchema], default: [] },
  },
  baseSchemaOptions(),
);

conversationSchema.index({ ownerId: 1, documentId: 1, updatedAt: -1 });

export const MAX_MESSAGES = 200;

export const Conversation = model('Conversation', conversationSchema);
