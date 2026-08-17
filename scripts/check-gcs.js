/**
 * npm run gcs:check
 *
 * Round-trips a real object through the configured bucket: upload, stat,
 * download, sign, delete. Proves credentials, permissions and naming before
 * the API is pointed at it.
 *
 * Pass --keep to leave the object behind so it can be eyeballed in the console.
 */
import { env } from '../src/config/env.js';
import { createGcsDriver } from '../src/infra/storage/gcs.driver.js';
import { buildObjectKey } from '../src/infra/storage/object-key.js';
import { buildTinyPdf } from '../tests/fixtures/pdf-builder.js';

const keep = process.argv.includes('--keep');

const step = (n, label) => console.log(`\n[${n}/6] ${label}`);
const ok = (msg) => console.log(`      ✓ ${msg}`);

async function main() {
  console.log('GCS connection check');
  console.log(`  bucket     ${env.GCS_BUCKET ?? '(unset)'}`);
  console.log(`  prefix     ${env.GCS_PREFIX}/`);
  console.log(`  project    ${env.GCS_PROJECT_ID ?? '(from credentials)'}`);
  console.log(`  key file   ${env.GCS_KEY_FILE ?? '(Application Default Credentials)'}`);

  if (!env.GCS_BUCKET) {
    throw new Error('GCS_BUCKET is not set — add it to .env');
  }

  const driver = createGcsDriver();

  step(1, 'Reaching the bucket');
  const reachable = await driver.healthCheck();
  if (!reachable) {
    throw new Error(`Bucket "${env.GCS_BUCKET}" is not visible to these credentials`);
  }
  ok('bucket exists and is readable');

  step(2, 'Uploading a test PDF');
  const pdf = await buildTinyPdf();
  const key = buildObjectKey('gcs-connection-check.pdf', { prefix: env.GCS_PREFIX });
  const { uri } = await driver.put(key, pdf, {
    contentType: 'application/pdf',
    metadata: { source: 'gcs:check' },
  });
  ok(`${uri}  (${String(pdf.length)} bytes)`);

  step(3, 'Confirming it exists');
  if (!(await driver.exists(key))) {
    throw new Error('Object was uploaded but does not exist — check bucket permissions');
  }
  ok('object is present');

  step(4, 'Downloading it back');
  const roundTripped = await driver.get(key);
  if (!roundTripped.equals(pdf)) {
    throw new Error(
      `Downloaded ${String(roundTripped.length)} bytes, expected ${String(pdf.length)}`,
    );
  }
  ok('bytes match exactly');

  step(5, 'Generating a signed URL');
  try {
    const url = await driver.signedUrl(key, { ttlSeconds: 300 });
    ok(`${url.slice(0, 90)}…`);
  } catch (error) {
    // Signing needs a private key; ADC from a user account cannot do it.
    console.log(`      ! signing unavailable: ${error.message}`);
    console.log('        (expected with user ADC — needs a service account key)');
  }

  step(6, keep ? 'Leaving the object in place' : 'Deleting it');
  if (keep) {
    ok(`kept at ${key}`);
  } else {
    await driver.delete(key);
    ok('deleted');
  }

  console.log('\nGCS is wired up correctly.\n');
}

main().catch((error) => {
  console.error(`\n✗ ${error.message}\n`);
  if (error.cause?.errors) {
    console.error(JSON.stringify(error.cause.errors, null, 2));
  }
  process.exit(1);
});
