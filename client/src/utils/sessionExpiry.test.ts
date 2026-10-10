import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installSessionExpiryWatcher, setSessionExpiredHandler } from './sessionExpiry';

function jsonResponse(status: number): Response {
  return new Response(JSON.stringify({ success: status < 400 }), { status });
}

describe('session expiry watcher', () => {
  const nativeFetch = window.fetch;
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
    window.fetch = mockFetch as unknown as typeof fetch;
    installSessionExpiryWatcher();
  });

  afterEach(() => {
    window.fetch = nativeFetch;
    setSessionExpiredHandler(null);
  });

  it('notifies the handler on a 401 from a regular API endpoint', async () => {
    mockFetch.mockResolvedValue(jsonResponse(401));
    const handler = vi.fn();
    setSessionExpiredHandler(handler);

    await fetch('/api/users');

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('does not notify on a 401 from /api/auth/me (the routine auth-state check)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(401));
    const handler = vi.fn();
    setSessionExpiredHandler(handler);

    await fetch('/api/auth/me');

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not notify on a 401 from /api/auth/login (a bad-password attempt)', async () => {
    mockFetch.mockResolvedValue(jsonResponse(401));
    const handler = vi.fn();
    setSessionExpiredHandler(handler);

    await fetch('/api/auth/login', { method: 'POST' });

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not notify on a successful response', async () => {
    mockFetch.mockResolvedValue(jsonResponse(200));
    const handler = vi.fn();
    setSessionExpiredHandler(handler);

    await fetch('/api/users');

    expect(handler).not.toHaveBeenCalled();
  });

  it('does not throw when no handler is registered', async () => {
    mockFetch.mockResolvedValue(jsonResponse(401));

    await expect(fetch('/api/users')).resolves.toBeDefined();
  });
});
