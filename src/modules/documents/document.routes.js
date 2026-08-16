import { Router } from 'express';
import { authenticate } from '../../http/middleware/authenticate.js';
import { uploadRateLimit } from '../../http/middleware/rate-limit.js';
import { uploadSingle } from '../../http/middleware/upload.js';
import { validate } from '../../http/middleware/validate.js';
import * as controller from './document.controller.js';
import { documentIdParams, listDocumentsQuery } from './document.schema.js';

export function documentRoutes() {
  const router = Router();

  router.use(authenticate());

  router.post('/', uploadRateLimit(), uploadSingle({ field: 'file' }), controller.upload);
  router.get('/', validate({ query: listDocumentsQuery }), controller.list);
  router.get('/:id', validate({ params: documentIdParams }), controller.getById);
  router.get('/:id/download', validate({ params: documentIdParams }), controller.downloadUrl);
  router.delete('/:id', validate({ params: documentIdParams }), controller.remove);

  return router;
}
