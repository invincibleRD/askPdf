import { RequestTimeoutError } from '../../core/errors.js';

/**
 * Bounds how long a request may occupy a connection.
 *
 * A handler blocked on a slow upstream would otherwise hold its socket until
 * the client gives up, and under load that is how a pool gets exhausted.
 *
 * Streaming responses opt out: an SSE chat legitimately stays open for
 * minutes, so the timer is cleared as soon as headers are flushed.
 *
 * @param {number} timeoutMs
 */
export function requestTimeout(timeoutMs) {
  return function requestTimeoutMiddleware(req, res, next) {
    if (res.headersSent) {
      next();
      return;
    }

    const timer = setTimeout(() => {
      if (!res.writableEnded) {
        next(new RequestTimeoutError(timeoutMs));
      }
    }, timeoutMs);

    const clear = () => {
      clearTimeout(timer);
    };

    // `close` covers client disconnects, `finish` a completed response, and
    // the header write covers long-lived streams that have not finished yet.
    res.once('finish', clear);
    res.once('close', clear);
    const originalWriteHead = res.writeHead.bind(res);
    res.writeHead = (...args) => {
      clear();
      return originalWriteHead(...args);
    };

    next();
  };
}
