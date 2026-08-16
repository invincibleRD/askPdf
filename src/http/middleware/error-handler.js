import { ZodError } from 'zod';
import { ErrorCode, REQUEST_ID_HEADER } from '../../config/constants.js';
import { isProduction } from '../../config/env.js';
import {
  AppError,
  PayloadTooLargeError,
  RateLimitError,
  ValidationError,
  toAppError,
} from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';

const log = createLogger('http:error');

/**
 * Terminal error handler.
 *
 * Every failure in the HTTP layer funnels through here so that responses have
 * one shape:
 *
 *   { "error": { "code": "...", "message": "...", "details": {...} },
 *     "requestId": "..." }
 *
 * Expected failures keep their message. Unexpected ones are logged in full
 * and answered with a generic 500 — the caller learns nothing about the
 * internals, but the request id in the body ties their report to the log
 * line that has the stack.
 */
export function errorHandler() {
  // Express identifies error middleware by arity, so all four parameters must
  // stay in the signature even though `next` is unused after the headers
  // check.
  // eslint-disable-next-line no-unused-vars
  return function errorHandlerMiddleware(err, req, res, next) {
    const appError = normalise(err);

    const logPayload = {
      err: appError.isOperational ? undefined : (appError.cause ?? appError),
      code: appError.code,
      statusCode: appError.statusCode,
      method: req.method,
      path: req.originalUrl,
    };

    if (appError.statusCode >= 500) {
      log.error(logPayload, appError.message);
    } else {
      log.warn(logPayload, appError.message);
    }

    // A streaming response (SSE chat) may already have flushed headers. There
    // is no way to change the status at that point, so end the stream and let
    // the client's event handler surface the failure.
    if (res.headersSent) {
      res.end();
      return;
    }

    if (appError instanceof RateLimitError) {
      res.setHeader('Retry-After', String(appError.retryAfterSeconds));
    }

    const body = appError.toJSON();
    body.requestId = req.id ?? res.getHeader(REQUEST_ID_HEADER);

    // Outside production the stack is genuinely useful in a terminal and
    // there is no one to leak it to.
    if (!isProduction && !appError.isOperational) {
      const cause = appError.cause;
      body.error.debug = {
        message: cause instanceof Error ? cause.message : String(cause),
        stack: cause instanceof Error ? cause.stack?.split('\n').slice(0, 8) : undefined,
      };
    }

    res.status(appError.statusCode).json(body);
  };
}

/**
 * Translates framework and driver errors into the application taxonomy.
 *
 * Without this, a malformed JSON body would surface as an opaque 500 instead
 * of the 400 it is.
 *
 * @param {unknown} err
 * @returns {AppError}
 */
function normalise(err) {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof ZodError) {
    return ValidationError.fromZod(err);
  }

  // body-parser failures arrive as plain errors with a `type` discriminator.
  if (err && typeof err === 'object' && 'type' in err) {
    switch (err.type) {
      case 'entity.parse.failed':
        return new ValidationError('Request body is not valid JSON');
      case 'entity.too.large':
        return new PayloadTooLargeError(Number(err.limit) || 0);
      case 'encoding.unsupported':
        return new ValidationError('Unsupported content encoding');
      default:
        break;
    }
  }

  return toAppError(err);
}

/**
 * Catch-all for unmatched routes.
 *
 * Registered after every router so that a typo in a URL returns a structured
 * 404 in the same envelope as every other error, rather than Express's HTML
 * default page.
 */
export function notFoundHandler() {
  return function notFoundMiddleware(req, res) {
    res.status(404).json({
      error: {
        code: ErrorCode.NOT_FOUND,
        message: `Cannot ${req.method} ${req.path}`,
      },
      requestId: req.id,
    });
  };
}
