import pinoHttp from 'pino-http';
import { logger } from '../../core/logger.js';

export function requestLogger({ quietPaths = ['/healthz', '/readyz', '/metrics'] } = {}) {
  return pinoHttp({
    logger,
    genReqId: (req) => req.id,
    autoLogging: {
      // A probe every few seconds would drown real traffic.
      ignore: (req) =>
        quietPaths.some((path) => req.url === path || req.url.startsWith(`${path}?`)),
    },
    customLogLevel(_req, res, err) {
      if (err || res.statusCode >= 500) return 'error';
      if (res.statusCode >= 400) return 'warn';
      return 'info';
    },
    customSuccessMessage(req, res) {
      return `${req.method} ${req.url} ${String(res.statusCode)}`;
    },
    customErrorMessage(req, _res, err) {
      return `${req.method} ${req.url} failed: ${err.message}`;
    },
    serializers: {
      req: (req) => ({
        method: req.method,
        url: req.url,
        userAgent: req.headers['user-agent'],
        ip: req.raw?.ip,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}
