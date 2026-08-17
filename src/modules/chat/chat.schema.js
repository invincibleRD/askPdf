import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Must be a valid id');

export const askSchema = z
  .object({
    documentId: objectId,
    question: z.string().trim().min(1, 'Question is required').max(2_000),
    conversationId: objectId.optional(),
  })
  .strict();

export const conversationIdParams = z.object({ id: objectId }).strict();

export const listConversationsQuery = z
  .object({
    documentId: objectId.optional(),
    limit: z.coerce.number().int().min(1).max(100).default(20),
  })
  .strict();
