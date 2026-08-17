import { z } from 'zod';
import { DocumentStatus } from '../../config/constants.js';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Must be a valid id');

export const documentIdParams = z.object({ id: objectId }).strict();

export const listDocumentsQuery = z
  .object({
    limit: z.coerce.number().int().min(1).max(100).default(20),
    cursor: objectId.optional(),
    status: z.enum(Object.values(DocumentStatus)).optional(),
  })
  .strict();
