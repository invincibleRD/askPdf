import { User } from './user.model.js';
import { rethrowDuplicateKey, serialize, toObjectId } from '../../infra/mongo/schema-helpers.js';

/**
 * User persistence.
 *
 * Repositories are the only place that talks to a Mongoose model. Services
 * above them work with plain objects, which keeps document hydration, lean
 * queries and index choices from leaking into business logic.
 */

/**
 * @param {{ email: string, passwordHash: string, name: string, role?: string }} input
 */
export async function createUser(input) {
  try {
    const user = await User.create(input);
    return serialize(user.toObject());
  } catch (error) {
    rethrowDuplicateKey(error, 'An account with this email already exists');
  }
}

/**
 * Looks up an account for sign-in.
 *
 * The password hash is `select: false` on the schema, so authentication has
 * to ask for it deliberately — which means no other caller can leak it.
 *
 * @param {string} email
 * @param {{ withPassword?: boolean }} [options]
 */
export async function findUserByEmail(email, { withPassword = false } = {}) {
  const query = User.findOne({ email: email.toLowerCase().trim() });

  if (withPassword) {
    query.select('+passwordHash');
  }

  const user = await query.lean().exec();
  return serialize(user);
}

/**
 * @param {string} id
 */
export async function findUserById(id) {
  const objectId = toObjectId(id);
  if (!objectId) {
    return null;
  }

  const user = await User.findById(objectId).lean().exec();
  return serialize(user);
}

/**
 * Records a successful sign-in.
 *
 * Deliberately fire-and-forget at the call site: a failed timestamp update
 * must never turn a valid login into an error.
 *
 * @param {string} id
 */
export async function touchLastLogin(id) {
  const objectId = toObjectId(id);
  if (!objectId) {
    return;
  }

  await User.updateOne({ _id: objectId }, { $set: { lastLoginAt: new Date() } }).exec();
}

/**
 * Invalidates every outstanding refresh token for a user.
 *
 * Used by sign-out-everywhere and by password change. Cheaper and more
 * reliable than maintaining a blacklist: tokens carry the version they were
 * signed with and are rejected once it falls behind.
 *
 * @param {string} id
 * @returns {Promise<number | null>} The new token version.
 */
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

/**
 * @param {string} email
 * @returns {Promise<boolean>}
 */
export async function emailExists(email) {
  const count = await User.countDocuments({ email: email.toLowerCase().trim() }).limit(1).exec();
  return count > 0;
}
