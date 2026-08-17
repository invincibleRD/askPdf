import { Router } from 'express';
import { authenticate } from '../../http/middleware/authenticate.js';
import { validate } from '../../http/middleware/validate.js';
import * as controller from './job.controller.js';
import { jobIdParams, listJobsQuery } from './job.schema.js';

export function jobRoutes() {
  const router = Router();

  router.use(authenticate());

  router.get('/', validate({ query: listJobsQuery }), controller.list);
  router.get('/:id', validate({ params: jobIdParams }), controller.getById);

  return router;
}
