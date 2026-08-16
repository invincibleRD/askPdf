import { ErrorCode } from '../config/constants.js';

/**
 * Application error taxonomy.
 *
 * Two kinds of failure reach the error handler:
 *
 *   - *Expected* failures — a document that does not exist, a payload that is
 *     too large, a rate limit. These are `AppError`s: they carry a status, a
 *     stable machine-readable code and a message safe to show a caller.
 *   - *Unexpected* failures — a null dereference, a driver crash. These are
 *     plain `Error`s and are never echoed to the caller; the handler logs
 *     them and returns a generic 500.
 *
 * The `isOperational` flag is what separates the two, and it is also what the
 * process-level handlers use to decide whether to keep running or exit.
 */
export class AppError extends Error {
  /**
   * @param {object} params
   * @param {string} params.message   Safe to return to the caller.
   * @param {number} params.statusCode
   * @param {string} params.code      Stable identifier clients branch on.
   * @param {object} [params.details] Structured context (e.g. field errors).
   * @param {unknown} [params.cause]  Underlying error, kept for logs only.
   * @param {boolean} [params.isOperational]
   */
  constructor({ message, statusCode, code, details, cause, isOperational = true }) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = new.target.name;
    this.statusCode = statusCode;
    this.code = code;
    this.isOperational = isOperational;
    if (details !== undefined) {
      this.details = details;
    }
    Error.captureStackTrace?.(this, new.target);
  }

  /** Response body shape. Never includes the cause or the stack. */
  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export class ValidationError extends AppError {
  /**
   * @param {string} message
   * @param {object} [details] Field-level issues, typically from zod.
   */
  constructor(message = 'Request validation failed', details) {
    super({ message, statusCode: 400, code: ErrorCode.VALIDATION_FAILED, details });
  }

  /**
   * Builds a ValidationError from a zod error, flattening issues into a
   * `{ field: [messages] }` map that a form can render directly.
   *
   * @param {import('zod').ZodError} zodError
   * @param {string} [message]
   */
  static fromZod(zodError, message = 'Request validation failed') {
    const fields = {};

    for (const issue of zodError.issues) {
      const key = issue.path.join('.') || '_';
      (fields[key] ??= []).push(issue.message);
    }

    return new ValidationError(message, { fields });
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Authentication required', details) {
    super({ message, statusCode: 401, code: ErrorCode.UNAUTHORIZED, details });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'You do not have access to this resource', details) {
    super({ message, statusCode: 403, code: ErrorCode.FORBIDDEN, details });
  }
}

export class NotFoundError extends AppError {
  /**
   * @param {string} [resource] Resource name, e.g. "Document".
   * @param {object} [details]
   */
  constructor(resource = 'Resource', details) {
    super({
      message: `${resource} not found`,
      statusCode: 404,
      code: ErrorCode.NOT_FOUND,
      details,
    });
  }
}

export class ConflictError extends AppError {
  constructor(message = 'Resource already exists', details) {
    super({ message, statusCode: 409, code: ErrorCode.CONFLICT, details });
  }
}

export class PayloadTooLargeError extends AppError {
  /**
   * @param {number} limitBytes The advertised maximum, echoed to the caller so
   *   a client can report it without hard-coding the value.
   */
  constructor(limitBytes) {
    super({
      message: `Upload exceeds the maximum size of ${String(limitBytes)} bytes`,
      statusCode: 413,
      code: ErrorCode.PAYLOAD_TOO_LARGE,
      details: { limitBytes },
    });
  }
}

export class UnsupportedMediaTypeError extends AppError {
  constructor(message = 'Unsupported media type', details) {
    super({ message, statusCode: 415, code: ErrorCode.UNSUPPORTED_MEDIA_TYPE, details });
  }
}

export class RateLimitError extends AppError {
  /**
   * @param {number} retryAfterSeconds Mirrored into the Retry-After header.
   */
  constructor(retryAfterSeconds) {
    super({
      message: 'Too many requests, please retry later',
      statusCode: 429,
      code: ErrorCode.RATE_LIMITED,
      details: { retryAfterSeconds },
    });
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

/**
 * The document exists but its ingestion pipeline has not finished, so there
 * is nothing to answer questions against yet.
 */
export class DocumentNotReadyError extends AppError {
  /**
   * @param {string} status Current document status.
   */
  constructor(status) {
    super({
      message: `Document is not ready for questions (status: ${status})`,
      statusCode: 409,
      code: ErrorCode.DOCUMENT_NOT_READY,
      details: { status },
    });
  }
}

/**
 * Retrieval found nothing above the similarity floor.
 *
 * This is the hallucination guard surfacing as an error rather than an
 * ungrounded answer: with no context that clears the threshold, the service
 * declines instead of letting the model improvise.
 */
export class NoRelevantContextError extends AppError {
  /**
   * @param {number} threshold  The configured minimum score.
   * @param {number} [bestScore] Best score actually observed, for debugging.
   */
  constructor(threshold, bestScore) {
    super({
      message: 'No passage in this document is relevant enough to answer the question',
      statusCode: 422,
      code: ErrorCode.NO_RELEVANT_CONTEXT,
      details: { threshold, ...(bestScore === undefined ? {} : { bestScore }) },
    });
  }
}

/** A dependency we do not control failed (Gemini, S3, …). */
export class UpstreamError extends AppError {
  /**
   * @param {string} service
   * @param {string} [message]
   * @param {unknown} [cause]
   */
  constructor(service, message = 'Upstream service call failed', cause) {
    super({
      message,
      statusCode: 502,
      code: ErrorCode.UPSTREAM_FAILURE,
      details: { service },
      cause,
    });
    this.service = service;
  }
}

/** A dependency we do control is unreachable (Mongo, Redis). */
export class ServiceUnavailableError extends AppError {
  /**
   * @param {string} [message]
   * @param {unknown} [cause]
   */
  constructor(message = 'Service temporarily unavailable', cause) {
    super({ message, statusCode: 503, code: ErrorCode.SERVICE_UNAVAILABLE, cause });
  }
}

export class RequestTimeoutError extends AppError {
  /**
   * @param {number} timeoutMs
   */
  constructor(timeoutMs) {
    super({
      message: 'Request timed out',
      statusCode: 408,
      code: ErrorCode.REQUEST_TIMEOUT,
      details: { timeoutMs },
    });
  }
}

/**
 * Narrows an unknown thrown value to an operational AppError.
 *
 * @param {unknown} error
 * @returns {boolean}
 */
export function isOperationalError(error) {
  return error instanceof AppError && error.isOperational;
}

/**
 * Normalises anything thrown into an AppError.
 *
 * Unknown failures collapse to a generic 500 whose message is deliberately
 * uninformative — the real cause is preserved on `.cause` for the logger, not
 * for the caller.
 *
 * @param {unknown} error
 * @returns {AppError}
 */
export function toAppError(error) {
  if (error instanceof AppError) {
    return error;
  }

  return new AppError({
    message: 'An unexpected error occurred',
    statusCode: 500,
    code: ErrorCode.INTERNAL_ERROR,
    isOperational: false,
    cause: error,
  });
}
