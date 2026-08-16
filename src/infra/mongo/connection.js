import mongoose from 'mongoose';
import { env, isProduction } from '../../config/env.js';
import { registerResource } from '../../core/lifecycle.js';
import { createLogger } from '../../core/logger.js';
import { ServiceUnavailableError } from '../../core/errors.js';

const log = createLogger('mongo');

let connecting = null;

export function connectMongo({ uri = env.MONGO_URI } = {}) {
  connecting ??= openConnection(uri);
  return connecting;
}

async function openConnection(uri) {
  // Without this a query issued while the driver is down sits in a buffer
  // until it times out with a confusing error.
  mongoose.set('bufferCommands', false);
  mongoose.set('strictQuery', true);
  mongoose.set('strict', 'throw');

  attachConnectionLogging();

  await mongoose.connect(uri, {
    maxPoolSize: env.MONGO_MAX_POOL_SIZE,
    minPoolSize: env.MONGO_MIN_POOL_SIZE,
    serverSelectionTimeoutMS: env.MONGO_SERVER_SELECTION_TIMEOUT_MS,
    // Index builds block writes, so in production they're a migration step
    // (npm run db:indexes), never a side effect of a rolling deploy.
    autoIndex: !isProduction,
    autoCreate: !isProduction,
    // zlib not zstd: zstd needs a native module matching the image arch.
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

/** readyState reports intent; a ping catches an open socket with no primary. */
export async function pingMongo() {
  if (mongoose.connection.readyState !== 1) {
    return false;
  }

  const admin = mongoose.connection.db?.admin();
  if (!admin) {
    return false;
  }

  return (await admin.ping()).ok === 1;
}

export async function disconnectMongo() {
  connecting = null;
  await mongoose.disconnect();
}

export function assertMongoConnected() {
  if (mongoose.connection.readyState !== 1) {
    throw new ServiceUnavailableError('Database connection is not available');
  }
}

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
