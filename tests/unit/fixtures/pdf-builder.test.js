import { describe, expect, it } from 'vitest';
import {
  buildCorpusPdf,
  buildCorpusPdfs,
  buildCorruptPdf,
  buildImageOnlyPdf,
  buildLargePdf,
  buildNotAPdf,
  buildTinyPdf,
  buildUnicodePdf,
} from '../../fixtures/pdf-builder.js';
import { CORPUS } from '../../fixtures/corpus.js';
import { PDF_MAGIC_BYTES } from '../../../src/config/constants.js';

/** `%PDF-` — the five bytes upload validation checks for. */
const MAGIC = Buffer.from(PDF_MAGIC_BYTES);

/** @param {Buffer} buffer */
const startsWithPdfMagic = (buffer) => buffer.subarray(0, MAGIC.length).equals(MAGIC);

describe('corpus definition', () => {
  it('has several documents on unrelated topics', () => {
    expect(CORPUS.length).toBeGreaterThanOrEqual(4);
    expect(new Set(CORPUS.map((doc) => doc.topic)).size).toBe(CORPUS.length);
  });

  it('spans multiple pages per document, so citations can be checked', () => {
    for (const doc of CORPUS) {
      expect(doc.pages.length, doc.slug).toBeGreaterThanOrEqual(2);
    }
  });

  it('carries expected and off-topic probes for every document', () => {
    for (const doc of CORPUS) {
      expect(doc.probes.expected.length, doc.slug).toBeGreaterThanOrEqual(2);
      expect(doc.probes.offTopic.length, doc.slug).toBeGreaterThanOrEqual(1);
    }
  });

  it('answers every expected probe somewhere in its own document text', () => {
    // If a probe's answer is not actually present, a retrieval failure would
    // look like a model problem when it is really a broken fixture.
    for (const doc of CORPUS) {
      const fullText = doc.pages.flatMap((page) => [page.heading, ...page.paragraphs]).join('\n');

      for (const probe of doc.probes.expected) {
        expect(fullText, `${doc.slug}: ${probe.question}`).toMatch(probe.mustMatch);
      }
    }
  });

  it('draws off-topic probes from other documents in the corpus', () => {
    // An off-topic question has to be a real question about a *different*
    // document, otherwise the threshold test proves nothing.
    for (const doc of CORPUS) {
      for (const question of doc.probes.offTopic) {
        const ownText = doc.pages
          .flatMap((page) => page.paragraphs)
          .join(' ')
          .toLowerCase();
        const distinctive = question
          .toLowerCase()
          .split(/\W+/)
          .filter((word) => word.length > 6);

        expect(
          distinctive.some((word) => ownText.includes(word)),
          question,
        ).toBe(false);
      }
    }
  });
});

describe('buildCorpusPdf', () => {
  it('produces a real PDF for every corpus entry', async () => {
    const pdfs = await buildCorpusPdfs();

    expect(pdfs).toHaveLength(CORPUS.length);
    for (const pdf of pdfs) {
      expect(startsWithPdfMagic(pdf.buffer), pdf.slug).toBe(true);
      expect(pdf.buffer.byteLength, pdf.slug).toBeGreaterThan(1_000);
    }
  });

  it('ends with the PDF trailer marker', async () => {
    const buffer = await buildCorpusPdf(CORPUS[0]);

    expect(buffer.subarray(-32).toString('latin1')).toContain('%%EOF');
  });

  it('produces distinct bytes for distinct documents', async () => {
    const [first, second] = await Promise.all([
      buildCorpusPdf(CORPUS[0]),
      buildCorpusPdf(CORPUS[1]),
    ]);

    expect(first.equals(second)).toBe(false);
  });
});

describe('edge case fixtures', () => {
  it.each([
    ['single paragraph', buildTinyPdf],
    ['no text layer', buildImageOnlyPdf],
    ['non-Latin script', buildUnicodePdf],
    ['many pages', () => buildLargePdf(40)],
  ])('builds a valid PDF for %s', async (_label, build) => {
    expect(startsWithPdfMagic(await build())).toBe(true);
  });
});

describe('invalid upload fixtures', () => {
  it('produces bytes that fail the magic-byte check', () => {
    expect(startsWithPdfMagic(buildNotAPdf())).toBe(false);
  });

  it('produces a file that passes the magic-byte check but is not readable', () => {
    // This is the fixture that proves validation and parsing are separate
    // concerns: the header is right, the body is not.
    expect(startsWithPdfMagic(buildCorruptPdf())).toBe(true);
  });
});
