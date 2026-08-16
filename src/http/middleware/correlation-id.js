import { REQUEST_ID_HEADER } from '../../config/constants.js';
import { newRequestId, runWithContext } from '../../core/request-context.js';

/**
 * Establishes the correlation id for the request.
 *
 * Runs first in the pipeline so that everything downstream — including the
 * error handler — has an id to log and to echo back. An id supplied by an
 * upstream proxy is reused; otherwise a fresh UUID is minted.
 *
 * The whole rest of the request runs inside the AsyncLocalStorage scope,
 * which is what lets the logger stamp records without any call site passing
 * the id along.
 */
export function correlationId() {
  return function correlationIdMiddleware(req, res, next) {
    const incoming = req.get(REQUEST_ID_HEADER);
    // Only accept an upstream id that looks sane; a header is caller-supplied
    // input and ends up in log files.
    const requestId = isSafeRequestId(incoming) ? incoming : newRequestId();

    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithContext({ requestId }, () => {
      next();
    });
  };
}

/**
 * @param {string | undefined} value
 * @returns {value is string}
 */
function isSafeRequestId(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\w.:-]+$/.test(value)
  );
}
