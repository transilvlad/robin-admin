import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, authApi } from './client';

describe('API client response handling', () => {
  afterEach(() => vi.restoreAllMocks());

  it('accepts an empty successful response', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
    await expect(authApi.me()).resolves.toEqual({});
  });

  it('reports non-JSON error responses without leaking parser errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('<html>bad gateway</html>', {
      status: 502,
      statusText: 'Bad Gateway',
      headers: { 'Content-Type': 'text/html' },
    }));

    await expect(authApi.me()).rejects.toMatchObject({
      message: 'Bad Gateway',
      status: 502,
    } satisfies Partial<ApiError>);
  });

  it('wraps network failures as API errors', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(authApi.me()).rejects.toMatchObject({
      message: 'Failed to fetch',
      status: 0,
    } satisfies Partial<ApiError>);
  });
});
