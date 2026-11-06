import { config as appConfig } from '../config.js';
import { getConfig } from '../db/queries/config.js';
import { enqueueLogsBatch, getLogsSpoolStatus, type LogsSpoolOrigin, type LogsSpoolStatus, type LogsStoreRow } from '../db/queries/logs-spool.js';
import { logger } from '../logger.js';
import type { LogsSource, LogsSourcesResult } from '../types/logs.js';
import { normalizeLogText, truncateLogText } from './log-text.js';

export const MAX_BATCH_LINES = 2_000;
export const MAX_LINE_BYTES = 8 * 1024;
export const MAX_INGEST_LINES = 1_000;
export const MAX_SOURCE_NAME_LENGTH = 120;
export const MAX_QUERY_LENGTH = 1_000;
export const MAX_SEARCH_LIMIT = 1_000;
export const DEFAULT_SEARCH_LIMIT = 200;
export const MAX_SEARCH_SERVICES = 50;
export const MAX_SEARCH_RANGE_MS = 31 * 24 * 60 * 60 * 1000;
const INGEST_TIMEOUT_MS = 10_000;
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
const SEARCH_TIMEOUT_MS = 15_000;
const HEALTH_TIMEOUT_MS = 5_000;
const RESPONSE_LIMIT = 16 * 1024 * 1024;
const STREAM_FIELDS = 'service_type,service_id';

export interface LogEntry {
  time: string; // RFC3339 or nanosecond epoch string
  receivedAt?: string;
  message: string;
  serviceType?: string;
  serviceId?: string;
  source: string;
  sourceType?: string;
  sourceName?: string;
  severity?: string;
  host?: string;
  environment?: string;
  eventId?: string;
  attributesJson?: string;
  agentId?: string;
}

export interface LogSearchRow {
  time: string;
  serviceType: string;
  serviceId: string;
  source: string;
  sourceType: string;
  sourceName: string;
  severity: string;
  host: string;
  environment: string;
  eventId: string;
  receivedAt: string;
  message: string;
}

export interface LogSearchParams {
  start: Date;
  end: Date;
  serviceIds?: string[];
  serviceTypes?: string[];
  sourceNames?: string[];
  query?: string;
  limit?: number;
}

export interface LogSearchResult {
  rows: LogSearchRow[];
  limit: number;
  truncated: boolean;
  query: string;
}

export interface LogsWriteStatus extends LogsSpoolStatus {
  capacityBytes: number;
}

export interface LogsStoreStatus {
  enabled: boolean;
  reachable: boolean;
  storageBytes: number | null;
  maxDiskBytes: number | null;
  retentionDays: number;
  rowsIngested24h: number | null;
  oldestLogAt: string | null;
  metrics: {
    rowsIngestedTotal: number | null;
    bytesIngestedTotal: number | null;
    rowsDroppedTotal: number | null;
    streamsCreatedTotal: number | null;
  };
  error?: string;
  write: LogsWriteStatus;
}

export class LogsQueryError extends Error {
  readonly status = 400;
}

export class LogsStoreUnavailableError extends Error {
  readonly status = 503;
  constructor(message = 'Logs store is unavailable') { super(message); }
}

export class LogsBatchTooLargeError extends Error {
  readonly status = 413;
}

/** A store write that failed; `uncertain` means the lines may have been stored. */
export class LogsStoreWriteError extends Error {
  constructor(message: string, readonly uncertain: boolean, readonly rejected = false) { super(message); }
}

type Fetch = typeof fetch;

let fetchImpl: Fetch = (...args) => fetch(...args);

export function setLogsStoreFetchForTests(fn: Fetch | null): void {
  fetchImpl = fn ?? ((...args) => fetch(...args));
}

/** Nanoseconds since the epoch for an RFC 3339 timestamp, or null. */
export function rfc3339ToNanos(value: string): bigint | null {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,9}))?(Z|[+-]\d{2}:\d{2})$/.exec(value);
  if (!match) return null;
  const ms = Date.parse(`${match[1]}${match[3]}`);
  if (!Number.isFinite(ms)) return null;
  return BigInt(ms) * 1_000_000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}

