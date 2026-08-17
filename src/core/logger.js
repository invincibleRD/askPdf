import pino from 'pino';
import { env, isProduction } from '../config/env.js';
import { getContext } from './request-context.js';

// Redacted centrally rather than at call sites — the call site that leaks a
// token is always the one nobody remembered to check.
const REDACTED_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["x-api-key"]',
  'res.headers["set-cookie"]',
  'password',
  'passwordHash',
  '*.password',
  '*.passwordHash',
  'refreshToken',
  '*.refreshToken',
  'accessToken',
  '*.accessToken',
  'apiKey',
  '*.apiKey',
  'GEMINI_API_KEY',
  'JWT_ACCESS_SECRET',
  'JWT_REFRESH_SECRET',
  'S3_SECRET_ACCESS_KEY',
];

/**
 * pino-pretty is a devDependency, so it is absent from the runtime image built
 * with --omit=dev. Resolving it first means LOG_PRETTY=true degrades to JSON
 * instead of crashing the process at boot — a logging preference must never be
 * able to take the service down.
 */
function resolvePrettyTransport() {
  if (!env.LOG_PRETTY || isProduction) {
    return undefined;
  }

  try {
    import.meta.resolve('pino-pretty');
  } catch {
    process.stderr.write('LOG_PRETTY is set but pino-pretty is not installed; using JSON logs\n');
    return undefined;
  }

  return {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:HH:MM:ss.l',
      ignore: 'pid,hostname,service',
    },
  };
}

const transport = resolvePrettyTransport();

export const logger = pino({
  level: env.LOG_LEVEL,
  base: { service: env.SERVICE_NAME, env: env.NODE_ENV },
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  mixin() {
    const { requestId, userId, jobId } = getContext();
    return {
      ...(requestId === undefined ? {} : { requestId }),
      ...(userId === undefined ? {} : { userId }),
      ...(jobId === undefined ? {} : { jobId }),
    };
  },
  serializers: {
    err: pino.stdSerializers.err,
    error: pino.stdSerializers.err,
  },
  ...(transport === undefined ? {} : { transport }),
});

export function createLogger(component, bindings = {}) {
  return logger.child({ component, ...bindings });
}
