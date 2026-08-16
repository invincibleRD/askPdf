import { ValidationError } from '../../core/errors.js';

/**
 * Parses and *replaces* the named request parts, so handlers get coerced
 * values with unknown keys stripped.
 *
 * @param {{ body?: import('zod').ZodTypeAny, query?: import('zod').ZodTypeAny, params?: import('zod').ZodTypeAny }} schemas
 */
export function validate(schemas) {
  return function validateMiddleware(req, _res, next) {
    for (const part of ['params', 'query', 'body']) {
      const schema = schemas[part];
      if (!schema) {
        continue;
      }

      const result = schema.safeParse(req[part]);
      if (!result.success) {
        next(ValidationError.fromZod(result.error, `Invalid request ${part}`));
        return;
      }

      // req.query is a getter in Express 5, so assignment throws.
      Object.defineProperty(req, part, {
        value: result.data,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    }

    next();
  };
}
