import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../../src/http/app.js';
import { useTestDatabase } from '../../helpers/db.js';
import { signedInUser, withAuth } from '../../helpers/auth.js';
import { createLocalDriver, setStorage } from '../../../src/infra/storage/index.js';
import { createFakeProvider, setAiProvider } from '../../../src/infra/ai/index.js';
import { getRedis } from '../../../src/infra/redis/connection.js';
import { createConsumer } from '../../../src/queue/consumer.js';
import { drainQueue, getJobStatus, queueDepth } from '../../../src/queue/queue.js';
import { reapAbandonedJobs } from '../../../src/queue/reaper.js';
import { buildCorpusPdf, buildImageOnlyPdf } from '../../fixtures/pdf-builder.js';
import { CORPUS } from '../../fixtures/corpus.js';
import { DocumentStatus, JobStatus } from '../../../src/config/constants.js';
import { Chunk } from '../../../src/modules/documents/chunk.model.js';
import { Job } from '../../../src/modules/jobs/job.model.js';
import { env } from '../../../src/config/env.js';

useTestDatabase();

const app = createApp();
let owner;
let consumer;

beforeEach(async () => {
  await getRedis().flushdb();
  await drainQueue();
  setStorage(createLocalDriver({ root: await mkdtemp(join(tmpdir(), 'askpdf-worker-')) }));
  setAiProvider(createFakeProvider());
  owner = await signedInUser();
});

afterEach(async () => {
  const running = consumer;
  consumer = undefined;
  await running?.stop({ timeoutMs: 2_000 });
});

function upload(definition, token = owner.tokens.accessToken) {
  return buildCorpusPdf(definition).then((pdf) =>
    withAuth(request(app).post('/api/v1/documents'), token).attach('file', pdf, {
      filename: `${definition.slug}.pdf`,
      contentType: 'application/pdf',
    }),
  );
}

/**
 * Polls until the document reaches a settled state.
 *
 * `until` matters for the retry case: a transient failure sets FAILED before
 * the retry runs, so "anything but processing" would return too early.
 */
