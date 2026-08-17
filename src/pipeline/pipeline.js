import { PIPELINE_STAGES, PipelineStage } from '../config/constants.js';
import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';
import { embedBatched } from '../infra/ai/index.js';
import { getStorage } from '../infra/storage/index.js';
import { deleteChunksForDocument, insertChunks } from '../modules/documents/chunk.repository.js';
import {
  markDocumentFailed,
  markDocumentProcessing,
  markDocumentReady,
  updateDocumentStage,
} from '../modules/documents/document.repository.js';
import {
  chunksIndexed,
  pipelineDuration,
  pipelineFailures,
  pipelineStageDuration,
} from '../infra/metrics/registry.js';
import { chunkPages } from './chunk.js';
import { parsePdf } from './parse.js';

const log = createLogger('pipeline');

/**
 * The five-stage ingestion pipeline.
 *
 * parse → chunk → embed → index → finalize
 *
 * Each stage reports progress before it starts, so a client polling job status
 * sees movement rather than a long silence. Any failure runs the compensating
 * cleanup: partial chunks are deleted and the document is marked failed, so a
 * retry starts from a clean slate instead of colliding with half-written rows.
 *
 * @param {{ documentId: string, ownerId: string, storageKey: string }} input
 * @param {{ onStage?: (stage: string) => Promise<void>, signal?: AbortSignal }} [hooks]
 */
export async function runPipeline({ documentId, ownerId, storageKey }, { onStage, signal } = {}) {
  const startedAt = Date.now();

  const claimed = await markDocumentProcessing(documentId);
  if (!claimed) {
    // Another worker already has it, or it is already finished.
    log.warn({ documentId }, 'document is not claimable, skipping');
    return { skipped: true };
  }

  // Each stage is timed by closing out the previous one on entry, so the
  // histogram reflects real stage boundaries rather than wall clock guesses.
  let currentStage = null;
  let stageStartedAt = 0;

  const closeStage = () => {
    if (currentStage) {
      pipelineStageDuration.observe({ stage: currentStage }, (Date.now() - stageStartedAt) / 1000);
    }
  };

  const enter = async (stage) => {
    throwIfAborted(signal);
    closeStage();
    currentStage = stage;
    stageStartedAt = Date.now();

    await updateDocumentStage(documentId, stage);
    await onStage?.(stage);
    log.debug({ documentId, stage }, 'stage started');
  };

  try {
    await enter(PipelineStage.PARSE);
    const buffer = await getStorage().get(storageKey);
    const { pages, pageCount, title } = await parsePdf(buffer);

    await enter(PipelineStage.CHUNK);
    const chunks = chunkPages(pages);

    if (chunks.length === 0) {
      throw Object.assign(new Error('Document produced no chunks'), { retryable: false });
    }

    await enter(PipelineStage.EMBED);
    const vectors = await embedBatched(
      chunks.map((chunk) => chunk.text),
      {
        onProgress: (done, total) => {
          log.debug({ documentId, done, total }, 'embedding progress');
        },
      },
    );

    await enter(PipelineStage.INDEX);
    throwIfAborted(signal);
    // A previous attempt may have written some of these; the unique
    // {documentId, index} would reject the insert otherwise.
    await deleteChunksForDocument(documentId);
    await insertChunks(
      chunks.map((chunk, i) => ({
        documentId,
        ownerId,
        index: chunk.index,
        text: chunk.text,
        tokenCount: chunk.tokenCount,
        pageStart: chunk.pageStart,
        pageEnd: chunk.pageEnd,
        embedding: vectors[i],
      })),
    );

    await enter(PipelineStage.FINALIZE);
    const document = await markDocumentReady(documentId, {
      pageCount,
      chunkCount: chunks.length,
      ...(title ? { title } : {}),
    });

    closeStage();
    const durationMs = Date.now() - startedAt;
    chunksIndexed.inc(chunks.length);
    pipelineDuration.observe({ outcome: 'success' }, durationMs / 1000);

    log.info(
      { documentId, pageCount, chunks: chunks.length, durationMs },
      'document ingested successfully',
    );

    return { skipped: false, document, pageCount, chunkCount: chunks.length, durationMs };
  } catch (error) {
    closeStage();
    pipelineDuration.observe({ outcome: 'failure' }, (Date.now() - startedAt) / 1000);
    pipelineFailures.inc({
      stage: currentStage ?? 'unknown',
      retryable: String(error?.retryable !== false),
    });

    await compensate(documentId, { ...error, stage: currentStage, message: error?.message });
    throw error;
  }
}

/**
 * Undoes a partial run.
 *
 * Without this a failed attempt leaves chunks behind that no ready document
 * points at — they would be counted, embedded and searched forever.
 */
async function compensate(documentId, error) {
  const stage = error?.stage;

  try {
    const removed = await deleteChunksForDocument(documentId);
    if (removed > 0) {
      log.warn({ documentId, removed }, 'removed partial chunks after failure');
    }
  } catch (cleanupError) {
    log.error({ err: cleanupError, documentId }, 'failed to clean up partial chunks');
  }

  try {
    await markDocumentFailed(documentId, {
      stage,
      message: error?.message ?? 'Unknown failure',
    });
  } catch (statusError) {
    log.error({ err: statusError, documentId }, 'failed to record document failure');
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw Object.assign(new Error('Pipeline aborted: worker is shutting down'), {
      retryable: true,
      aborted: true,
    });
  }
}

/** Progress percentage for a stage, matching what the job repository stores. */
export function stageProgress(stage) {
  const index = PIPELINE_STAGES.indexOf(stage);
  return index < 0 ? 0 : Math.round(((index + 1) / PIPELINE_STAGES.length) * 100);
}

export { PIPELINE_STAGES, env };