/**
 * Build store rows for lines a Fleet agent read. A line keeps the time the
 * agent read from the log when it is plausible (within retention and not in the
 * future); otherwise the arrival time is used. A later line's timestamp is
 * not changed to force the batch into chronological order.
 */
export function fleetLogRows(
  meta: { serviceType: string; serviceId: string; source: string; agentId?: string },
  lines: string[],
  times: unknown[] = [],
  nowMs = Date.now(),
): LogsStoreRow[] {
  const earliest = BigInt(nowMs - appConfig.logs.retentionDays * 24 * 60 * 60 * 1000) * 1_000_000n;
  const latest = BigInt(nowMs + MAX_FUTURE_SKEW_MS) * 1_000_000n;
  const arrival = BigInt(nowMs) * 1_000_000n;
  const receivedAt = new Date(nowMs).toISOString();
  const rows: LogsStoreRow[] = [];
  lines.forEach((line, index) => {
    if (typeof line !== 'string' || !line.trim()) return;
    const raw = times[index];
    const parsed = typeof raw === 'string' ? rfc3339ToNanos(raw) : null;
    const nanos = parsed !== null && parsed >= earliest && parsed <= latest ? parsed : arrival;
    rows.push(toStoreRow({
      time: nanos.toString(),
      receivedAt,
      message: line,
      serviceType: meta.serviceType,
      serviceId: meta.serviceId,
      source: meta.source,
      sourceType: 'fleet',
      sourceName: meta.serviceId,
      ...(meta.agentId ? { agentId: meta.agentId } : {}),
    }));
  });
  return rows;
}

export function toStoreRow(entry: LogEntry): LogsStoreRow {
  const row: LogsStoreRow = {
    _time: entry.time,
    _msg: entry.message,
    ...(entry.receivedAt ? { received_at: entry.receivedAt } : {}),
    ...(entry.serviceType ? { service_type: entry.serviceType } : {}),
    ...(entry.serviceId ? { service_id: entry.serviceId } : {}),
    source: entry.source,
    ...(entry.sourceType ? { source_type: entry.sourceType } : {}),
    ...(entry.sourceName ? { source_name: entry.sourceName } : {}),
    ...(entry.severity ? { severity: entry.severity } : {}),
    ...(entry.host ? { host: entry.host } : {}),
    ...(entry.environment ? { environment: entry.environment } : {}),
    ...(entry.eventId ? { event_id: entry.eventId } : {}),
    ...(entry.attributesJson ? { attributes_json: entry.attributesJson } : {}),
    ...(entry.agentId ? { agent_id: entry.agentId } : {}),
  };
  for (const key of Object.keys(row)) row[key] = normalizeLogText(row[key]);
  row._msg = truncateLogText(row._msg, MAX_LINE_BYTES);
  return row;
}

function errorCode(error: unknown): string {
  const cause = (error as { cause?: { code?: unknown } } | null)?.cause;
  return typeof cause?.code === 'string' ? cause.code : '';
}

/**
 * Write rows to the store. Failures are classified so the delivery worker knows
 * whether the store may already hold the lines: a refused connection never
 * reached it, while a timeout or server error may have stored some of them.
 */
export async function writeStoreRows(rows: LogsStoreRow[], timeoutMs = INGEST_TIMEOUT_MS): Promise<void> {
  if (!rows.length) return;
  const params = new URLSearchParams({ _stream_fields: `${STREAM_FIELDS},source_type`, _msg_field: '_msg', _time_field: '_time' });
  let response: { status: number; body: string };
  try {
    response = await storeFetch(`/insert/jsonline?${params}`, timeoutMs, {
      method: 'POST',
      headers: { 'Content-Type': 'application/stream+json' },
      body: `${rows.map((row) => JSON.stringify(row)).join('\n')}\n`,
    });
  } catch (error) {
    const code = errorCode(error);
    const notSent = ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN'].includes(code) || /not configured/.test(String(error));
    throw new LogsStoreWriteError(safeMessage(error), !notSent);
  }
  if (response.status >= 200 && response.status < 300) return;
  const rejected = response.status === 400 || response.status === 413 || response.status === 422;
  throw new LogsStoreWriteError(`Logs store rejected the batch (HTTP ${response.status})`, !rejected, rejected);
}

