import { ForbiddenError, UnauthorizedError } from '../../core/errors.js';
import { setContext } from '../../core/request-context.js';
import { verifyAccessToken } from '../../modules/auth/token.service.js';
import { findUserById } from '../../modules/users/user.repository.js';

/**
 * Verification is signature-only; the short access TTL bounds how long a
 * revoked user stays usable.
 *
 * @param {{ loadUser?: boolean }} [options] Fetch the full profile — only for
 *   endpoints that actually need it.
 */
export function authenticate({ loadUser = false } = {}) {
  return async function authenticateMiddleware(req, _res, next) {
    const token = extractBearerToken(req);

    if (!token) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    const payload = verifyAccessToken(token);
    let user = { id: payload.sub, role: payload.role };

    if (loadUser) {
      const record = await findUserById(payload.sub);

      if (!record || record.disabledAt) {
        next(new UnauthorizedError('Account is no longer active'));
        return;
      }

      user = record;
    }

    // Each request has its own `req`, so there is no cross-request race here.
    // eslint-disable-next-line require-atomic-updates
    req.user = user;
    setContext({ userId: user.id });
    next();
  };
}

/** Attaches the user when a token is present, but doesn't require one. */
export function optionalAuthenticate() {
  return function optionalAuthenticateMiddleware(req, _res, next) {
    const token = extractBearerToken(req);

    if (!token) {
      next();
      return;
    }

    try {
      const payload = verifyAccessToken(token);
      req.user = { id: payload.sub, role: payload.role };
      setContext({ userId: req.user.id });
    } catch {
      // A bad token here is treated as no token.
    }

    next();
  };
}

export function requireRole(...roles) {
  return function requireRoleMiddleware(req, _res, next) {
    if (!req.user) {
      next(new UnauthorizedError('Authentication required'));
      return;
    }

    if (!roles.includes(req.user.role)) {
      next(new ForbiddenError('This action requires a different role'));
      return;
    }

    next();
  };
}

// Header only. Tokens in query strings end up in access logs and browser
// history.
function extractBearerToken(req) {
  const header = req.get('authorization');

  if (!header) {
    return null;
  }

  const [scheme, token] = header.split(' ');

  if (!token || scheme?.toLowerCase() !== 'bearer') {
    return null;
  }

  return token.trim() || null;
}