async function waitForStatus(documentId, token, { timeoutMs = 20_000, until } = {}) {
  const deadline = Date.now() + timeoutMs;
  const settled = until ? [until] : [DocumentStatus.READY, DocumentStatus.FAILED];
  let last;

  while (Date.now() < deadline) {
    const response = await withAuth(request(app).get(`/api/v1/documents/${documentId}`), token);
    last = response.body.document;

    if (settled.includes(last.status)) {
      return last;
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  throw new Error(`Document stuck at "${last?.status}" after ${String(timeoutMs)}ms`);
}

describe('end to end ingestion', () => {
  it('takes an upload all the way to ready', async () => {
    const created = await upload(CORPUS[0]);
    expect(created.body.document.status).toBe(DocumentStatus.PENDING);

    consumer = createConsumer({ concurrency: 1 });
    consumer.start();

    const document = await waitForStatus(created.body.document.id, owner.tokens.accessToken);

    expect(document.status).toBe(DocumentStatus.READY);
    expect(document.pageCount).toBe(CORPUS[0].pages.length);
    expect(document.chunkCount).toBeGreaterThan(0);
    expect(document.title).toBe(CORPUS[0].title);
    expect(document.stage).toBeNull();
  });

  it('writes chunks with embeddings of the configured dimensionality', async () => {
    const created = await upload(CORPUS[1]);
    consumer = createConsumer({ concurrency: 1 });
    consumer.start();

    const document = await waitForStatus(created.body.document.id, owner.tokens.accessToken);

    const chunks = await Chunk.find({ documentId: document.id }).lean();
    expect(chunks).toHaveLength(document.chunkCount);
    expect(chunks[0].embedding).toHaveLength(env.EMBEDDING_DIMENSIONS);
    expect(chunks[0].ownerId.toString()).toBe(owner.user.id);
    expect(chunks.every((c) => c.pageStart >= 1)).toBe(true);
  });

  it('marks the job completed at full progress', async () => {
    const created = await upload(CORPUS[2]);
    consumer = createConsumer({ concurrency: 1 });
    consumer.start();

    await waitForStatus(created.body.document.id, owner.tokens.accessToken);

    const job = await Job.findById(created.body.job.id).lean();
    expect(job.status).toBe(JobStatus.COMPLETED);
    expect(job.progress).toBe(100);
    expect(job.finishedAt).toBeInstanceOf(Date);
  });

  it('mirrors job state into redis so polling avoids mongo', async () => {
    const created = await upload(CORPUS[3]);
    consumer = createConsumer({ concurrency: 1 });
    consumer.start();

    await waitForStatus(created.body.document.id, owner.tokens.accessToken);

    const status = await getJobStatus(created.body.job.id);
    expect(status).toMatchObject({ status: JobStatus.COMPLETED, progress: '100' });
  });

  it('processes several documents concurrently', async () => {
    const uploads = [];
    for (const definition of CORPUS) {
      uploads.push(await upload(definition));
    }

    consumer = createConsumer({ concurrency: 3 });
    consumer.start();

    const documents = await Promise.all(
      uploads.map((u) => waitForStatus(u.body.document.id, owner.tokens.accessToken)),
    );

    expect(documents.every((d) => d.status === DocumentStatus.READY)).toBe(true);
    await expect(queueDepth()).resolves.toMatchObject({ ready: 0 });
  });

  it('keeps one user chunks out of another user document', async () => {
    const other = await signedInUser();
    const mine = await upload(CORPUS[0]);
    const theirs = await upload(CORPUS[1], other.tokens.accessToken);

    consumer = createConsumer({ concurrency: 2 });
    consumer.start();

    await waitForStatus(mine.body.document.id, owner.tokens.accessToken);
    await waitForStatus(theirs.body.document.id, other.tokens.accessToken);

    const mineChunks = await Chunk.find({ documentId: mine.body.document.id }).lean();
    expect(mineChunks.every((c) => c.ownerId.toString() === owner.user.id)).toBe(true);
  });
});

describe('failure handling', () => {
  it('fails a scanned PDF without retrying, and leaves no chunks behind', async () => {
    const pdf = await buildImageOnlyPdf();
    const created = await withAuth(
      request(app).post('/api/v1/documents'),
      owner.tokens.accessToken,
    ).attach('file', pdf, { filename: 'scan.pdf', contentType: 'application/pdf' });

    consumer = createConsumer({ concurrency: 1 });
    consumer.start();

    const document = await waitForStatus(created.body.document.id, owner.tokens.accessToken);

    expect(document.status).toBe(DocumentStatus.FAILED);
    expect(document.failure.message).toMatch(/scanned|OCR/i);

    // Not retryable, so it goes straight to dead rather than burning attempts.
    const job = await Job.findById(created.body.job.id).lean();
    expect(job.status).toBe(JobStatus.DEAD);
    expect(job.attempts).toBe(1);

    await expect(Chunk.countDocuments({ documentId: document.id })).resolves.toBe(0);
    await expect(queueDepth()).resolves.toMatchObject({ dead: 1 });
  });

  it('retries a transient failure and succeeds on the next attempt', async () => {
    let calls = 0;
    const flaky = createFakeProvider();
    const realEmbed = flaky.embed.bind(flaky);
    flaky.embed = (texts) => {
      calls += 1;
      if (calls === 1) {
        return Promise.reject(Object.assign(new Error('rate limit exceeded'), { status: 429 }));
      }
      return realEmbed(texts);
    };
    setAiProvider(flaky);

    const created = await upload(CORPUS[0]);
    consumer = createConsumer({ concurrency: 1 });
    consumer.start();

    const document = await waitForStatus(created.body.document.id, owner.tokens.accessToken, {
      timeoutMs: 30_000,
      until: DocumentStatus.READY,
    });

    expect(document.status).toBe(DocumentStatus.READY);
    const job = await Job.findById(created.body.job.id).lean();
    expect(job.attempts).toBeGreaterThan(1);
  });

  it('discards a job whose document was deleted before pickup', async () => {
    const created = await upload(CORPUS[0]);

    await withAuth(
      request(app).delete(`/api/v1/documents/${created.body.document.id}`),
      owner.tokens.accessToken,
    );

    consumer = createConsumer({ concurrency: 1 });
    consumer.start();

    await expect
      .poll(async () => (await Job.findById(created.body.job.id).lean()).status, {
        timeout: 10_000,
      })
      .toBe(JobStatus.DEAD);
  });
});

describe('reaper', () => {
  it('requeues a job whose worker stopped reporting', async () => {
    const created = await upload(CORPUS[0]);
    const jobId = created.body.job.id;

    // Simulate a worker that claimed the job and then died.
    await Job.updateOne(
      { _id: jobId },
      {
        $set: {
          status: JobStatus.ACTIVE,
          claimedBy: 'worker-that-died',
          heartbeatAt: new Date(Date.now() - 600_000),
          attempts: 1,
        },
      },
    );
    await drainQueue();

    const result = await reapAbandonedJobs({ visibilityTimeoutMs: 300_000 });

    expect(result).toMatchObject({ reaped: 1, requeued: 1 });
    await expect(queueDepth()).resolves.toMatchObject({ ready: 1 });

    const job = await Job.findById(jobId).lean();
    expect(job.status).toBe(JobStatus.QUEUED);
    // Attempts are preserved, so retries stay bounded.
    expect(job.attempts).toBe(1);
  });

  it('recovers the document to ready once a worker picks the requeued job up', async () => {
    const created = await upload(CORPUS[1]);

    await Job.updateOne(
      { _id: created.body.job.id },
      {
        $set: {
          status: JobStatus.ACTIVE,
          claimedBy: 'worker-that-died',
          heartbeatAt: new Date(Date.now() - 600_000),
          attempts: 1,
        },
      },
    );
    await drainQueue();
    await reapAbandonedJobs({ visibilityTimeoutMs: 300_000 });

    consumer = createConsumer({ concurrency: 1 });
    consumer.start();

    const document = await waitForStatus(created.body.document.id, owner.tokens.accessToken);
    expect(document.status).toBe(DocumentStatus.READY);
  });

  it('kills an abandoned job that already used its attempts', async () => {
    const created = await upload(CORPUS[2]);

    await Job.updateOne(
      { _id: created.body.job.id },
      {
        $set: {
          status: JobStatus.ACTIVE,
          heartbeatAt: new Date(Date.now() - 600_000),
          attempts: env.QUEUE_MAX_ATTEMPTS,
        },
      },
    );

    const result = await reapAbandonedJobs({ visibilityTimeoutMs: 300_000 });

    expect(result).toMatchObject({ dead: 1, requeued: 0 });
    const document = await withAuth(
      request(app).get(`/api/v1/documents/${created.body.document.id}`),
      owner.tokens.accessToken,
    );
    expect(document.body.document.status).toBe(DocumentStatus.FAILED);
  });

  it('ignores jobs whose heartbeat is current', async () => {
    await upload(CORPUS[0]);

    await expect(reapAbandonedJobs({ visibilityTimeoutMs: 300_000 })).resolves.toMatchObject({
      reaped: 0,
    });
  });
});
