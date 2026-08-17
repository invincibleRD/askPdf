import { describe, expect, it } from 'vitest';
import { UnprocessablePdfError, parsePdf } from '../../../src/pipeline/parse.js';
import {
  buildCorpusPdf,
  buildCorruptPdf,
  buildImageOnlyPdf,
  buildLargePdf,
  buildNotAPdf,
  buildTinyPdf,
} from '../../fixtures/pdf-builder.js';
import { CORPUS } from '../../fixtures/corpus.js';

describe('parsePdf', () => {
  it('extracts text page by page, so citations can name a page', async () => {
    const definition = CORPUS[0];

    const { pages, pageCount } = await parsePdf(await buildCorpusPdf(definition));

    expect(pageCount).toBe(definition.pages.length);
    expect(pages).toHaveLength(definition.pages.length);
    expect(pages[0].page).toBe(1);
    // Each source page's heading must land on the matching output page.
    definition.pages.forEach((source, i) => {
      expect(pages[i].text).toContain(source.heading);
    });
  });

  it('reads the document title from the metadata', async () => {
    const { title } = await parsePdf(await buildCorpusPdf(CORPUS[1]));

    expect(title).toBe(CORPUS[1].title);
  });

  it('preserves the facts a question will be asked about', async () => {
    const { pages } = await parsePdf(await buildCorpusPdf(CORPUS[0]));
    const fullText = pages.map((page) => page.text).join('\n');

    for (const probe of CORPUS[0].probes.expected) {
      expect(fullText).toMatch(probe.mustMatch);
    }
  });

  it('handles a single-paragraph document', async () => {
    const { pages, pageCount } = await parsePdf(await buildTinyPdf());

    expect(pageCount).toBe(1);
    expect(pages[0].text).toContain('4000 hours');
  });

  it('parses a 120-page document', async () => {
    const { pageCount } = await parsePdf(await buildLargePdf(120));

    expect(pageCount).toBe(120);
  });

  it('rejects a scan with no text layer, rather than ingesting nothing', async () => {
    await expect(parsePdf(await buildImageOnlyPdf())).rejects.toThrow(/scanned|OCR/i);
  });

  it('marks an unreadable PDF as not worth retrying', async () => {
    const error = await parsePdf(await buildImageOnlyPdf()).catch((e) => e);

    expect(error).toBeInstanceOf(UnprocessablePdfError);
    expect(error.retryable).toBe(false);
  });

  it('rejects a corrupt file', async () => {
    await expect(parsePdf(buildCorruptPdf())).rejects.toThrow();
  });

  it('rejects bytes that are not a PDF at all', async () => {
    await expect(parsePdf(buildNotAPdf())).rejects.toThrow();
  });
});
