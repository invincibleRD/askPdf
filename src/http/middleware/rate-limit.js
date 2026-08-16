import rateLimit, { ipKeyGenerator } from 'express-rate-limit';
import { RedisStore } from 'rate-limit-redis';
import { env, isTest } from '../../config/env.js';
import { RateLimitError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { getRedis, redisKey } from '../../infra/redis/connection.js';

const log = createLogger('rate-limit');

// Counters live in Redis so the limit is the same regardless of replica count.
function buildLimiter({ windowMs, max, name }) {
  return rateLimit({
    windowMs,
    limit: max,
    standardHeaders: 'draft-7',
    legacyHeaders: false,

    ...(isTest
      ? {}
      : {
          store: new RedisStore({
            sendCommand: (...args) => getRedis().call(...args),
            prefix: redisKey('ratelimit', name, ''),
          }),
        }),

    keyGenerator(req) {
      // ipKeyGenerator normalises IPv6 to a /64, otherwise a client can rotate
      // through its own prefix for free.
      return req.user?.id ? `user:${req.user.id}` : `ip:${ipKeyGenerator(req.ip)}`;
    },

    handler(req, _res, next) {
      log.warn(
        { limiter: name, userId: req.user?.id, ip: req.ip, path: req.path },
        'rate limit exceeded',
      );
      next(new RateLimitError(Math.ceil(windowMs / 1000)));
    },

    // Throttling readiness would pull the pod from rotation and make it worse.
    skip: (req) => req.path === '/healthz' || req.path === '/readyz',
  });
}

// The max override exists so tests can drive a limiter without waiting out a
// production-sized window.
export function globalRateLimit({ max = env.RATE_LIMIT_MAX } = {}) {
  return buildLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, max, name: 'global' });
}

export function authRateLimit({ max = env.RATE_LIMIT_AUTH_MAX } = {}) {
  return buildLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, max, name: 'auth' });
}

export function uploadRateLimit({ max = env.RATE_LIMIT_UPLOAD_MAX } = {}) {
  return buildLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, max, name: 'upload' });
}

export function chatRateLimit({ max = env.RATE_LIMIT_CHAT_MAX } = {}) {
  return buildLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, max, name: 'chat' });
}
