import { env } from '../config/env.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('pipeline:chunk');

/**
 * Roughly four characters per token for English prose.
 *
 * A real tokenizer would be exact, but it would also be a large dependency to
 * carry for a value only used to decide where to split. The chunk size is a
 * soft target, so the approximation is fine — it is deliberately conservative
 * so a chunk never exceeds the embedder's window.
 */
const CHARS_PER_TOKEN = 4;

export function estimateTokens(text) {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Splits parsed pages into overlapping chunks.
 *
 * Splits at paragraph boundaries where possible and sentence boundaries
 * otherwise, because a chunk cut mid-sentence embeds badly and reads worse
 * when it is quoted back as a citation.
 *
 * Consecutive chunks overlap so a fact that straddles a boundary appears
 * whole in at least one of them.
 *
 * @param {Array<{ page: number, text: string }>} pages
 * @param {{ chunkTokens?: number, overlapTokens?: number }} [options]
 */
export function chunkPages(
  pages,
  { chunkTokens = env.CHUNK_SIZE_TOKENS, overlapTokens = env.CHUNK_OVERLAP_TOKENS } = {},
) {
  const maxChars = chunkTokens * CHARS_PER_TOKEN;
  const overlapChars = overlapTokens * CHARS_PER_TOKEN;

  const segments = pages.flatMap((page) =>
    splitIntoSegments(page.text).map((text) => ({ text, page: page.page })),
  );

  const chunks = [];
  let buffer = [];
  let bufferLength = 0;

  const flush = () => {
    if (buffer.length === 0) {
      return;
    }

    const text = buffer
      .map((segment) => segment.text)
      .join('\n\n')
      .trim();

    if (text.length > 0) {
      chunks.push({
        index: chunks.length,
        text,
        tokenCount: estimateTokens(text),
        pageStart: buffer[0].page,
        pageEnd: buffer[buffer.length - 1].page,
      });
    }

    buffer = carryOverlap(buffer, overlapChars);
    bufferLength = buffer.reduce((sum, segment) => sum + segment.text.length + 2, 0);
  };

  for (const segment of segments) {
    // A single segment longer than the window has to be broken up on its own
    // terms, or it would sit in the buffer and never fit.
    if (segment.text.length > maxChars) {
      flush();

      for (const piece of hardSplit(segment.text, maxChars, overlapChars)) {
        chunks.push({
          index: chunks.length,
          text: piece,
          tokenCount: estimateTokens(piece),
          pageStart: segment.page,
          pageEnd: segment.page,
        });
      }
      continue;
    }

    if (bufferLength + segment.text.length > maxChars) {
      flush();
    }

    buffer.push(segment);
    bufferLength += segment.text.length + 2;
  }

  // Final flush must not re-seed the buffer with overlap.
  if (buffer.length > 0) {
    const text = buffer
      .map((segment) => segment.text)
      .join('\n\n')
      .trim();
    if (text.length > 0) {
      chunks.push({
        index: chunks.length,
        text,
        tokenCount: estimateTokens(text),
        pageStart: buffer[0].page,
        pageEnd: buffer[buffer.length - 1].page,
      });
    }
  }

  log.info(
    { chunks: chunks.length, pages: pages.length, chunkTokens, overlapTokens },
    'document chunked',
  );

  return chunks;
}

/** Paragraphs first; a paragraph too large for one chunk falls back to sentences. */
function splitIntoSegments(text) {
  return text
    .split(/\n{2,}/)
    .flatMap((paragraph) => {
      const trimmed = paragraph.trim();
      if (trimmed.length === 0) {
        return [];
      }

      return trimmed.length > env.CHUNK_SIZE_TOKENS * CHARS_PER_TOKEN
        ? splitSentences(trimmed)
        : [trimmed];
    })
    .filter(Boolean);
}

function splitSentences(text) {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z(“"'])/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

/** Keeps trailing segments so the next chunk starts with shared context. */
function carryOverlap(buffer, overlapChars) {
  if (overlapChars <= 0) {
    return [];
  }

  const carried = [];
  let length = 0;

  for (let i = buffer.length - 1; i >= 0; i -= 1) {
    const segment = buffer[i];

    if (length + segment.text.length > overlapChars && carried.length > 0) {
      break;
    }

    carried.unshift(segment);
    length += segment.text.length;
  }

  // Carrying the whole buffer would make no forward progress.
  return carried.length === buffer.length ? carried.slice(-1) : carried;
}

/** Last resort for a run of text with no usable boundary, e.g. a table dump. */
function hardSplit(text, maxChars, overlapChars) {
  const pieces = [];
  const step = Math.max(1, maxChars - overlapChars);

  for (let start = 0; start < text.length; start += step) {
    const piece = text.slice(start, start + maxChars).trim();
    if (piece.length > 0) {
      pieces.push(piece);
    }
    if (start + maxChars >= text.length) {
      break;
    }
  }

  return pieces;
}
