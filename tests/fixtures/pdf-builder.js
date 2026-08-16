import PDFDocument from 'pdfkit';
import { CORPUS, EDGE_CASES } from './corpus.js';

/**
 * PDF generation for tests.
 *
 * Fixtures are built at run time rather than committed as binaries. Three
 * reasons: the repository stays free of opaque blobs, the text in a fixture
 * can be asserted against because it is declared next to the assertion, and a
 * change to the corpus cannot drift out of sync with the files.
 *
 * These are real PDFs produced by a real writer — the parser is exercised
 * against the same structures it will meet in production, not a hand-rolled
 * approximation.
 */

/**
 * Renders a PDFKit document to a single Buffer.
 *
 * @param {(doc: PDFKit.PDFDocument) => void} draw
 * @param {{ title?: string, author?: string }} [meta]
 * @returns {Promise<Buffer>}
 */
function render(draw, meta = {}) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 56,
      info: {
        Title: meta.title ?? 'Untitled',
        Author: meta.author ?? 'AskPDF Test Suite',
        Subject: meta.subject ?? '',
      },
    });

    /** @type {Buffer[]} */
    const chunks = [];
    doc.on('data', (chunk) => chunks.push(chunk));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      draw(doc);
      doc.end();
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Builds one corpus document as a multi-page PDF.
 *
 * Each entry in `pages` becomes its own physical page, so a citation that
 * claims page 2 can be checked against the heading that is actually there.
 *
 * @param {(typeof CORPUS)[number]} definition
 * @returns {Promise<Buffer>}
 */
export function buildCorpusPdf(definition) {
  return render(
    (doc) => {
      definition.pages.forEach((page, pageIndex) => {
        if (pageIndex > 0) {
          doc.addPage();
        }

        if (pageIndex === 0) {
          doc.fontSize(20).text(definition.title, { align: 'left' });
          doc.moveDown(1);
        }

        doc.fontSize(14).text(page.heading);
        doc.moveDown(0.5);

        doc.fontSize(11);
        for (const paragraph of page.paragraphs) {
          doc.text(paragraph, { align: 'left', lineGap: 2 });
          doc.moveDown(0.6);
        }
      });
    },
    { title: definition.title, subject: definition.topic },
  );
}

/** Builds every corpus document. @returns {Promise<Array<{slug: string, title: string, buffer: Buffer}>>} */
export async function buildCorpusPdfs() {
  return Promise.all(
    CORPUS.map(async (definition) => ({
      slug: definition.slug,
      title: definition.title,
      topic: definition.topic,
      buffer: await buildCorpusPdf(definition),
    })),
  );
}

/**
 * A PDF with a single short paragraph — the one-chunk path.
 *
 * @returns {Promise<Buffer>}
 */
export function buildTinyPdf(text = EDGE_CASES.tiny.text) {
  return render(
    (doc) => {
      doc.fontSize(12).text(text);
    },
    { title: EDGE_CASES.tiny.title },
  );
}

/**
 * A PDF with no extractable text.
 *
 * Stands in for a scan. Drawing vector shapes rather than glyphs means the
 * page has visible content but the parser finds nothing, which must be
 * reported as a clean failure and never as an empty successful ingest.
 *
 * @returns {Promise<Buffer>}
 */
export function buildImageOnlyPdf() {
  return render(
    (doc) => {
      doc.rect(80, 80, 420, 260).fill('#d8d8d8');
      doc.rect(120, 380, 340, 12).fill('#9a9a9a');
      doc.rect(120, 410, 300, 12).fill('#9a9a9a');
      doc.circle(300, 210, 60).fill('#7a7a7a');
    },
    { title: EDGE_CASES.imageOnly.title },
  );
}

/**
 * A PDF whose text is entirely non-Latin.
 *
 * PDFKit's built-in fonts cannot encode these scripts, so the glyphs are not
 * the point — what this catches is chunk sizing that counts bytes where it
 * should count characters.
 *
 * @returns {Promise<Buffer>}
 */
export function buildUnicodePdf(text = EDGE_CASES.unicode.text) {
  return render(
    (doc) => {
      doc.fontSize(12).text(text, { features: [] });
    },
    { title: EDGE_CASES.unicode.title },
  );
}

/**
 * A deliberately long PDF, for batching and page-ceiling limits.
 *
 * @param {number} [pageCount]
 * @returns {Promise<Buffer>}
 */
export function buildLargePdf(pageCount = EDGE_CASES.large.pageCount) {
  return render(
    (doc) => {
      for (let page = 0; page < pageCount; page += 1) {
        if (page > 0) {
          doc.addPage();
        }
        doc.fontSize(11).text(`Section ${String(page + 1)}`, { underline: true });
        doc.moveDown(0.5);
        for (let paragraph = 0; paragraph < 6; paragraph += 1) {
          doc.text(
            `Measurement ${String(page + 1)}.${String(paragraph + 1)}: the sampled value settled ` +
              `within tolerance after ${String((paragraph + 1) * 7)} seconds of operation, which ` +
              'is consistent with the behaviour recorded during the previous acceptance run.',
            { lineGap: 1.5 },
          );
          doc.moveDown(0.4);
        }
      }
    },
    { title: EDGE_CASES.large.title },
  );
}

/**
 * Bytes that are not a PDF at all.
 *
 * Upload validation must reject this on its magic bytes, whatever the
 * filename or declared content type claims.
 */
export function buildNotAPdf() {
  return Buffer.from('This is a plain text file pretending to be a PDF.\n', 'utf8');
}

/**
 * A file whose first bytes are the PDF header but whose body is corrupt.
 *
 * Passes the cheap magic-byte check and then fails in the parser — the case
 * that separates "validated the upload" from "can actually read it".
 */
export function buildCorruptPdf() {
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'ascii'),
    Buffer.from('%\xE2\xE3\xCF\xD3\n', 'binary'),
    Buffer.from('1 0 obj <<<< endobj trailer garbage', 'ascii'),
  ]);
}
