import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ApiKeyRecord } from '../db/queries/security.js';

const telemetryConfig = vi.hoisted(() => ({ storeUrl: '', ingestBodyLimitBytes: 64, requestTimeoutMs: 1000 }));
vi.mock('../services/telemetry/connection.js', () => ({ getStoreConnection: vi.fn(async () => ({ mode: telemetryConfig.storeUrl ? 'external' : 'disabled', url: telemetryConfig.storeUrl, auth: 'none', allowPrivate: false })), connectionUrl: (value: { url: string }) => value.url, connectionHeaders: () => ({}) }));
vi.mock('../services/telemetry/transport.js', async importOriginal => {
  const original = await importOriginal<typeof import('../services/telemetry/transport.js')>();
  return { ...original, storeRequest: original.createStoreTransport({ addressAllowed: () => true }) };
});

vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../middleware/audit.js', () => ({ AuditActions: new Proxy({}, { get: (_target, key) => String(key) }), logAudit: vi.fn() }));
vi.mock('../db/queries/telemetry-dashboards.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../db/queries/telemetry-dashboards.js')>();
  return {
    TelemetryConflictError: original.TelemetryConflictError,
    listTelemetryDashboards: vi.fn(),
    getTelemetryDashboard: vi.fn(),
    createTelemetryDashboard: vi.fn(),
    updateTelemetryDashboard: vi.fn(),
    deleteTelemetryDashboard: vi.fn(),
    reorderTelemetryDashboards: vi.fn(),
    listTelemetryDashboardVersions: vi.fn(),
    getTelemetryDashboardVersion: vi.fn(),
    keepTelemetryDashboardContent: vi.fn(),
  };
});

vi.mock('../services/telemetry/sources.js', () => ({ listTelemetrySources: vi.fn(), telemetryStoreHealth: vi.fn() }));
vi.mock('../db/queries/monitoring.js', () => ({ listMonitoringIssueSpans: vi.fn() }));

const { default: router } = await import('./telemetry.js');
const sources = await import('../services/telemetry/sources.js');
const monitoring = await import('../db/queries/monitoring.js');
const { getConfig } = await import('../db/queries/config.js');
const dashboards = await import('../db/queries/telemetry-dashboards.js');
const { getTemplate, templateContent } = await import('../services/telemetry/dashboards/index.js');
const mockGetConfig = vi.mocked(getConfig);
const HOST = {
  ...templateContent(getTemplate('host')!),
  uid: 'host',
  templateKey: 'host',
  version: 1,
  updatedAt: new Date(0).toISOString(),
  updatedBy: null,
};

interface StoredRequest {
  url: string;
  headers: IncomingMessage['headers'];
  body: string;
}

let storeStatus = 204;
// JSON answer for store read endpoints (/api/v1/query_range and similar).
let storeJson: unknown | ((url: string) => unknown) = { status: 'success', data: { resultType: 'matrix', result: [] } };
const storeRequests: StoredRequest[] = [];
let store: Server;
let storeUrl: string;
let app: Server;
let baseUrl: string;
let requestApiKey: Partial<ApiKeyRecord> | null = null;

function apiKey(scopes: string[]): Partial<ApiKeyRecord> {
  return { id: 1, name: 'vector', role: 'viewer', scopes, expiresAt: null, revokedAt: null };
}

