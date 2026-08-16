import { User } from './user.model.js';
import { rethrowDuplicateKey, serialize, toObjectId } from '../../infra/mongo/schema-helpers.js';

export async function createUser(input) {
  try {
    const user = await User.create(input);
    // toJSON, not toObject — only toJSON runs the transform that strips the hash.
    return user.toJSON();
  } catch (error) {
    rethrowDuplicateKey(error, 'An account with this email already exists');
  }
}

/** The hash is select:false, so authentication has to ask for it explicitly. */
export async function findUserByEmail(email, { withPassword = false } = {}) {
  const query = User.findOne({ email: email.toLowerCase().trim() });

  if (withPassword) {
    query.select('+passwordHash');
  }

  return serialize(await query.lean().exec());
}

export async function findUserById(id) {
  const objectId = toObjectId(id);
  if (!objectId) {
    return null;
  }

  return serialize(await User.findById(objectId).lean().exec());
}

export async function touchLastLogin(id) {
  const objectId = toObjectId(id);
  if (!objectId) {
    return;
  }

  await User.updateOne({ _id: objectId }, { $set: { lastLoginAt: new Date() } }).exec();
}

/** Invalidates every outstanding refresh token without a blacklist. */
export async function incrementTokenVersion(id) {
  const objectId = toObjectId(id);
  if (!objectId) {
    return null;
  }

  const user = await User.findOneAndUpdate(
    { _id: objectId },
    { $inc: { tokenVersion: 1 } },
    { new: true, projection: { tokenVersion: 1 } },
  )
    .lean()
    .exec();

  return user ? user.tokenVersion : null;
}

export async function emailExists(email) {
  const count = await User.countDocuments({ email: email.toLowerCase().trim() }).limit(1).exec();
  return count > 0;
}
