import { beforeAll, describe, expect, it } from 'vitest';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import request from 'supertest';
import { createApp } from '../../../src/http/app.js';
import { useTestDatabase } from '../../helpers/db.js';
import { signedInUser, withAuth } from '../../helpers/auth.js';
import { createLocalDriver, setStorage } from '../../../src/infra/storage/index.js';
import { createFakeProvider, embedBatched, setAiProvider } from '../../../src/infra/ai/index.js';
import { getRedis } from '../../../src/infra/redis/connection.js';
import { drainQueue } from '../../../src/queue/queue.js';
import { buildCorpusPdf } from '../../fixtures/pdf-builder.js';
import { CORPUS } from '../../fixtures/corpus.js';
import { DocumentStatus, ErrorCode } from '../../../src/config/constants.js';
import { env } from '../../../src/config/env.js';
import { chunkPages } from '../../../src/pipeline/chunk.js';
import { parsePdf } from '../../../src/pipeline/parse.js';
import { insertChunks } from '../../../src/modules/documents/chunk.repository.js';
import { markDocumentReady } from '../../../src/modules/documents/document.repository.js';

// The corpus is built once and only read, so it must survive between tests.
useTestDatabase({ clearBetweenTests: false });

const app = createApp();

/**
 * Small window on purpose: the fixtures fit one default-sized chunk each, and
 * a single-chunk document can't show whether ranking works.
 */
const CHUNK_OPTIONS = { chunkTokens: 48, overlapTokens: 8 };

let alice;
let bob;
const owned = { alice: {}, bob: {} };

/** Ingests directly — the worker path has its own suite. */
async function ingest(user, definition, key) {
  const pdf = await buildCorpusPdf(definition);

  const created = await withAuth(
    request(app).post('/api/v1/documents'),
    user.tokens.accessToken,
  ).attach('file', pdf, { filename: `${definition.slug}.pdf`, contentType: 'application/pdf' });

  const documentId = created.body.document.id;
  const { pages, pageCount, title } = await parsePdf(pdf);
  const chunks = chunkPages(pages, CHUNK_OPTIONS);
  const vectors = await embedBatched(chunks.map((c) => c.text));

  await insertChunks(
    chunks.map((chunk, i) => ({
      documentId,
      ownerId: user.user.id,
      index: chunk.index,
      text: chunk.text,
      tokenCount: chunk.tokenCount,
      pageStart: chunk.pageStart,
      pageEnd: chunk.pageEnd,
      embedding: vectors[i],
    })),
  );

  await markDocumentReady(documentId, { pageCount, chunkCount: chunks.length, title });
  owned[key][definition.slug] = documentId;
  return documentId;
}

beforeAll(async () => {
  await getRedis().flushdb();
  await drainQueue();
  setStorage(createLocalDriver({ root: await mkdtemp(join(tmpdir(), 'askpdf-rag-')) }));
  setAiProvider(createFakeProvider());

  alice = await signedInUser();
  bob = await signedInUser();

  for (const definition of CORPUS) {
    await ingest(alice, definition, 'alice');
  }
  await ingest(bob, CORPUS[0], 'bob');
}, 120_000);

const askAs = (user, body) =>
  withAuth(request(app).post('/api/v1/chat'), user.tokens.accessToken).send(body);

describe('retrieval precision', () => {
  it('produced several chunks per document, so ranking is exercised', async () => {
    const response = await withAuth(
      request(app).get(`/api/v1/documents/${owned.alice[CORPUS[0].slug]}`),
      alice.tokens.accessToken,
    );

    expect(response.body.document.chunkCount).toBeGreaterThan(2);
  });

  it.each(CORPUS.map((doc) => [doc.slug, doc.probes.expected[0]]))(
    '%s returns an answer with citations',
    async (slug, probe) => {
      const response = await askAs(alice, {
        documentId: owned.alice[slug],
        question: probe.question,
      });

      expect(response.status).toBe(200);
      expect(response.body.answer).toBeTruthy();
      expect(response.body.citations.length).toBeGreaterThan(0);
      expect(response.body.conversationId).toBeTruthy();
    },
  );

  it('never returns a citation below the configured floor', async () => {
    const response = await askAs(alice, {
      documentId: owned.alice[CORPUS[1].slug],
      question: CORPUS[1].probes.expected[0].question,
    });

    for (const citation of response.body.citations) {
      expect(citation.score).toBeGreaterThanOrEqual(env.RETRIEVAL_MIN_SCORE);
    }
  });

  it('cites real page numbers within the document', async () => {
    const response = await askAs(alice, {
      documentId: owned.alice[CORPUS[3].slug],
      question: CORPUS[3].probes.expected[0].question,
    });

    for (const citation of response.body.citations) {
      expect(citation.pageStart).toBeGreaterThanOrEqual(1);
      expect(citation.pageStart).toBeLessThanOrEqual(CORPUS[3].pages.length);
    }
  });
});

