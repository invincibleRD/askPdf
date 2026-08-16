import mongoose from 'mongoose';
import { env, isProduction } from '../../config/env.js';
import { registerResource } from '../../core/lifecycle.js';
import { createLogger } from '../../core/logger.js';
import { ServiceUnavailableError } from '../../core/errors.js';

const log = createLogger('mongo');

/**
 * MongoDB connection lifecycle.
 *
 * Both processes call `connectMongo()` once at startup. The connection is
 * registered with the lifecycle registry, which gives readiness a real signal
 * and guarantees the driver is closed during a graceful shutdown.
 */

/** Guards against a second connect call in the same process. */
let connecting = null;

/**
 * Opens the connection and registers it for health checks and shutdown.
 *
 * @param {{ uri?: string }} [options]
 * @returns {Promise<typeof mongoose>}
 */
export function connectMongo({ uri = env.MONGO_URI } = {}) {
  connecting ??= openConnection(uri);
  return connecting;
}

async function openConnection(uri) {
  // Without this, a query issued while the driver is down sits in a buffer
  // until it times out with a confusing error. Failing immediately surfaces
  // the real problem — the database is unreachable — and lets readiness
  // report it.
  mongoose.set('bufferCommands', false);
  mongoose.set('strictQuery', true);
  // Reject writes containing keys the schema does not declare rather than
  // silently dropping them.
  mongoose.set('strict', 'throw');

  attachConnectionLogging();

  await mongoose.connect(uri, {
    maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    minPoolSize: env.MONGO_MIN_POOL_SIZE,
    serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    // Building an index on a large collection blocks writes. In production
    // that must be a deliberate migration step (`npm run db:indexes`), never
    // a side effect of a rolling deploy.
    autoIndex: !isProduction,
    autoCreate: !isProduction,
    // Compress the wire protocol; embeddings are large and mostly redundant.
    // zlib only — zstd would compress better but needs a native module, and
    // a prebuilt binary that has to match the image architecture is not worth
    // the deployment risk here.
    compressors: ['zlib'],
    retryWrites: true,
  });

  registerResource({
    name: 'mongo',
    check: pingMongo,
    close: async () => {
      await mongoose.disconnect();
      connecting = null;
    },
  });

  log.info(
    { database: mongoose.connection.name, poolSize: env.MONGO_MAX_POOL_SIZE },
    'mongo connected',
  );

  return mongoose;
}

/**
 * Readiness probe for MongoDB.
 *
 * `readyState` alone is not enough — it reports the driver's intent, not
 * whether the server answers. A ping catches the case where the socket is
 * open but the replica set has no primary.
 *
 * @returns {Promise<boolean>}
 */
export async function pingMongo() {
  if (mongoose.connection.readyState !== 1) {
    return false;
  }

  const admin = mongoose.connection.db?.admin();
  if (!admin) {
    return false;
  }

  const result = await admin.ping();
  return result.ok === 1;
}

/** Closes the connection. Exported for tests; production goes through the registry. */
export async function disconnectMongo() {
  connecting = null;
  await mongoose.disconnect();
}

/**
 * Throws if the database is not usable.
 *
 * Call at the top of a code path that would otherwise fail deep inside a
 * driver with an unhelpful message.
 */
export function assertMongoConnected() {
  if (mongoose.connection.readyState !== 1) {
    throw new ServiceUnavailableError('Database connection is not available');
  }
}

/**
 * Connection event logging.
 *
 * The driver reconnects on its own; these logs are what tell you afterwards
 * that it happened and for how long.
 */
function attachConnectionLogging() {
  const connection = mongoose.connection;

  connection.on('disconnected', () => {
    log.warn('mongo disconnected');
  });

  connection.on('reconnected', () => {
    log.info('mongo reconnected');
  });

  connection.on('error', (error) => {
    log.error({ err: error }, 'mongo connection error');
  });
}

export { mongoose };
