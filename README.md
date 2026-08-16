# AskPDF

A RAG-powered document Q&A backend. Upload a PDF, ask questions about it, and
get answers that are grounded in the document — with citations, and with a
refusal rather than a guess when nothing in the document is relevant.

Built as a production-shaped service rather than a demo: the ingestion work
runs in a separate process behind a Redis queue, every dependency is health
checked, and the whole thing ships as one container image that runs on
Docker Compose locally and on Kubernetes in production.

---

## Why it is built this way

**Uploads return immediately.** Parsing, chunking and embedding a 20 MB PDF
takes seconds to minutes. Doing that inside the request would hold a
connection open and time out behind any load balancer. The API writes a job
and returns `202 Accepted` with a job id; a worker process picks the job up
off a Redis queue. Clients poll job status, which is mirrored into a Redis
hash for cheap reads.

**Answers are grounded or refused.** Retrieved passages must clear a cosine
similarity floor (0.7 by default) before they are allowed into the prompt.
When nothing clears it the service returns `NO_RELEVANT_CONTEXT` instead of
letting the model improvise — the difference between a tool you can trust and
a plausible liar.

**Failures leave no orphans.** A document that fails mid-pipeline has its
partial chunks removed and its status set to `failed`, so a retry starts from
a clean slate rather than compounding half-written state.

---

## Architecture

```
              ┌──────────────┐        ┌──────────────┐
   client ───▶│   API (n×)   │───────▶│    Redis     │
              │  express 5   │  job   │  queue+state │
              └──────┬───────┘        └──────┬───────┘
                     │                       │ BRPOP
                     │ metadata              ▼
                     │                ┌──────────────┐
                     ├───────────────▶│  Worker (n×) │
                     │                │  5-stage     │
                     ▼                │  pipeline    │
              ┌──────────────┐        └──────┬───────┘
              │   MongoDB    │◀──────────────┘
              │ docs+chunks  │   chunks + embeddings
              └──────────────┘
```

The ingestion pipeline runs five stages in order:

| Stage      | What it does                                         |
| ---------- | ---------------------------------------------------- |
| `parse`    | Extract text and page boundaries from the PDF        |
| `chunk`    | Split into overlapping windows that fit the embedder |
| `embed`    | Batch chunks into 768-dimension vectors              |
| `index`    | Persist chunks and vectors, build the search index   |
| `finalize` | Mark the document ready and clean up temporary state |

## Project layout

```
src/
├── config/       env schema + shared vocabulary; the only place reading process.env
├── core/         framework-agnostic building blocks (errors, logger, lifecycle)
├── http/         express app, middleware pipeline, route table
├── modules/      feature slices — routes → controller → service → repository
└── entrypoints/  the two processes: api.js and worker.js
tests/
├── unit/         pure logic, no I/O
└── integration/  real HTTP, real MongoDB, real Redis
deploy/k8s/       Kustomize base + per-environment overlays
```

Feature modules never import each other's internals and never learn where
they are mounted — `src/http/routes.js` owns that.

## Getting started

Requires Node 22.12+ and Docker.

```bash
cp .env.example .env
```

Everything at once, including MongoDB and Redis:

```bash
docker compose up -d
```

Or run the processes on the host against containerised dependencies:

```bash
docker compose up -d mongo redis
npm install
npm run dev
npm run dev:worker
```

Check it is alive:

```bash
curl -s localhost:3000/healthz
```

## Configuration

Every setting is declared and validated in [`src/config/env.js`](src/config/env.js);
the process refuses to start on an invalid environment rather than coming up
half-configured. See [`.env.example`](.env.example) for the full list.

Required: `MONGO_URI`, `REDIS_URL`, `GEMINI_API_KEY`, `JWT_ACCESS_SECRET`,
`JWT_REFRESH_SECRET`.

## Scripts

| Command                 | Purpose                                      |
| ----------------------- | -------------------------------------------- |
| `npm run dev`           | API with file watching                       |
| `npm run dev:worker`    | Ingestion worker with file watching          |
| `npm test`              | Full suite                                   |
| `npm run test:unit`     | Unit tests only (no external services)       |
| `npm run test:coverage` | Suite with coverage thresholds               |
| `npm run lint`          | ESLint                                       |
| `npm run verify`        | Format check + lint + tests, as CI runs them |

## Health endpoints

| Endpoint   | Meaning                                                          |
| ---------- | ---------------------------------------------------------------- |
| `/healthz` | Liveness. Deliberately shallow — never fails on a database blip. |
| `/readyz`  | Readiness. Fails while draining or when a dependency is down.    |

## Deployment

The image runs both processes; the command selects which:

```bash
docker build -t askpdf:latest .
```

Kubernetes manifests live in `deploy/k8s` and are applied with Kustomize.

## License

MIT — see [LICENSE](LICENSE).
