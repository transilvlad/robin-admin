/**
 * Who is sending Telemetry, and how the store is doing.
 *
 * Sources are senders seen in the configured discovery window: their groups, how many series
 * they send now, and when they last sent anything. Store health reads the
 * store's own metrics when it is VictoriaMetrics, and works with less detail
 * on any other Prometheus-compatible store.
 */

import { connectionUrl, getStoreConnection } from './connection.js';
import { getConfig } from '../../db/queries/config.js';
import { labelNames, labelValues, queryInstant, MAX_LABEL_VALUES } from './query.js';
import { readTelemetryStore, readTelemetryStoreText } from './store-client.js';
import { discoverySelector } from './discovery.js';

export interface TelemetrySource {
  name: string;
  groups: string[];
  query: string;
  /** Series the source sends now (within the store's lookback window). */
  series: number;
  /** Unix seconds of the newest sample, or null when older than a day. */
  lastSeen: number | null;
  silent: boolean;
}

export interface TelemetrySources {
  sourceLabel: string;
  groupLabel: string;
  sources: TelemetrySource[];
  sourceWindowDays: number;
  silentAfterSeconds: number;
  refreshSeconds: number;
  limit: number;
  truncated: boolean;
  emptyReason: 'no-data' | 'selector-mismatch' | 'missing-source-label' | null;
  suggestedSourceLabels: string[];
}

export async function listTelemetrySources(nowSeconds = Math.floor(Date.now() / 1000)): Promise<TelemetrySources> {
  const settings = await getConfig();
  const limit = settings.telemetrySourceLimit;
  const windowSeconds = settings.telemetrySourceWindowDays * 86400;
  const identity = settings.telemetrySourceLabel;
  const group = settings.telemetryGroupLabel;
  const by = group ? `${identity}, ${group}` : identity;
  const selector = discoverySelector(settings);
  const [hosts, counts, roles, current, recent] = await Promise.all([
    labelValues({ name: identity, match: selector, start: nowSeconds - windowSeconds, end: nowSeconds }),
    queryInstant({ query: `count by (${by}) (${selector})`, time: nowSeconds, maxSeries: limit }),
    // Roles of hosts that have stopped too, sampled hourly over the source window to stay cheap.
    queryInstant({
      query: `group by (${by}) (last_over_time(group by (${by}) (${selector})[${windowSeconds}s:1h]))`,
      time: nowSeconds,
      maxSeries: limit,
    }),
    // Exact time of the newest sample for hosts that are sending now.
    queryInstant({ query: `max by (${identity}) (timestamp(${selector}))`, time: nowSeconds, maxSeries: limit }),
    // To within five minutes for hosts that stopped during the last day.
    queryInstant({
      query: `max by (${identity}) (max_over_time(timestamp(group by (${identity}) (${selector}))[24h:5m]))`,
      time: nowSeconds,
      maxSeries: limit,
    }),
  ]);

  const sources = new Map<string, TelemetrySource>();
  let truncated = hosts.length > limit || hosts.length >= MAX_LABEL_VALUES || [counts, roles, current, recent].some(result => result.truncated);
  const source = (host: string) => {
    if (!host) return undefined;
    let entry = sources.get(host);
    if (!entry) {
      if (sources.size >= limit) { truncated = true; return undefined; }
      entry = { name: host, groups: [], query: discoverySelector(settings, [`${identity}=${JSON.stringify(host)}`]), series: 0, lastSeen: null, silent: true };
      sources.set(host, entry);
    }
    return entry;
  };
  for (const host of hosts.slice(0, limit)) source(host);
  for (const { labels, value } of counts.series) {
    const entry = source(labels[identity]);
    if (!entry) continue;
    entry.series += value ?? 0;
    if (group && labels[group] && !entry.groups.includes(labels[group])) entry.groups.push(labels[group]);
  }
  for (const { labels } of roles.series) {
    const entry = source(labels[identity]);
    if (!entry) continue;
    if (group && labels[group] && !entry.groups.includes(labels[group])) entry.groups.push(labels[group]);
  }
  for (const { labels, value } of recent.series) {
    const entry = source(labels[identity]);
    if (value !== null && entry) entry.lastSeen = Math.floor(value);
  }
  for (const { labels, value } of current.series) {
    const entry = source(labels[identity]);
    if (value !== null && entry) entry.lastSeen = Math.floor(value);
  }
  let emptyReason: TelemetrySources['emptyReason'] = null;
  let suggestedSourceLabels: string[] = [];
  if (sources.size === 0) {
    // Diagnose empty discovery only; populated refreshes need no extra metadata reads.
    const window = { name: '__name__', start: nowSeconds - windowSeconds, end: nowSeconds };
    const [allMetrics, matchingMetrics] = await Promise.all([
      labelValues(window),
      labelValues({ ...window, match: settings.telemetrySourceSelector }),
    ]);
    emptyReason = allMetrics.length === 0 ? 'no-data'
      : matchingMetrics.length === 0 ? 'selector-mismatch' : 'missing-source-label';
    if (emptyReason === 'missing-source-label') {
      suggestedSourceLabels = (await labelNames({
        match: settings.telemetrySourceSelector,
        start: nowSeconds - windowSeconds,
        end: nowSeconds,
      })).filter(name => name !== '__name__' && name !== identity && name !== group).slice(0, 12);
    }
  }
  return {
    sourceLabel: identity,
    groupLabel: group,
    sources: [...sources.values()]
      .map((entry) => ({ ...entry, groups: entry.groups.sort(), silent: entry.lastSeen === null || nowSeconds - entry.lastSeen > settings.telemetrySilentAfterSeconds }))
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })),
    sourceWindowDays: settings.telemetrySourceWindowDays,
    silentAfterSeconds: settings.telemetrySilentAfterSeconds,
    refreshSeconds: settings.telemetrySourceRefreshSeconds,
    limit,
    truncated,
    emptyReason,
    suggestedSourceLabels,
  };
}

