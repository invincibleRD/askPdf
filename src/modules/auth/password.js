import bcrypt from 'bcryptjs';
import { env } from '../../config/env.js';

// bcryptjs, not the native bcrypt binding: the native one compiles on install,
// which would mean dropping --ignore-scripts from the Docker build.

export function hashPassword(plaintext) {
  return bcrypt.hash(plaintext, env.BCRYPT_ROUNDS);
}

export async function verifyPassword(plaintext, hash) {
  if (!hash) {
    return false;
  }

  try {
    return await bcrypt.compare(plaintext, hash);
  } catch {
    return false;
  }
}

/** True when the hash was made with a weaker cost than we now require. */
export function needsRehash(hash) {
  try {
    return bcrypt.getRounds(hash) < env.BCRYPT_ROUNDS;
  } catch {
    return true;
  }
}

// Burns comparable time when the email doesn't exist, so response latency
// can't be used to enumerate registered addresses.
export async function burnTiming() {
  await bcrypt.compare(
    'timing-equalisation',
    '$2b$12$C6UzMDM.H6dfI/f/IKcEe.WlnHjb5Xp0hBEWpr8bEbwLIWPMs4Kwm',
  );
}
