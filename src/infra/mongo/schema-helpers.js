import { Types } from 'mongoose';
import { ConflictError } from '../../core/errors.js';

/**
 * Conventions shared by every schema.
 *
 * Keeping these in one place is what stops the API from developing
 * inconsistencies — one collection returning `_id`, another `id`, a third
 * leaking `__v` — as the number of models grows.
 */

/**
 * Options applied to every schema.
 *
 * The `toJSON` transform is the important one: it renames `_id` to `id` and
 * drops the version key, so a document can be returned from a controller
 * without a hand-written mapper at every call site.
 *
 * @param {{ transform?: (doc: unknown, ret: Record<string, unknown>) => unknown }} [overrides]
 */
export function baseSchemaOptions({ transform } = {}) {
  return {
    timestamps: true,
    versionKey: '__v',
    optimisticConcurrency: false,
    minimize: false,
    toJSON: {
      virtuals: true,
      transform(doc, ret) {
        ret.id = String(ret._id);
        delete ret._id;
        delete ret.__v;
        return transform ? transform(doc, ret) : ret;
      },
    },
    toObject: { virtuals: true },
  };
}

/**
 * Turns a duplicate-key driver error into a domain ConflictError.
 *
 * MongoDB reports uniqueness violations as error 11000 from deep inside the
 * driver. Without this the API would answer 500 for what is a perfectly
 * ordinary 409.
 *
 * @param {unknown} error
 * @param {string} message
 * @returns {never}
 */
export function rethrowDuplicateKey(error, message) {
  if (isDuplicateKeyError(error)) {
    const field = Object.keys(error.keyPattern ?? {})[0];
    throw new ConflictError(message, field ? { field } : undefined);
  }
  throw error;
}

/**
 * @param {unknown} error
 * @returns {boolean}
 */
export function isDuplicateKeyError(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 11000;
}

/**
 * Parses a value into an ObjectId, or returns null when it is not one.
 *
 * Repositories use this to reject a malformed id before it reaches the driver,
 * which would otherwise throw a CastError that surfaces as a 500 instead of
 * the 404 the caller deserves.
 *
 * @param {unknown} value
 * @returns {import('mongoose').Types.ObjectId | null}
 */
export function toObjectId(value) {
  if (value instanceof Types.ObjectId) {
    return value;
  }
  if (typeof value === 'string' && Types.ObjectId.isValid(value)) {
    return new Types.ObjectId(value);
  }
  return null;
}

/**
 * Normalises a lean document for API output.
 *
 * `.lean()` skips hydration — a meaningful saving when reading thousands of
 * chunks — but it also skips the `toJSON` transform, so the same renaming has
 * to happen explicitly.
 *
 * @template {Record<string, unknown>} T
 * @param {T | null} doc
 * @returns {(Omit<T, '_id' | '__v'> & { id: string }) | null}
 */
export function serialize(doc) {
  if (!doc) {
    return null;
  }

  const { _id, __v: _version, ...rest } = doc;
  return { id: String(_id), ...rest };
}

/**
 * @template {Record<string, unknown>} T
 * @param {T[]} docs
 */
export function serializeMany(docs) {
  return docs.map((doc) => serialize(doc));
}
