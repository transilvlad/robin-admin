import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildLogsQuery,
  countLogs,
  fleetLogRows,
  getLogsSources,
  getLogsStoreStatus,
  ingestExternalLogs,
  LogsBatchTooLargeError,
  LogsQueryError,
  LogsStoreUnavailableError,
  LogsStoreWriteError,
  MAX_LINE_BYTES,
  rfc3339ToNanos,
  searchLogs,
  setLogsStoreFetchForTests,
  storedBatchSequences,
  writeStoreRows,
} from './logs-store.js';
import { getConfig } from '../db/queries/config.js';
import { enqueueLogsBatch, getLogsSpoolStatus } from '../db/queries/logs-spool.js';

vi.mock('../config.js', () => ({ config: { logs: { storeUrl: 'http://logs-backend:9428', maxDiskBytes: 10_000, retentionDays: 14, spoolMaxBytes: 1_000_000 } } }));
vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../db/queries/logs-spool.js', () => ({ enqueueLogsBatch: vi.fn(), getLogsSpoolStatus: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const mockGetConfig = vi.mocked(getConfig);
const mockEnqueue = vi.mocked(enqueueLogsBatch);
const mockSpoolStatus = vi.mocked(getLogsSpoolStatus);
const fetchMock = vi.fn();
const meta = { serviceType: 'dovecot', serviceId: 'dovecot-1', source: 'file', agentId: 'agent-1' };

function respond(status: number, body = '') {
  return new Response(body, { status });
}

function refused(): Error {
  return new TypeError('fetch failed', { cause: Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }) });
}

beforeEach(() => {
  fetchMock.mockReset();
  mockEnqueue.mockReset();
  setLogsStoreFetchForTests(fetchMock as unknown as typeof fetch);
  mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
  mockSpoolStatus.mockResolvedValue({
    queuedLines: 3, queuedBytes: 300, oldestQueuedAt: null, retryingBatches: 0, uncertainBatches: 0, uncertainDeliveries24h: 0, droppedLines24h: 0,
    rejectedLines24h: 0, discardedLines24h: 0, lastDeliveredAt: null, lastErrorAt: null, lastError: null,
  });
});

afterEach(() => {
  setLogsStoreFetchForTests(null);
});

describe('buildLogsQuery', () => {
  it('scopes by quoted service filters and sorts newest first', () => {
    expect(buildLogsQuery({ serviceIds: ['a"b', 'c'], serviceTypes: ['postfix'], query: 'error OR warn' }))
      .toBe('service_id:in("a\\"b","c") service_type:in("postfix") (error OR warn) | sort by (_time desc)');
  });

  it('matches everything when no filters are given', () => {
    expect(buildLogsQuery({})).toBe('* | sort by (_time desc)');
  });

  it('scopes by an exact source name', () => {
    expect(buildLogsQuery({ sourceNames: ['Sentry / production'] }))
      .toBe('(source_name:in("Sentry / production") or (source_name:"" agent_id:* service_id:in("Sentry / production"))) | sort by (_time desc)');
  });

  it('rejects pipes outside quotes but allows them inside', () => {
    expect(() => buildLogsQuery({ query: 'error | delete' })).toThrow(LogsQueryError);
    expect(() => buildLogsQuery({ query: 'x) | stats count()' })).toThrow(/Pipes/);
    expect(buildLogsQuery({ query: '"a | b"' })).toContain('("a | b")');
    expect(buildLogsQuery({ query: '"a \\" | b"' })).toContain('("a \\" | b")');
  });

  it('rejects unterminated quotes, multi-line and oversized queries', () => {
    expect(() => buildLogsQuery({ query: '"open' })).toThrow(/unterminated/);
    expect(() => buildLogsQuery({ query: 'a\nb' })).toThrow(/single line/);
    expect(() => buildLogsQuery({ query: 'x'.repeat(1001) })).toThrow(/at most/);
  });
});

