import { describe, expect, it } from 'vitest';
import {
  getContext,
  getRequestId,
  runWithContext,
  setContext,
} from '../../../src/core/request-context.js';

describe('request context', () => {
  it('exposes the bound context inside the callback', () => {
    runWithContext({ requestId: 'req-1', userId: 'user-1' }, () => {
      expect(getContext()).toMatchObject({ requestId: 'req-1', userId: 'user-1' });
      expect(getRequestId()).toBe('req-1');
    });
  });

  it('generates a request id when none is supplied', () => {
    runWithContext({}, () => {
      expect(getRequestId()).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('returns an empty context outside any bound scope', () => {
    expect(getContext()).toEqual({});
    expect(getRequestId()).toBeUndefined();
  });

  it('survives across await boundaries', async () => {
    await runWithContext({ requestId: 'req-2' }, async () => {
      await new Promise((resolve) => setImmediate(resolve));
      expect(getRequestId()).toBe('req-2');
    });
  });

  it('keeps concurrent scopes isolated', async () => {
    const seen = await Promise.all([
      runWithContext({ requestId: 'a' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 10));
        return getRequestId();
      }),
      runWithContext({ requestId: 'b' }, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1));
        return getRequestId();
      }),
    ]);

    expect(seen).toEqual(['a', 'b']);
  });

  it('merges late-arriving fields such as the authenticated user', () => {
    runWithContext({ requestId: 'req-3' }, () => {
      setContext({ userId: 'user-9' });

      expect(getContext()).toEqual({ requestId: 'req-3', userId: 'user-9' });
    });
  });

  it('ignores setContext outside a bound scope', () => {
    expect(() => {
      setContext({ userId: 'nobody' });
    }).not.toThrow();
    expect(getContext()).toEqual({});
  });
});
