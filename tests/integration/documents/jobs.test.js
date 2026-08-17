import { beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../../src/http/app.js';
import { useTestDatabase } from '../../helpers/db.js';
import { signedInUser, withAuth } from '../../helpers/auth.js';
import { createLocalDriver, setStorage } from '../../../src/infra/storage/index.js';
import { getRedis } from '../../../src/infra/redis/connection.js';
import { buildCorpusPdf } from '../../fixtures/pdf-builder.js';
import { CORPUS } from '../../fixtures/corpus.js';
import { JobStatus } from '../../../src/config/constants.js';

useTestDatabase();

const app = createApp();
let owner;

beforeEach(async () => {
  await getRedis().flushdb();
  setStorage(createLocalDriver({ root: await mkdtemp(join(tmpdir(), 'askpdf-jobs-')) }));
  owner = await signedInUser();
});

function upload(token = owner.tokens.accessToken) {
  return buildCorpusPdf(CORPUS[0]).then((pdf) =>
    withAuth(request(app).post('/api/v1/documents'), token).attach('file', pdf, {
      filename: 'report.pdf',
      contentType: 'application/pdf',
    }),
  );
}

describe('GET /jobs/:id', () => {
  it('reports the job a client can poll after upload', async () => {
    const created = await upload();

    const response = await withAuth(
      request(app).get(`/api/v1/jobs/${created.body.job.id}`),
      owner.tokens.accessToken,
    );

    expect(response.status).toBe(200);
    expect(response.body.job).toMatchObject({
      status: JobStatus.QUEUED,
      progress: 0,
      documentId: created.body.document.id,
    });
  });

  it('carries the request id that created it, so both processes share a trace', async () => {
    const pdf = await buildCorpusPdf(CORPUS[1]);
    const created = await withAuth(request(app).post('/api/v1/documents'), owner.tokens.accessToken)
      .set('x-request-id', 'trace-upload-1')
      .attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });

    const response = await withAuth(
      request(app).get(`/api/v1/jobs/${created.body.job.id}`),
      owner.tokens.accessToken,
    );

    expect(response.body.job.requestId).toBe('trace-upload-1');
  });

  it('404s another user job', async () => {
    const other = await signedInUser();
    const created = await upload();

    const response = await withAuth(
      request(app).get(`/api/v1/jobs/${created.body.job.id}`),
      other.tokens.accessToken,
    );

    expect(response.status).toBe(404);
  });
});

describe('GET /jobs', () => {
  it('lists only the requesting user jobs', async () => {
    const other = await signedInUser();
    await upload();
    await upload(other.tokens.accessToken);

    const response = await withAuth(request(app).get('/api/v1/jobs'), owner.tokens.accessToken);

    expect(response.body.items).toHaveLength(1);
  });
});
