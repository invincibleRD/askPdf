import { Router } from 'express';
import { authenticate } from '../../http/middleware/authenticate.js';
import { chatRateLimit } from '../../http/middleware/rate-limit.js';
import { validate } from '../../http/middleware/validate.js';
import * as controller from './chat.controller.js';
import { askSchema, conversationIdParams, listConversationsQuery } from './chat.schema.js';

export function chatRoutes() {
  const router = Router();

  router.use(authenticate());

  // Each question costs an embedding plus a generation, so it gets its own budget.
  const limiter = chatRateLimit();

  router.post('/', limiter, validate({ body: askSchema }), controller.ask);
  router.post('/stream', limiter, validate({ body: askSchema }), controller.askStream);

  router.get(
    '/conversations',
    validate({ query: listConversationsQuery }),
    controller.listConversations,
  );
  router.get(
    '/conversations/:id',
    validate({ params: conversationIdParams }),
    controller.getConversation,
  );

  return router;
}
