import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const telemetryConfig = vi.hoisted(() => ({ storeUrl: '', ingestBodyLimitBytes: 64, requestTimeoutMs: 1000 }));
vi.mock('../../db/queries/config.js', () => ({ getConfig: vi.fn(async () => ({ telemetryRequestTimeoutMs: 1000, telemetrySilentAfterSeconds: 900, telemetrySourceLabel: 'instance', telemetryGroupLabel: 'job', telemetrySourceSelector: 'up' })) }));
vi.mock('./connection.js', () => ({ getStoreConnection: vi.fn(async () => ({ mode: 'external', url: telemetryConfig.storeUrl, auth: 'none', allowPrivate: false })), connectionUrl: (value: { url: string }) => value.url, connectionHeaders: () => ({}) }));
vi.mock('./transport.js', async importOriginal => {
  const original = await importOriginal<typeof import('./transport.js')>();
  return { ...original, storeRequest: original.createStoreTransport({ addressAllowed: () => true }) };
});

const { labelValues, MAX_POINTS, MAX_SERIES, queryInstant, queryRange, resolveStep } = await import('./query.js');
const { TelemetryQueryError, TelemetryStoreUnavailableError } = await import('./store-client.js');

let reply: { status: number; body: unknown } = { status: 200, body: {} };
const requests: URL[] = [];
let store: Server;

beforeAll(async () => {
  store = createServer((req, res) => {
    requests.push(new URL(req.url ?? '/', 'http://store'));
    res.writeHead(reply.status, { 'content-type': 'application/json' }).end(JSON.stringify(reply.body));
  });
  store.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => store.once('listening', resolve));
  telemetryConfig.storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => store.close(() => resolve()));
});

beforeEach(() => {
  requests.length = 0;
});

function matrix(result: Array<{ metric: Record<string, string>; values: Array<[number, string]> }>) {
  return { status: 200, body: { status: 'success', data: { resultType: 'matrix', result } } };
}

describe('resolveStep', () => {
  it('picks a readable step for about 600 points', () => {
    expect(resolveStep(3600)).toBe(15);
    expect(resolveStep(6 * 3600)).toBe(60);
    expect(resolveStep(7 * 86400)).toBe(1800);
  });

  it('never returns more than MAX_POINTS points', () => {
    expect(resolveStep(86400, 1)).toBe(Math.ceil(86400 / MAX_POINTS));
    expect(resolveStep(3600, 30)).toBe(30);
  });
});

describe('queryRange', () => {
  it('aligns series onto shared timestamps and maps NaN to null', async () => {
    reply = matrix([
      { metric: { host: 'a' }, values: [[100, '1'], [160, '2']] },
      { metric: { host: 'b' }, values: [[160, 'NaN'], [220, '3']] },
    ]);
    const result = await queryRange({ query: 'up', start: 100, end: 220, step: 60 });
    expect(result.timestamps).toEqual([100, 160, 220]);
    expect(result.series).toEqual([
      { labels: { host: 'a' }, values: [1, 2, null] },
      { labels: { host: 'b' }, values: [null, null, 3] },
    ]);
    expect(result.step).toBe(60);
    expect(requests[0].pathname).toBe('/api/v1/query_range');
    expect(requests[0].searchParams.get('step')).toBe('60');
  });

  it('caps the number of series and reports truncation', async () => {
    reply = matrix(Array.from({ length: MAX_SERIES + 5 }, (_, i) => ({ metric: { i: String(i) }, values: [[100, '1']] })));
    const result = await queryRange({ query: 'up', start: 100, end: 200 });
    expect(result.series).toHaveLength(MAX_SERIES);
    expect(result.truncated).toBe(true);
  });

  it('validates input before contacting the store', async () => {
    await expect(queryRange({ query: '', start: 1, end: 2 })).rejects.toBeInstanceOf(TelemetryQueryError);
    await expect(queryRange({ query: 'up', start: 200, end: 100 })).rejects.toThrow('end must be after start');
    await expect(queryRange({ query: 'up', start: 1, end: 1 + 401 * 86400 })).rejects.toThrow('400 days');
    await expect(queryRange({ query: 'x'.repeat(4001), start: 1, end: 2 })).rejects.toThrow('at most');
    expect(requests).toHaveLength(0);
  });

  it('reports store query errors as query errors', async () => {
    reply = { status: 422, body: { status: 'error', errorType: 'bad_data', error: 'unknown function "nope"' } };
    await expect(queryRange({ query: 'nope(up)', start: 1, end: 100 })).rejects.toThrow('Telemetry query rejected (HTTP 422): unknown function "nope"');
  });

  it('bounds and removes control characters from store query errors', async () => {
    reply = { status: 400, body: { status: 'error', error: 'bad\nquery\t' + 'x'.repeat(500) } };
    await expect(queryRange({ query: 'up', start: 1, end: 100 }))
      .rejects.toThrow('Telemetry query rejected (HTTP 400): bad query ' + 'x'.repeat(390));
  });

  it('reports a failing store as unavailable', async () => {
    reply = { status: 500, body: {} };
    await expect(queryRange({ query: 'up', start: 1, end: 100 })).rejects.toThrow('Telemetry store returned HTTP 500');
    await expect(queryRange({ query: 'up', start: 1, end: 100 })).rejects.toBeInstanceOf(TelemetryStoreUnavailableError);
  });
});

describe('queryInstant', () => {
  it('returns vector and scalar results', async () => {
    reply = { status: 200, body: { status: 'success', data: { resultType: 'vector', result: [{ metric: { host: 'a' }, value: [1, '4'] }] } } };
    await expect(queryInstant({ query: 'up' })).resolves.toEqual({ series: [{ labels: { host: 'a' }, value: 4 }], truncated: false });

    reply = { status: 200, body: { status: 'success', data: { resultType: 'scalar', result: [1, '2'] } } };
    await expect(queryInstant({ query: '1+1' })).resolves.toEqual({ series: [{ labels: {}, value: 2 }], truncated: false });
  });
});

describe('labelValues', () => {
  it('rejects invalid label names', async () => {
    await expect(labelValues({ name: '../admin' })).rejects.toBeInstanceOf(TelemetryQueryError);
    expect(requests).toHaveLength(0);
  });

  it('passes the selector and a default one-hour window', async () => {
    reply = { status: 200, body: { status: 'success', data: ['worker-a', 'worker-b'] } };
    await expect(labelValues({ name: 'host', match: '{role="worker"}' })).resolves.toEqual(['worker-a', 'worker-b']);
    const params = requests[0].searchParams;
    expect(requests[0].pathname).toBe('/api/v1/label/host/values');
    expect(params.get('match[]')).toBe('{role="worker"}');
    expect(Number(params.get('end')) - Number(params.get('start'))).toBeGreaterThanOrEqual(3600);
  });
});