describe('fleetLogRows', () => {
  const now = Date.parse('2026-11-03T12:00:00Z');

  it('keeps plausible agent times independently and falls back to arrival', () => {
    const rows = fleetLogRows(meta, ['first', '', 'second', 'third', 'fourth'], [
      '2026-11-03T11:59:00.000000123Z',
      undefined,
      '2026-11-03T11:58:00Z',
      'not a time',
      '2025-01-01T00:00:00Z',
    ], now);

    expect(rows.map((row) => row._msg)).toEqual(['first', 'second', 'third', 'fourth']);
    expect(rows[0]).toMatchObject({
      _time: '1793707140000000123', received_at: '2026-11-03T12:00:00.000Z', service_type: 'dovecot', service_id: 'dovecot-1',
      source: 'file', source_type: 'fleet', source_name: 'dovecot-1', agent_id: 'agent-1',
    });
    expect(rows[1]._time).toBe(String(BigInt(Date.parse('2026-11-03T11:58:00Z')) * 1_000_000n));
    expect(rows[2]._time).toBe(String(BigInt(now) * 1_000_000n));
    expect(rows[3]._time).toBe(String(BigInt(now) * 1_000_000n));
  });

  it('does not replace a historical timestamp after an untimestamped line', () => {
    const rows = fleetLogRows(meta, ['continuation', 'historical entry'], ['', '2026-11-03T11:30:00Z'], now);
    expect(rows[0]._time).toBe(String(BigInt(now) * 1_000_000n));
    expect(rows[1]._time).toBe(String(BigInt(Date.parse('2026-11-03T11:30:00Z')) * 1_000_000n));
  });

  it('rejects times in the future beyond the allowed skew', () => {
    const [row] = fleetLogRows(meta, ['late'], ['2026-11-03T13:00:00Z'], now);
    expect(row._time).toBe(String(BigInt(now) * 1_000_000n));
  });

  it('truncates oversized lines', () => {
    const [row] = fleetLogRows(meta, ['x'.repeat(MAX_LINE_BYTES + 10)], [], now);
    expect(Buffer.byteLength(row._msg, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
  });

  it('preserves a complete replacement character at the truncation boundary', () => {
    const [row] = fleetLogRows(meta, [`${'x'.repeat(MAX_LINE_BYTES - 6)}\uFFFDmore`], [], now);
    expect(row._msg.endsWith('\uFFFD…')).toBe(true);
    expect(Buffer.byteLength(row._msg, 'utf8')).toBe(MAX_LINE_BYTES);
  });

  it('normalizes characters PostgreSQL cannot store in messages and metadata', () => {
    const [row] = fleetLogRows(
      { ...meta, source: 'file\u0000\uD800', agentId: 'agent\uDC00' },
      ['before\u0000\uD800-middle-\uDC00 \uD83D\uDE00'],
      [],
      now,
    );
    expect(row).toMatchObject({
      _msg: 'before\uFFFD\uFFFD-middle-\uFFFD \uD83D\uDE00',
      source: 'file\uFFFD\uFFFD',
      agent_id: 'agent\uFFFD',
    });
  });

  it('keeps a maximum-size normalized Fleet row within the minimum spool capacity', () => {
    const [row] = fleetLogRows(
      { serviceType: 'postgres', serviceId: 's'.repeat(64), source: '\u0001'.repeat(120), agentId: 'a'.repeat(64) },
      ['\u0000'.repeat(MAX_LINE_BYTES)],
      [],
      now,
    );
    expect(row._msg.includes('\u0000')).toBe(false);
    expect(Buffer.byteLength(row._msg, 'utf8')).toBeLessThanOrEqual(MAX_LINE_BYTES);
    expect(Buffer.byteLength(JSON.stringify([row]), 'utf8')).toBeLessThanOrEqual(64 * 1024);
  });

  it('parses RFC 3339 times to nanoseconds', () => {
    expect(rfc3339ToNanos('1970-01-01T00:00:01.5+00:00')).toBe(1_500_000_000n);
    expect(rfc3339ToNanos('1970-01-01 00:00:01Z')).toBeNull();
  });
});

describe('writeStoreRows', () => {
  it('writes NDJSON with stream fields', async () => {
    fetchMock.mockResolvedValue(respond(200));
    await writeStoreRows([{ _time: '1', _msg: 'a', service_id: 's' }, { _time: '2', _msg: 'b', service_id: 's' }]);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('http://logs-backend:9428/insert/jsonline?');
    expect(url).toContain('_stream_fields=service_type%2Cservice_id%2Csource_type');
    expect((init.body as string).trim().split('\n').map((line) => JSON.parse(line)._msg)).toEqual(['a', 'b']);
  });

  it('classifies failures by whether the store may hold the lines', async () => {
    fetchMock.mockRejectedValueOnce(refused());
    await expect(writeStoreRows([{ _time: '1', _msg: 'a' }])).rejects.toMatchObject({ uncertain: false, rejected: false });
    fetchMock.mockRejectedValueOnce(new Error('The operation was aborted due to timeout'));
    await expect(writeStoreRows([{ _time: '1', _msg: 'a' }])).rejects.toMatchObject({ uncertain: true, rejected: false });
    fetchMock.mockResolvedValueOnce(respond(503));
    await expect(writeStoreRows([{ _time: '1', _msg: 'a' }])).rejects.toMatchObject({ uncertain: true, rejected: false });
    fetchMock.mockResolvedValueOnce(respond(400, 'bad'));
    await expect(writeStoreRows([{ _time: '1', _msg: 'a' }])).rejects.toMatchObject({ uncertain: false, rejected: true });
    await expect(writeStoreRows([])).resolves.toBeUndefined();
  });
});

describe('storedBatchSequences', () => {
  it('lists distinct stored positions of a batch around its line times', async () => {
    fetchMock.mockResolvedValue(respond(200, '{"ingest_seq":"0"}\n{"ingest_seq":"2"}\n'));
    const rows = [{ _time: '1793707140000000000', _msg: 'a' }, { _time: '2026-11-03T11:59:30Z', _msg: 'b' }, { _time: '1793707140000000002', _msg: 'c' }];
    await expect(storedBatchSequences('6c1f5c3e-batch', rows)).resolves.toEqual(new Set([0, 2]));
    const url = new URL(fetchMock.mock.calls[0][0] as string);
    expect(url.pathname).toBe('/select/logsql/query');
    expect(url.searchParams.get('query')).toBe('ingest_batch:"6c1f5c3e-batch" | stats by (ingest_seq) count() as entries');
    expect(url.searchParams.get('start')).toBe('2026-11-03T11:58:00.000Z');
    expect(url.searchParams.get('limit')).toBe('4');
  });

  it('treats a failed check as uncertain', async () => {
    fetchMock.mockResolvedValue(respond(500));
    await expect(storedBatchSequences('b', [{ _time: '1', _msg: 'a' }])).rejects.toBeInstanceOf(LogsStoreWriteError);
  });
});

describe('ingestExternalLogs', () => {
  const entry = { time: '2026-11-03T11:00:00Z', message: 'hello', source: 'http', sourceType: 'http', sourceName: 'collector' };

  it('queues store rows with the idempotency key', async () => {
    mockEnqueue.mockResolvedValue('queued');
    await ingestExternalLogs([entry], { origin: 'http', idempotencyKey: '7:abc' });
    expect(mockEnqueue).toHaveBeenCalledWith({
      origin: 'http',
      idempotencyKey: '7:abc',
      rows: [{ _time: '2026-11-03T11:00:00Z', _msg: 'hello', source: 'http', source_type: 'http', source_name: 'collector' }],
      maxBytes: 1_000_000,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a repeated batch without queueing it again', async () => {
    mockEnqueue.mockResolvedValue('duplicate');
    await expect(ingestExternalLogs([entry], { origin: 'sentry', idempotencyKey: 'r1' })).resolves.toBeUndefined();
  });

  it('reports a full or unavailable queue', async () => {
    mockEnqueue.mockResolvedValueOnce('full');
    await expect(ingestExternalLogs([entry], { origin: 'http' })).rejects.toThrow('Logs ingestion queue is full');
    mockEnqueue.mockRejectedValueOnce(new Error('connection terminated'));
    await expect(ingestExternalLogs([entry], { origin: 'http' })).rejects.toBeInstanceOf(LogsStoreUnavailableError);
  });

  it('reports a batch larger than the queue capacity as a permanent 413 condition', async () => {
    mockEnqueue.mockResolvedValue('too_large');
    await expect(ingestExternalLogs([entry], { origin: 'http' })).rejects.toBeInstanceOf(LogsBatchTooLargeError);
  });

  it('bounds the batch size before queueing', async () => {
    await expect(ingestExternalLogs(Array.from({ length: 1_001 }, () => entry), { origin: 'http' })).rejects.toBeInstanceOf(LogsQueryError);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });
});

describe('searchLogs', () => {
  const start = new Date('2026-11-03T10:00:00Z');
  const end = new Date('2026-11-03T11:00:00Z');

  it('requests limit+1 rows and reports truncation', async () => {
    const row = (msg: string) => JSON.stringify({ _time: '2026-11-03T10:30:00Z', _msg: msg, service_type: 'robin', service_id: 'r1', source: 'file' });
    fetchMock.mockResolvedValue(respond(200, `${row('a')}\n${row('b')}\n${row('c')}\n`));
    const result = await searchLogs({ start, end, limit: 2, serviceIds: ['r1'], sourceNames: ['collector'] });

    const body = new URLSearchParams(fetchMock.mock.calls[0][1].body as string);
    expect(body.get('limit')).toBe('3');
    expect(body.get('start')).toBe(start.toISOString());
    expect(body.get('query')).toBe('service_id:in("r1") (source_name:in("collector") or (source_name:"" agent_id:* service_id:in("collector"))) | sort by (_time desc)');
    expect(result.rows.map((r) => r.message)).toEqual(['a', 'b']);
    expect(result.rows[0]).toEqual({
      time: '2026-11-03T10:30:00Z', serviceType: 'robin', serviceId: 'r1', source: 'file', sourceType: '', sourceName: '',
      severity: '', host: '', environment: '', eventId: '', receivedAt: '', message: 'a',
    });
    expect(result.truncated).toBe(true);
  });

  it('validates the time range', async () => {
    await expect(searchLogs({ start: end, end: start })).rejects.toThrow(LogsQueryError);
    await expect(searchLogs({ start: new Date('2026-01-01'), end })).rejects.toThrow(/31 days/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('limits the number of exact service and source filters', async () => {
    const filters = Array.from({ length: 51 }, (_, index) => `name, ${index}`);
    await expect(searchLogs({ start, end, serviceIds: filters })).rejects.toThrow('Select at most 50 services');
    await expect(searchLogs({ start, end, sourceNames: filters })).rejects.toThrow('Select at most 50 sources');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('surfaces store parse errors as query errors and outages as unavailable', async () => {
    fetchMock.mockResolvedValueOnce(respond(400, 'cannot parse `query` arg [foo:(]: unexpected end'));
    await expect(searchLogs({ start, end, query: 'foo:(' })).rejects.toThrow(/cannot parse/);
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(searchLogs({ start, end })).rejects.toBeInstanceOf(LogsStoreUnavailableError);
    fetchMock.mockResolvedValueOnce(respond(500, 'internal detail'));
    await expect(searchLogs({ start, end })).rejects.toBeInstanceOf(LogsStoreUnavailableError);
  });
});

describe('log stats and sources', () => {
  it('counts exact matches for a bounded alert window', async () => {
    fetchMock.mockResolvedValue(respond(200, JSON.stringify({
      status: 'success',
      data: { resultType: 'vector', result: [{ metric: { __name__: 'count(*)' }, value: [1, '12'] }] },
    })));
    await expect(countLogs('error', 300, new Date('2026-11-03T11:00:00Z'))).resolves.toBe(12);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toContain('/select/logsql/stats_query');
    const form = new URLSearchParams(init.body as string);
    expect(form.get('query')).toBe('(error) | stats count()');
    expect(form.get('start')).toBe('2026-11-03T10:55:00.000Z');
    expect(form.get('time')).toBe('2026-11-03T11:00:00.000Z');
    expect(form.has('end')).toBe(false);
  });

  it('rejects alert query pipes and invalid windows before contacting the store', async () => {
    await expect(countLogs('error | stats count(*)', 300)).rejects.toThrow(LogsQueryError);
    await expect(countLogs('error', 20)).rejects.toThrow(/between 60 and 86400/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['NaN', '-1', '', 'Infinity', '1.5'])('rejects invalid counts instead of treating %s as zero', async (value) => {
    fetchMock.mockResolvedValue(respond(200, JSON.stringify({
      status: 'success', data: { resultType: 'vector', result: [{ value: [1, value] }] },
    })));
    await expect(countLogs('error', 300)).rejects.toBeInstanceOf(LogsStoreUnavailableError);
  });

  it('bounds streamed responses even without a content-length header', async () => {
    fetchMock.mockResolvedValue(respond(200, 'x'.repeat(16 * 1024 * 1024 + 1)));
    await expect(countLogs('error', 300)).rejects.toBeInstanceOf(LogsStoreUnavailableError);
  });

  it('returns bounded source counts and last-seen timestamps', async () => {
    mockGetConfig.mockResolvedValue({ logsEnabled: true, logsSourceLimit: 10, logsSourceQuietAfterSeconds: 600, logsRequestTimeoutMs: 15000 } as never);
    fetchMock.mockResolvedValue(respond(200, [
      ...Array.from({ length: 11 }, (_, index) => JSON.stringify({ source_name: `collector-${index}`, source_type: 'http', service_type: 'robin', service_id: 'r1', log_count: 20 - index, last_seen: '2026-11-03T10:59:00Z' })),
      '',
    ].join('\n')));
    const result = await getLogsSources(7);
    expect(result.sources).toHaveLength(10);
    expect(result.sources[0]).toEqual({ sourceName: 'collector-0', sourceType: 'http', serviceType: 'robin', serviceId: 'r1', count: 20, lastSeen: '2026-11-03T10:59:00Z' });
    expect(result).toMatchObject({ windowDays: 7, truncated: true, limit: 10, quietAfterSeconds: 600 });
    const requestUrl = new URL(fetchMock.mock.calls[0][0] as string);
    expect(requestUrl.searchParams.get('limit')).toBe('21');
    expect(requestUrl.searchParams.get('start')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(requestUrl.searchParams.get('end')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(requestUrl.searchParams.get('query')).toContain('agent_id');
    expect(requestUrl.searchParams.get('query')).toContain('sort by (log_count desc)');
  });

  it('attributes legacy fleet rows to their service and merges them with new rows', async () => {
    fetchMock.mockResolvedValue(respond(200, [
      JSON.stringify({ source_type: 'fleet', source_name: 'suite-cyrus', service_type: 'cyrus', service_id: 'suite-cyrus', agent_id: 'a1', log_count: 2, last_seen: '2026-11-04T09:00:00Z' }),
      JSON.stringify({ service_type: 'cyrus', service_id: 'suite-cyrus', agent_id: 'a1', log_count: 70, last_seen: '2026-11-04T08:00:00Z' }),
      JSON.stringify({ service_type: '', service_id: '', log_count: 1, last_seen: '2026-11-04T07:00:00Z' }),
    ].join('\n')));
    const result = await getLogsSources(7);
    expect(result.sources).toEqual([
      { sourceName: 'suite-cyrus', sourceType: 'fleet', serviceType: 'cyrus', serviceId: 'suite-cyrus', count: 72, lastSeen: '2026-11-04T09:00:00Z' },
      { sourceName: 'Unknown source', sourceType: '', serviceType: '', serviceId: '', count: 1, lastSeen: '2026-11-04T07:00:00Z' },
    ]);
    expect(result).toMatchObject({ limit: 200, quietAfterSeconds: 900, truncated: false });
  });
});

describe('getLogsStoreStatus', () => {
  it('retries a cold health check once before reporting the store unreachable', async () => {
    fetchMock.mockResolvedValue(respond(503));
    fetchMock.mockRejectedValueOnce(new Error('timed out')).mockResolvedValueOnce(respond(200, 'OK'));
    const status = await getLogsStoreStatus();
    expect(status.reachable).toBe(true);
    expect(fetchMock.mock.calls[0][0]).toContain('/health');
    expect(fetchMock.mock.calls[1][0]).toContain('/health');
  });
  it('reports reachability and storage size', async () => {
    fetchMock
      .mockResolvedValueOnce(respond(200, 'OK'))
      .mockResolvedValueOnce(respond(200, [
        'vl_data_size_bytes{type="indexdb"} 100',
        'vl_data_size_bytes{type="storage"} 50',
        'vl_rows_ingested_total{type="jsonline"} 40',
        'vl_bytes_ingested_total{type="jsonline"} 4000',
        'vl_rows_dropped_total{reason="old"} 2',
        'vl_streams_created_total 6',
      ].join('\n')))
      .mockResolvedValueOnce(respond(200, JSON.stringify({
        status: 'success',
        data: { resultType: 'vector', result: [{ metric: { __name__: 'count(*)' }, value: [1, '25'] }] },
      })))
      .mockResolvedValueOnce(respond(200, '{"_time":"2026-10-25T00:00:00Z"}\n'));
    await expect(getLogsStoreStatus()).resolves.toMatchObject({
      enabled: true,
      reachable: true,
      storageBytes: 150,
      maxDiskBytes: 10_000,
      retentionDays: 14,
      rowsIngested24h: 25,
      oldestLogAt: '2026-10-25T00:00:00Z',
      metrics: { rowsIngestedTotal: 40, bytesIngestedTotal: 4000, rowsDroppedTotal: 2, streamsCreatedTotal: 6 },
    });
    const oldestRequest = new URL(fetchMock.mock.calls[3][0] as string);
    expect(oldestRequest.searchParams.get('query')).toBe('* | sort by (_time) asc | fields _time');
    expect(oldestRequest.searchParams.get('start')).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(oldestRequest.searchParams.get('end')).toMatch(/^\d{4}-\d\d-\d\dT/);
  });

  it('reports an unreachable store without throwing', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    await expect(getLogsStoreStatus()).resolves.toMatchObject({ reachable: false, error: 'Logs store is unreachable' });
  });
});