/**
 * Accept a bounded external batch into the durable queue. Once this resolves
 * the lines survive a restart or a store outage; a full queue is reported so
 * the sender can retry later.
 */
export async function ingestExternalLogs(
  entries: LogEntry[],
  options: { origin: Exclude<LogsSpoolOrigin, 'fleet'>; idempotencyKey?: string | null },
): Promise<void> {
  if (entries.length === 0) return;
  if (entries.length > MAX_INGEST_LINES) throw new LogsQueryError(`Ingest at most ${MAX_INGEST_LINES} log lines per request`);
  if (!appConfig.logs.storeUrl) throw new LogsStoreUnavailableError('Logs store is not configured');
  let outcome;
  try {
    outcome = await enqueueLogsBatch({
      origin: options.origin,
      idempotencyKey: options.idempotencyKey,
      rows: entries.map(toStoreRow),
      maxBytes: appConfig.logs.spoolMaxBytes,
    });
  } catch (error) {
    logger.warn('External Logs ingestion could not be queued', { error: safeMessage(error), lines: entries.length });
    throw new LogsStoreUnavailableError('Logs ingestion is temporarily unavailable');
  }
  if (outcome === 'full') {
    logger.warn('External Logs ingestion refused because the queue is full', { lines: entries.length });
    throw new LogsStoreUnavailableError('Logs ingestion queue is full');
  }
  if (outcome === 'too_large') {
    throw new LogsBatchTooLargeError('Logs batch exceeds the configured queue capacity; split this batch and retry');
  }
}

async function storeFetch(path: string, timeoutMs: number, init: RequestInit = {}): Promise<{ status: number; body: string }> {
  const base = appConfig.logs.storeUrl;
  if (!base) throw new Error('Logs store is not configured');
  const response = await fetchImpl(`${base}${path}`, { ...init, signal: AbortSignal.timeout(timeoutMs) });
  const reader = response.body?.getReader();
  if (!reader) return { status: response.status, body: '' };
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > RESPONSE_LIMIT) throw new Error('Logs store response exceeds the safety limit');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
}

function safeMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/abort|timeout/i.test(message)) return 'Logs store request timed out';
  if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|socket/i.test(message)) return 'Logs store is unreachable';
  return message.slice(0, 200);
}

/** Quote a value as a LogsQL string literal. */
export function quoteLogsValue(value: string): string {
  return JSON.stringify(value);
}

/**
 * Validate free text typed into the search box. Filters (words, phrases,
 * field:value, AND/OR/NOT, parentheses) are allowed; pipes are not, so a query
 * cannot replace the server's sort, limit or scoping.
 */
export function validateUserQuery(raw: string | undefined): string {
  const query = (raw ?? '').trim();
  if (query.length > MAX_QUERY_LENGTH) throw new LogsQueryError(`Query must be at most ${MAX_QUERY_LENGTH} characters`);
  let quote: string | null = null;
  for (let i = 0; i < query.length; i += 1) {
    const ch = query[i];
    if (ch === '\n' || ch === '\r') throw new LogsQueryError('Query must be a single line');
    if (quote) {
      if (ch === '\\' && quote !== '`') { i += 1; continue; }
      if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '|') throw new LogsQueryError('Pipes (|) are not supported in Logs search; use filters only');
  }
  if (quote) throw new LogsQueryError('Query has an unterminated quoted string');
  return query;
}

