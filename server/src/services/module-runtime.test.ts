import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const target = { slug: 'robin-tools', installed: true, probeUrl: 'http://robin-tools-server:3003/health' };

describe('module runtime readiness', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each([
    [{ ...target, installed: false }, 'This module is not installed on the current deployment.'],
    [{ ...target, probeUrl: null }, 'No runtime probe URL is configured for this module.'],
  ])('does not probe an unavailable target', async (input, message) => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    expect(await probeModuleRuntime(input)).toEqual({ runtimeAvailable: false, runtimeStatus: 'unknown', runtimeMessage: message });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('caches successful health responses, not credentials or frontend availability', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    expect((await probeModuleRuntime(target)).runtimeAvailable).toBe(true);
    await probeModuleRuntime(target);
    expect(fetch).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledWith(target.probeUrl, { method: 'HEAD', signal: expect.any(AbortSignal), redirect: 'manual' });
    await vi.advanceTimersByTimeAsync(10_000);
    await probeModuleRuntime(target);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('allows a cold response slower than the former 1.5 second deadline', async () => {
    const fetch = vi.fn().mockImplementation(() => new Promise<Response>((resolve) => {
      setTimeout(() => resolve(new Response(null, { status: 200 })), 1900);
    }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    const probe = probeModuleRuntime(target);
    await vi.advanceTimersByTimeAsync(1900);
    expect((await probe).runtimeStatus).toBe('reachable');
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('coalesces concurrent callers throughout a transient startup retry', async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    const probes = [probeModuleRuntime(target), probeModuleRuntime(target), probeModuleRuntime(target)];
    await vi.advanceTimersByTimeAsync(250);
    expect((await Promise.all(probes)).every(result => result.runtimeAvailable)).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([408, 425, 429, 502, 503, 504])('retries transient HTTP %s once', async (status) => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status }))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    const probe = probeModuleRuntime(target);
    await vi.advanceTimersByTimeAsync(250);
    expect((await probe).runtimeAvailable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('retries a refused connection once', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new TypeError('fetch failed'))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    const probe = probeModuleRuntime(target);
    await vi.advanceTimersByTimeAsync(250);
    expect((await probe).runtimeAvailable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('aborts a slow attempt, then accepts the ready retry', async () => {
    const fetch = vi.fn().mockImplementationOnce((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    })).mockResolvedValueOnce(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    const probe = probeModuleRuntime(target);
    await vi.advanceTimersByTimeAsync(3250);
    expect((await probe).runtimeAvailable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds repeated timeouts and quickly rechecks recovery after failure', async () => {
    const fetch = vi.fn().mockImplementation((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      options.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
    }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    const probe = probeModuleRuntime(target);
    await vi.advanceTimersByTimeAsync(6250);
    expect(await probe).toEqual({ runtimeAvailable: false, runtimeStatus: 'unreachable', runtimeMessage: 'Module runtime readiness probe timed out after 3000 ms.' });
    expect(fetch).toHaveBeenCalledTimes(2);
    await probeModuleRuntime(target);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(2000);
    fetch.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect((await probeModuleRuntime(target)).runtimeAvailable).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
  });

  it.each([301, 302, 401, 403, 404, 405, 500])('does not hide HTTP %s behind retries or redirects', async (status) => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    expect(await probeModuleRuntime(target)).toEqual({ runtimeAvailable: false, runtimeStatus: 'unreachable', runtimeMessage: `Module runtime probe returned HTTP ${status}.` });
    expect(fetch).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps a persistent startup failure visible after the bounded retry', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 503 }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    const probe = probeModuleRuntime(target);
    await vi.advanceTimersByTimeAsync(250);
    expect((await probe).runtimeStatus).toBe('unreachable');
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('does not reuse cached readiness for a different URL or installation state', async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    vi.stubGlobal('fetch', fetch);
    const { probeModuleRuntime } = await import('./module-runtime.js');
    await probeModuleRuntime(target);
    expect((await probeModuleRuntime({ ...target, probeUrl: 'http://new-host:3003/health' })).runtimeAvailable).toBe(true);
    expect((await probeModuleRuntime({ ...target, installed: false })).runtimeStatus).toBe('unknown');
    expect(fetch).toHaveBeenCalledTimes(2);
  });
});
