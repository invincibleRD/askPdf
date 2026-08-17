import { extractText, getDocumentProxy } from 'unpdf';
import { env } from '../config/env.js';
import { ValidationError } from '../core/errors.js';
import { createLogger } from '../core/logger.js';

const log = createLogger('pipeline:parse');

/**
 * Extracts text and metadata from a PDF.
 *
 * Returns text per page rather than one blob, because a citation that says
 * "page 4" has to mean it.
 *
 * @param {Buffer} buffer
 * @returns {Promise<{ pages: Array<{ page: number, text: string }>, pageCount: number, title?: string }>}
 */
export async function parsePdf(buffer) {
  let pdf;

  try {
    pdf = await getDocumentProxy(new Uint8Array(buffer));
  } catch (error) {
    // Encrypted or structurally broken: retrying will produce the same result.
    throw new UnprocessablePdfError(`Could not read the PDF: ${error.message}`);
  }

  const pageCount = pdf.numPages;

  if (pageCount === 0) {
    throw new UnprocessablePdfError('PDF contains no pages');
  }

  if (pageCount > env.MAX_PDF_PAGES) {
    throw new UnprocessablePdfError(
      `PDF has ${String(pageCount)} pages, the limit is ${String(env.MAX_PDF_PAGES)}`,
    );
  }

  const { text } = await extractText(pdf, { mergePages: false });

  const pages = text.map((raw, index) => ({
    page: index + 1,
    text: normaliseWhitespace(raw),
  }));

  const withText = pages.filter((page) => page.text.length > 0);

  if (withText.length === 0) {
    // Almost always a scan. Retrying cannot help; OCR would be a different
    // feature, so this fails loudly rather than producing an empty document.
    throw new UnprocessablePdfError(
      'No selectable text found — this looks like a scanned document and needs OCR',
    );
  }

  const title = await readTitle(pdf);

  log.info(
    { pageCount, pagesWithText: withText.length, characters: totalLength(pages) },
    'pdf parsed',
  );

  return { pages, pageCount, ...(title ? { title } : {}) };
}

/**
 * A PDF we will never be able to process.
 *
 * Distinct from a transient failure: the worker marks these dead immediately
 * instead of burning three attempts on a file that cannot improve.
 */
export class UnprocessablePdfError extends ValidationError {
  constructor(message) {
    super(message);
    this.retryable = false;
  }
}

async function readTitle(pdf) {
  try {
    const metadata = await pdf.getMetadata();
    const title = metadata?.info?.Title;

    return typeof title === 'string' && title.trim().length > 0
      ? title.trim().slice(0, 500)
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * PDF extraction leaves ragged spacing and hyphenated line breaks; both would
 * otherwise end up inside chunks and be embedded as noise.
 */
function normaliseWhitespace(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/-\n(?=[a-z])/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((line) => line.trim())
    .join('\n')
    .trim();
}

function totalLength(pages) {
  return pages.reduce((sum, page) => sum + page.text.length, 0);
}
