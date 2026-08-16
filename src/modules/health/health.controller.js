import { getLiveness, getReadiness } from './health.service.js';

export function liveness(_req, res) {
  res.status(200).json(getLiveness());
}

export async function readiness(_req, res) {
  const { ready, body } = await getReadiness();

  // 503 is what pulls the pod out of the Service endpoints.
  res.status(ready ? 200 : 503).json(body);
}