/** Parse Prometheus text exposition into name -> [{labels, value}]. */
export function parseExposition(text: string): Map<string, Array<{ labels: Record<string, string>; value: number }>> {
  const metrics = new Map<string, Array<{ labels: Record<string, string>; value: number }>>();
  for (const line of text.split('\n')) {
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^([a-zA-Z_:][a-zA-Z0-9_:]*)(\{(.*)\})?\s+(\S+)/);
    if (!match) continue;
    const labels: Record<string, string> = {};
    for (const pair of (match[3] ?? '').matchAll(/([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"/g)) {
      labels[pair[1]] = pair[2];
    }
    const value = Number(match[4]);
    if (!Number.isFinite(value)) continue;
    const list = metrics.get(match[1]) ?? [];
    list.push({ labels, value });
    metrics.set(match[1], list);
  }
  return metrics;
}

export interface TelemetryStoreHealth {
  /** Store host and port, never credentials or paths. */
  address: string;
  kind: 'victoriametrics' | 'prometheus-compatible';
  version: string | null;
  retention: string | null;
  totalSeries: number;
  dataSizeBytes: number | null;
  freeDiskBytes: number | null;
  /** Memory the store may use (its container limit, when it has one). */
  memoryLimitBytes: number | null;
  rowsInserted: number | null;
  /** Samples the store refused (malformed lines, bad labels) since it started. */
  rowsRejected: number | null;
  /** Per second, measured between this and the previous health read. */
  ingestRate: number | null;
  rejectRate: number | null;
  topMetrics: Array<{ name: string; series: number }>;
}

/**
 * Rates compare a read with a baseline at least this old. Senders write in
 * batches every few seconds to a minute, so a shorter window can see no change
 * and report zero.
 */
const MIN_RATE_WINDOW_MS = 60_000;
/** The baseline is replaced once older than this, so rates stay recent. */
const MAX_RATE_WINDOW_MS = 10 * 60_000;

let previous: { at: number; inserted: number; rejected: number } | null = null;

function sum(metrics: ReturnType<typeof parseExposition>, name: string, filter?: (labels: Record<string, string>) => boolean): number | null {
  const list = metrics.get(name);
  if (!list) return null;
  return list.filter((entry) => !filter || filter(entry.labels)).reduce((total, entry) => total + entry.value, 0);
}

export async function telemetryStoreHealth(): Promise<TelemetryStoreHealth> {
  const [tsdb, text] = await Promise.all([
    readTelemetryStore<{ totalSeries: number; seriesCountByMetricName?: Array<{ name: string; value: number }> }>(
      '/api/v1/status/tsdb',
      new URLSearchParams({ topN: '10' }),
    ),
    readTelemetryStoreText('/metrics'),
  ]);
  const metrics = text ? parseExposition(text) : new Map();
  const victoria = metrics.has('vm_app_version');
  const inserted = sum(metrics, 'vm_rows_inserted_total');
  const rejected = victoria
    ? (sum(metrics, 'vm_rows_invalid_total') ?? 0) + (sum(metrics, 'vm_rows_ignored_total') ?? 0)
    : null;

  let ingestRate: number | null = null;
  let rejectRate: number | null = null;
  const now = Date.now();
  if (inserted !== null && rejected !== null) {
    const age = previous ? now - previous.at : Infinity;
    const restarted = previous !== null && inserted < previous.inserted;
    if (previous && !restarted && age >= MIN_RATE_WINDOW_MS && age <= MAX_RATE_WINDOW_MS) {
      const seconds = age / 1000;
      ingestRate = (inserted - previous.inserted) / seconds;
      rejectRate = Math.max(0, rejected - previous.rejected) / seconds;
    }
    // A store restart resets its counters; start again from the new values.
    if (age > MAX_RATE_WINDOW_MS || restarted) previous = { at: now, inserted, rejected };
  }

  let address = '';
  try {
    address = new URL(connectionUrl(await getStoreConnection())).host;
  } catch {
    address = '';
  }

  return {
    address,
    kind: victoria ? 'victoriametrics' : 'prometheus-compatible',
    version: metrics.get('vm_app_version')?.[0]?.labels.short_version ?? null,
    retention: metrics.get('flag')?.find((entry: { labels: Record<string, string> }) => entry.labels.name === 'retentionPeriod')?.labels.value ?? null,
    totalSeries: tsdb.totalSeries,
    dataSizeBytes: sum(metrics, 'vm_data_size_bytes'),
    freeDiskBytes: sum(metrics, 'vm_free_disk_space_bytes'),
    memoryLimitBytes: sum(metrics, 'vm_available_memory_bytes'),
    rowsInserted: inserted,
    rowsRejected: rejected,
    ingestRate,
    rejectRate,
    topMetrics: (tsdb.seriesCountByMetricName ?? []).map((entry) => ({ name: entry.name, series: entry.value })),
  };
}
