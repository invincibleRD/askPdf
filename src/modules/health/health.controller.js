import { getLiveness, getReadiness } from './health.service.js';

/** GET /healthz */
export function liveness(_req, res) {
  res.status(200).json(getLiveness());
}

/** GET /readyz */
export async function readiness(_req, res) {
  const { ready, body } = await getReadiness();

  // 503 is what makes Kubernetes pull the pod out of the Service endpoints;
  // the body explains which dependency is at fault.
  res.status(ready ? 200 : 503).json(body);
}
