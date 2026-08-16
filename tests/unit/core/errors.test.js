import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  ConflictError,
  DocumentNotReadyError,
  ForbiddenError,
  NoRelevantContextError,
  NotFoundError,
  PayloadTooLargeError,
  RateLimitError,
  ServiceUnavailableError,
  UnauthorizedError,
  UpstreamError,
  ValidationError,
  isOperationalError,
  toAppError,
} from '../../../src/core/errors.js';
import { ErrorCode } from '../../../src/config/constants.js';

describe('AppError', () => {
  it('carries status, code and operational flag', () => {
    const error = new AppError({ message: 'boom', statusCode: 418, code: 'TEAPOT' });

    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(418);
    expect(error.code).toBe('TEAPOT');
    expect(error.isOperational).toBe(true);
    expect(error.name).toBe('AppError');
  });

  it('names itself after the concrete subclass', () => {
    expect(new NotFoundError('Document').name).toBe('NotFoundError');
  });

  it('serialises without leaking the cause or the stack', () => {
    const cause = new Error('connection reset by peer');
    const error = new AppError({
      message: 'safe message',
      statusCode: 500,
      code: 'X',
      cause,
    });

    const body = JSON.parse(JSON.stringify(error));

    expect(body).toEqual({ error: { code: 'X', message: 'safe message' } });
    expect(error.cause).toBe(cause);
  });

  it('includes details when supplied', () => {
    const error = new AppError({
      message: 'nope',
      statusCode: 400,
      code: 'X',
      details: { field: 'title' },
    });

    expect(error.toJSON().error.details).toEqual({ field: 'title' });
  });
});

describe('ValidationError.fromZod', () => {
  it('flattens zod issues into a field map', () => {
    const schema = z.object({
      email: z.string().email(),
      password: z.string().min(8),
    });
    const result = schema.safeParse({ email: 'nope', password: 'x' });

    const error = ValidationError.fromZod(result.error);

    expect(error.statusCode).toBe(400);
    expect(error.code).toBe(ErrorCode.VALIDATION_FAILED);
    expect(Object.keys(error.details.fields)).toEqual(['email', 'password']);
    expect(error.details.fields.password[0]).toMatch(/8/);
  });

  it('groups multiple issues on the same field', () => {
    const schema = z.object({ tags: z.array(z.string().min(2)) });
    const result = schema.safeParse({ tags: ['a', 'b'] });

    const error = ValidationError.fromZod(result.error);

    expect(Object.keys(error.details.fields)).toHaveLength(2);
  });
});

describe('error taxonomy', () => {
  it.each([
    [new ValidationError(), 400, ErrorCode.VALIDATION_FAILED],
    [new UnauthorizedError(), 401, ErrorCode.UNAUTHORIZED],
    [new ForbiddenError(), 403, ErrorCode.FORBIDDEN],
    [new NotFoundError(), 404, ErrorCode.NOT_FOUND],
    [new ConflictError(), 409, ErrorCode.CONFLICT],
    [new PayloadTooLargeError(1024), 413, ErrorCode.PAYLOAD_TOO_LARGE],
    [new RateLimitError(30), 429, ErrorCode.RATE_LIMITED],
    [new DocumentNotReadyError('processing'), 409, ErrorCode.DOCUMENT_NOT_READY],
    [new NoRelevantContextError(0.7), 422, ErrorCode.NO_RELEVANT_CONTEXT],
    [new UpstreamError('gemini'), 502, ErrorCode.UPSTREAM_FAILURE],
    [new ServiceUnavailableError(), 503, ErrorCode.SERVICE_UNAVAILABLE],
  ])('%s maps to the right status and code', (error, status, code) => {
    expect(error.statusCode).toBe(status);
    expect(error.code).toBe(code);
    expect(isOperationalError(error)).toBe(true);
  });

  it('echoes the upload limit so clients need not hard-code it', () => {
    expect(new PayloadTooLargeError(20_971_520).details).toEqual({ limitBytes: 20_971_520 });
  });

  it('reports the retrieval threshold and best observed score', () => {
    expect(new NoRelevantContextError(0.7, 0.42).details).toEqual({
      threshold: 0.7,
      bestScore: 0.42,
    });
  });

  it('omits the best score when none was observed', () => {
    expect(new NoRelevantContextError(0.7).details).toEqual({ threshold: 0.7 });
  });
});

describe('toAppError', () => {
  it('passes an AppError through untouched', () => {
    const original = new NotFoundError('Document');

    expect(toAppError(original)).toBe(original);
  });

  it('collapses an unknown error into a non-operational 500', () => {
    const cause = new Error('undefined is not a function');

    const error = toAppError(cause);

    expect(error.statusCode).toBe(500);
    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(error.isOperational).toBe(false);
    expect(error.cause).toBe(cause);
  });

  it('does not leak the original message to the caller', () => {
    const error = toAppError(new Error('mongodb://user:pw@host is unreachable'));

    expect(error.toJSON().error.message).toBe('An unexpected error occurred');
  });

  it('handles non-Error throwables', () => {
    expect(toAppError('a string').statusCode).toBe(500);
    expect(isOperationalError(toAppError(null))).toBe(false);
  });
});
