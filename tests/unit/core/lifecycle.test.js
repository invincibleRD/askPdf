import { afterEach, describe, expect, it } from 'vitest';
import {
  checkResources,
  closeResources,
  isDraining,
  registerResource,
  resetResources,
  setDraining,
} from '../../../src/core/lifecycle.js';

afterEach(() => {
  resetResources();
});

describe('registerResource', () => {
  it('rejects a duplicate name', () => {
    registerResource({ name: 'mongo' });

    expect(() => {
      registerResource({ name: 'mongo' });
    }).toThrow(/already registered/);
  });
});

describe('checkResources', () => {
  it('is healthy with nothing registered', async () => {
    await expect(checkResources()).resolves.toMatchObject({ healthy: true, checks: {} });
  });

  it('marks a hanging check as down instead of blocking readiness', async () => {
    registerResource({ name: 'stuck', check: () => new Promise(() => {}) });

    const { healthy, checks } = await checkResources({ timeoutMs: 20 });

    expect(healthy).toBe(false);
    expect(checks.stuck.status).toBe('down');
    expect(checks.stuck.error).toMatch(/timed out/);
  });

  it('runs checks concurrently rather than in sequence', async () => {
    const slow = () => new Promise((resolve) => setTimeout(() => resolve(true), 60));
    registerResource({ name: 'a', check: slow });
    registerResource({ name: 'b', check: slow });
    registerResource({ name: 'c', check: slow });

    const startedAt = performance.now();
    await checkResources();

    expect(performance.now() - startedAt).toBeLessThan(150);
  });
});

describe('closeResources', () => {
  it('closes in reverse registration order', async () => {
    const closed = [];
    registerResource({ name: 'redis', close: () => closed.push('redis') });
    registerResource({ name: 'queue', close: () => closed.push('queue') });

    await closeResources();

    // The queue consumer depends on the redis client, so it goes first.
    expect(closed).toEqual(['queue', 'redis']);
  });

  it('continues after a failing close', async () => {
    const closed = [];
    registerResource({ name: 'mongo', close: () => closed.push('mongo') });
    registerResource({
      name: 'broken',
      close: () => {
        throw new Error('socket already destroyed');
      },
    });

    await expect(closeResources()).resolves.toBeUndefined();
    expect(closed).toEqual(['mongo']);
  });
});

describe('draining flag', () => {
  it('defaults to false and flips on demand', () => {
    expect(isDraining()).toBe(false);

    setDraining(true);

    expect(isDraining()).toBe(true);
  });
});
