/**
 * Memoisation for the reporting aggregates.
 *
 * Reporting screens summarize the maintained rollups. Cache work by timeframe
 * and scope so navigation and concurrent readers can share derived results.
 *
 * Cache lifetime and invalidation:
 *
 *   - Aggregates are pure functions of `(timeframe, scope, options)` over
 *     rollup data. Ingest/replacement invalidations are coalesced for up to
 *     thirty seconds; a completed rebuild invalidates immediately.
 *   - Completed entries expire after the configured TTL (five minutes by default) and are bounded by count and
 *     an estimated retained-memory budget. This is not a process RSS limit.
 *   - Separate queries are not a cross-screen database snapshot. Concurrent
 *     writes can be visible between reads; do not promise atomic page totals.
 *
 * Operator decisions (source review state) are deliberately NOT cached — those
 * must take effect immediately, and they are cheap to read anyway.
 *
 * In-flight requests are shared. Two people opening Sources at once, or one
 * screen issuing several aggregates, do the work once.
 */

import { logger } from '../logger.js';
import { onReportingSettingsChanged, reportingPolicy, reportingCacheBudgetBytes } from './reporting-settings.js';

interface Entry {
  value: Promise<unknown>;
  expiresAt: number;
  completedAt: number;
  /** The generation this entry was computed in; bumped by invalidation. */
  generation: number;
  bytes: number;
}

const entries = new Map<string, Entry>();
const inFlight = new Map<string, Entry>();
let generation = 0;
let retainedBytes = 0;
onReportingSettingsChanged(() => {
  const now = Date.now();
  for (const entry of entries.values()) {
    entry.expiresAt = Math.min(entry.expiresAt, entry.completedAt + reportingPolicy().reportingCacheTtlSeconds * 1000);
  }
  evictExpired(now);
  while (entries.size > reportingPolicy().reportingCacheEntries || retainedBytes > reportingCacheBudgetBytes()) {
    const oldest = entries.keys().next();
    if (oldest.done) break;
    removeEntry(oldest.value);
  }
});

/**
 * Drop cached entries. Already-running readers retain their original promise;
 * subsequent requests compute against the new generation.
 */
export function invalidateReportingCache(): void {
  generation += 1;
  if (entries.size > 0) {
    logger.debug(`Reporting cache invalidated (${entries.size} entries dropped)`);
  }
  entries.clear();
  retainedBytes = 0;
  inFlight.clear();
}

/** Cache statistics, for diagnostics. */
export function reportingCacheSize(): number {
  return entries.size;
}

export function reportingCacheBytes(): number {
  return retainedBytes;
}

/** Conservative structural estimate, without copying a large result into JSON. */
export function estimateReportingCacheBytes(value: unknown): number {
  const budget = reportingCacheBudgetBytes();
  const seen = new WeakSet<object>();
  const fieldNames = new Set<string>();
  let bytes = 0;
  function visit(item: unknown, depth: number): void {
    if (bytes > budget) return;
    if (typeof item === 'string') { bytes += 24 + item.length * 2; return; }
    if (item === null || typeof item !== 'object') { bytes += 8; return; }
    if (seen.has(item)) return;
    seen.add(item);
    if (depth > 32) { bytes = budget + 1; return; }
    bytes += 64;
    if (item instanceof Date) return;
    if (item instanceof Map) {
      for (const [key, child] of item) {
        bytes += 32;
        visit(key, depth + 1);
        visit(child, depth + 1);
        if (bytes > budget) break;
      }
    } else if (item instanceof Set) {
      for (const child of item) {
        bytes += 24;
        visit(child, depth + 1);
        if (bytes > budget) break;
      }
    } else if (Array.isArray(item)) {
      for (const child of item) {
        bytes += 8;
        visit(child, depth + 1);
        if (bytes > budget) break;
      }
    } else if (Object.getPrototypeOf(item) === Object.prototype || Object.getPrototypeOf(item) === null) {
      for (const key in item) {
        if (!Object.hasOwn(item, key)) continue;
        bytes += 16;
        if (!fieldNames.has(key)) {
          fieldNames.add(key);
          bytes += 32 + key.length * 2;
        }
        visit((item as Record<string, unknown>)[key], depth + 1);
        if (bytes > budget) break;
      }
    } else {
      // Unsupported containers must not hide their contents from the budget.
      bytes = budget + 1;
    }
  }
  visit(value, 0);
  return bytes;
}

