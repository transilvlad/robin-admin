import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHmac } from 'node:crypto';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './logs.js';
import * as serviceLogs from '../services/service-logs.js';
import * as configQueries from '../db/queries/config.js';
import * as logsStore from '../services/logs-store.js';
import { logAudit, AuditActions } from '../middleware/audit.js';

// service-types.js is NOT mocked — the real parseServiceType drives validation.
vi.mock('../services/service-logs.js', () => ({
  getServiceLogs: vi.fn(),
}));

vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../middleware/audit.js', () => ({
  AuditActions: {
    LOGS_SAVED_SEARCH_CREATE: 'logs_saved_search.create',
    LOGS_SAVED_SEARCH_UPDATE: 'logs_saved_search.update',
    LOGS_SAVED_SEARCH_DELETE: 'logs_saved_search.delete',
    LOGS_ALERT_RULE_CREATE: 'logs_alert_rule.create',
    LOGS_ALERT_RULE_UPDATE: 'logs_alert_rule.update',
    LOGS_ALERT_RULE_DELETE: 'logs_alert_rule.delete',
    LOGS_QUARANTINE_RETRY: 'logs_quarantine.retry',
    LOGS_QUARANTINE_DISCARD: 'logs_quarantine.discard',
  },
  logAudit: vi.fn(),
}));
vi.mock('../db/queries/logs.js', () => ({
  LogsCapacityError: class LogsCapacityError extends Error {},
  createLogsAlertRule: vi.fn(),
  createLogsSavedSearch: vi.fn(),
  deleteLogsAlertRule: vi.fn(),
  deleteLogsSavedSearch: vi.fn(),
  getLogsAlertRuleById: vi.fn(),
  listAllLogsAlertRules: vi.fn(),
  listLogsAlertRules: vi.fn(),
  listLogsSavedSearches: vi.fn(),
  recordLogsAlertEvaluation: vi.fn(),
  updateLogsAlertRule: vi.fn(),
  updateLogsSavedSearch: vi.fn(),
}));
vi.mock('../db/queries/logs-spool.js', () => ({
  discardRejectedLogsBatch: vi.fn(),
  getRejectedLogsBatch: vi.fn(),
  listRejectedLogsBatches: vi.fn(),
  retryRejectedLogsBatch: vi.fn(),
}));
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>();
  return { ...actual, config: { ...actual.config, logs: { ...actual.config.logs, sentryClientSecret: 'test-secret' } } };
});

vi.mock('../services/logs-store.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/logs-store.js')>();
  return { ...actual, searchLogs: vi.fn(), getLogsStoreStatus: vi.fn(), getLogsSources: vi.fn(), ingestExternalLogs: vi.fn() };
});

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockGetServiceLogs = vi.mocked(serviceLogs.getServiceLogs);
const mockGetConfig = vi.mocked(configQueries.getConfig);
const mockSearchLogs = vi.mocked(logsStore.searchLogs);
const mockStatus = vi.mocked(logsStore.getLogsStoreStatus);
const mockIngestExternalLogs = vi.mocked(logsStore.ingestExternalLogs);
const mockGetLogsSources = vi.mocked(logsStore.getLogsSources);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'] ?? 'admin';
    if (role !== 'anonymous') {
      Object.assign(req, { session: { admin: { id: 7, uid: 'test-admin', role, name: 'Admin', email: 'admin@example.test' } } });
    }
    if ((req.path === '/logs/ingest' && req.headers['x-test-auth'] !== 'none') || req.headers['x-test-auth'] === 'logs-key') {
      Object.assign(req, { apiKey: { id: 7, name: 'collector-prod', role: 'viewer', scopes: ['logs:write'] } });
    }
    next();
  });
  app.use((req, res, next) => {
    if (req.path === '/logs/ingest' || req.path === '/logs/sentry') return next();
    return express.json()(req, res, next);
  });
  app.use('/logs', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/logs`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('logs route', () => {
  it('GET / returns the logs payload for a co-located service', async () => {
    const payload = {
      available: true,
      source: 'journalctl -u postfix',
      lines: ['2026-01-01 postfix/smtpd: connect'],
    };
    mockGetServiceLogs.mockResolvedValue(payload as never);

    const res = await fetch(`${baseUrl}/?serviceType=postfix&serviceId=s1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: payload });
    expect(mockGetServiceLogs).toHaveBeenCalledWith('postfix', 's1', expect.any(Number));
  });

  it('GET / returns 400 when serviceId is missing', async () => {
    const res = await fetch(`${baseUrl}/?serviceType=postfix`);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/serviceId/);
    expect(mockGetServiceLogs).not.toHaveBeenCalled();
  });

  it('GET / returns 400 for an invalid serviceType', async () => {
    const res = await fetch(`${baseUrl}/?serviceType=bogus&serviceId=s1`);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/serviceType/);
    expect(mockGetServiceLogs).not.toHaveBeenCalled();
  });
});