export function buildLogsQuery(params: Pick<LogSearchParams, 'serviceIds' | 'serviceTypes' | 'sourceNames' | 'query'>): string {
  const parts: string[] = [];
  const ids = [...new Set((params.serviceIds ?? []).filter(Boolean))];
  const types = [...new Set((params.serviceTypes ?? []).filter(Boolean))];
  const sources = [...new Set((params.sourceNames ?? []).filter(Boolean))];
  if (ids.length) parts.push(`service_id:in(${ids.map(quoteLogsValue).join(',')})`);
  if (types.length) parts.push(`service_type:in(${types.map(quoteLogsValue).join(',')})`);
  if (sources.length) {
    const list = sources.map(quoteLogsValue).join(',');
    // Legacy fleet rows have no source_name; their source is the service id.
    parts.push(`(source_name:in(${list}) or (source_name:"" agent_id:* service_id:in(${list})))`);
  }
  const user = validateUserQuery(params.query);
  if (user) parts.push(`(${user})`);
  return `${parts.length ? parts.join(' ') : '*'} | sort by (_time desc)`;
}

// Fleet lines stored before source fields existed carry only agent/service ids.
function legacyFleetSource(row: Record<string, unknown>): { sourceType: string; sourceName: string } | null {
  if (typeof row.source_name === 'string' && row.source_name) return null;
  const serviceId = typeof row.service_id === 'string' ? row.service_id : '';
  const agentId = typeof row.agent_id === 'string' ? row.agent_id : '';
  return serviceId && agentId ? { sourceType: 'fleet', sourceName: serviceId } : null;
}

async function requestTimeoutMs(): Promise<number> {
  try {
    const value = (await getConfig()).logsRequestTimeoutMs;
    return Number.isInteger(value) && value > 0 ? value : SEARCH_TIMEOUT_MS;
  } catch (error) {
    logger.warn('Logs request timeout configuration unavailable; using the default', { error: safeMessage(error) });
    return SEARCH_TIMEOUT_MS;
  }
}

function parseRow(row: Record<string, unknown>): LogSearchRow {
  const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
  const legacy = legacyFleetSource(row);
  return {
    time: text('_time'),
    serviceType: text('service_type'),
    serviceId: text('service_id'),
    source: text('source'),
    sourceType: legacy?.sourceType ?? text('source_type'),
    sourceName: legacy?.sourceName ?? text('source_name'),
    severity: text('severity'),
    host: text('host'),
    environment: text('environment'),
    eventId: text('event_id'),
    receivedAt: text('received_at'),
    message: text('_msg'),
  };
}

