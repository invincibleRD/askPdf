import { Types } from 'mongoose';
import { ConflictError } from '../../core/errors.js';

/** Shared schema options: renames _id to id and drops __v on serialisation. */
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

/** MongoDB reports uniqueness violations as 11000; without this they'd be 500s. */
export function rethrowDuplicateKey(error, message) {
  if (isDuplicateKeyError(error)) {
    const field = Object.keys(error.keyPattern ?? {})[0];
    throw new ConflictError(message, field ? { field } : undefined);
  }
  throw error;
}

export function isDuplicateKeyError(error) {
  return Boolean(error) && typeof error === 'object' && error.code === 11000;
}

/** Null for a malformed id, so the caller can 404 instead of hitting a CastError. */
export function toObjectId(value) {
  if (value instanceof Types.ObjectId) {
    return value;
  }
  if (typeof value === 'string' && Types.ObjectId.isValid(value)) {
    return new Types.ObjectId(value);
  }
  return null;
}

/** .lean() skips the schema transform, so lean reads get the same shape here. */
export function serialize(doc) {
  if (!doc) {
    return null;
  }

  const { _id, __v: _version, ...rest } = doc;
  return { id: String(_id), ...rest };
}

export function serializeMany(docs) {
  return docs.map((doc) => serialize(doc));
}
