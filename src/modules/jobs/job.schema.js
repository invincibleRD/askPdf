import { z } from 'zod';

const objectId = z.string().regex(/^[0-9a-f]{24}$/i, 'Must be a valid id');

export const jobIdParams = z.object({ id: objectId }).strict();

export const listJobsQuery = z
  .object({ limit: z.coerce.number().int().min(1).max(100).default(20) })
  .strict();
