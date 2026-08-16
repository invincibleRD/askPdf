import { REQUEST_ID_HEADER } from '../../config/constants.js';
import { newRequestId, runWithContext } from '../../core/request-context.js';

/** Runs first so everything downstream, including the error handler, has an id. */
export function correlationId() {
  return function correlationIdMiddleware(req, res, next) {
    const incoming = req.get(REQUEST_ID_HEADER);
    const requestId = isSafeRequestId(incoming) ? incoming : newRequestId();

    req.id = requestId;
    res.setHeader(REQUEST_ID_HEADER, requestId);

    runWithContext({ requestId }, () => {
      next();
    });
  };
}

// The header is caller-supplied and ends up in log files.
function isSafeRequestId(value) {
  return (
    typeof value === 'string' && value.length > 0 && value.length <= 128 && /^[\w.:-]+$/.test(value)
  );
}
