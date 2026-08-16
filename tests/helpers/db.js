import { afterAll, afterEach, beforeAll } from 'vitest';
import { connectMongo, disconnectMongo, mongoose } from '../../src/infra/mongo/connection.js';
import { resetResources } from '../../src/core/lifecycle.js';

// Tests run against real MongoDB: unique partial indexes and conditional
// updates are database behaviour, and a mock would agree with a schema the
// real server rejects.

// Vitest forks one process per file, so each needs its own database or the
// wipe between tests would delete another file's fixtures mid-run.
function databaseNameForWorker() {
  const workerId = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? '1';
  return `askpdf-test-${workerId}`;
}

export function testMongoUri() {
  const uri = new URL(process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/askpdf-test');
  uri.pathname = `/${databaseNameForWorker()}`;
  return uri.toString();
}

export function useTestDatabase() {
  beforeAll(async () => {
    await connectMongo({ uri: testMongoUri() });
    await syncTestIndexes();
  });

  afterEach(async () => {
    await clearCollections();
  });

  afterAll(async () => {
    await mongoose.connection.dropDatabase();
    await disconnectMongo();
    resetResources();
  });
}

/** Deletes rows rather than dropping collections, which would take the indexes with them. */
export async function clearCollections() {
  const { collections } = mongoose.connection;

  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

export async function syncTestIndexes() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}
