import { z } from 'zod';

// Every configurable value is declared here once, and nothing else in src/
// reads process.env directly (ESLint enforces it). An invalid environment is a
// boot-time crash, not a half-configured process.

const booleanFromEnv = (defaultValue) =>
  z
    .enum(['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'])
    .default(defaultValue ? 'true' : 'false')
    .transform((value) => ['true', '1', 'yes', 'on'].includes(value));

const intFromEnv = (defaultValue, { min = 1, max = Number.MAX_SAFE_INTEGER } = {}) =>
  z.coerce.number().int().min(min).max(max).default(defaultValue);

const MEGABYTE = 1024 * 1024;

export const envSchema = z
  .object({
    /* ---- Runtime -------------------------------------------------------- */
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: intFromEnv(3000, { min: 0, max: 65_535 }),
    HOST: z.string().min(1).default('0.0.0.0'),
    SERVICE_NAME: z.string().min(1).default('askpdf'),

    /* ---- Logging -------------------------------------------------------- */
    LOG_LEVEL: z
      .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
      .default('info'),
    LOG_PRETTY: booleanFromEnv(false),

    /* ---- HTTP ----------------------------------------------------------- */
    // Comma-separated; "*" is rejected in production.
    CORS_ORIGINS: z.string().default('*'),
    REQUEST_TIMEOUT_MS: intFromEnv(30_000, { min: 1_000 }),
    // Must stay below terminationGracePeriodSeconds.
    SHUTDOWN_TIMEOUT_MS: intFromEnv(15_000, { min: 1_000 }),
    // Time to let the load balancer notice we're draining.
    SHUTDOWN_DRAIN_MS: intFromEnv(5_000, { min: 0 }),
    TRUST_PROXY: booleanFromEnv(true),

    /* ---- MongoDB -------------------------------------------------------- */
    MONGO_URI: z.string().min(1),
    MONGO_MAX_POOL_SIZE: intFromEnv(20),
    MONGO_MIN_POOL_SIZE: intFromEnv(2, { min: 0 }),
    MONGO_SERVER_SELECTION_TIMEOUT_MS: intFromEnv(10_000, { min: 500 }),

    /* ---- Redis ---------------------------------------------------------- */
    REDIS_URL: z.string().min(1),
    REDIS_KEY_PREFIX: z.string().default('askpdf'),

    /* ---- Queue ---------------------------------------------------------- */
    QUEUE_NAME: z.string().min(1).default('ingest'),
    QUEUE_MAX_ATTEMPTS: intFromEnv(3, { min: 1, max: 10 }),
    QUEUE_BACKOFF_BASE_MS: intFromEnv(2_000, { min: 100 }),
    // How long a worker blocks on BRPOP before checking for shutdown.
    QUEUE_BLOCK_TIMEOUT_SEC: intFromEnv(5, { min: 1, max: 60 }),
    // A job with an older heartbeat is considered abandoned and requeued.
    QUEUE_VISIBILITY_TIMEOUT_MS: intFromEnv(300_000, { min: 10_000 }),
    WORKER_CONCURRENCY: intFromEnv(2, { min: 1, max: 32 }),
    JOB_STATUS_TTL_SEC: intFromEnv(86_400, { min: 60 }),

    /* ---- Storage -------------------------------------------------------- */
    STORAGE_DRIVER: z.enum(['local', 's3']).default('local'),
    STORAGE_LOCAL_PATH: z.string().default('./storage'),
    S3_BUCKET: z.string().optional(),
    S3_REGION: z.string().optional(),
    S3_ENDPOINT: z.string().url().optional(),
    S3_ACCESS_KEY_ID: z.string().optional(),
    S3_SECRET_ACCESS_KEY: z.string().optional(),
    S3_FORCE_PATH_STYLE: booleanFromEnv(false),

    /* ---- Uploads -------------------------------------------------------- */
    MAX_UPLOAD_BYTES: intFromEnv(20 * MEGABYTE, { min: MEGABYTE }),
    MAX_PDF_PAGES: intFromEnv(500, { min: 1 }),

    /* ---- Chunking ------------------------------------------------------- */
    CHUNK_SIZE_TOKENS: intFromEnv(512, { min: 64, max: 2_048 }),
    CHUNK_OVERLAP_TOKENS: intFromEnv(64, { min: 0, max: 512 }),

    /* ---- AI provider ---------------------------------------------------- */
    AI_PROVIDER: z.enum(['gemini', 'fake']).default('gemini'),
    GEMINI_API_KEY: z.string().min(1),
    GEMINI_EMBEDDING_MODEL: z.string().min(1).default('text-embedding-004'),
    GEMINI_CHAT_MODEL: z.string().min(1).default('gemini-2.0-flash'),
    EMBEDDING_DIMENSIONS: intFromEnv(768, { min: 64, max: 4_096 }),
    EMBEDDING_BATCH_SIZE: intFromEnv(32, { min: 1, max: 100 }),
    AI_REQUEST_TIMEOUT_MS: intFromEnv(60_000, { min: 1_000 }),
    AI_MAX_RETRIES: intFromEnv(3, { min: 0, max: 10 }),

    /* ---- Retrieval ------------------------------------------------------ */
    // Chunks below this cosine similarity never reach the model — the
    // hallucination guard.
    RETRIEVAL_MIN_SCORE: z.coerce.number().min(0).max(1).default(0.7),
    RETRIEVAL_TOP_K: intFromEnv(6, { min: 1, max: 50 }),
    RETRIEVAL_CANDIDATES: intFromEnv(100, { min: 10, max: 1_000 }),
    VECTOR_INDEX_NAME: z.string().min(1).default('chunk_embedding_index'),
    // Atlas vector search needs a real Atlas cluster; "memory" scores in-process.
    VECTOR_SEARCH_DRIVER: z.enum(['memory', 'atlas']).default('memory'),

    /* ---- Auth ----------------------------------------------------------- */
    JWT_ACCESS_SECRET: z.string().min(32),
    JWT_REFRESH_SECRET: z.string().min(32),
    JWT_ACCESS_TTL: z.string().min(1).default('15m'),
    JWT_REFRESH_TTL: z.string().min(1).default('30d'),
    JWT_ISSUER: z.string().min(1).default('askpdf'),
    JWT_AUDIENCE: z.string().min(1).default('askpdf-api'),
    BCRYPT_ROUNDS: intFromEnv(12, { min: 4, max: 15 }),

    /* ---- Rate limiting -------------------------------------------------- */
    RATE_LIMIT_WINDOW_MS: intFromEnv(60_000, { min: 1_000 }),
    RATE_LIMIT_MAX: intFromEnv(120, { min: 1 }),
    // Tighter than the rest: each attempt costs a bcrypt verification.
    RATE_LIMIT_AUTH_MAX: intFromEnv(10, { min: 1 }),
    RATE_LIMIT_UPLOAD_MAX: intFromEnv(10, { min: 1 }),
    RATE_LIMIT_CHAT_MAX: intFromEnv(30, { min: 1 }),

    /* ---- Observability -------------------------------------------------- */
    METRICS_ENABLED: booleanFromEnv(true),
    METRICS_PATH: z.string().startsWith('/').default('/metrics'),
    SWAGGER_ENABLED: booleanFromEnv(true),
  })
  .superRefine((env, ctx) => {
    if (env.CHUNK_OVERLAP_TOKENS >= env.CHUNK_SIZE_TOKENS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['CHUNK_OVERLAP_TOKENS'],
        message: 'CHUNK_OVERLAP_TOKENS must be smaller than CHUNK_SIZE_TOKENS',
      });
    }

    if (env.MONGO_MIN_POOL_SIZE > env.MONGO_MAX_POOL_SIZE) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MONGO_MIN_POOL_SIZE'],
        message: 'MONGO_MIN_POOL_SIZE cannot exceed MONGO_MAX_POOL_SIZE',
      });
    }

    if (env.STORAGE_DRIVER === 's3') {
      for (const key of ['S3_BUCKET', 'S3_REGION']) {
        if (!env[key]) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: `${key} is required when STORAGE_DRIVER is "s3"`,
          });
        }
      }
    }

    if (env.NODE_ENV === 'production') {
      if (env.AI_PROVIDER === 'fake') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['AI_PROVIDER'],
          message: 'The fake AI provider must never be enabled in production',
        });
      }
      if (env.CORS_ORIGINS.trim() === '*') {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['CORS_ORIGINS'],
          message: 'CORS_ORIGINS must be an explicit allow-list in production',
        });
      }
      if (env.JWT_ACCESS_SECRET === env.JWT_REFRESH_SECRET) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['JWT_REFRESH_SECRET'],
          message: 'Access and refresh tokens must be signed with different secrets',
        });
      }
    }
  });

/** Separate from the singleton so tests can exercise the schema directly. */
export function parseEnv(source) {
  const result = envSchema.safeParse(source);

  if (result.success) {
    return { success: true, data: Object.freeze(result.data) };
  }

  const details = result.error.issues
    .map((issue) => `  - ${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('\n');

  return { success: false, error: `Invalid environment configuration:\n${details}` };
}

function loadEnv() {
  const result = parseEnv(process.env);

  if (!result.success) {
    // The logger depends on config, so this predates it.
    process.stderr.write(`${result.error}\n`);
    process.exit(1);
  }

  return result.data;
}

export const env = loadEnv();

export const isProduction = env.NODE_ENV === 'production';
export const isTest = env.NODE_ENV === 'test';
export const isDevelopment = env.NODE_ENV === 'development';
