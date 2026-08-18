# ADR 0002: Separate API and worker deployments, scaled on different signals

## Status
Accepted

## Context
Ingesting a PDF — parse, chunk, embed, index — takes seconds to minutes and is
dominated by waiting on the Gemini embedding API. Serving HTTP requests is a
tens-of-milliseconds, CPU-and-IO job. Running both in one process would couple
their failure and scaling: a burst of uploads would starve request handling,
and a crash in either would take down both.

## Decision
Ship one image, two Deployments, selected by the container command
(`api.js` vs `worker.js`). They scale on different signals:

- **API** — HorizontalPodAutoscaler on CPU. Request latency tracks CPU well.
- **Worker** — HPA on `askpdf_queue_depth{state=ready}` via an external metric.
  A worker blocked on a Gemini call uses almost no CPU while the backlog grows,
  so CPU-based scaling would sit at one replica exactly when more are needed.
  Queue depth is the signal that actually reflects pending work.

The worker serves no application traffic but runs a metrics-only HTTP server so
Prometheus can scrape its pipeline timings and Kubernetes has a liveness probe.

## Consequences
- The two scale and fail independently.
- Worker autoscaling needs `askpdf_queue_depth` exposed as an external metric
  (prometheus-adapter). Until that is wired, the worker HPA falls back to a
  fixed replica count.
- One image, so a worker can never run a different build of the pipeline than
  the API that enqueues for it.
