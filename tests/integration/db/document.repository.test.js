import { beforeEach, describe, expect, it } from 'vitest';
import { useTestDatabase } from '../../helpers/db.js';
import { buildDocument, createTestDocument, createTestUser } from '../../helpers/factories.js';
import {
  countDocumentsForOwner,
  createDocument,
  findDocumentByContentHash,
  findDocumentForOwner,
  findStalledDocuments,
  listDocumentsForOwner,
  markDocumentFailed,
  markDocumentProcessing,
  markDocumentReady,
  softDeleteDocument,
} from '../../../src/modules/documents/document.repository.js';
import { Document } from '../../../src/modules/documents/document.model.js';
import { DocumentStatus, PipelineStage } from '../../../src/config/constants.js';
import { ConflictError } from '../../../src/core/errors.js';

useTestDatabase();

let owner;
let otherOwner;

beforeEach(async () => {
  owner = await createTestUser();
  otherOwner = await createTestUser();
});

describe('createDocument', () => {
  it('starts a document in the pending state', async () => {
    const document = await createTestDocument(owner.id);

    expect(document.status).toBe(DocumentStatus.PENDING);
    expect(document.chunkCount).toBe(0);
    expect(document.id).toBeTruthy();
    expect(document._id).toBeUndefined();
  });

  it('rejects a second upload of identical bytes by the same user', async () => {
    const input = buildDocument(owner.id);
    await createDocument(input);

    await expect(
      createDocument(buildDocument(owner.id, { contentHash: input.contentHash })),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it('lets two different users upload the same file', async () => {
    const input = buildDocument(owner.id);
    await createDocument(input);

    const second = await createDocument(
      buildDocument(otherOwner.id, { contentHash: input.contentHash }),
    );

    expect(second.id).toBeTruthy();
  });

  it('frees the content hash once a document is deleted', async () => {
    const input = buildDocument(owner.id);
    const first = await createDocument(input);
    await softDeleteDocument(first.id, owner.id);

    const second = await createDocument(
      buildDocument(owner.id, { contentHash: input.contentHash }),
    );

    expect(second.id).not.toBe(first.id);
  });
});

describe('findDocumentForOwner', () => {
  it('returns a document to its owner', async () => {
    const document = await createTestDocument(owner.id);

    await expect(findDocumentForOwner(document.id, owner.id)).resolves.toMatchObject({
      id: document.id,
    });
  });

  it('hides another user document behind the same null as a missing one', async () => {
    const document = await createTestDocument(owner.id);

    // Identical response for "not yours" and "does not exist", so probing ids
    // leaks nothing.
    await expect(findDocumentForOwner(document.id, otherOwner.id)).resolves.toBeNull();
  });

  it('returns null for a malformed id instead of throwing a cast error', async () => {
    await expect(findDocumentForOwner('not-an-object-id', owner.id)).resolves.toBeNull();
  });

  it('does not return a soft-deleted document', async () => {
    const document = await createTestDocument(owner.id);
    await softDeleteDocument(document.id, owner.id);

    await expect(findDocumentForOwner(document.id, owner.id)).resolves.toBeNull();
  });
});

describe('findDocumentByContentHash', () => {
  it('finds an existing upload of the same bytes, so it need not be embedded twice', async () => {
    const input = buildDocument(owner.id);
    const created = await createDocument(input);

    await expect(findDocumentByContentHash(owner.id, input.contentHash)).resolves.toMatchObject({
      id: created.id,
    });
  });

  it('is scoped to the user, so one upload does not reveal another user file', async () => {
    const input = buildDocument(owner.id);
    await createDocument(input);

    await expect(findDocumentByContentHash(otherOwner.id, input.contentHash)).resolves.toBeNull();
  });

  it('ignores a deleted document so the file can be uploaded again', async () => {
    const input = buildDocument(owner.id);
    const created = await createDocument(input);
    await softDeleteDocument(created.id, owner.id);

    await expect(findDocumentByContentHash(owner.id, input.contentHash)).resolves.toBeNull();
  });
});

describe('listDocumentsForOwner', () => {
  it('returns only the requesting user documents, newest first', async () => {
    const first = await createTestDocument(owner.id);
    const second = await createTestDocument(owner.id);
    await createTestDocument(otherOwner.id);

    const { items } = await listDocumentsForOwner(owner.id);

    expect(items.map((doc) => doc.id)).toEqual([second.id, first.id]);
  });

  it('paginates with a cursor and stops cleanly at the end', async () => {
    const created = [];
    for (let i = 0; i < 5; i += 1) {
      created.push(await createTestDocument(owner.id));
    }

    const firstPage = await listDocumentsForOwner(owner.id, { limit: 2 });
    const secondPage = await listDocumentsForOwner(owner.id, {
      limit: 2,
      cursor: firstPage.nextCursor,
    });
    const thirdPage = await listDocumentsForOwner(owner.id, {
      limit: 2,
      cursor: secondPage.nextCursor,
    });

    expect(firstPage.items).toHaveLength(2);
    expect(secondPage.items).toHaveLength(2);
    expect(thirdPage.items).toHaveLength(1);
    expect(thirdPage.nextCursor).toBeNull();

    const seen = [...firstPage.items, ...secondPage.items, ...thirdPage.items].map((d) => d.id);
    expect(new Set(seen).size).toBe(5);
  });

  it('filters by status', async () => {
    const ready = await createTestDocument(owner.id);
    await createTestDocument(owner.id);
    await markDocumentProcessing(ready.id);
    await markDocumentReady(ready.id, { pageCount: 3, chunkCount: 9 });

    const { items } = await listDocumentsForOwner(owner.id, { status: DocumentStatus.READY });

    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(ready.id);
  });

  it('returns an empty page for a user with nothing', async () => {
    await expect(listDocumentsForOwner(owner.id)).resolves.toEqual({ items: [], nextCursor: null });
  });
});

describe('status transitions', () => {
  it('moves pending to processing and stamps the start time', async () => {
    const document = await createTestDocument(owner.id);

    const updated = await markDocumentProcessing(document.id);

    expect(updated.status).toBe(DocumentStatus.PROCESSING);
    expect(updated.processingStartedAt).toBeInstanceOf(Date);
  });

  it('refuses to claim a document that is already processing', async () => {
    const document = await createTestDocument(owner.id);
    await markDocumentProcessing(document.id);

    // The second worker loses the race and gets null rather than stealing it.
    await expect(markDocumentProcessing(document.id)).resolves.toBeNull();
  });

  it('allows a failed document to be retried', async () => {
    const document = await createTestDocument(owner.id);
    await markDocumentProcessing(document.id);
    await markDocumentFailed(document.id, { stage: PipelineStage.EMBED, message: 'rate limited' });

    const retried = await markDocumentProcessing(document.id);

    expect(retried.status).toBe(DocumentStatus.PROCESSING);
    // A retry starts clean rather than carrying the previous failure.
    expect(retried.failure).toBeNull();
  });

  it('records counts and clears the stage when ready', async () => {
    const document = await createTestDocument(owner.id);
    await markDocumentProcessing(document.id);

    const ready = await markDocumentReady(document.id, {
      pageCount: 12,
      chunkCount: 48,
      title: 'Annual Report',
    });

    expect(ready).toMatchObject({
      status: DocumentStatus.READY,
      pageCount: 12,
      chunkCount: 48,
      title: 'Annual Report',
      stage: null,
    });
    expect(ready.processedAt).toBeInstanceOf(Date);
  });

  it('records which stage failed and why', async () => {
    const document = await createTestDocument(owner.id);

    const failed = await markDocumentFailed(document.id, {
      stage: PipelineStage.PARSE,
      message: 'encrypted pdf',
      attempts: 2,
    });

    expect(failed.status).toBe(DocumentStatus.FAILED);
    expect(failed.failure).toMatchObject({
      stage: PipelineStage.PARSE,
      message: 'encrypted pdf',
      attempts: 2,
    });
  });

  it('truncates an enormous failure message rather than rejecting the write', async () => {
    const document = await createTestDocument(owner.id);

    const failed = await markDocumentFailed(document.id, { message: 'x'.repeat(5_000) });

    expect(failed.failure.message).toHaveLength(2_000);
  });
});

describe('softDeleteDocument', () => {
  it('reports success once and refuses a second delete', async () => {
    const document = await createTestDocument(owner.id);

    await expect(softDeleteDocument(document.id, owner.id)).resolves.toBe(true);
    await expect(softDeleteDocument(document.id, owner.id)).resolves.toBe(false);
  });

  it('will not delete another user document', async () => {
    const document = await createTestDocument(owner.id);

    await expect(softDeleteDocument(document.id, otherOwner.id)).resolves.toBe(false);
    await expect(findDocumentForOwner(document.id, owner.id)).resolves.not.toBeNull();
  });
});

describe('findStalledDocuments', () => {
  it('finds documents stuck in processing past the deadline', async () => {
    const stalled = await createTestDocument(owner.id);
    const healthy = await createTestDocument(owner.id);
    await markDocumentProcessing(stalled.id);
    await markDocumentProcessing(healthy.id);

    // Backdate one so it looks like a worker died holding it.
    await Document.updateOne(
      { _id: stalled.id },
      { $set: { processingStartedAt: new Date(Date.now() - 600_000) } },
    );

    const found = await findStalledDocuments(300_000);

    expect(found.map((doc) => doc.id)).toEqual([stalled.id]);
  });

  it('ignores documents that are not processing', async () => {
    await createTestDocument(owner.id);

    await expect(findStalledDocuments(0)).resolves.toEqual([]);
  });
});

describe('countDocumentsForOwner', () => {
  it('counts only live documents for that user', async () => {
    const first = await createTestDocument(owner.id);
    await createTestDocument(owner.id);
    await createTestDocument(otherOwner.id);
    await softDeleteDocument(first.id, owner.id);

    await expect(countDocumentsForOwner(owner.id)).resolves.toBe(1);
  });
});