export async function searchLogs(params: LogSearchParams): Promise<LogSearchResult> {
  const startMs = params.start.getTime();
  const endMs = params.end.getTime();
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs >= endMs) {
    throw new LogsQueryError('start must be before end');
  }
  if (endMs - startMs > MAX_SEARCH_RANGE_MS) throw new LogsQueryError('Time range must be at most 31 days');
  if ((params.serviceIds?.length ?? 0) > MAX_SEARCH_SERVICES) throw new LogsQueryError(`Select at most ${MAX_SEARCH_SERVICES} services`);
  if ((params.sourceNames?.length ?? 0) > MAX_SEARCH_SERVICES) throw new LogsQueryError(`Select at most ${MAX_SEARCH_SERVICES} sources`);
  if ((params.sourceNames ?? []).some((source) => source.length > MAX_SOURCE_NAME_LENGTH)) {
    throw new LogsQueryError(`Source names must be at most ${MAX_SOURCE_NAME_LENGTH} characters`);
  }
  const limit = Math.max(1, Math.min(MAX_SEARCH_LIMIT, Math.trunc(params.limit ?? DEFAULT_SEARCH_LIMIT) || DEFAULT_SEARCH_LIMIT));
  const query = buildLogsQuery(params);

  const form = new URLSearchParams({
    query,
    limit: String(limit + 1),
    start: params.start.toISOString(),
    end: params.end.toISOString(),
  });
  let response: { status: number; body: string };
  try {
    response = await storeFetch('/select/logsql/query', await requestTimeoutMs(), {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (error) {
    logger.warn('Logs store search failed', { error: safeMessage(error) });
    throw new LogsStoreUnavailableError();
  }
  if (response.status === 400) {
    throw new LogsQueryError(response.body.trim().split('\n')[0].slice(0, 300) || 'Invalid query');
  }
  if (response.status !== 200) {
    logger.warn('Logs store search returned an error', { status: response.status });
    throw new LogsStoreUnavailableError();
  }
  try {
    const rows = parseJsonLines(response.body).map(parseRow);
    return { rows: rows.slice(0, limit), limit, truncated: rows.length > limit, query };
  } catch (error) {
    logger.warn('Logs store returned invalid search results', { error: safeMessage(error) });
    throw new LogsStoreUnavailableError();
  }
}

function parseStorageBytes(metrics: string): number | null {
  let total = 0;
  let found = false;
  for (const line of metrics.split('\n')) {
    const match = /^vl_data_size_bytes\{[^}]*\}\s+([0-9.eE+]+)/.exec(line);
    if (match) { total += Number(match[1]); found = true; }
  }
  return found ? total : null;
}

function parseMetricSum(metrics: string, metricName: string): number | null {
  let total = 0;
  let found = false;
  for (const line of metrics.split('\n')) {
    const match = new RegExp(`^${metricName}(?:\\{[^}]*\\})?\\s+([0-9.eE+]+)$`).exec(line);
    if (!match) continue;
    const value = Number(match[1]);
    if (Number.isFinite(value)) {
      total += value;
      found = true;
    }
  }
  return found ? total : null;
}

function parseStatsCount(body: string): number {
  const parsed = JSON.parse(body) as {
    status?: string;
    data?: { resultType?: string; result?: Array<{ value?: [number, string] }> };
  };
  if (parsed.status !== 'success' || parsed.data?.resultType !== 'vector' || !Array.isArray(parsed.data.result)) {
    throw new Error('Logs store returned an invalid stats response');
  }
  const value = parsed.data.result.reduce((sum, item) => {
    const raw = item.value?.[1];
    const parsedValue = typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) throw new Error('Logs store returned an invalid count');
    return sum + parsedValue;
  }, 0);
  if (!Number.isSafeInteger(value)) throw new Error('Logs store count exceeds the supported range');
  return value;
}

async function statsCount(query: string, start: Date, end: Date, timeoutMs?: number): Promise<number> {
  const form = new URLSearchParams({
    query: `${query} | stats count()`,
    time: end.toISOString(),
    start: start.toISOString(),
  });
  const response = await storeFetch('/select/logsql/stats_query', timeoutMs ?? await requestTimeoutMs(), {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  });
  if (response.status === 400) {
    throw new LogsQueryError(response.body.trim().slice(0, 300) || 'Invalid Logs alert query');
  }
  if (response.status !== 200) throw new LogsStoreUnavailableError();
  return parseStatsCount(response.body);
}

export async function countLogs(query: string, windowSeconds: number, now = new Date()): Promise<number> {
  if (!Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 86400) {
    throw new LogsQueryError('Alert window must be between 60 and 86400 seconds');
  }
  const filter = validateUserQuery(query);
  const start = new Date(now.getTime() - windowSeconds * 1000);
  try {
    return await statsCount(filter ? `(${filter})` : '*', start, now);
  } catch (error) {
    if (error instanceof LogsQueryError || error instanceof LogsStoreUnavailableError) throw error;
    logger.warn('Logs stats query failed', { error: safeMessage(error) });
    throw new LogsStoreUnavailableError();
  }
}

function parseJsonLines(body: string): Array<Record<string, unknown>> {
  return body.split('\n').filter((line) => line.trim()).map((line) => {
    const row: unknown = JSON.parse(line);
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Logs store returned an invalid row');
    return row as Record<string, unknown>;
  });
}

