import PDFDocument from 'pdfkit';
import { CORPUS, EDGE_CASES } from './corpus.js';

// Built at run time rather than committed as binaries, so the fixture text
// lives next to the assertions that depend on it and can't drift.

/** @param {(doc: PDFKit.PDFDocument) => void} draw */
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

/** One page per `pages` entry, so a page citation can be checked against it. */
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

/** The one-chunk path. */
export function buildTinyPdf(text = EDGE_CASES.tiny.text) {
  return render(
    (doc) => {
      doc.fontSize(12).text(text);
    },
    { title: EDGE_CASES.tiny.title },
  );
}

/**
 * Stands in for a scan: vector shapes, no glyphs, so the page has visible
 * content but the parser finds nothing.
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

/** The glyphs aren't the point — chunk sizing that counts bytes is. */
export function buildUnicodePdf(text = EDGE_CASES.unicode.text) {
  return render(
    (doc) => {
      doc.fontSize(12).text(text, { features: [] });
    },
    { title: EDGE_CASES.unicode.title },
  );
}

/** For batching and page-ceiling limits. */
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

/** Must be rejected on magic bytes, whatever the filename claims. */
export function buildNotAPdf() {
  return Buffer.from('This is a plain text file pretending to be a PDF.\n', 'utf8');
}

/** Passes the magic-byte check, then fails in the parser. */
export function buildCorruptPdf() {
  return Buffer.concat([
    Buffer.from('%PDF-1.7\n', 'ascii'),
    Buffer.from('%\xE2\xE3\xCF\xD3\n', 'binary'),
    Buffer.from('1 0 obj <<<< endobj trailer garbage', 'ascii'),
  ]);
}
