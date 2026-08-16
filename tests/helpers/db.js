import { afterAll, afterEach, beforeAll } from 'vitest';
import { connectMongo, disconnectMongo, mongoose } from '../../src/infra/mongo/connection.js';
import { resetResources } from '../../src/core/lifecycle.js';

/**
 * Database harness for integration tests.
 *
 * Tests run against a real MongoDB rather than an in-memory mock, because the
 * things worth testing here — unique partial indexes, conditional updates,
 * `insertMany` ordering — are database behaviour, not application behaviour.
 * A mock would happily agree with a schema the real server rejects.
 */

/**
 * Vitest forks one process per test file, so each needs its own database or
 * the collection wipe between tests would delete another file's fixtures
 * mid-run.
 */
function databaseNameForWorker() {
  const workerId = process.env.VITEST_WORKER_ID ?? process.env.VITEST_POOL_ID ?? '1';
  return `askpdf-test-${workerId}`;
}

/** @returns {string} */
export function testMongoUri() {
  const uri = new URL(process.env.MONGO_URI ?? 'mongodb://127.0.0.1:27017/askpdf-test');
  uri.pathname = `/${databaseNameForWorker()}`;
  return uri.toString();
}

/**
 * Connects before the suite, clears data between tests, drops the database at
 * the end.
 *
 * Call once at the top of an integration file:
 *
 *   useTestDatabase();
 */
export function useTestDatabase() {
  beforeAll(async () => {
    await connectMongo({ uri: testMongoUri() });
    // Indexes are what several of these tests are actually asserting on, so
    // build them once up front rather than relying on autoIndex racing the
    // first write.
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

/**
 * Empties every collection without dropping them.
 *
 * Deleting documents keeps the indexes in place; dropping the collections
 * would discard them and make the next test's uniqueness assertion pass for
 * the wrong reason.
 */
export async function clearCollections() {
  const { collections } = mongoose.connection;

  await Promise.all(Object.values(collections).map((collection) => collection.deleteMany({})));
}

/** Builds the indexes declared by every registered model. */
export async function syncTestIndexes() {
  await Promise.all(Object.values(mongoose.models).map((model) => model.syncIndexes()));
}
