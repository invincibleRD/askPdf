import { httpRequestDuration, httpRequestsInFlight } from '../../infra/metrics/registry.js';

/** Path segments that are identifiers, collapsed so cardinality stays bounded. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Records duration and count for every request.
 *
 * The label is the route pattern, never the raw path — `/documents/<id>` would
 * mint a new time series per document.
 */
export function metricsMiddleware({ ignorePaths = ['/metrics'] } = {}) {
  return function metricsRecorder(req, res, next) {
    if (ignorePaths.includes(req.path)) {
      next();
      return;
    }

    const startedAt = process.hrtime.bigint();
    httpRequestsInFlight.inc();

    let recorded = false;
    const record = () => {
      if (recorded) {
        return;
      }
      recorded = true;

      httpRequestsInFlight.dec();
      httpRequestDuration.observe(
        { method: req.method, route: routeLabel(req), status: String(res.statusCode) },
        Number(process.hrtime.bigint() - startedAt) / 1e9,
      );
    };

    // `close` also covers a client that disconnects mid-stream, which `finish`
    // misses — an abandoned SSE answer still consumed the time.
    res.once('finish', record);
    res.once('close', record);

    next();
  };
}

/**
 * Derived from `originalUrl`, not `req.route`.
 *
 * Express unwinds `req.baseUrl` when a request leaves a mounted router, so by
 * the time `finish` fires the mount prefix is already gone — a chat request
 * would be labelled `/` and an auth 401 `/me`. `originalUrl` is always the full
 * path, and collapsing id-shaped segments recovers the pattern without
 * depending on router internals.
 */
function routeLabel(req) {
  const path = req.originalUrl.split('?')[0];

  if (path === '/healthz' || path === '/readyz') {
    return path;
  }

  // Anything outside the API is a stray request; one label keeps 404 scans
  // from minting a series per probed URL.
  if (!path.startsWith('/api/')) {
    return '<unmatched>';
  }

  return normalisePath(path);
}

function normalisePath(path) {
  const normalised = path
    .replace(/\/+$/, '')
    .split('/')
    .map((segment) => (OBJECT_ID.test(segment) || UUID.test(segment) ? ':id' : segment))
    .join('/');

  return normalised || '/';
}
