import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../../src/http/app.js';
import { useTestDatabase } from '../../helpers/db.js';
import { signedInUser, withAuth } from '../../helpers/auth.js';
import { createLocalDriver, setStorage } from '../../../src/infra/storage/index.js';
import { getRedis } from '../../../src/infra/redis/connection.js';
import { buildCorpusPdf, buildNotAPdf, buildTinyPdf } from '../../fixtures/pdf-builder.js';
import { CORPUS } from '../../fixtures/corpus.js';
import { DocumentStatus, ErrorCode, JobStatus } from '../../../src/config/constants.js';
import { Job } from '../../../src/modules/jobs/job.model.js';

useTestDatabase();

const app = createApp();
let storageRoot;
let storage;
let owner;

beforeEach(async () => {
  await getRedis().flushdb();
  storageRoot = await mkdtemp(join(tmpdir(), 'askpdf-storage-'));
  storage = createLocalDriver({ root: storageRoot });
  setStorage(storage);
  owner = await signedInUser();
});

afterAll(async () => {
  if (storageRoot) {
    await rm(storageRoot, { recursive: true, force: true });
  }
});

/** Posts a PDF buffer as multipart. */
function postPdf(buffer, { token = owner.tokens.accessToken, filename = 'report.pdf' } = {}) {
  return withAuth(request(app).post('/api/v1/documents'), token).attach('file', buffer, {
    filename,
    contentType: 'application/pdf',
  });
}

