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

export function globalRateLimit() {
  return buildLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_MAX,
    name: 'global',
  });
}

// Tighter: each attempt costs a bcrypt verification, so an unthrottled login
// is both a brute-force target and a cheap DoS.
export function authRateLimit() {
  return buildLimiter({ windowMs: env.RATE_LIMIT_WINDOW_MS, max: 10, name: 'auth' });
}

export function uploadRateLimit() {
  return buildLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_UPLOAD_MAX,
    name: 'upload',
  });
}

export function chatRateLimit() {
  return buildLimiter({
    windowMs: env.RATE_LIMIT_WINDOW_MS,
    max: env.RATE_LIMIT_CHAT_MAX,
    name: 'chat',
  });
}