/**
 * DMARC reports can arrive continuously, and invalidating the aggregate cache
 * on every single ingest would make the TTL above ineffective by wiping
 * freshly computed results before operators can reuse them.
 *
 * This coalesces a burst of ingest-triggered invalidations into at most one
 * per window: a new report becomes visible in aggregates within this many
 * milliseconds rather than instantly, independently of the configured TTL.
 */
const INGEST_INVALIDATION_DEBOUNCE_MS = 30 * 1000;
let ingestDebounceTimer: ReturnType<typeof setTimeout> | null = null;

export function scheduleReportingCacheInvalidation(): void {
  if (ingestDebounceTimer) return;
  ingestDebounceTimer = setTimeout(() => {
    ingestDebounceTimer = null;
    invalidateReportingCache();
  }, INGEST_INVALIDATION_DEBOUNCE_MS);
}

/** Test-only: drops any pending debounced invalidation without running it. */
export function resetIngestInvalidationDebounceForTests(): void {
  if (ingestDebounceTimer) clearTimeout(ingestDebounceTimer);
  ingestDebounceTimer = null;
}

function evictExpired(now: number): void {
  for (const [key, entry] of entries) {
    if (entry.expiresAt <= now || entry.generation !== generation) removeEntry(key);
  }
}

function removeEntry(key: string): void {
  const entry = entries.get(key);
  if (entry) retainedBytes -= entry.bytes;
  entries.delete(key);
}

/**
 * Run `compute` unless an identical call is already cached or in flight.
 *
 * A rejected computation is evicted immediately rather than cached, so a
 * transient database error does not pin a failure for the whole TTL.
 */
export function memo<T>(key: string, compute: () => Promise<T>, estimate: (value: T) => number = estimateReportingCacheBytes): Promise<T> {
  const now = Date.now();
  evictExpired(now);
  const existing = entries.get(key);
  if (existing) {
    entries.delete(key);
    entries.set(key, existing);
    return existing.value as Promise<T>;
  }
  const pending = inFlight.get(key);
  if (pending) return pending.value as Promise<T>;

  const bornIn = generation;
  let computation: Promise<T>;
  try {
    computation = compute();
  } catch (error) {
    return Promise.reject(error);
  }
  const entry: Entry = { value: computation, expiresAt: 0, completedAt: 0, generation: bornIn, bytes: 0 };
  const value = computation.then(result => {
    if (bornIn === generation && inFlight.get(key) === entry) {
      const resultBytes = estimate(result);
      const bytes = resultBytes + 64 + key.length * 2;
      if (Number.isFinite(resultBytes) && resultBytes >= 0 && bytes <= reportingCacheBudgetBytes()) {
        evictExpired(Date.now());
        while (entries.size >= reportingPolicy().reportingCacheEntries || retainedBytes + bytes > reportingCacheBudgetBytes()) {
          const oldest = entries.keys().next();
          if (oldest.done) break;
          removeEntry(oldest.value);
        }
        entry.bytes = bytes;
        entry.completedAt = Date.now();
        entry.expiresAt = entry.completedAt + reportingPolicy().reportingCacheTtlSeconds * 1000;
        entries.set(key, entry);
        retainedBytes += bytes;
      }
    }
    return result;
  }).finally(() => {
    if (inFlight.get(key) === entry) inFlight.delete(key);
  });
  entry.value = value;
  inFlight.set(key, entry);

  return value;
}

/**
 * Build a stable cache key. Object key order is normalised so that callers
 * constructing equivalent options differently still share a result.
 */
export function cacheKey(name: string, ...parts: unknown[]): string {
  return `${name}:${parts.map(stable).join('|')}`;
}

/** Rollups are day-grained; sub-day bounds and UI metadata cannot change them. */
export function rollupCacheKey(
  name: string,
  timeframe: { from: Date; to: Date },
  scope: { domain?: string | null; sourceIp?: string | null; reporter?: string | null } = {},
  ...parts: unknown[]
): string {
  return cacheKey(name,
    { from: timeframe.from.toISOString().slice(0, 10), to: timeframe.to.toISOString().slice(0, 10) },
    { domain: scope.domain?.toLowerCase() || undefined, sourceIp: scope.sourceIp || undefined, reporter: scope.reporter?.toLowerCase() || undefined },
    ...parts);
}

function stable(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return String(value.getTime());
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((k) => record[k] !== undefined && record[k] !== null)
      .map((k) => `${k}=${stable(record[k])}`)
      .join(',')}}`;
  }
  return String(value);
}
