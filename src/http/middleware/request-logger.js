import pinoHttp from 'pino-http';
import { logger } from '../../core/logger.js';

/**
 * Access logging.
 *
 * One line per completed request, at a level chosen by outcome: 5xx is an
 * error, 4xx a warning, everything else info. Health and metrics endpoints
 * are silenced because a probe every few seconds drowns real traffic.
 */
export function requestLogger({ quietPaths = ['/healthz', '/readyz', '/metrics'] } = {}) {
  return pinoHttp({
    logger,
    // The correlation-id middleware has already decided the id; reuse it so
    // the access log and the application logs agree.
    genReqId: (req) => req.id,
    autoLogging: {
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
        // Header values are attacker-controlled; the logger's redact rules
        // already strip authorization and cookies from this object.
        userAgent: req.headers['user-agent'],
        ip: req.raw?.ip,
      }),
      res: (res) => ({ statusCode: res.statusCode }),
    },
  });
}
