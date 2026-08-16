import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import {
  AppError,
  NoRelevantContextError,
  NotFoundError,
  PayloadTooLargeError,
  ValidationError,
  isOperationalError,
  toAppError,
} from '../../../src/core/errors.js';
import { ErrorCode } from '../../../src/config/constants.js';

describe('AppError', () => {
  it('names itself after the concrete subclass', () => {
    expect(new NotFoundError('Document').name).toBe('NotFoundError');
  });

  it('serialises without the cause or the stack', () => {
    const cause = new Error('connection reset by peer');
    const error = new AppError({ message: 'safe message', statusCode: 500, code: 'X', cause });

    expect(JSON.parse(JSON.stringify(error))).toEqual({
      error: { code: 'X', message: 'safe message' },
    });
    expect(error.cause).toBe(cause);
  });
});

describe('ValidationError.fromZod', () => {
  it('flattens issues into a field map', () => {
    const result = z
      .object({ email: z.string().email(), password: z.string().min(8) })
      .safeParse({ email: 'nope', password: 'x' });

    const error = ValidationError.fromZod(result.error);

    expect(error.statusCode).toBe(400);
    expect(Object.keys(error.details.fields)).toEqual(['email', 'password']);
  });
});

describe('error details', () => {
  it('echoes the upload limit so clients need not hard-code it', () => {
    expect(new PayloadTooLargeError(20_971_520).details).toEqual({ limitBytes: 20_971_520 });
  });

  it('reports the retrieval threshold, with the best score when observed', () => {
    expect(new NoRelevantContextError(0.7, 0.42).details).toEqual({
      threshold: 0.7,
      bestScore: 0.42,
    });
    expect(new NoRelevantContextError(0.7).details).toEqual({ threshold: 0.7 });
  });
});

describe('toAppError', () => {
  it('passes an AppError through untouched', () => {
    const original = new NotFoundError('Document');

    expect(toAppError(original)).toBe(original);
  });

  it('collapses an unknown error into a non-operational 500 without leaking it', () => {
    const cause = new Error('mongodb://user:pw@host is unreachable');

    const error = toAppError(cause);

    expect(error.statusCode).toBe(500);
    expect(error.code).toBe(ErrorCode.INTERNAL_ERROR);
    expect(error.isOperational).toBe(false);
    expect(error.cause).toBe(cause);
    expect(error.toJSON().error.message).toBe('An unexpected error occurred');
  });

  it('handles non-Error throwables', () => {
    expect(toAppError('a string').statusCode).toBe(500);
    expect(isOperationalError(toAppError(null))).toBe(false);
  });
});
