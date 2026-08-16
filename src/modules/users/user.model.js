import { Schema, model } from 'mongoose';
import { UserRole } from '../../config/constants.js';
import { baseSchemaOptions } from '../../infra/mongo/schema-helpers.js';

const userSchema = new Schema(
  {
    email: {
      type: String,
      required: true,
      unique: true,
      // Folded on write, so the unique index enforces case-insensitivity
      // rather than every call site remembering to.
      lowercase: true,
      trim: true,
      maxlength: 254,
    },

    passwordHash: { type: String, required: true, select: false },

    name: { type: String, required: true, trim: true, maxlength: 120 },

    role: {
      type: String,
      enum: Object.values(UserRole),
      default: UserRole.USER,
      index: true,
    },

    /**
     * Refresh tokens embed the version they were minted with, so incrementing
     * this revokes every outstanding token without a blacklist.
     */
    tokenVersion: { type: Number, default: 0, min: 0 },

    lastLoginAt: { type: Date },
    disabledAt: { type: Date, default: null },
  },
  baseSchemaOptions({
    transform(_doc, ret) {
      delete ret.passwordHash;
      return ret;
    },
  }),
);

userSchema.index({ email: 1, disabledAt: 1 });

export const User = model('User', userSchema);
