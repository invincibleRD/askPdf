import { UnauthorizedError } from '../../core/errors.js';
import { createLogger } from '../../core/logger.js';
import { User } from '../users/user.model.js';
import {
  createUser,
  findUserByEmail,
  findUserById,
  incrementTokenVersion,
  touchLastLogin,
} from '../users/user.repository.js';
import { burnTiming, hashPassword, needsRehash, verifyPassword } from './password.js';
import {
  isRefreshTokenRevoked,
  issueTokenPair,
  revokeRefreshToken,
  verifyRefreshToken,
} from './token.service.js';

const log = createLogger('auth');

export async function register({ email, password, name }) {
  const passwordHash = await hashPassword(password);

  // No pre-flight existence check — the unique index is the real guard and
  // the repository turns its error into a ConflictError.
  const user = await createUser({ email, passwordHash, name });

  log.info({ userId: user.id }, 'user registered');

  return { user, tokens: issueTokenPair({ ...user, tokenVersion: user.tokenVersion ?? 0 }) };
}

export async function login({ email, password }) {
  const user = await findUserByEmail(email, { withPassword: true });

  if (!user) {
    await burnTiming();
    throw new UnauthorizedError('Invalid email or password');
  }

  if (user.disabledAt) {
    throw new UnauthorizedError('This account has been disabled');
  }

  if (!(await verifyPassword(password, user.passwordHash))) {
    log.warn({ userId: user.id }, 'failed login attempt');
    throw new UnauthorizedError('Invalid email or password');
  }

  // Login is the only point we hold the plaintext, so it's the only chance to
  // move an old hash up to the current cost factor.
  if (needsRehash(user.passwordHash)) {
    await upgradeHash(user.id, password);
  }

  await touchLastLogin(user.id);
  log.info({ userId: user.id }, 'user signed in');

  const { passwordHash: _hash, ...safeUser } = user;
  return { user: safeUser, tokens: issueTokenPair(user) };
}

/** Refresh tokens are single use — the presented one is revoked in exchange. */
export async function refresh(refreshToken) {
  const payload = verifyRefreshToken(refreshToken);

  if (await isRefreshTokenRevoked(payload.jti)) {
    log.warn({ userId: payload.sub, jti: payload.jti }, 'revoked refresh token presented');
    throw new UnauthorizedError('Refresh token is no longer valid');
  }

  const user = await findUserById(payload.sub);
  if (!user || user.disabledAt) {
    throw new UnauthorizedError('Account is no longer active');
  }

  if (payload.tokenVersion !== user.tokenVersion) {
    log.warn({ userId: user.id }, 'refresh token rejected: stale token version');
    throw new UnauthorizedError('Refresh token is no longer valid');
  }

  await revokeRefreshToken(payload.jti, payload.exp);

  return { user, tokens: issueTokenPair(user) };
}

export async function logout({ userId, refreshToken, everywhere = false }) {
  if (everywhere) {
    await incrementTokenVersion(userId);
    log.info({ userId }, 'signed out of all sessions');
    return { everywhere: true };
  }

  if (refreshToken) {
    try {
      const payload = verifyRefreshToken(refreshToken);
      await revokeRefreshToken(payload.jti, payload.exp);
    } catch {
      // Already expired or malformed — the desired end state already holds.
    }
  }

  log.info({ userId }, 'signed out');
  return { everywhere: false };
}

export async function changePassword({ userId, currentPassword, newPassword }) {
  const user = await User.findById(userId).select('+passwordHash').lean().exec();

  if (!user) {
    throw new UnauthorizedError('Account is no longer active');
  }

  if (!(await verifyPassword(currentPassword, user.passwordHash))) {
    log.warn({ userId }, 'password change rejected: wrong current password');
    throw new UnauthorizedError('Current password is incorrect');
  }

  const passwordHash = await hashPassword(newPassword);

  // Bumping tokenVersion invalidates every outstanding refresh token.
  await User.updateOne(
    { _id: userId },
    { $set: { passwordHash }, $inc: { tokenVersion: 1 } },
  ).exec();
  log.info({ userId }, 'password changed, all sessions invalidated');

  const updated = await findUserById(userId);
  return { user: updated, tokens: issueTokenPair(updated) };
}

async function upgradeHash(userId, plaintext) {
  try {
    const passwordHash = await hashPassword(plaintext);
    await User.updateOne({ _id: userId }, { $set: { passwordHash } }).exec();
    log.info({ userId }, 'password hash upgraded');
  } catch (error) {
    // A successful login must not fail because an optimisation did.
    log.error({ err: error, userId }, 'failed to upgrade password hash');
  }
}
