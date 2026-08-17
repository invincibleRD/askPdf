import { describe, expect, it } from 'vitest';
import { chunkPages, estimateTokens } from '../../../src/pipeline/chunk.js';

const page = (page, text) => ({ page, text });

describe('chunkPages', () => {
  it('keeps a short document as a single chunk', () => {
    const chunks = chunkPages([page(1, 'A short paragraph about espresso machines.')]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ index: 0, pageStart: 1, pageEnd: 1 });
  });

  it('numbers chunks contiguously from zero', () => {
    const pages = Array.from({ length: 6 }, (_unused, i) =>
      page(i + 1, `Paragraph ${String(i)}. ${'filler text '.repeat(200)}`),
    );

    const chunks = chunkPages(pages, { chunkTokens: 128, overlapTokens: 16 });

    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_c, i) => i));
  });

  it('tracks which pages a chunk came from', () => {
    const chunks = chunkPages(
      [page(1, 'First page content here.'), page(2, 'Second page content here.')],
      { chunkTokens: 512, overlapTokens: 0 },
    );

    const spanned = chunks.flatMap((c) => [c.pageStart, c.pageEnd]);
    expect(Math.min(...spanned)).toBe(1);
    expect(Math.max(...spanned)).toBe(2);
  });

  it('respects the size target', () => {
    const pages = [
      page(
        1,
        Array.from(
          { length: 40 },
          (_u, i) => `Sentence number ${String(i)} with some words in it.`,
        ).join('\n\n'),
      ),
    ];

    const chunks = chunkPages(pages, { chunkTokens: 64, overlapTokens: 8 });

    // 4 chars/token, with slack for the final segment that tips it over.
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThan(64 * 4 * 1.6);
    }
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('overlaps consecutive chunks so a straddling fact survives', () => {
    const paragraphs = Array.from(
      { length: 12 },
      (_u, i) => `Paragraph ${String(i)} contains distinctive marker ${String(i)} within it.`,
    );

    const chunks = chunkPages([page(1, paragraphs.join('\n\n'))], {
      chunkTokens: 40,
      overlapTokens: 16,
    });

    expect(chunks.length).toBeGreaterThan(1);
    const shared = chunks.slice(1).some((chunk, i) => {
      const previousTail = chunks[i].text.split('\n\n').at(-1);
      return chunk.text.includes(previousTail);
    });
    expect(shared).toBe(true);
  });

  it('splits a paragraph that is larger than a whole chunk', () => {
    const giant = `${'word '.repeat(3000)}`;

    const chunks = chunkPages([page(1, giant)], { chunkTokens: 100, overlapTokens: 10 });

    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.text.length).toBeLessThanOrEqual(100 * 4);
    }
  });

  it('always makes forward progress rather than looping on overlap', () => {
    const chunks = chunkPages(
      [page(1, Array.from({ length: 30 }, (_u, i) => `Para ${String(i)}.`).join('\n\n'))],
      { chunkTokens: 16, overlapTokens: 15 },
    );

    expect(chunks.length).toBeLessThan(100);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('drops empty pages without producing empty chunks', () => {
    const chunks = chunkPages([page(1, ''), page(2, 'Real content.'), page(3, '   ')]);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].text).toBe('Real content.');
  });

  it('returns nothing for a document with no text', () => {
    expect(chunkPages([page(1, ''), page(2, '  ')])).toEqual([]);
  });

  it('records a token estimate on every chunk', () => {
    const chunks = chunkPages([page(1, 'Some reasonable content for a chunk.')]);

    expect(chunks[0].tokenCount).toBe(estimateTokens(chunks[0].text));
    expect(chunks[0].tokenCount).toBeGreaterThan(0);
  });
});