beforeAll(async () => {
  store = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      storeRequests.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString() });
      if (req.method === 'GET' && req.url?.startsWith('/api/v1/')) {
        const payload = typeof storeJson === 'function' ? storeJson(req.url) : storeJson;
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(payload));
        return;
      }
      res.writeHead(storeStatus).end(storeStatus >= 400 ? 'cannot parse sample' : undefined);
    });
  });
  store.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => store.once('listening', resolve));
  storeUrl = `http://127.0.0.1:${(store.address() as AddressInfo).port}`;

  const server = express();
  server.use(express.json());
  server.use((req, _res, next) => {
    if (requestApiKey) req.apiKey = requestApiKey as ApiKeyRecord;
    next();
  });
  server.use('/api/telemetry', router);
  app = server.listen(0);
  await new Promise<void>((resolve) => app.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(app.address() as AddressInfo).port}/api/telemetry`;
});

afterAll(async () => {
  await new Promise<void>((resolve) => app.close(() => resolve()));
  await new Promise<void>((resolve) => store.close(() => resolve()));
});

beforeEach(() => {
  telemetryConfig.storeUrl = storeUrl;
  storeStatus = 204;
  storeRequests.length = 0;
  requestApiKey = apiKey(['telemetry:write']);
  mockGetConfig.mockResolvedValue({ telemetryEnabled: true, telemetryIngestBodyLimitBytes: 64, telemetryRequestTimeoutMs: 1000, telemetrySilentAfterSeconds: 900, telemetrySourceLabel: 'instance', telemetryGroupLabel: 'job', telemetrySourceSelector: 'up' } as never);
  vi.mocked(dashboards.listTelemetryDashboards).mockResolvedValue([
    { uid: 'host', title: HOST.title, description: HOST.description, templateKey: 'host', version: 1, updatedAt: HOST.updatedAt },
  ]);
  vi.mocked(dashboards.getTelemetryDashboard).mockImplementation(async (uid) => (uid === 'host' ? HOST : null));
  vi.mocked(dashboards.createTelemetryDashboard).mockImplementation(async (content) => ({ ...HOST, ...content, uid: 'new' }));
  vi.mocked(dashboards.updateTelemetryDashboard).mockImplementation(async (uid, content) => (uid === 'host' ? { ...HOST, ...content, version: 2 } : null));
  vi.mocked(dashboards.deleteTelemetryDashboard).mockResolvedValue(true);
  vi.mocked(dashboards.reorderTelemetryDashboards).mockResolvedValue();
});

function post(path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-protobuf', ...headers },
    body,
  });
}

describe('telemetry ingest', () => {
  it('forwards remote write bodies and decoding headers to the store', async () => {
    const response = await post('/write', 'snappy-frame', {
      'content-encoding': 'snappy',
      'x-prometheus-remote-write-version': '0.1.0',
      cookie: 'robin.admin.sid=secret',
    });
    expect(response.status).toBe(204);
    expect(storeRequests).toHaveLength(1);
    expect(storeRequests[0].url).toBe('/api/v1/write');
    expect(storeRequests[0].body).toBe('snappy-frame');
    expect(storeRequests[0].headers['content-encoding']).toBe('snappy');
    expect(storeRequests[0].headers['x-prometheus-remote-write-version']).toBe('0.1.0');
    expect(storeRequests[0].headers.cookie).toBeUndefined();
  });

  it('forwards Prometheus text imports to the import endpoint', async () => {
    const response = await post('/import', 'host_load1{host="a"} 0.5 1790000000000\n', { 'content-type': 'text/plain' });
    expect(response.status).toBe(204);
    expect(storeRequests[0].url).toBe('/api/v1/import/prometheus');
  });

  it('rejects requests without an API key, including admin sessions', async () => {
    requestApiKey = null;
    expect((await post('/write', 'frame')).status).toBe(401);
    expect(storeRequests).toHaveLength(0);
  });

  it('rejects API keys without telemetry:write', async () => {
    requestApiKey = apiKey(['telemetry:read', 'metrics:read']);
    expect((await post('/write', 'frame')).status).toBe(403);
    expect(storeRequests).toHaveLength(0);
  });

  it('rejects payloads over the size limit before contacting the store', async () => {
    expect((await post('/write', 'x'.repeat(65))).status).toBe(413);
    expect(storeRequests).toHaveLength(0);
  });

  it('rejects empty and already-parsed bodies', async () => {
    expect((await post('/write', '')).status).toBe(400);
    expect((await post('/write', '{"a":1}', { 'content-type': 'application/json' })).status).toBe(415);
    expect(storeRequests).toHaveLength(0);
  });

  it('relays store rejections of malformed data', async () => {
    storeStatus = 400;
    const response = await post('/write', 'frame');
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Telemetry store returned HTTP 400');
  });

  it('returns a retryable 503 when the store fails or is unreachable', async () => {
    storeStatus = 500;
    let response = await post('/write', 'frame');
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('5');

    telemetryConfig.storeUrl = 'http://127.0.0.1:1';
    response = await post('/write', 'frame');
    expect(response.status).toBe(503);
  });

  it('answers sender health checks from the store health endpoint', async () => {
    let response = await fetch(`${baseUrl}/write`);
    expect(response.status).toBe(200);
    expect(storeRequests.at(-1)?.url).toBe('/health');

    storeStatus = 500;
    response = await fetch(`${baseUrl}/import`);
    expect(response.status).toBe(503);

    requestApiKey = null;
    expect((await fetch(`${baseUrl}/write`)).status).toBe(401);
  });

  it('returns 503 when no store is configured', async () => {
    telemetryConfig.storeUrl = '';
    expect((await post('/write', 'frame')).status).toBe(503);
  });
});

describe('telemetry reads', () => {
  it('resolves a source using configured labels without assuming a dashboard', async () => {
    requestApiKey = apiKey(['telemetry:read']);
    const response = await fetch(`${baseUrl}/source-query?name=${encodeURIComponent('node"a')}`);
    expect(response.status).toBe(200);
    expect((await response.json()).data.query).toBe('{__name__="up",instance!="",instance="node\\"a"}');
    expect((await fetch(`${baseUrl}/source-query?name=`)).status).toBe(400);
  });
  beforeEach(() => {
    requestApiKey = apiKey(['telemetry:read']);
  });

  it('requires authentication and the telemetry:read scope', async () => {
    requestApiKey = null;
    expect((await fetch(`${baseUrl}/dashboards`)).status).toBe(401);
    requestApiKey = apiKey(['telemetry:write']);
    expect((await fetch(`${baseUrl}/dashboards`)).status).toBe(403);
  });

  it('lists stored dashboards and loads one', async () => {
    const list = await (await fetch(`${baseUrl}/dashboards`)).json();
    expect(list.data).toEqual([expect.objectContaining({ uid: 'host', title: 'Linux host' })]);
    const one = await (await fetch(`${baseUrl}/dashboards/host`)).json();
    expect(one.data.rows.length).toBeGreaterThan(0);
    expect((await fetch(`${baseUrl}/dashboards/nope`)).status).toBe(404);
  });

  it('lists the templates that can be added', async () => {
    const templates = await (await fetch(`${baseUrl}/templates`)).json();
    expect(templates.data.map((template: { key: string }) => template.key)).toContain('docker');
  });

  it('refuses reads while Telemetry is disabled but still reports status', async () => {
    mockGetConfig.mockResolvedValue({ telemetryEnabled: false, telemetryRequestTimeoutMs: 1000, telemetrySilentAfterSeconds: 900, telemetrySourceLabel: 'instance', telemetryGroupLabel: 'job', telemetrySourceSelector: 'up' } as never);
    expect((await fetch(`${baseUrl}/dashboards`)).status).toBe(403);
    storeJson = (url: string) => (url.includes('/status/tsdb')
      ? { status: 'success', data: { totalSeries: 7 } }
      : { status: 'success', data: ['worker-a'] });
    const status = await (await fetch(`${baseUrl}/status`)).json();
    expect(status.data).toEqual({ enabled: false, configured: true, reachable: true, totalSeries: 7, sources: ['worker-a'], silentAfterSeconds: 900 });
  });

  it('serves dashboards without a store but needs one for data', async () => {
    telemetryConfig.storeUrl = '';
    expect((await fetch(`${baseUrl}/dashboards`)).status).toBe(200);
    expect((await fetch(`${baseUrl}/dashboards/host/panels/cpu-modes?start=1&end=2`)).status).toBe(503);
    const status = await (await fetch(`${baseUrl}/status`)).json();
    expect(status.data).toMatchObject({ configured: false, reachable: false });
  });

  it('runs a saved panel with substituted variables', async () => {
    storeJson = { status: 'success', data: { resultType: 'matrix', result: [{ metric: { mode: 'user' }, values: [[1000, '12.5']] }] } };
    const response = await fetch(`${baseUrl}/dashboards/host/panels/cpu-modes?start=1000&end=4600&var-host=worker-a`);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data.series).toEqual([{ name: 'user', query: 0, labels: { mode: 'user' }, values: [12.5] }]);
    const sent = new URL(storeRequests.at(-1)!.url, 'http://store');
    expect(sent.searchParams.get('query')).toContain('host=~"worker-a"');
  });

  it('maps query errors to 400 and unknown panels to 404', async () => {
    storeJson = { status: 'error', errorType: 'bad_data', error: 'parse error' };
    const bad = await fetch(`${baseUrl}/query_range?query=${encodeURIComponent('rate(')}&start=1000&end=2000`);
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('Telemetry query rejected (HTTP 200)');
    expect((await fetch(`${baseUrl}/dashboards/host/panels/nope?start=1&end=2`)).status).toBe(404);
  });

  it('returns variable options and label values', async () => {
    storeJson = { status: 'success', data: ['worker-b', 'worker-a'] };
    const options = await (await fetch(`${baseUrl}/dashboards/host/variables/host`)).json();
    expect(options.data).toEqual(['worker-a', 'worker-b']);
    const values = await (await fetch(`${baseUrl}/labels/role/values?match=host_uptime`)).json();
    expect(values.data).toEqual(['worker-b', 'worker-a']);
  });
});

describe('dashboard changes', () => {
  const json = (method: string, body?: unknown) => ({
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  beforeEach(() => {
    requestApiKey = { ...apiKey(['telemetry:manage', 'telemetry:read']), role: 'editor' };
  });

  it('needs the editor role and the telemetry:manage scope', async () => {
    requestApiKey = { ...apiKey(['telemetry:manage']), role: 'viewer' };
    expect((await fetch(`${baseUrl}/dashboards`, json('POST', { title: 'New' }))).status).toBe(403);
    // An ingest key can never change dashboards.
    requestApiKey = { ...apiKey(['telemetry:write']), role: 'editor' };
    expect((await fetch(`${baseUrl}/dashboards`, json('POST', { title: 'New' }))).status).toBe(403);
    expect(dashboards.createTelemetryDashboard).not.toHaveBeenCalled();
  });

  it('creates a blank dashboard, from a template, or as a copy', async () => {
    const blank = await fetch(`${baseUrl}/dashboards`, json('POST', { title: 'Mail', rows: [] }));
    expect(blank.status).toBe(201);
    expect(dashboards.createTelemetryDashboard).toHaveBeenLastCalledWith(
      { title: 'Mail', description: '', variables: [], rows: [] },
      expect.objectContaining({ templateKey: null }),
    );

    await fetch(`${baseUrl}/dashboards`, json('POST', { templateKey: 'docker' }));
    expect(dashboards.createTelemetryDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Docker containers' }),
      expect.objectContaining({ templateKey: 'docker', preferredUid: 'docker' }),
    );

    await fetch(`${baseUrl}/dashboards`, json('POST', { duplicateOf: 'host' }));
    expect(dashboards.createTelemetryDashboard).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: 'Linux host (copy)' }),
      expect.objectContaining({ templateKey: null }),
    );
    expect((await fetch(`${baseUrl}/dashboards`, json('POST', { templateKey: 'nope' }))).status).toBe(404);
  });

  it('rejects invalid content with every problem listed', async () => {
    const response = await fetch(`${baseUrl}/dashboards`, json('POST', { title: '', rows: 'x' }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.problems).toEqual(expect.arrayContaining(['title: is required', 'rows: must be a list']));
  });

  it('saves with the edited version and reports conflicts', async () => {
    const content = { ...HOST, title: 'Hosts' };
    expect((await fetch(`${baseUrl}/dashboards/host`, json('PUT', { ...content, version: undefined }))).status).toBe(400);

    const saved = await fetch(`${baseUrl}/dashboards/host`, json('PUT', { ...content, version: 1 }));
    expect(saved.status).toBe(200);
    expect(dashboards.updateTelemetryDashboard).toHaveBeenLastCalledWith('host', expect.objectContaining({ title: 'Hosts' }), 1, 'vector');

    vi.mocked(dashboards.updateTelemetryDashboard).mockRejectedValueOnce(new dashboards.TelemetryConflictError(4));
    const conflict = await fetch(`${baseUrl}/dashboards/host`, json('PUT', { ...content, version: 1 }));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).currentVersion).toBe(4);
  });

  it('restores the default layout or an earlier version', async () => {
    const restored = await fetch(`${baseUrl}/dashboards/host/restore-default`, json('POST'));
    expect(restored.status).toBe(200);
    // Restoring the default also records the template it came from.
    expect(dashboards.updateTelemetryDashboard).toHaveBeenLastCalledWith('host', expect.objectContaining({ title: 'Linux host' }), 1, 'vector', 'host');

    vi.mocked(dashboards.getTelemetryDashboardVersion).mockResolvedValueOnce({ title: 'Old', description: '', variables: [], rows: [] });
    await fetch(`${baseUrl}/dashboards/host/versions/1/restore`, json('POST'));
    expect(dashboards.updateTelemetryDashboard).toHaveBeenLastCalledWith('host', expect.objectContaining({ title: 'Old' }), 1, 'vector', undefined);
  });

  it('keeps a dashboard as it is instead of a newer default', async () => {
    vi.mocked(dashboards.keepTelemetryDashboardContent).mockResolvedValueOnce({ uid: 'host', templateUpdated: false } as never);
    const kept = await fetch(`${baseUrl}/dashboards/host/keep`, json('POST'));
    expect(kept.status).toBe(200);
    expect(dashboards.keepTelemetryDashboardContent).toHaveBeenCalledWith('host');
    vi.mocked(dashboards.keepTelemetryDashboardContent).mockResolvedValueOnce(null);
    expect((await fetch(`${baseUrl}/dashboards/custom/keep`, json('POST'))).status).toBe(404);
  });

  it('deletes and reorders dashboards', async () => {
    expect((await fetch(`${baseUrl}/dashboards/host`, json('DELETE'))).status).toBe(200);
    expect(dashboards.deleteTelemetryDashboard).toHaveBeenCalledWith('host');
    expect((await fetch(`${baseUrl}/dashboard-order`, json('PUT', { uids: ['b', 'a'] }))).status).toBe(200);
    expect(dashboards.reorderTelemetryDashboards).toHaveBeenCalledWith(['b', 'a']);
    expect((await fetch(`${baseUrl}/dashboard-order`, json('PUT', { uids: 'a' }))).status).toBe(400);
  });

  it('previews an unsaved panel against the store', async () => {
    storeJson = { status: 'success', data: { resultType: 'matrix', result: [{ metric: {}, values: [[1000, '3']] }] } };
    const response = await fetch(`${baseUrl}/preview/panel`, json('POST', {
      panel: { id: 'p', title: 'Up', type: 'stat', unit: 'count', queries: [{ expr: 'count(up{host=~"$host"})' }], layout: { x: 0, y: 0, w: 3, h: 4 } },
      variables: [{ name: 'host', label: 'Host', source: 'host' }],
      values: { host: ['a'] },
      start: 1000,
      end: 2000,
    }));
    expect(response.status).toBe(200);
    expect(new URL(storeRequests.at(-1)!.url, 'http://store').searchParams.get('query')).toBe('count(up{host=~"a"})');
  });
});

describe('sources, store health, annotations and rendered queries', () => {
  beforeEach(() => {
    requestApiKey = apiKey(['telemetry:read']);
  });

  it('lists sources to any reader', async () => {
    const data = { sources: [{ host: 'worker-a', roles: ['worker'], series: 40, lastSeen: 1000, silent: false }], sourceWindowDays: 7, silentAfterSeconds: 900, refreshSeconds: 60, limit: 2000, truncated: false };
    vi.mocked(sources.listTelemetrySources).mockResolvedValue(data);
    const body = await (await fetch(`${baseUrl}/sources`)).json();
    expect(body.data).toEqual(data);
  });

  it('shows store health to editors only', async () => {
    vi.mocked(sources.telemetryStoreHealth).mockResolvedValue({ address: 'store:8428', totalSeries: 3 } as never);
    expect((await fetch(`${baseUrl}/store`)).status).toBe(403);
    requestApiKey = { ...apiKey(['telemetry:read']), role: 'editor' };
    const body = await (await fetch(`${baseUrl}/store`)).json();
    expect(body.data).toMatchObject({ address: 'store:8428', totalSeries: 3 });
  });

  it('returns monitoring issues as annotations to admins only while Monitoring is on', async () => {
    vi.mocked(monitoring.listMonitoringIssueSpans).mockResolvedValue([{ id: 1, checkName: 'SMTP', severity: 'critical', summary: 'down', openedAt: '2026-10-01T00:00:00.000Z', closedAt: null }]);
    requestApiKey = { ...apiKey(['telemetry:read']), role: 'editor' };
    expect((await fetch(`${baseUrl}/annotations?start=1000&end=2000`)).status).toBe(403);
    requestApiKey = { ...apiKey(['telemetry:read']), role: 'admin' };
    let body = await (await fetch(`${baseUrl}/annotations?start=1000&end=2000`)).json();
    expect(body.data).toEqual([]);
    mockGetConfig.mockResolvedValue({ telemetryEnabled: true, monitoringEnabled: true } as never);
    body = await (await fetch(`${baseUrl}/annotations?start=1000&end=2000`)).json();
    expect(body.data).toHaveLength(1);
    expect(monitoring.listMonitoringIssueSpans).toHaveBeenCalledWith(new Date(1_000_000), new Date(2_000_000));
    expect((await fetch(`${baseUrl}/annotations?start=2000&end=1000`)).status).toBe(400);
  });

  it('renders a saved panel\'s queries with variables and the rate window', async () => {
    const body = await (await fetch(`${baseUrl}/dashboards/host/panels/cpu-busy/queries?start=1000&end=4600&var-host=worker-a`)).json();
    expect(body.data.unit).toBe('percent');
    expect(body.data.queries[0].expr).toContain('host=~"worker-a"');
    expect(body.data.queries[0].expr).toContain('[240s]');
  });

  it('lists label names for a metric without the metric name label', async () => {
    storeJson = { status: 'success', data: ['__name__', 'host', 'role'] };
    const body = await (await fetch(`${baseUrl}/labels?match=host_load1`)).json();
    expect(body.data).toEqual(['host', 'role']);
    const sent = new URL(storeRequests.at(-1)!.url, 'http://store');
    expect(sent.pathname).toBe('/api/v1/labels');
    expect(sent.searchParams.get('match[]')).toBe('host_load1');
  });
});
