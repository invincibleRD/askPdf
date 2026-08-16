import { createHash, randomUUID } from 'node:crypto';
import jwt from 'jsonwebtoken';
import { env } from '../../config/env.js';
import { UnauthorizedError } from '../../core/errors.js';
import { getRedis, redisKey } from '../../infra/redis/connection.js';

// Access and refresh tokens use different secrets, so an access token can't be
// replayed at the refresh endpoint.

const revokedKey = (jti) => redisKey('revoked', jti);

export function signAccessToken(user) {
  return jwt.sign({ sub: user.id, role: user.role, type: 'access' }, env.JWT_ACCESS_SECRET, {
    expiresIn: env.JWT_ACCESS_TTL,
    issuer: env.JWT_ISSUER,
    audience: env.JWT_AUDIENCE,
  });
}

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

export function verifyAccessToken(token) {
  const payload = verify(token, env.JWT_ACCESS_SECRET);

  if (payload.type !== 'access') {
    throw new UnauthorizedError('Invalid token type');
  }

  return payload;
}

/** Signature and claims only — revocation is checked separately. */
export function verifyRefreshToken(token) {
  const payload = verify(token, env.JWT_REFRESH_SECRET);

  if (payload.type !== 'refresh') {
    throw new UnauthorizedError('Invalid token type');
  }

  return payload;
}

function verify(token, secret) {
  try {
    return jwt.verify(token, secret, {
      issuer: env.JWT_ISSUER,
      audience: env.JWT_AUDIENCE,
      algorithms: ['HS256'],
    });
  } catch (error) {
    if (error instanceof jwt.TokenExpiredError) {
      throw new UnauthorizedError('Token has expired', { reason: 'expired' });
    }
    throw new UnauthorizedError('Invalid token', { reason: 'invalid' });
  }
}

/**
 * @param {string} jti
 * @param {number} expiresAtSeconds The token's own `exp`, so the denylist
 *   entry expires with it instead of growing forever.
 */
export async function revokeRefreshToken(jti, expiresAtSeconds) {
  const ttlSeconds = Math.max(1, Math.ceil(expiresAtSeconds - Date.now() / 1000));

  await getRedis().set(revokedKey(jti), '1', 'EX', ttlSeconds);
}

export async function isRefreshTokenRevoked(jti) {
  return (await getRedis().exists(revokedKey(jti))) === 1;
}

/** For logging a token without logging a working credential. */
export function fingerprintToken(token) {
  return createHash('sha256').update(token).digest('hex').slice(0, 16);
}
