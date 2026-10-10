import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  memo,
  cacheKey,
  rollupCacheKey,
  invalidateReportingCache,
  reportingCacheSize,
  reportingCacheBytes,
  estimateReportingCacheBytes,
  scheduleReportingCacheInvalidation,
  resetIngestInvalidationDebounceForTests,
} from './reporting-cache.js';
import { reportingCacheBudgetBytes, reportingDefaults, applyReportingSettings } from './reporting-settings.js';

describe('cacheKey', () => {
  it('is stable across equivalent objects written in different orders', () => {
    expect(cacheKey('x', { b: 2, a: 1 })).toBe(cacheKey('x', { a: 1, b: 2 }));
  });

  it('ignores absent optional fields so callers can pass them or not', () => {
    expect(cacheKey('x', { a: 1, b: undefined })).toBe(cacheKey('x', { a: 1 }));
  });

  it('distinguishes different timeframes', () => {
    const from = new Date('2026-04-01');
    const to = new Date('2026-05-01');
    expect(cacheKey('x', { from, to })).not.toBe(cacheKey('x', { from, to: from }));
  });

  it('separates namespaces so two aggregates cannot collide', () => {
    expect(cacheKey('totals', 1)).not.toBe(cacheKey('trend', 1));
  });

  it('shares rollups for the same UTC days without rounding raw-record keys', () => {
    const morning = { from: new Date('2026-09-01T01:00:00Z'), to: new Date('2026-09-30T01:00:00Z'), defaulted: true };
    const evening = { from: new Date('2026-09-01T22:00:00Z'), to: new Date('2026-09-30T22:00:00Z'), defaulted: false };
    expect(rollupCacheKey('totals', morning)).toBe(rollupCacheKey('totals', evening));
    expect(cacheKey('records', morning)).not.toBe(cacheKey('records', evening));
    expect(rollupCacheKey('totals', morning, {domain:'a.test'})).not.toBe(rollupCacheKey('totals', morning, {domain:'b.test'}));
    expect(rollupCacheKey('totals', morning)).not.toBe(rollupCacheKey('totals', {...morning,to:new Date('2026-10-01')}));
    expect(rollupCacheKey('totals', morning)).toBe(rollupCacheKey('totals', evening, { domain: null, sourceIp: '', reporter: undefined }));
    expect(rollupCacheKey('totals', morning, { domain: 'MAIL.TEST', reporter: 'Receiver' })).toBe(rollupCacheKey('totals', evening, { domain: 'mail.test', reporter: 'receiver' }));
    expect(rollupCacheKey('totals', morning, { domain: 'mail.test ' })).not.toBe(rollupCacheKey('totals', evening, { domain: 'mail.test' }));
  });
});

