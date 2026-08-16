import { describe, expect, it } from 'vitest';
import { parseEnv } from '../../../src/config/env.js';

/** The smallest environment that satisfies the schema. */
const baseEnv = () => ({
  MONGO_URI: 'mongodb://localhost:27017/askpdf',
  REDIS_URL: 'redis://localhost:6379',
  GEMINI_API_KEY: 'key',
  JWT_ACCESS_SECRET: 'a'.repeat(32),
  JWT_REFRESH_SECRET: 'b'.repeat(32),
});

describe('parseEnv', () => {
  it('accepts a minimal environment and applies defaults', () => {
    const result = parseEnv(baseEnv());

    expect(result.success).toBe(true);
    expect(result.data.NODE_ENV).toBe('development');
    expect(result.data.PORT).toBe(3000);
    expect(result.data.RETRIEVAL_MIN_SCORE).toBe(0.7);
    expect(result.data.EMBEDDING_DIMENSIONS).toBe(768);
    expect(result.data.MAX_UPLOAD_BYTES).toBe(20 * 1024 * 1024);
  });

  it('coerces numeric strings into numbers', () => {
    const result = parseEnv({ ...baseEnv(), PORT: '8080', RETRIEVAL_TOP_K: '12' });

    expect(result.success).toBe(true);
    expect(result.data.PORT).toBe(8080);
    expect(result.data.RETRIEVAL_TOP_K).toBe(12);
  });

  it('coerces the documented truthy spellings into booleans', () => {
    for (const [raw, expected] of [
      ['true', true],
      ['1', true],
      ['yes', true],
      ['on', true],
      ['false', false],
      ['0', false],
      ['no', false],
      ['off', false],
    ]) {
      const result = parseEnv({ ...baseEnv(), METRICS_ENABLED: raw });
      expect(result.success, `METRICS_ENABLED=${raw}`).toBe(true);
      expect(result.data.METRICS_ENABLED, `METRICS_ENABLED=${raw}`).toBe(expected);
    }
  });

  it('freezes the parsed config so it cannot drift at runtime', () => {
    const result = parseEnv(baseEnv());

    expect(Object.isFrozen(result.data)).toBe(true);
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

  it('rejects JWT secrets shorter than 32 characters', () => {
    const result = parseEnv({ ...baseEnv(), JWT_ACCESS_SECRET: 'too-short' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('JWT_ACCESS_SECRET');
  });

  it('rejects a port outside the valid range', () => {
    const result = parseEnv({ ...baseEnv(), PORT: '70000' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('PORT');
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

  it('rejects a min pool size larger than the max', () => {
    const result = parseEnv({ ...baseEnv(), MONGO_MIN_POOL_SIZE: '30', MONGO_MAX_POOL_SIZE: '10' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('MONGO_MIN_POOL_SIZE');
  });

  it('requires bucket and region when the S3 driver is selected', () => {
    const result = parseEnv({ ...baseEnv(), STORAGE_DRIVER: 's3' });

    expect(result.success).toBe(false);
    expect(result.error).toContain('S3_BUCKET');
    expect(result.error).toContain('S3_REGION');
  });

  it('accepts the S3 driver once bucket and region are supplied', () => {
    const result = parseEnv({
      ...baseEnv(),
      STORAGE_DRIVER: 's3',
      S3_BUCKET: 'askpdf-docs',
      S3_REGION: 'ap-south-1',
    });

    expect(result.success).toBe(true);
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
      const result = parseEnv({ ...prodEnv(), AI_PROVIDER: 'fake' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('AI_PROVIDER');
    });

    it('refuses a wildcard CORS allow-list', () => {
      const result = parseEnv({ ...prodEnv(), CORS_ORIGINS: '*' });

      expect(result.success).toBe(false);
      expect(result.error).toContain('CORS_ORIGINS');
    });

    it('refuses reusing one secret for both token types', () => {
      const secret = 'c'.repeat(32);
      const result = parseEnv({
        ...prodEnv(),
        JWT_ACCESS_SECRET: secret,
        JWT_REFRESH_SECRET: secret,
      });

      expect(result.success).toBe(false);
      expect(result.error).toContain('JWT_REFRESH_SECRET');
    });

    it('allows the wildcard outside production', () => {
      expect(parseEnv({ ...baseEnv(), CORS_ORIGINS: '*' }).success).toBe(true);
    });
  });
});
