import cors from 'cors';
import helmet from 'helmet';
import { env, isProduction } from '../../config/env.js';
import { ForbiddenError } from '../../core/errors.js';

export function securityHeaders() {
  return helmet({
    // JSON API — nothing here should ever render as a document.
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        frameAncestors: ["'none'"],
        baseUri: ["'none'"],
        formAction: ["'none'"],
      },
    },
    noSniff: true,
    referrerPolicy: { policy: 'no-referrer' },
    crossOriginResourcePolicy: { policy: 'same-site' },
    // Setting HSTS in dev would pin localhost to https for six months.
    hsts: isProduction ? { maxAge: 15_552_000, includeSubDomains: true } : false,
  });
}

export function corsPolicy() {
  const allowed = env.CORS_ORIGINS.split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const allowAny = allowed.includes('*');

  return cors({
    origin(origin, callback) {
      // No Origin header means same-origin, curl, or server-to-server.
      if (!origin || allowAny || allowed.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(new ForbiddenError('Origin not allowed', { origin }));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit', 'RateLimit-Policy'],
    maxAge: 86_400,
  });
}