export async function logsWriteStatus(): Promise<LogsWriteStatus> {
  return { ...await getLogsSpoolStatus(), capacityBytes: appConfig.logs.spoolMaxBytes };
}

function rowTimeMs(row: LogsStoreRow): number | null {
  const value = row._time;
  if (/^\d+$/.test(value)) return Number(BigInt(value) / 1_000_000n);
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Sequence numbers of a tagged batch that the store already holds, used after
 * an uncertain write so only missing lines are sent again.
 */
export async function storedBatchSequences(batchId: string, rows: LogsStoreRow[]): Promise<Set<number>> {
  const times = rows.map(rowTimeMs).filter((ms): ms is number => ms !== null);
  const now = Date.now();
  const start = new Date((times.length ? Math.min(...times) : now) - 60_000);
  const end = new Date(Math.max(now, times.length ? Math.max(...times) : now) + 60_000);
  const params = new URLSearchParams({
    // Group before limiting so duplicate rows cannot hide other positions.
    query: `ingest_batch:${quoteLogsValue(batchId)} | stats by (ingest_seq) count() as entries`,
    start: start.toISOString(),
    end: end.toISOString(),
    limit: String(rows.length + 1),
  });
  const response = await storeFetch(`/select/logsql/query?${params}`, INGEST_TIMEOUT_MS);
  if (response.status !== 200) throw new LogsStoreWriteError(`Logs store verification returned HTTP ${response.status}`, true);
  const seen = new Set<number>();
  for (const row of parseJsonLines(response.body)) {
    const seq = Number(row.ingest_seq);
    if (Number.isInteger(seq)) seen.add(seq);
  }
  return seen;
}

async function oldestLogTimestamp(): Promise<string | null> {
  const end = new Date();
  const start = new Date(end.getTime() - (appConfig.logs.retentionDays + 1) * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    query: '* | sort by (_time) asc | fields _time',
    start: start.toISOString(),
    end: end.toISOString(),
    limit: '1',
  });
  const response = await storeFetch(`/select/logsql/query?${params}`, HEALTH_TIMEOUT_MS);
  if (response.status !== 200) return null;
  const row = parseJsonLines(response.body)[0];
  return typeof row?._time === 'string' ? row._time : null;
}

export async function getLogsSources(windowDays = 7): Promise<LogsSourcesResult> {
  const settings = await getConfig();
  const boundedDays = Math.max(1, Math.min(30, Math.trunc(windowDays) || 7));
  const boundedLimit = Math.max(10, Math.min(1000, Math.trunc(settings.logsSourceLimit) || 200));
  const quietAfterSeconds = Math.max(60, Math.trunc(settings.logsSourceQuietAfterSeconds) || 900);
  // agent_id lets legacy fleet rows (no source fields) be attributed to their service.
  const query = '* | stats by (source_name, source_type, service_type, service_id, agent_id) count() as log_count, max(_time) as last_seen | sort by (log_count desc)';
  const end = new Date();
  const start = new Date(end.getTime() - boundedDays * 24 * 60 * 60 * 1000);
  const params = new URLSearchParams({
    query,
    start: start.toISOString(),
    end: end.toISOString(),
    limit: String(boundedLimit * 2 + 1),
  });
  try {
    const response = await storeFetch(`/select/logsql/query?${params}`, await requestTimeoutMs());
    if (response.status === 400) {
      throw new LogsQueryError(response.body.trim().slice(0, 300) || 'Unable to summarize Logs sources');
    }
    if (response.status !== 200) throw new LogsStoreUnavailableError();
    const rows = parseJsonLines(response.body);
    const merged = new Map<string, LogsSource>();
    for (const row of rows) {
      const legacy = legacyFleetSource(row);
      const text = (key: string) => (typeof row[key] === 'string' ? (row[key] as string) : '');
      const source: LogsSource = {
        sourceName: legacy?.sourceName ?? (text('source_name') || 'Unknown source'),
        sourceType: legacy?.sourceType ?? text('source_type'),
        serviceType: text('service_type'),
        serviceId: text('service_id'),
        count: Math.max(0, Number(row.log_count) || 0),
        lastSeen: text('last_seen') || null,
      };
      const key = JSON.stringify([source.sourceType, source.sourceName, source.serviceType, source.serviceId]);
      const existing = merged.get(key);
      if (!existing) {
        merged.set(key, source);
        continue;
      }
      existing.count += source.count;
      if (source.lastSeen && (!existing.lastSeen || Date.parse(source.lastSeen) > Date.parse(existing.lastSeen))) {
        existing.lastSeen = source.lastSeen;
      }
    }
    const sources = [...merged.values()].sort((a, b) => b.count - a.count);
    return {
      windowDays: boundedDays,
      sources: sources.slice(0, boundedLimit),
      truncated: sources.length > boundedLimit || rows.length > boundedLimit * 2,
      limit: boundedLimit,
      quietAfterSeconds,
    };
  } catch (error) {
    if (error instanceof LogsQueryError || error instanceof LogsStoreUnavailableError) throw error;
    logger.warn('Logs source inventory query failed', { error: safeMessage(error) });
    throw new LogsStoreUnavailableError();
  }
}

