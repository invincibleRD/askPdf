/**
 * npm run db:indexes
 *
 * Production runs autoIndex off — an index build holds a lock, and a rolling
 * deploy would trigger it on every pod at once. syncIndexes also drops indexes
 * no longer in a schema.
 */
import { env } from '../src/config/env.js';
import { connectMongo, disconnectMongo, mongoose } from '../src/infra/mongo/connection.js';
import { createLogger } from '../src/core/logger.js';
import { CHUNK_VECTOR_INDEX, Chunk } from '../src/modules/documents/chunk.model.js';

// Importing registers the models with Mongoose.
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

// Cluster-level feature Mongoose doesn't model, so this goes through the
// driver. Atlas builds asynchronously — accepted is not the same as queryable.
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
