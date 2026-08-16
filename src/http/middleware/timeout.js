import { RequestTimeoutError } from '../../core/errors.js';

/** Streaming responses opt out: the timer clears once headers are flushed. */
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
