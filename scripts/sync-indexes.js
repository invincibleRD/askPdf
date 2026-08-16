/**
 * Index migration.
 *
 *   npm run db:indexes
 *
 * Production runs with `autoIndex: false`, because building an index on a
 * large collection holds a lock and a rolling deploy would trigger it on
 * every pod at once. Index changes are therefore a deliberate step, run once
 * before the deploy that needs them.
 *
 * `syncIndexes()` also *drops* indexes that no longer appear in a schema, so
 * removing one from the code is what removes it from the cluster.
 */
import { env } from '../src/config/env.js';
import { connectMongo, disconnectMongo, mongoose } from '../src/infra/mongo/connection.js';
import { createLogger } from '../src/core/logger.js';
import { CHUNK_VECTOR_INDEX, Chunk } from '../src/modules/documents/chunk.model.js';

// Importing the models is what registers them with Mongoose; without these
// the sync would find nothing to do.
import '../src/modules/users/user.model.js';
import '../src/modules/documents/document.model.js';
import '../src/modules/jobs/job.model.js';

const log = createLogger('script:sync-indexes');

async function main() {
  await connectMongo();

  for (const [name, model] of Object.entries(mongoose.models)) {
    const dropped = await model.syncIndexes();
    log.info({ model: name, dropped }, 'indexes synced');
  }

  if (env.VECTOR_SEARCH_DRIVER === 'atlas') {
    await syncVectorIndex();
  } else {
    log.info(
      { driver: env.VECTOR_SEARCH_DRIVER },
      'skipping vector index: only Atlas supports search indexes',
    );
  }

  await disconnectMongo();
  log.info('done');
}

/**
 * Creates or updates the Atlas Vector Search index.
 *
 * Search indexes are a cluster-level feature that Mongoose does not model, so
 * they go through the driver directly. Atlas builds them asynchronously —
 * this returns as soon as the definition is accepted, not when it is queryable.
 */
async function syncVectorIndex() {
  const collection = Chunk.collection;

  const existing = await collection.listSearchIndexes(CHUNK_VECTOR_INDEX.name).toArray();

  if (existing.length > 0) {
    await collection.updateSearchIndex(CHUNK_VECTOR_INDEX.name, CHUNK_VECTOR_INDEX.definition);
    log.info({ index: CHUNK_VECTOR_INDEX.name }, 'vector index updated');
    return;
  }

  await collection.createSearchIndex({
    name: CHUNK_VECTOR_INDEX.name,
    type: CHUNK_VECTOR_INDEX.type,
    definition: CHUNK_VECTOR_INDEX.definition,
  });
  log.info(
    { index: CHUNK_VECTOR_INDEX.name, dimensions: env.EMBEDDING_DIMENSIONS },
    'vector index created — Atlas builds it in the background',
  );
}

main().catch(async (error) => {
  log.fatal({ err: error }, 'index sync failed');
  await disconnectMongo().catch(() => {});
  process.exit(1);
});