describe('logs search route', () => {
  it.each(['/search', '/status', '/configuration', '/sources', '/saved-searches', '/alerts', '/quarantine'])('protects administrator endpoint %s', async (path) => {
    expect((await fetch(`${baseUrl}${path}`, { headers: { 'x-test-role': 'anonymous' } })).status).toBe(401);
    expect((await fetch(`${baseUrl}${path}`, { headers: { 'x-test-role': 'viewer' } })).status).toBe(403);
    expect((await fetch(`${baseUrl}${path}`, { headers: { 'x-test-auth': 'logs-key' } })).status).toBe(403);
  });

  it('refuses search while Logs is disabled', async () => {
    mockGetConfig.mockResolvedValue({ logsEnabled: false } as never);
    const res = await fetch(`${baseUrl}/search?q=error`);
    expect(res.status).toBe(403);
    expect(mockSearchLogs).not.toHaveBeenCalled();
  });

  describe('Logs child-page routes', () => {
    beforeEach(() => {
      mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
    });

    it('audits saved-search creation without recording query text', async () => {
      const queries = await import('../db/queries/logs.js');
      vi.mocked(queries.createLogsSavedSearch).mockResolvedValue({
        id: 8,
        name: 'Authentication failures',
        description: null,
        filters: { query: 'secret-user@example.test', serviceId: '', sourceName: '', rangePreset: '1h' },
        createdBy: 'Admin',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      const response = await fetch(`${baseUrl}/saved-searches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Authentication failures',
          filters: { query: 'secret-user@example.test', serviceId: '', sourceName: '', rangePreset: '1h' },
        }),
      });

      expect(response.status).toBe(201);
      expect(logAudit).toHaveBeenCalledWith(expect.anything(), AuditActions.LOGS_SAVED_SEARCH_CREATE, {
        entityType: 'logs_saved_search',
        entityId: '8',
        newValues: { name: 'Authentication failures', rangePreset: '1h' },
      });
      expect(vi.mocked(logAudit).mock.calls[0][2].newValues).not.toHaveProperty('query');
    });

    it('lists team saved searches', async () => {
      const saved = [{ id: 1, name: 'Auth failures' }];
      const queries = await import('../db/queries/logs.js');
      vi.mocked(queries.listLogsSavedSearches).mockResolvedValue(saved as never);

      const res = await fetch(`${baseUrl}/saved-searches`);
      expect(res.status).toBe(200);
      expect((await res.json()).data).toEqual(saved);
    });

    it('lists bounded source inventory', async () => {
      mockGetLogsSources.mockResolvedValue({ windowDays: 30, sources: [], truncated: false, limit: 200, quietAfterSeconds: 900 });

      const res = await fetch(`${baseUrl}/sources?windowDays=30`);
      expect(res.status).toBe(200);
      expect(mockGetLogsSources).toHaveBeenCalledWith(30);
    });

    it('rejects malformed saved-search and alert input instead of broadening the filter', async () => {
      const queries = await import('../db/queries/logs.js');
      const savedSearch = await fetch(`${baseUrl}/saved-searches`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bad filter', filters: { query: 42, rangePreset: '1h' } }),
      });
      expect(savedSearch.status).toBe(400);
      expect((await savedSearch.json()).error).toMatch(/filters\.query must be a string/);
      expect(queries.createLogsSavedSearch).not.toHaveBeenCalled();

      const alert = await fetch(`${baseUrl}/alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'Bad alert', query: 42, windowSeconds: 300, comparator: '>=', threshold: 1, forSeconds: 300 }),
      });
      expect(alert.status).toBe(400);
      expect((await alert.json()).error).toMatch(/query must be a string/);
      expect(queries.createLogsAlertRule).not.toHaveBeenCalled();
    });

    describe('quarantine routes', () => {
      it('lists rejected batches and returns their retained entries', async () => {
        const spool = await import('../db/queries/logs-spool.js');
        vi.mocked(spool.listRejectedLogsBatches).mockResolvedValue([{
          id: '18', origin: 'http', lineCount: 1, bytes: 42, error: 'invalid row', createdAt: '2026-11-03T10:00:00.000Z',
        }]);
        vi.mocked(spool.getRejectedLogsBatch).mockResolvedValue([{ _msg: 'retained' }] as never);

        expect(await (await fetch(`${baseUrl}/quarantine`)).json()).toMatchObject({
          data: [{ id: '18', lineCount: 1, error: 'invalid row' }],
        });
        expect(await (await fetch(`${baseUrl}/quarantine/18`)).json()).toMatchObject({ data: [{ _msg: 'retained' }] });
        expect(spool.getRejectedLogsBatch).toHaveBeenCalledWith('18');
      });

      it('validates ids and audits retry and discard actions', async () => {
        const spool = await import('../db/queries/logs-spool.js');
        vi.mocked(spool.retryRejectedLogsBatch).mockResolvedValue(true);
        vi.mocked(spool.discardRejectedLogsBatch).mockResolvedValue(true);

        expect((await fetch(`${baseUrl}/quarantine/0/retry`, { method: 'POST' })).status).toBe(400);
        expect((await fetch(`${baseUrl}/quarantine/18/retry`, { method: 'POST' })).status).toBe(200);
        expect((await fetch(`${baseUrl}/quarantine/18`, { method: 'DELETE' })).status).toBe(200);
        expect(logAudit).toHaveBeenCalledWith(expect.anything(), AuditActions.LOGS_QUARANTINE_RETRY, {
          entityType: 'logs_ingest_batch', entityId: '18',
        });
        expect(logAudit).toHaveBeenCalledWith(expect.anything(), AuditActions.LOGS_QUARANTINE_DISCARD, {
          entityType: 'logs_ingest_batch', entityId: '18',
        });
      });
    });
  });

  describe('external Logs ingest routes', () => {
    beforeEach(() => {
      mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
      mockIngestExternalLogs.mockResolvedValue();
    });

    it('accepts generic JSON with a logs:write key', async () => {
      const res = await fetch(`${baseUrl}/ingest`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'worker failed', severity: 'error' }),
      });

      expect(res.status).toBe(204);
      expect(mockIngestExternalLogs).toHaveBeenCalledWith([
        expect.objectContaining({ message: 'worker failed', sourceType: 'http', sourceName: 'collector-prod' }),
      ], { origin: 'http', idempotencyKey: null });
    });

    it('scopes an Idempotency-Key to the API key and validates it', async () => {
      const send = (key: string) => fetch(`${baseUrl}/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain', 'Idempotency-Key': key }, body: 'once',
      });
      expect((await send('batch-42')).status).toBe(204);
      expect(mockIngestExternalLogs).toHaveBeenCalledWith(expect.any(Array), { origin: 'http', idempotencyKey: '7:batch-42' });
      expect((await send('x'.repeat(129))).status).toBe(400);
      expect(mockIngestExternalLogs).toHaveBeenCalledTimes(1);
    });

    it('does not accept an administrator session instead of an ingest key', async () => {
      const res = await fetch(`${baseUrl}/ingest`, {
        method: 'POST', headers: { 'x-test-auth': 'none', 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'not authorized' }),
      });
      expect(res.status).toBe(401);
      expect(mockIngestExternalLogs).not.toHaveBeenCalled();
    });

    it('accepts a configured body limit larger than the default', async () => {
      mockGetConfig.mockResolvedValue({ logsEnabled: true, logsIngestBodyLimitBytes: 16 * 1024 * 1024 } as never);
      const res = await fetch(`${baseUrl}/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: 'x'.repeat(9 * 1024 * 1024) }),
      });
      expect(res.status).toBe(204);
    });

    it('returns retry guidance rather than success when storage is unavailable', async () => {
      mockIngestExternalLogs.mockRejectedValueOnce(new logsStore.LogsStoreUnavailableError());
      const res = await fetch(`${baseUrl}/ingest`, {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: 'retry me',
      });
      expect(res.status).toBe(503);
      expect(res.headers.get('retry-after')).toBe('5');
    });

    it('verifies Sentry webhook signatures before ingesting', async () => {
      const payload = JSON.stringify({ action: 'triggered', data: { event: { message: 'Sentry alert', issue_id: 'issue-1' } } });
      const signature = createHmac('sha256', 'test-secret').update(payload).digest('hex');
      const res = await fetch(`${baseUrl}/sentry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sentry-Hook-Signature': signature,
          'Sentry-Hook-Resource': 'event_alert',
          'Request-ID': 'request-1',
        },
        body: payload,
      });

      expect(res.status).toBe(204);
      expect(mockIngestExternalLogs).toHaveBeenCalledWith([
        expect.objectContaining({ message: 'Sentry alert', sourceType: 'sentry', eventId: 'request-1' }),
      ], { origin: 'sentry', idempotencyKey: 'request-1' });
    });

    it('rejects invalid Sentry signatures', async () => {
      const res = await fetch(`${baseUrl}/sentry`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Sentry-Hook-Resource': 'event_alert', 'Sentry-Hook-Signature': 'bad' },
        body: JSON.stringify({ data: {} }),
      });
      expect(res.status).toBe(401);
      expect(mockIngestExternalLogs).not.toHaveBeenCalled();
    });
  });

  it('passes scoped filters and the time range to the store', async () => {
    mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
    mockSearchLogs.mockResolvedValue({ rows: [], limit: 50, truncated: false, query: '*' });
    const res = await fetch(`${baseUrl}/search?start=2026-11-03T10:00:00Z&end=2026-11-03T11:00:00Z&serviceId=a,b&serviceType=postfix&sourceName=collector-a&q=error&limit=50`);
    expect(res.status).toBe(200);
    expect(mockSearchLogs).toHaveBeenCalledWith({
      start: new Date('2026-11-03T10:00:00Z'),
      end: new Date('2026-11-03T11:00:00Z'),
      serviceIds: ['a', 'b'],
      serviceTypes: ['postfix'],
      sourceNames: ['collector-a'],
      query: 'error',
      limit: 50,
    });
  });

  it('combines legacy filters with repeated exact names containing commas', async () => {
    mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
    mockSearchLogs.mockResolvedValue({ rows: [], limit: 50, truncated: false, query: '*' });
    const params = new URLSearchParams({
      limit: '50', serviceId: 'legacy-a,legacy-b', sourceName: 'previous-a,previous-b',
    });
    params.append('serviceIds', 'checkout, europe');
    params.append('serviceIds', 'worker');
    params.append('sourceNames', 'collector, production');
    params.append('sourceNames', 'other');

    const res = await fetch(`${baseUrl}/search?${params}`);
    expect(res.status).toBe(200);
    expect(mockSearchLogs).toHaveBeenCalledWith(expect.objectContaining({
      serviceIds: ['legacy-a', 'legacy-b', 'checkout, europe', 'worker'],
      sourceNames: ['previous-a', 'previous-b', 'collector, production', 'other'],
    }));
  });

  it('rejects an unknown service type', async () => {
    mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
    const res = await fetch(`${baseUrl}/search?serviceType=bogus`);
    expect(res.status).toBe(400);
    expect(mockSearchLogs).not.toHaveBeenCalled();
  });

  it('maps query and store errors to 400 and 503', async () => {
    mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
    mockSearchLogs.mockRejectedValueOnce(new logsStore.LogsQueryError('Pipes (|) are not supported'));
    expect((await fetch(`${baseUrl}/search?q=a`)).status).toBe(400);
    mockSearchLogs.mockRejectedValueOnce(new logsStore.LogsStoreUnavailableError());
    const res = await fetch(`${baseUrl}/search?q=a`);
    expect(res.status).toBe(503);
    expect((await res.json()).error).toBe('Logs store is unavailable');
  });

  it('returns store status', async () => {
    const status = { enabled: true, reachable: false, storageBytes: null, error: 'Logs store is unreachable', write: { queued: 0, queuedBytes: 0, sent: 0, dropped: 0, failedBatches: 0, lastSuccessAt: null, lastErrorAt: null, lastError: null } };
    mockStatus.mockResolvedValue(status);
    const res = await fetch(`${baseUrl}/status`);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(status);
  });

  it('returns deployment configuration without exposing the Sentry secret', async () => {
    mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
    const res = await fetch(`${baseUrl}/configuration`);
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain('test-secret');
    expect(JSON.parse(text).data).toMatchObject({
      enabled: true,
      sentryWebhookConfigured: true,
      endpoints: { ingest: '/api/logs/ingest', sentry: '/api/logs/sentry' },
    });
  });

  it('enforces the configured ingest body limit', async () => {
    mockGetConfig.mockResolvedValue({ logsEnabled: true, logsIngestBodyLimitBytes: 65536 } as never);
    const res = await fetch(`${baseUrl}/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'x'.repeat(70_000) }),
    });
    expect(res.status).toBe(413);
    expect(mockIngestExternalLogs).not.toHaveBeenCalled();
  });

  it.each(['1suffix', '1.5', '0', '-1'])('rejects malformed saved-search ids: %s', async (id) => {
    mockGetConfig.mockResolvedValue({ logsEnabled: true } as never);
    expect((await fetch(`${baseUrl}/saved-searches/${id}`, { method: 'DELETE' })).status).toBe(400);
  });
});
