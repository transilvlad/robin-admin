import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, authApi, logsApi } from './client';

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

  it('sends exact Logs filters without splitting commas', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ success: true, data: { rows: [], limit: 200, truncated: false, query: '*' } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } },
    ));

    await logsApi.search({
      start: 100,
      end: 200,
      serviceIds: ['checkout, europe', 'worker'],
      sourceNames: ['collector, production', 'other'],
    });

    const url = new URL(String(fetchMock.mock.calls[0][0]), 'https://admin.example.test');
    expect(url.searchParams.getAll('serviceIds')).toEqual(['checkout, europe', 'worker']);
    expect(url.searchParams.getAll('sourceNames')).toEqual(['collector, production', 'other']);
  });
});
