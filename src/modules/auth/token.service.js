import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../core/errors.js';
import { getRedis, redisKey } from '../../infra/redis/connection.js';

/**
 * Token issuing and verification.
 *
 * Two token types with deliberately different jobs:
 *
 *   - **access** — short lived (15 minutes), sent on every request, verified
 *     with signature checking alone. No database round trip, which is what
 *     keeps authentication off the hot path.
 *   - **refresh** — long lived (30 days), sent only to /auth/refresh,
 *     single-use, and checked against Redis so it can be revoked.
 *
 * The pair is signed with *different* secrets. If it were one secret, an
 * access token could be replayed at the refresh endpoint and the short expiry
 * would buy nothing.
 */

/** Redis key holding a denylisted refresh token id until its natural expiry. */
const revokedKey = (jti) => redisKey('revoked', jti);

/**
 * Mints an access token.
 *
 * The payload carries only what authorisation needs. Anything else — name,
 * email — would be a stale copy the moment the user changes it, and JWT
 * payloads are readable by anyone holding the token.
 *
 * @param {{ id: string, role: string }} user
 * @returns {string}
 */
export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, type: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

/**
 * Mints a refresh token.
 *
 * Carries a unique `jti` so an individual token can be revoked, and the
 * user's `tokenVersion` so every outstanding token can be invalidated at once
 * by incrementing a single counter.
 *
 * @param {{ id: string, tokenVersion: number }} user
 * @returns {{ token: string, jti: string }}
 */
export function signRefreshToken(user) {
  const jti = randomUUID();

  const token = jwt.sign(
    { sub: user.id, type: 'refresh', tokenVersion: user.tokenVersion },
    env.JWT_REFRESH_SECRET,
    {
      expiresIn: env.JWT_REFRESH_TTL,
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      jwtid: jti,
    },
  );

  return { token, jti };
}

/**
 * Issues a fresh pair.
 *
 * @param {{ id: string, role: string, tokenVersion: number }} user
 */
export function issueTokenPair(user) {
  const { token: refreshToken, jti } = signRefreshToken(user);

  return {
    accessToken: signAccessToken(user),
    refreshToken,
    refreshTokenId: jti,
    tokenType: 'Bearer',
    expiresIn: env.JWT_ACCESS_TTL,
  };
}

/**
 * Verifies an access token.
 *
 * Signature, expiry, issuer and audience are all checked. The `type` claim is
 * checked too, so a refresh token cannot be presented as an access token even
 * if the secrets were ever unified by mistake.
 *
 * @param {string} token
 * @returns {{ sub: string, role: string }}
 */
export function verifyAccessToken(token) {
  const payload = verify(token, env.JWT_ACCESS_SECRET);

  if (payload.type !== 'access') {
    throw new UnauthorizedError('Invalid token type');
  }

  return payload;
}

/**
 * Verifies a refresh token's signature and claims.
 *
 * Revocation is checked separately by `isRefreshTokenRevoked`, because that
 * requires Redis and this function stays synchronous and pure.
 *
 * @param {string} token
 * @returns {{ sub: string, jti: string, tokenVersion: number }}
 */
export function verifyRefreshToken(token) {
  const payload = verify(token, env.JWT_REFRESH_SECRET);

  if (payload.type !== 'refresh') {
    throw new UnauthorizedError('Invalid token type');
  }

  return payload;
}

/**
 * @param {string} token
 * @param {string} secret
 */
function verify(token, secret) {
  try {
    return jwt.verify(token, secret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
  } catch (error) {
    // The distinction between expired and malformed is useful to a client —
    // one means "refresh", the other means "sign in again" — but nothing more
    // specific than that is disclosed.
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Token has expired', { reason: 'expired' });
    }
    throw new UnauthorizedError('Invalid token', { reason: 'invalid' });
  }
}

/**
 * Revokes a single refresh token.
 *
 * The entry is stored with a TTL matching what remains of the token's own
 * lifetime: once the token would expire anyway, the denylist entry is
 * pointless and evicts itself. That bounds the denylist by the refresh
 * window rather than letting it grow forever.
 *
 * @param {string} jti
 * @param {number} expiresAtSeconds Unix seconds from the token's `exp` claim.
 */
export async function revokeRefreshToken(jti, expiresAtSeconds) {
  const ttlSeconds = Math.max(1, Math.ceil(expiresAtSeconds - Date.now() / 1000));

  await getRedis().set(revokedKey(jti), '1', 'EX', ttlSeconds);
}

/**
 * @param {string} jti
 * @returns {Promise<boolean>}
 */
export async function isRefreshTokenRevoked(jti) {
  const found = await getRedis().exists(revokedKey(jti));
  return found === 1;
}

/**
 * A stable, non-reversible fingerprint of a token.
 *
 * Used where a token has to appear in a log or an audit record. Logging the
 * token itself would hand a reader a working credential.
 *
 * @param {string} token
 * @returns {string}
 */
export function fingerprintToken(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}