async function storeFetchWithRetry(path: string): Promise<{ status: number; body: string }> {
  try {
    return await storeFetch(path, HEALTH_TIMEOUT_MS);
  } catch {
    // A single retry absorbs cold-start latency after the store restarts.
    return storeFetch(path, HEALTH_TIMEOUT_MS);
  }
}

function storeHealth(): Promise<{ status: number; body: string }> {
  return storeFetchWithRetry('/health');
}

export async function getLogsStoreStatus(): Promise<LogsStoreStatus> {
  const enabled = (await getConfig()).logsEnabled;
  const write = await logsWriteStatus();
  const base = {
    maxDiskBytes: appConfig.logs.maxDiskBytes,
    retentionDays: appConfig.logs.retentionDays,
    rowsIngested24h: null as number | null,
    oldestLogAt: null as string | null,
    metrics: {
      rowsIngestedTotal: null as number | null,
      bytesIngestedTotal: null as number | null,
      rowsDroppedTotal: null as number | null,
      streamsCreatedTotal: null as number | null,
    },
  };
  try {
    const health = await storeHealth();
    if (health.status !== 200) return { ...base, enabled, reachable: false, storageBytes: null, error: `Logs store health returned HTTP ${health.status}`, write };
    let storageBytes: number | null = null;
    let metricText = '';
    try {
      const metrics = await storeFetchWithRetry('/metrics');
      if (metrics.status === 200) {
        metricText = metrics.body;
        storageBytes = parseStorageBytes(metrics.body);
      }
    } catch { /* storage size is informational */ }
    const [rowsIngested24h, oldestLogAt] = await Promise.all([
      statsCount('*', new Date(Date.now() - 24 * 60 * 60 * 1000), new Date(), HEALTH_TIMEOUT_MS).catch(() => null),
      oldestLogTimestamp().catch(() => null),
    ]);
    return {
      ...base,
      enabled,
      reachable: true,
      storageBytes,
      rowsIngested24h,
      oldestLogAt,
      metrics: {
        rowsIngestedTotal: parseMetricSum(metricText, 'vl_rows_ingested_total'),
        bytesIngestedTotal: parseMetricSum(metricText, 'vl_bytes_ingested_total'),
        rowsDroppedTotal: parseMetricSum(metricText, 'vl_rows_dropped_total'),
        streamsCreatedTotal: parseMetricSum(metricText, 'vl_streams_created_total'),
      },
      write,
    };
  } catch (error) {
    return { ...base, enabled, reachable: false, storageBytes: null, error: safeMessage(error), write };
  }
}
