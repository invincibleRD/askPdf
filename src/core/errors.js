import { ErrorCode } from '../config/constants.js';

/**
 * `isOperational` separates expected failures (safe to show the caller) from
 * bugs (logged, answered with a generic 500).
 */
export class AppError extends Error {
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
  constructor(message = 'Request validation failed', details) {
    super({ message, statusCode: 400, code: ErrorCode.VALIDATION_FAILED, details });
  }

  /** Flattens zod issues into a `{ field: [messages] }` map. */
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

export class DocumentNotReadyError extends AppError {
  constructor(status) {
    super({
      message: `Document is not ready for questions (status: ${status})`,
      statusCode: 409,
      code: ErrorCode.DOCUMENT_NOT_READY,
      details: { status },
    });
  }
}

/** Nothing cleared the similarity floor, so we decline instead of guessing. */
export class NoRelevantContextError extends AppError {
  constructor(threshold, bestScore) {
    super({
      message: 'No passage in this document is relevant enough to answer the question',
      statusCode: 422,
      code: ErrorCode.NO_RELEVANT_CONTEXT,
      details: { threshold, ...(bestScore === undefined ? {} : { bestScore }) },
    });
  }
}

/** A dependency we don't control failed (Gemini, S3). */
export class UpstreamError extends AppError {
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
  constructor(message = 'Service temporarily unavailable', cause) {
    super({ message, statusCode: 503, code: ErrorCode.SERVICE_UNAVAILABLE, cause });
  }
}

export class RequestTimeoutError extends AppError {
  constructor(timeoutMs) {
    super({
      message: 'Request timed out',
      statusCode: 408,
      code: ErrorCode.REQUEST_TIMEOUT,
      details: { timeoutMs },
    });
  }
}

export function isOperationalError(error) {
  return error instanceof AppError && error.isOperational;
}

/** Unknown failures collapse to a generic 500; the real cause stays on .cause. */
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