describe('POST /documents', () => {
  it('returns 202 with a job, not 201', async () => {
    const pdf = await buildCorpusPdf(CORPUS[0]);

    const response = await postPdf(pdf);

    // The row exists but is not usable yet; 202 is the honest status.
    expect(response.status).toBe(202);
    expect(response.body.document.status).toBe(DocumentStatus.PENDING);
    expect(response.body.job).toMatchObject({ status: JobStatus.QUEUED, progress: 0 });
  });

  it('writes the object under the pdf prefix with the date first', async () => {
    const pdf = await buildCorpusPdf(CORPUS[1]);

    const response = await postPdf(pdf, { filename: 'Quarterly Report.pdf' });

    const { storageKey } = response.body.document;
    expect(storageKey).toMatch(/^pdf\/\d{8}-\d{6}-[0-9a-f]{8}-quarterly-report\.pdf$/);
    await expect(storage.exists(storageKey)).resolves.toBe(true);
  });

  it('stores the exact bytes that were uploaded', async () => {
    const pdf = await buildCorpusPdf(CORPUS[2]);

    const response = await postPdf(pdf);

    const stored = await storage.get(response.body.document.storageKey);
    expect(stored.equals(pdf)).toBe(true);
  });

  it('records size and content hash', async () => {
    const pdf = await buildTinyPdf();

    const response = await postPdf(pdf);

    expect(response.body.document.byteSize).toBe(pdf.length);
    expect(response.body.document.contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('creates exactly one job per upload', async () => {
    const pdf = await buildCorpusPdf(CORPUS[3]);

    const response = await postPdf(pdf);

    await expect(Job.countDocuments({ documentId: response.body.document.id })).resolves.toBe(1);
  });

  it('reuses the original document when the same bytes are uploaded again', async () => {
    const pdf = await buildCorpusPdf(CORPUS[0]);

    const first = await postPdf(pdf);
    const second = await postPdf(pdf, { filename: 'different-name.pdf' });

    expect(second.status).toBe(202);
    expect(second.body.duplicate).toBe(true);
    expect(second.body.document.id).toBe(first.body.document.id);
  });

  it('lets a different user upload the same file', async () => {
    const other = await signedInUser();
    const pdf = await buildCorpusPdf(CORPUS[0]);

    await postPdf(pdf);
    const response = await postPdf(pdf, { token: other.tokens.accessToken });

    expect(response.body.duplicate).toBe(false);
  });
});

describe('POST /documents — rejections', () => {
  it('requires authentication', async () => {
    const pdf = await buildTinyPdf();

    const response = await request(app)
      .post('/api/v1/documents')
      .attach('file', pdf, { filename: 'a.pdf', contentType: 'application/pdf' });

    expect(response.status).toBe(401);
  });

  it('rejects a file that is not a PDF, whatever it claims to be', async () => {
    const response = await withAuth(
      request(app).post('/api/v1/documents'),
      owner.tokens.accessToken,
    ).attach('file', buildNotAPdf(), {
      filename: 'trojan.pdf',
      contentType: 'application/pdf',
    });

    expect(response.status).toBe(415);
    expect(response.body.error.code).toBe(ErrorCode.UNSUPPORTED_MEDIA_TYPE);
  });

  it('rejects a non-PDF content type outright', async () => {
    const response = await withAuth(
      request(app).post('/api/v1/documents'),
      owner.tokens.accessToken,
    ).attach('file', Buffer.from('hello'), { filename: 'a.txt', contentType: 'text/plain' });

    expect(response.status).toBe(415);
  });

  it('rejects an upload over the size limit with 413', async () => {
    // Valid header so it passes the magic check and fails only on size.
    const oversized = Buffer.concat([
      Buffer.from('%PDF-1.7\n'),
      Buffer.alloc(21 * 1024 * 1024, 0x20),
    ]);

    const response = await postPdf(oversized, { filename: 'huge.pdf' });

    expect(response.status).toBe(413);
    expect(response.body.error.details.limitBytes).toBe(20 * 1024 * 1024);
  });

  it('rejects a request with no file part', async () => {
    const response = await withAuth(
      request(app).post('/api/v1/documents'),
      owner.tokens.accessToken,
    ).field('title', 'no file here');

    expect(response.status).toBe(400);
  });

  it('rejects an empty file', async () => {
    const response = await postPdf(Buffer.alloc(0), { filename: 'empty.pdf' });

    expect(response.status).toBe(400);
  });

  it('rejects a non-multipart body', async () => {
    const response = await withAuth(
      request(app).post('/api/v1/documents'),
      owner.tokens.accessToken,
    ).send({ file: 'not-multipart' });

    expect(response.status).toBe(415);
  });

  it('leaves nothing in storage when the upload is rejected', async () => {
    await postPdf(buildNotAPdf(), { filename: 'trojan.pdf' });

    const response = await withAuth(
      request(app).get('/api/v1/documents'),
      owner.tokens.accessToken,
    );
    expect(response.body.items).toHaveLength(0);
  });
});

describe('GET /documents', () => {
  it('lists only the requesting user documents', async () => {
    const other = await signedInUser();
    await postPdf(await buildCorpusPdf(CORPUS[0]));
    await postPdf(await buildCorpusPdf(CORPUS[1]));
    await postPdf(await buildCorpusPdf(CORPUS[2]), { token: other.tokens.accessToken });

    const response = await withAuth(
      request(app).get('/api/v1/documents'),
      owner.tokens.accessToken,
    );

    expect(response.status).toBe(200);
    expect(response.body.items).toHaveLength(2);
  });

  it('paginates', async () => {
    for (const definition of CORPUS.slice(0, 3)) {
      await postPdf(await buildCorpusPdf(definition));
    }

    const page = await withAuth(
      request(app).get('/api/v1/documents?limit=2'),
      owner.tokens.accessToken,
    );

    expect(page.body.items).toHaveLength(2);
    expect(page.body.nextCursor).toBeTruthy();
  });

  it('rejects an unknown query parameter', async () => {
    const response = await withAuth(
      request(app).get('/api/v1/documents?evil=1'),
      owner.tokens.accessToken,
    );

    expect(response.status).toBe(400);
  });
});

describe('GET /documents/:id', () => {
  it('returns the document to its owner', async () => {
    const created = await postPdf(await buildCorpusPdf(CORPUS[0]));

    const response = await withAuth(
      request(app).get(`/api/v1/documents/${created.body.document.id}`),
      owner.tokens.accessToken,
    );

    expect(response.status).toBe(200);
    expect(response.body.document.id).toBe(created.body.document.id);
  });

  it('404s another user document rather than 403, so ids cannot be probed', async () => {
    const other = await signedInUser();
    const created = await postPdf(await buildCorpusPdf(CORPUS[0]));

    const response = await withAuth(
      request(app).get(`/api/v1/documents/${created.body.document.id}`),
      other.tokens.accessToken,
    );

    expect(response.status).toBe(404);
  });

  it('rejects a malformed id with 400', async () => {
    const response = await withAuth(
      request(app).get('/api/v1/documents/not-an-id'),
      owner.tokens.accessToken,
    );

    expect(response.status).toBe(400);
  });
});

describe('DELETE /documents/:id', () => {
  it('removes the document and its stored object', async () => {
    const created = await postPdf(await buildCorpusPdf(CORPUS[0]));
    const { id, storageKey } = created.body.document;

    const response = await withAuth(
      request(app).delete(`/api/v1/documents/${id}`),
      owner.tokens.accessToken,
    );

    expect(response.status).toBe(200);
    await expect(storage.exists(storageKey)).resolves.toBe(false);

    const after = await withAuth(
      request(app).get(`/api/v1/documents/${id}`),
      owner.tokens.accessToken,
    );
    expect(after.status).toBe(404);
  });

  it('will not delete another user document', async () => {
    const other = await signedInUser();
    const created = await postPdf(await buildCorpusPdf(CORPUS[0]));

    const response = await withAuth(
      request(app).delete(`/api/v1/documents/${created.body.document.id}`),
      other.tokens.accessToken,
    );

    expect(response.status).toBe(404);
  });

  it('frees the content hash so the file can be uploaded again', async () => {
    const pdf = await buildCorpusPdf(CORPUS[0]);
    const created = await postPdf(pdf);

    await withAuth(
      request(app).delete(`/api/v1/documents/${created.body.document.id}`),
      owner.tokens.accessToken,
    );
    const reupload = await postPdf(pdf);

    expect(reupload.status).toBe(202);
    expect(reupload.body.duplicate).toBe(false);
    expect(reupload.body.document.id).not.toBe(created.body.document.id);
  });
});