describe('memo', () => {
  beforeEach(() => {
    applyReportingSettings(reportingDefaults());
    invalidateReportingCache();
  });
  afterEach(() => applyReportingSettings(reportingDefaults()));

  it('trims completed entries immediately when count or byte limits decrease', async () => {
    for (let i = 0; i < 20; i++) await memo(`item-${i}`, async () => i, () => 1024 * 1024);
    applyReportingSettings({ ...reportingDefaults(), reportingCacheEntries: 10 });
    expect(reportingCacheSize()).toBe(10);
    applyReportingSettings({ ...reportingDefaults(), reportingCacheMiB: 16 });
    expect(reportingCacheBytes()).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it('shortens existing lifetimes without extending them on later policy changes', async () => {
    vi.useFakeTimers();
    try {
      await memo('entry', async () => 1);
      await vi.advanceTimersByTimeAsync(6000);
      applyReportingSettings({ ...reportingDefaults(), reportingCacheTtlSeconds: 5 });
      expect(reportingCacheSize()).toBe(0);
      await memo('entry', async () => 2);
      applyReportingSettings(reportingDefaults());
      await vi.advanceTimersByTimeAsync(5001);
      expect(await memo('entry', async () => 3)).toBe(3);
    } finally { vi.useRealTimers(); }
  });

  it('computes once for repeated calls', async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return 'value';
    };
    expect(await memo('k', compute)).toBe('value');
    expect(await memo('k', compute)).toBe('value');
    expect(calls).toBe(1);
  });

  it('shares an in-flight computation rather than starting a second', async () => {
    let calls = 0;
    let release: (v: string) => void = () => {};
    const compute = () => {
      calls += 1;
      return new Promise<string>((resolve) => {
        release = resolve;
      });
    };

    const a = memo('inflight', compute);
    const b = memo('inflight', compute);
    release('done');

    expect(await a).toBe('done');
    expect(await b).toBe('done');
    expect(calls).toBe(1);
  });

  it('recomputes after invalidation, so ingest cannot leave a stale number', async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    expect(await memo('k', compute)).toBe(1);
    invalidateReportingCache();
    expect(await memo('k', compute)).toBe(2);
  });

  it('does not cache a failure, so a transient error is retried', async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      if (calls === 1) throw new Error('transient');
      return 'ok';
    };

    await expect(memo('k', compute)).rejects.toThrow('transient');
    expect(await memo('k', compute)).toBe('ok');
  });

  it('discards a result computed before an invalidation that raced it', async () => {
    let release: (v: string) => void = () => {};
    const first = memo('raced', () => new Promise<string>((r) => (release = r)));
    invalidateReportingCache();
    release('stale');
    await first;

    // The entry born in the old generation must not be served afterwards.
    expect(await memo('raced', async () => 'fresh')).toBe('fresh');
  });

  it('empties on invalidation', async () => {
    await memo('a', async () => 1);
    await memo('b', async () => 2);
    expect(reportingCacheSize()).toBe(2);
    invalidateReportingCache();
    expect(reportingCacheSize()).toBe(0);
  });

  it('accounts for a specialized result estimate in the shared budget', async () => {
    const estimate = vi.fn(() => 32);
    const compute = vi.fn(async () => 42);
    await memo('custom', compute, estimate);
    expect(reportingCacheBytes()).toBe(32 + 64 + 'custom'.length * 2);
    expect(await memo('custom', compute, estimate)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(1);
    expect(estimate).toHaveBeenCalledTimes(1);
  });

  it.each([-1, NaN, Infinity, reportingCacheBudgetBytes()])('does not retain an invalid or oversized specialized estimate: %s', async bytes => {
    const compute = vi.fn(async () => 42);
    expect(await memo('custom', compute, () => bytes)).toBe(42);
    expect(await memo('custom', compute, () => bytes)).toBe(42);
    expect(compute).toHaveBeenCalledTimes(2);
    expect(reportingCacheBytes()).toBe(0);
  });

  it('stays bounded under many distinct keys', async () => {
    for (let i = 0; i < 500; i += 1) {
      await memo(`key-${i}`, async () => i);
    }
    expect(reportingCacheSize()).toBeLessThanOrEqual(200);
  });

  it('evicts by estimated bytes and retains the most recently used result', async () => {
    const large = 'x'.repeat(24 * 1024 * 1024);
    await memo('a', async () => large);
    await memo('b', async () => large);
    await memo('a', async () => 'not recomputed');
    await memo('c', async () => large);
    expect(reportingCacheBytes()).toBeLessThanOrEqual(reportingCacheBudgetBytes());
    expect(await memo('a', async () => 'not recomputed')).toBe(large);
    expect(await memo('b', async () => 'evicted')).toBe('evicted');
  });

  it('returns oversized results but does not retain them', async () => {
    const large = 'x'.repeat(reportingCacheBudgetBytes() / 2);
    const compute = vi.fn(async () => large);
    expect(await memo('large', compute)).toBe(large);
    expect(reportingCacheBytes()).toBe(0);
    await memo('large', compute);
    expect(compute).toHaveBeenCalledTimes(2);
  });

  it('protects in-flight deduplication from completed-entry eviction and TTL', async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: string) => void;
      const compute = vi.fn(() => new Promise<string>(resolve => { release = resolve; }));
      const first = memo('pending', compute);
      for (let i = 0; i < 201; i++) await memo(`other-${i}`, async () => i);
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000 + 1);
      const second = memo('pending', compute);
      release('done');
      expect(await first).toBe('done');
      expect(await second).toBe('done');
      expect(compute).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it('does not let an old generation replace or remove a new in-flight read', async () => {
    let oldRelease!: (value: string) => void;
    let newRelease!: (value: string) => void;
    const old = memo('same', () => new Promise<string>(resolve => { oldRelease = resolve; }));
    invalidateReportingCache();
    const next = memo('same', () => new Promise<string>(resolve => { newRelease = resolve; }));
    oldRelease('old');
    await old;
    const compute = vi.fn(async () => 'wrong');
    const shared = memo('same', compute);
    newRelease('new');
    expect(await next).toBe('new');
    expect(await shared).toBe('new');
    expect(compute).not.toHaveBeenCalled();
    expect(await memo('same', compute)).toBe('new');
  });

  it('starts expiry at completion and accounts for expiry and invalidation', async () => {
    vi.useFakeTimers();
    try {
      let release!: (value: string) => void;
      const first = memo('slow', () => new Promise<string>(resolve => { release = resolve; }));
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      release('done');
      await first;
      expect(reportingCacheBytes()).toBeGreaterThan(0);
      expect(await memo('slow', async () => 'wrong')).toBe('done');
      await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
      await memo('fresh', async () => 1);
      expect(reportingCacheSize()).toBe(1);
      invalidateReportingCache();
      expect(reportingCacheBytes()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it('converts a synchronous computation error to a retryable rejection', async () => {
    await expect(memo('throw', () => { throw new Error('sync'); })).rejects.toThrow('sync');
    expect(await memo('throw', async () => 'recovered')).toBe('recovered');
  });
});

describe('estimated cache weight', () => {
  it('counts row fields, array slots, strings and dates without double counting shared objects', () => {
    const row = { ip: '192.0.2.1', date: new Date(0), count: 1, domains: ['example.test'] };
    expect(estimateReportingCacheBytes([row, row])).toBeLessThan(estimateReportingCacheBytes([row, { ...row }]));
    expect(estimateReportingCacheBytes([row])).toBeGreaterThan(estimateReportingCacheBytes([]));
  });

  it('handles cycles and refuses unsupported containers or excessive depth', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(estimateReportingCacheBytes(cyclic)).toBeLessThan(reportingCacheBudgetBytes());
    expect(estimateReportingCacheBytes(new URL('https://example.test'))).toBeGreaterThan(reportingCacheBudgetBytes());
    let nested: unknown = null;
    for (let i = 0; i < 40; i++) nested = [nested];
    expect(estimateReportingCacheBytes(nested)).toBeGreaterThan(reportingCacheBudgetBytes());
  });

  it('accounts for shared field names once while counting every property slot', () => {
    const short = [{ a: 1 }, { a: 2 }];
    const long = [{ long_field_name: 1 }, { long_field_name: 2 }];
    expect(estimateReportingCacheBytes(long) - estimateReportingCacheBytes(short)).toBe(28);
  });

  it('includes Map and Set contents, including their shared objects and cycles', async () => {
    const row = {volume: 4};
    const map = new Map<string, unknown>([['a.test', row], ['b.test', row]]);
    map.set('self', map);
    expect(estimateReportingCacheBytes(map)).toBeGreaterThan(estimateReportingCacheBytes(new Map()));
    expect(estimateReportingCacheBytes(new Set([row]))).toBeGreaterThan(estimateReportingCacheBytes(new Set()));
    const compute = vi.fn(async () => map);
    expect(await memo('map', compute)).toBe(map);
    expect(await memo('map', compute)).toBe(map);
    expect(compute).toHaveBeenCalledTimes(1);
  });
});

describe('scheduleReportingCacheInvalidation', () => {
  beforeEach(() => {
    invalidateReportingCache();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetIngestInvalidationDebounceForTests();
    vi.useRealTimers();
  });

  it('does not invalidate immediately — a burst of ingests keeps serving the cached value', async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    expect(await memo('k', compute)).toBe(1);

    // A whole burst of reports arriving back-to-back coalesces into one
    // pending invalidation instead of wiping the cache on every single one.
    scheduleReportingCacheInvalidation();
    scheduleReportingCacheInvalidation();
    scheduleReportingCacheInvalidation();

    expect(await memo('k', compute)).toBe(1); // still cached, not yet invalidated
  });

  it('invalidates once the debounce window elapses', async () => {
    let calls = 0;
    const compute = async () => {
      calls += 1;
      return calls;
    };
    expect(await memo('k', compute)).toBe(1);

    scheduleReportingCacheInvalidation();
    await vi.advanceTimersByTimeAsync(30_000);

    expect(await memo('k', compute)).toBe(2);
  });
});
