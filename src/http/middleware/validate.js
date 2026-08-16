import { ValidationError } from '../../core/errors.js';

/**
 * Schema validation for request input.
 *
 * Controllers should never see unvalidated data. This middleware parses the
 * named parts of the request with zod and, importantly, *replaces* them with
 * the parsed result — so coercions and defaults declared in the schema are
 * what the handler actually gets, and unknown keys are stripped rather than
 * silently forwarded into a database write.
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

      // Express 5 exposes `req.query` through a getter, so assigning to it
      // throws. Defining the property replaces it outright, which keeps the
      // "handlers only see parsed input" guarantee for every part.
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
