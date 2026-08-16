import pino from 'pino';
import { env, isProduction } from '../config/env.js';
import { getContext } from './request-context.js';

/**
 * Structured logging.
 *
 * One pino instance for the whole process. Two behaviours are worth knowing:
 *
 *   - Every record is stamped with the ambient correlation id, so log lines
 *     from an HTTP request and from the worker that later processes its job
 *     share a `requestId` and can be grepped as one trace.
 *   - Secrets are redacted at the serializer level rather than at call sites,
 *     because the call site that leaks a token is always the one nobody
 *     remembered to check.
 */

/** Paths scrubbed from every record before it is written. */
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
 * Pretty output is a developer convenience only. In production the transport
 * is omitted entirely so records go to stdout as newline-delimited JSON for
 * the log collector to pick up.
 */
const transport =
  env.LOG_PRETTY && !isProduction
    ? {
        target: 'pino-pretty',
        options: {
          colorize: true,
          translateTime: 'SYS:HH:MM:ss.l',
          ignore: 'pid,hostname,service',
          singleLine: false,
        },
      }
    : undefined;

export const logger = pino({
  level: env.LOG_LEVEL,
  base: {
    service: env.SERVICE_NAME,
    env: env.NODE_ENV,
  },
  redact: { paths: REDACTED_PATHS, censor: '[redacted]' },
  // Emit `level: "info"` rather than `level: 30`; most log backends group on
  // the string and it costs nothing to be readable.
  formatters: {
    level: (label) => ({ level: label }),
  },
  timestamp: pino.stdTimeFunctions.isoTime,
  // Pull the correlation id out of AsyncLocalStorage on every record so call
  // sites never have to pass it.
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

/**
 * A child logger tagged with the component that owns it.
 *
 * Prefer this over importing `logger` directly: it makes filtering by
 * subsystem possible (`component="worker"`) without a naming convention in
 * the message text.
 *
 * @param {string} component
 * @param {Record<string, unknown>} [bindings]
 */
export function createLogger(component, bindings = {}) {
  return logger.child({ component, ...bindings });
}
