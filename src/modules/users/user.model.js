import { Schema, model } from 'mongoose';
import { UserRole } from '../../config/constants.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      // Addresses are compared case-insensitively; storing them folded means
      // the unique index enforces that rather than trusting every call site.
      lowercase: true,
      trim: true,
      maxlength: 254,
    },

    passwordHash: {
      type: String,
      required: true,
      // Never loaded unless a query asks for it explicitly, so an accidental
      // `findById(...)` in a controller cannot serialise the hash.
      select: false,
    },

    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 120,
    },

    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.USER,
      index: true,
    },

    /**
     * Bumped on password change or explicit sign-out-everywhere. Refresh
     * tokens embed the value they were minted with, so incrementing it
     * invalidates every outstanding token for this user at once — revocation
     * without a token blacklist.
     */
    tokenVersion: {
      type: Number,
      default: 0,
      min: 0,
    },

    lastLoginAt: { type: Date },

    /** Soft-delete marker; a disabled account keeps its documents. */
    disabledAt: { type: Date, default: null },
  },
  baseSchemaOptions({
    transform(_doc, ret) {
      // Belt and braces: even if a query selects the hash, it never reaches a
      // response body.
      delete ret.passwordHash;
      return ret;
    },
  }),
);

/** Active accounts only — the common case for every authenticated lookup. */
userSchema.index({ email: 1, disabledAt: 1 });

export const User = model('User', userSchema);
