import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../../src/config/env.js';
import { DEFAULT_RETRIEVAL_MIN_SCORE } from '../../../src/config/constants.js';

const baseEnv = () => ({
  MONGO_URI: 'mongodb://localhost:27017/askpdf',
  REDIS_URL: 'redis://localhost:6379',
  GEMINI_API_KEY: 'key',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
});

describe('parseEnv', () => {
  it('applies defaults and coerces types', () => {
    const result = parseEnv({ ...baseEnv(), PORT: '8080', METRICS_ENABLED: 'yes' });

    expect(result.success).toBe(true);
    expect(result.data.PORT).toBe(8080);
    expect(result.data.METRICS_ENABLED).toBe(true);
    expect(result.data.RETRIEVAL_MIN_SCORE).toBe(DEFAULT_RETRIEVAL_MIN_SCORE);
    expect(result.data.EMBEDDING_DIMENSIONS).toBe(768);
    expect(result.data.MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });

  it.each(['MONGO_URI', 'REDIS_URL', 'GEMINI_API_KEY', 'JWT_ACCESS_SECRET'])(
    'rejects a missing %s',
    (key) => {
      const source = baseEnv();
      delete source[key];

      const result = parseEnv(source);

      expect(result.success).toBe(false);
      expect(result.error).toContain(key);
    },
  );

  it('rejects a JWT secret shorter than 32 characters', () => {
    expect(parseEnv({ ...baseEnv(), JWT_ACCESS_SECRET: 'too-short' }).success).toBe(false);
  });

  it('rejects chunk overlap that is not smaller than chunk size', () => {
    const result = parseEnv({
      ...baseEnv(),
      CHUNK_SIZE_TOKENS: '256',
      CHUNK_OVERLAP_TOKENS: '256',
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('CHUNK_OVERLAP_TOKENS');
  });

  it('requires a bucket once the GCS driver is selected', () => {
    const result = parseEnv({ ...baseEnv(), STORAGE_DRIVER: 'gcs' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('GCS_BUCKET');
  });

  it('accepts the GCS driver with a bucket, defaulting the prefix to pdf', () => {
    const result = parseEnv({
      ...baseEnv(),
      STORAGE_DRIVER: 'gcs',
      GCS_BUCKET: 'test-bucket',
    });

    expect(result.success).toBe(true);
    expect(result.data.GCS_PREFIX).toBe('pdf');
  });
});

describe('production guard rails', () => {
  const prodEnv = () => ({
    ...baseEnv(),
    NODE_ENV: 'production',
    CORS_ORIGINS: 'https://askpdf.app',
  });

  it('accepts a well-formed production environment', () => {
    expect(parseEnv(prodEnv()).success).toBe(true);
  });

  it('refuses the fake AI provider', () => {
    expect(parseEnv({ ...prodEnv(), AI_PROVIDER: 'fake' }).success).toBe(false);
  });

  it('refuses a wildcard CORS list, which is fine outside production', () => {
    expect(parseEnv({ ...prodEnv(), CORS_ORIGINS: '*' }).success).toBe(false);
    expect(parseEnv({ ...baseEnv(), CORS_ORIGINS: '*' }).success).toBe(true);
  });

  it('refuses one secret shared by both token types', () => {
    const secret = 'c'.repeat(32);

    expect(
      parseEnv({ ...prodEnv(), JWT_ACCESS_SECRET: secret, JWT_REFRESH_SECRET: secret }).success,
    ).toBe(false);
  });
});
