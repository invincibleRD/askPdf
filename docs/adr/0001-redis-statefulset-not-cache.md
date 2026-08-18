# ADR 0001: Redis is durable state, not a cache

## Status
Accepted

## Context
Redis in this service holds four things: the ingestion queue, the refresh-token
denylist, job-status hashes, and rate-limit counters. Two of those are not
rebuildable on loss:

- **Queue** — a lost message strands an upload. The reaper recovers it from
  MongoDB, but only if MongoDB still has the job; a Redis flush mid-flight can
  still lose the in-Redis message before the reaper's next pass.
- **Refresh-token denylist** — lose it and revoked tokens work again until their
  natural 30-day expiry. That is a security regression, not a performance one.

Job-status hashes and rate-limit counters are genuinely disposable.

Because two of the four are stateful, running Redis as a plain stateless
Deployment with no volume — the usual "cache" pattern — would silently
un-revoke tokens and drop queued jobs on any restart or reschedule.

## Decision
Run Redis as a **StatefulSet with a PVC and AOF persistence**
(`appendonly yes`, `maxmemory-policy noeviction`) in every environment where we
host it ourselves. `noeviction` is deliberate: under memory pressure Redis must
refuse writes rather than silently drop a queued job.

In production on GCP the same `REDIS_URL` can point at Memorystore instead,
which gives managed HA and backups. The application does not change — it only
reads `REDIS_URL` — so the choice is an env value, not a code change.

## Consequences
- No data loss across Redis restarts or pod rescheduling.
- `noeviction` means a full Redis rejects writes; queue-depth metrics and the
  dead-letter queue make that visible before it bites.
- Memorystore is the recommended production target once there are real users;
  the in-cluster StatefulSet is the zero-cost default until then.
