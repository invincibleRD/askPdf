/**
 * npm run fixtures
 *
 * The suite builds these in memory; this writes them out so the same documents
 * can be opened in a viewer, curled at the API, or used by the seed script.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildCorpusPdfs,
  buildCorruptPdf,
  buildImageOnlyPdf,
  buildLargePdf,
  buildNotAPdf,
  buildTinyPdf,
  buildUnicodePdf,
} from '../tests/fixtures/pdf-builder.js';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = join(projectRoot, 'fixtures', 'pdfs');

async function write(name, buffer) {
  const path = join(outputDir, name);
  await writeFile(path, buffer);
  const kb = (buffer.byteLength / 1024).toFixed(1);
  console.log(`  ${name.padEnd(36)} ${kb.padStart(8)} KB`);
}

async function main() {
  await mkdir(outputDir, { recursive: true });

  console.log(`\nWriting fixtures to ${outputDir}\n`);

  console.log('Corpus (each on a distinct topic, for retrieval precision):');
  for (const doc of await buildCorpusPdfs()) {
    await write(`${doc.slug}.pdf`, doc.buffer);
  }

  console.log('\nEdge cases:');
  await write('single-paragraph.pdf', await buildTinyPdf());
  await write('unicode-content.pdf', await buildUnicodePdf());
  await write('scanned-no-text-layer.pdf', await buildImageOnlyPdf());
  await write('many-pages.pdf', await buildLargePdf());

  console.log('\nInvalid uploads (must be rejected):');
  await write('not-a-pdf.txt', buildNotAPdf());
  await write('corrupt.pdf', buildCorruptPdf());

  console.log('\nDone.\n');
}

main().catch((error) => {
  console.error('Failed to generate fixtures:', error);
  process.exit(1);
});
