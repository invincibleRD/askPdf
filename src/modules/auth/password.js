import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';

/**
 * Password hashing.
 *
 * Uses `bcryptjs` — the pure-JavaScript implementation — rather than the
 * native `bcrypt` binding. Both produce the same `$2b$` hashes and are
 * interchangeable, but the native one runs a compile step on install, which
 * would mean dropping `--ignore-scripts` from the Docker build and giving
 * every transitive dependency the right to execute code at image build time.
 * A slower hash is a good trade for not making that hole.
 */

/**
 * Hashes a plaintext password.
 *
 * The cost factor is configurable so it can be raised as hardware improves
 * without a code change; it is embedded in the resulting hash, so old
 * passwords keep verifying at the cost they were created with.
 *
 * @param {string} plaintext
 * @returns {Promise<string>}
 */
export function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, env.BCRYPT_ROUNDS);
}

/**
 * Checks a password against a stored hash.
 *
 * bcrypt's comparison is constant-time with respect to the hash, so this does
 * not leak how much of a guess was correct.
 *
 * @param {string} plaintext
 * @param {string} hash
 * @returns {Promise<boolean>}
 */
export async function verifyPassword(plaintext, hash) {
  if (!hash) {
    return false;
  }

  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    // A malformed hash in the database should read as "wrong password", not
    // crash the login endpoint.
    return false;
  }
}

/**
 * Whether a stored hash was created with a weaker cost than we now require.
 *
 * Lets a successful login transparently upgrade the stored hash, so raising
 * the cost factor eventually covers existing accounts instead of only new
 * ones.
 *
 * @param {string} hash
 * @returns {boolean}
 */
export function needsRehash(hash) {
  try {
    return bcrypt.getRounds(hash) < env.BCRYPT_ROUNDS;
  } catch {
    return true;
  }
}

/**
 * Burns roughly the time a real verification would take.
 *
 * Called when an email does not exist. Without it, "unknown account" returns
 * in a millisecond while "wrong password" takes a hundred, and that
 * difference is enough to enumerate which addresses are registered.
 *
 * @returns {Promise<void>}
 */
export async function burnTiming() {
  await bcrypt.compare(
    'timing-equalisation',
    '$2b$12$C6UzMDM.H6dfI/f/IKcEe.WlnHjb5Xp0hBEWpr8bEbwLIWPMs4Kwm',
  );
}