describe('hallucination guard', () => {
  // Semantic separation is proven against real embeddings in
  // retrieval-quality.test.js; here the gate is forced with a question that
  // shares no vocabulary with any document, so the plumbing is what is tested.
  const UNRELATED = 'zzzz qqqq xylophone wombat kaleidoscope';

  it('refuses with a machine-readable code rather than inventing an answer', async () => {
    const response = await askAs(alice, {
      documentId: owned.alice[CORPUS[0].slug],
      question: UNRELATED,
    });

    expect(response.status).toBe(422);
    expect(response.body.error.code).toBe(ErrorCode.NO_RELEVANT_CONTEXT);
    expect(response.body.error.details.threshold).toBe(env.RETRIEVAL_MIN_SCORE);
    expect(response.body.error.details.bestScore).toBeLessThan(env.RETRIEVAL_MIN_SCORE);
  });

  it('records the refusal as a turn so the user sees it in history', async () => {
    const documentId = owned.alice[CORPUS[2].slug];

    await askAs(alice, { documentId, question: UNRELATED });

    const list = await withAuth(
      request(app).get(`/api/v1/chat/conversations?documentId=${documentId}`),
      alice.tokens.accessToken,
    );
    const conversation = await withAuth(
      request(app).get(`/api/v1/chat/conversations/${list.body.items[0].id}`),
      alice.tokens.accessToken,
    );

    const assistant = conversation.body.conversation.messages.at(-1);
    expect(assistant.refused).toBe(true);
    expect(assistant.content).toMatch(/could not find/i);
  });
});

describe('cross-user isolation', () => {
  it('will not answer questions about another user document', async () => {
    const response = await askAs(bob, {
      documentId: owned.alice[CORPUS[1].slug],
      question: CORPUS[1].probes.expected[0].question,
    });

    expect(response.status).toBe(404);
  });

  it('answers from the asker own copy', async () => {
    const response = await askAs(bob, {
      documentId: owned.bob[CORPUS[0].slug],
      question: CORPUS[0].probes.expected[0].question,
    });

    expect(response.status).toBe(200);
    expect(response.body.citations.length).toBeGreaterThan(0);
  });

  it('will not open another user conversation', async () => {
    const documentId = owned.alice[CORPUS[0].slug];
    const asked = await askAs(alice, {
      documentId,
      question: CORPUS[0].probes.expected[0].question,
    });

    const response = await withAuth(
      request(app).get(`/api/v1/chat/conversations/${asked.body.conversationId}`),
      bob.tokens.accessToken,
    );

    expect(response.status).toBe(404);
  });
});

describe('conversations', () => {
  it('continues an existing conversation when given its id', async () => {
    const documentId = owned.alice[CORPUS[0].slug];

    const first = await askAs(alice, {
      documentId,
      question: CORPUS[0].probes.expected[0].question,
    });
    const second = await askAs(alice, {
      documentId,
      question: CORPUS[0].probes.expected[1].question,
      conversationId: first.body.conversationId,
    });

    expect(second.body.conversationId).toBe(first.body.conversationId);

    const conversation = await withAuth(
      request(app).get(`/api/v1/chat/conversations/${first.body.conversationId}`),
      alice.tokens.accessToken,
    );
    expect(conversation.body.conversation.messages).toHaveLength(4);
  });

  it('rejects a question against a document that is still processing', async () => {
    const pdf = await buildCorpusPdf(CORPUS[2]);
    const created = await withAuth(
      request(app).post('/api/v1/documents'),
      alice.tokens.accessToken,
    ).attach('file', pdf, { filename: 'pending.pdf', contentType: 'application/pdf' });

    const response = await askAs(alice, {
      documentId: created.body.document.id,
      question: 'anything',
    });

    expect(response.status).toBe(409);
    expect(response.body.error.code).toBe(ErrorCode.DOCUMENT_NOT_READY);
    expect(response.body.error.details.status).toBe(DocumentStatus.PENDING);
  });

  it('rejects an empty question', async () => {
    const response = await askAs(alice, {
      documentId: owned.alice[CORPUS[0].slug],
      question: '   ',
    });

    expect(response.status).toBe(400);
  });
});
