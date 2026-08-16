import { Router } from 'express';
import { validate } from '../../http/middleware/validate.js';
import { authenticate } from '../../http/middleware/authenticate.js';
import { authRateLimit } from '../../http/middleware/rate-limit.js';
import * as controller from './auth.controller.js';
import {
  changePasswordSchema,
  loginSchema,
  logoutSchema,
  refreshSchema,
  registerSchema,
} from './auth.schema.js';

export function authRoutes() {
  const router = Router();
  // Refresh is throttled too — a refresh token is a credential.
  const limiter = authRateLimit();

  router.post('/register', limiter, validate({ body: registerSchema }), controller.register);
  router.post('/login', limiter, validate({ body: loginSchema }), controller.login);
  router.post('/refresh', limiter, validate({ body: refreshSchema }), controller.refresh);
  router.post('/logout', authenticate(), validate({ body: logoutSchema }), controller.logout);

  router.post(
    '/change-password',
    limiter,
    authenticate(),
    validate({ body: changePasswordSchema }),
    controller.changePassword,
  );

  router.get('/me', authenticate({ loadUser: true }), controller.me);

  return router;
}
