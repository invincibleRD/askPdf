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

## Endpoints

| Method   | Path                             | Notes                                           |
| -------- | -------------------------------- | ----------------------------------------------- |
| `POST`   | `/api/v1/auth/register`          | Returns an access + refresh pair                |
| `POST`   | `/api/v1/auth/login`             |                                                 |
| `POST`   | `/api/v1/auth/refresh`           | Single use — the presented token is revoked     |
| `POST`   | `/api/v1/auth/logout`            | `everywhere: true` kills every session          |
| `POST`   | `/api/v1/auth/change-password`   | Invalidates all existing sessions               |
| `GET`    | `/api/v1/auth/me`                |                                                 |
| `POST`   | `/api/v1/documents`              | Multipart upload, returns **202** with a job id |
| `GET`    | `/api/v1/documents`              | Keyset paginated                                |
| `GET`    | `/api/v1/documents/:id`          |                                                 |
| `GET`    | `/api/v1/documents/:id/download` | Signed URL                                      |
| `DELETE` | `/api/v1/documents/:id`          | Removes chunks and the stored object too        |
| `GET`    | `/api/v1/jobs/:id`               | Poll ingestion progress                         |
| `GET`    | `/api/v1/jobs`                   |                                                 |

Uploading:

```bash
curl -X POST localhost:3000/api/v1/documents \
  -H "authorization: Bearer $TOKEN" \
  -F file=@fixtures/pdfs/espresso-machine-manual.pdf
```

## Ingestion pipeline

The worker consumes the queue and runs five stages per document:

| Stage      | What happens                                              |
| ---------- | --------------------------------------------------------- |
| `parse`    | Extract text per page via pdf.js, plus title metadata     |
| `chunk`    | Split at paragraph then sentence boundaries, with overlap |
| `embed`    | Batch through Gemini into 768-dimension vectors           |
| `index`    | Write chunks + vectors to MongoDB                         |
| `finalize` | Mark ready, record page and chunk counts                  |

Progress is written to both MongoDB and a Redis hash, so polling `GET /jobs/:id`
never touches the database primary.

**Failures.** A transient failure (rate limit, timeout) is retried with
exponential backoff and jitter via a delayed sorted set. A permanent one — an
encrypted PDF, a scan with no text layer — skips retries entirely and goes
straight to the dead-letter queue, because burning three attempts on a file
that cannot improve just costs worker capacity. Either way the pipeline deletes
its own partial chunks first, so a retry starts clean rather than colliding
with the unique `{documentId, index}` index.

**Crashes.** A worker killed mid-job leaves the job `active` with a heartbeat
that stops advancing. A reaper on every worker finds those, clears any partial
chunks and requeues them — preserving the attempt count, so retries stay
bounded.

Run the worker separately from the API:

```bash
npm run dev:worker
```

## Answering questions

A question is embedded, ranked against the document's chunks by cosine
similarity, and only passages clearing `RETRIEVAL_MIN_SCORE` are allowed into
the prompt. If nothing clears it the service returns `422 NO_RELEVANT_CONTEXT`
rather than letting the model improvise.

```bash
curl -X POST localhost:3000/api/v1/chat \
  -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -d '{"documentId":"...","question":"Which region contributed the most revenue?"}'
```

```json
{
  "answer": "The Nordic region contributed the most revenue this quarter with 14.6 million euros [1].",
  "bestScore": 0.7203,
  "citations": [
    { "chunkIndex": 0, "pageStart": 1, "pageEnd": 3, "score": 0.7203, "snippet": "..." }
  ]
}
```

`/chat/stream` sends the same thing as SSE: a `citations` event first — so a
client can render sources while the answer is still arriving — then `delta`
events, then `done`.

### On the threshold

`0.57` is not a guess. Measured across the test corpus with
`gemini-embedding-001`, off-topic questions peaked at **0.541** and on-topic
questions bottomed at **0.605**; the floor sits in that gap. It is model- and
corpus-dependent — an earlier value of 0.7 was falsely refusing five valid
questions once the embedding model changed.

`tests/integration/chat/retrieval-quality.test.js` re-measures that separation
against live Gemini and fails if it drifts:

```bash
RUN_AI_TESTS=1 npm test
```

That suite is opt-in because it needs an API key and spends quota. Everything
else runs against a deterministic fake provider — good enough to prove the
wiring, not good enough to prove retrieval quality, which is exactly why the
live suite exists.

## Storage

`STORAGE_DRIVER=local` writes to `STORAGE_LOCAL_PATH` for development.
`STORAGE_DRIVER=gcs` writes to a Google Cloud Storage bucket under the
`GCS_PREFIX` folder.

Object keys are date-first so a bucket listing sorts chronologically, and the
client's filename is slugged rather than used directly:

```
pdf/20260816-174502-a1b2c3d4-annual-report.pdf
```

Credentials come from `GCS_KEY_FILE` if set, otherwise Application Default
Credentials — which is what a GKE workload identity supplies, so production
needs no key file on disk.

Verify the bucket is reachable before pointing the API at it:

```bash
npm run gcs:check
```

## Observability

| Endpoint               | Where                   | Purpose                                     |
| ---------------------- | ----------------------- | ------------------------------------------- |
| `/metrics`             | api :3000, worker :9100 | Prometheus exposition                       |
| `/api/v1/docs`         | api                     | Swagger UI, try any endpoint in the browser |
| `/api/v1/openapi.json` | api                     | The raw OpenAPI 3.1 spec                    |

The worker serves no API traffic but runs its own metrics server — without it
the pipeline timings and queue depth are invisible.

Series worth knowing:

- `askpdf_ingest_stage_duration_seconds` — which of the five stages is slow
- `askpdf_queue_depth{state}` — read from Redis at scrape time, so it stays
  truthful when another process consumes a job. This is the signal to autoscale
  workers on, not CPU.
- `askpdf_retrieval_score{outcome}` — the histogram that lets
  `RETRIEVAL_MIN_SCORE` be tuned from real traffic instead of a fixture corpus
- `askpdf_chat_outcomes_total{outcome}` — refusal rate; a jump after a model
  change means the floor drifted
- `askpdf_embedded_texts_total` — a proxy for spend

The OpenAPI spec is hand-written and kept honest by a test: every route the
routers register must appear in it, and vice versa. Docs that lie are worse
than no docs, so drift fails the build.

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
