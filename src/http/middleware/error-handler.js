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

export function errorHandler() {
  // Express identifies error middleware by arity — all four params must stay.
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

    // A streaming response may have flushed headers already; the status can no
    // longer change, so end the stream and let the client's handler see it.
    if (res.headersSent) {
      res.end();
      return;
    }

    if (appError instanceof RateLimitError) {
      res.setHeader('Retry-After', String(appError.retryAfterSeconds));
    }

    const body = appError.toJSON();
    body.requestId = req.id ?? res.getHeader(REQUEST_ID_HEADER);

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

/** Framework and driver errors into the application taxonomy. */
function normalise(err) {
  if (err instanceof AppError) {
    return err;
  }

  if (err instanceof ZodError) {
    return ValidationError.fromZod(err);
  }

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
