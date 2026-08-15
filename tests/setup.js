/**
 * Global test bootstrap.
 *
 * Vitest loads this before any suite. It pins the environment variables the
 * config module requires so that importing application code inside a test
 * never depends on the developer's shell or a local .env file.
 */
process.env.NODE_ENV = 'test';
process.env.LOG_LEVEL ??= 'silent';
process.env.PORT ??= '0';
process.env.MONGO_URI ??= 'mongodb://127.0.0.1:27017/askpdf-test';
process.env.REDIS_URL ??= 'redis://127.0.0.1:6379/1';
process.env.GEMINI_API_KEY ??= 'test-gemini-key';
process.env.JWT_ACCESS_SECRET ??= 'test-access-secret-that-is-long-enough-x';
process.env.JWT_REFRESH_SECRET ??= 'test-refresh-secret-that-is-long-enough-x';
