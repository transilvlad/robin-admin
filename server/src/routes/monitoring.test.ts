import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './monitoring.js';
import * as monitoringQueries from '../db/queries/monitoring.js';
import * as monitoringScheduler from '../services/monitoring/scheduler.js';
import * as configTransfer from '../services/monitoring/config-transfer.js';
import * as heartbeat from '../services/monitoring/heartbeat.js';
import * as monitoringProbes from '../db/queries/monitoring-probes.js';
import { getConfig } from '../db/queries/config.js';
import { logAudit } from '../middleware/audit.js';
import { parseMonitoringOptions } from '../services/monitoring/options.js';
vi.mock('../middleware/audit.js', () => ({ logAudit: vi.fn() }));

const authState = vi.hoisted(() => ({
  authenticated: true,
  admin: true,
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    if (!authState.authenticated) {
      res.status(401).json({ success: false, error: 'Authentication required' });
      return;
    }
    next();
  },
}));

vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, res: { status: (code: number) => { json: (body: unknown) => void } }, next: () => void) => {
    if (!authState.admin) {
      res.status(403).json({ success: false, error: 'Admin privileges required' });
      return;
    }
    next();
  },
}));

vi.mock('../db/queries/monitoring.js', () => ({
  createMonitoringCheck: vi.fn(),
  createMonitoringTarget: vi.fn(),
  closeStaleMonitoringIssue: vi.fn(),
  deleteClosedMonitoringIssue: vi.fn(),
  deleteMonitoringCheck: vi.fn(),
  deleteMonitoringTarget: vi.fn(),
  getMonitoringCheck: vi.fn(),
  getMonitoringCheckHistory: vi.fn(),
  getMonitoringCheckLocationHistory: vi.fn(),
  getMonitoringCheckObservations: vi.fn(),
  requestMonitoringEvaluation: vi.fn(),
  getMonitoringSummary: vi.fn(),
  pauseMonitoringCheck: vi.fn(),
  resumeMonitoringCheck: vi.fn(),
  updateMonitoringCheck: vi.fn(),
  updateMonitoringTarget: vi.fn(),
}));

vi.mock('../db/queries/monitoring-probes.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../db/queries/monitoring-probes.js')>()),
  grantMonitoringProbeLocation: vi.fn(),
  listMonitoringProbeLocations: vi.fn(),
  updateMonitoringProbeLocation: vi.fn(),
}));

vi.mock('../services/monitoring/scheduler.js', () => ({
  runMonitoringCheckNow: vi.fn(),
}));
vi.mock('../services/monitoring/config-transfer.js', () => ({
  exportMonitoringConfiguration: vi.fn(),
  importMonitoringConfiguration: vi.fn(),
}));
vi.mock('../services/monitoring/heartbeat.js', () => ({
  deleteHeartbeatTarget: vi.fn(),
  getHeartbeatHealth: vi.fn(),
  listHeartbeatTargets: vi.fn(),
  saveHeartbeatTarget: vi.fn(),
  sendHeartbeatTest: vi.fn(),
}));

vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn(), debug: vi.fn() },
}));

let server: Server;
let baseUrl: string;
const mockGetConfig = vi.mocked(getConfig);

const summary = {
  targets: [],
  checks: [],
  openIssues: [],
  recentIssues: [],
  recentObservations: [],
  weeklyIssueCounts: [],
};

const targetInput = {
  name: 'Local Docker suite',
  targetType: 'host',
  environment: 'local',
};

const checkInput = {
  targetId: 1,
  name: 'Service health',
  checkType: 'http',
  endpoint: 'https://robin-admin-caddy:3443/',
  intervalSeconds: 60,
  timeoutSeconds: 5,
  confirmationSeconds: 0,
  recoverySeconds: 0,
  certExpiryDays: 14,
  certificateErrorMode: 'down',
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/monitoring', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

describe('monitoring check configuration', () => {
  it('persists typed options and never includes credential values in the audit', async () => {
    vi.mocked(monitoringQueries.createMonitoringCheck).mockResolvedValueOnce({ id: 1, name: 'Service health', secretHeaderNames: ['authorization'] } as never);
    const response = await fetch(`${baseUrl}/monitoring/checks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...checkInput, secretHeaders: { Authorization: 'Bearer test-secret' }, options: { http: { assertions: [{ kind: 'json', pointer: '/ready', operator: 'equals', value: true }] } } }) });
    expect(response.status).toBe(201);
    expect(monitoringQueries.createMonitoringCheck).toHaveBeenCalledWith(expect.objectContaining({ checkType: 'http', secretHeaders: { authorization: 'Bearer test-secret' }, allowPrivate: false }));
    expect(JSON.stringify(vi.mocked(logAudit).mock.calls.map(call => call.slice(1)))).not.toContain('test-secret');
    expect(await response.text()).not.toContain('test-secret');
  });
  it('accepts and persists the certificate-error warning policy', async () => {
    vi.mocked(monitoringQueries.createMonitoringCheck).mockResolvedValueOnce({ id: 2 } as never);
    const response = await fetch(`${baseUrl}/monitoring/checks`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...checkInput, certificateErrorMode: 'warning' }),
    });
    expect(response.status).toBe(201);
    expect(monitoringQueries.createMonitoringCheck).toHaveBeenCalledWith(expect.objectContaining({ certificateErrorMode: 'warning' }));
  });
  it.each([
    { checkType: 'https' }, { allowPrivate: 'true' }, { timeoutSeconds: true }, { unknown: true },
    { options: { tcp: { tls: true } } }, { options: { http: { headers: { Authorization: 'secret' } } } },
    { options: { http: { assertions: [{ kind: 'json', pointer: '/value', operator: 'gt', value: '1' }] } } },
    { checkType: 'tcp', endpoint: 'example.test', port: null, certExpiryDays: null },
  ])('rejects invalid or incompatible settings: %j', async patch => {
    const response = await fetch(`${baseUrl}/monitoring/checks`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...checkInput, ...patch }) });
    expect(response.status).toBe(400);
    expect(monitoringQueries.createMonitoringCheck).not.toHaveBeenCalled();
  });
  it('accepts IMAP on port 143 with STARTTLS enabled by default', async () => {
    vi.mocked(monitoringQueries.createMonitoringCheck).mockResolvedValueOnce({ id: 3 } as never);
    const response = await fetch(`${baseUrl}/monitoring/checks`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...checkInput, checkType: 'imap', endpoint: 'mail.example.test', port: 143, certExpiryDays: null }),
    });
    expect(response.status).toBe(201);
    expect(monitoringQueries.createMonitoringCheck).toHaveBeenCalledWith(expect.objectContaining({ checkType: 'imap', options: { imap: { startTls: true } } }));
  });
  it('exports configuration and previews imports without applying them', async () => {
    const configuration = { format: 'robin-admin-monitoring', version: 1, targets: [], checks: [], sections: [], components: [] };
    vi.mocked(configTransfer.exportMonitoringConfiguration).mockResolvedValueOnce(configuration as never);
    vi.mocked(configTransfer.importMonitoringConfiguration).mockResolvedValueOnce({
      changes: [{ resource: 'target', action: 'create', identity: 'Example (production)' }], conflicts: [], errors: [],
    });
    const exported = await fetch(`${baseUrl}/monitoring/export`);
    expect(exported.status).toBe(200);
    expect((await exported.json()).data).toEqual(configuration);
    const preview = await fetch(`${baseUrl}/monitoring/import`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ configuration, dryRun: true }),
    });
    expect(preview.status).toBe(200);
    expect(configTransfer.importMonitoringConfiguration).toHaveBeenCalledWith(configuration, true);
    expect(logAudit).not.toHaveBeenCalledWith(expect.anything(), 'monitoring.config_import', expect.anything());
  });
  it('validates partial updates against the saved protocol', async () => {
    vi.mocked(monitoringQueries.getMonitoringCheck).mockResolvedValueOnce({ ...checkInput, port: null, tlsMode: 'strict', options: parseMonitoringOptions('http') } as never);
    const response = await fetch(`${baseUrl}/monitoring/checks/1`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ port: 80 }) });
    expect(response.status).toBe(400);
    expect(monitoringQueries.updateMonitoringCheck).not.toHaveBeenCalled();
  });
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  authState.authenticated = true;
  authState.admin = true;
  mockGetConfig.mockResolvedValue({ monitoringEnabled: true } as never);
  vi.mocked(monitoringQueries.getMonitoringSummary).mockResolvedValue(summary);
});

describe('monitoring route permissions', () => {
  it('returns heartbeat configuration without any URL values', async () => {
    vi.mocked(heartbeat.listHeartbeatTargets).mockResolvedValueOnce([{
      id: 5, name: 'External uptime', intervalSeconds: 60, enabled: true,
      pingUrlConfigured: true, failureUrlConfigured: true, lastAttemptAt: null, lastResult: null, lastReason: null,
    }]);
    const response = await fetch(`${baseUrl}/monitoring/heartbeats`);
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('pingUrlConfigured');
    expect(body).not.toContain('https://');
    expect(heartbeat.listHeartbeatTargets).toHaveBeenCalledOnce();
  });

  it('audits heartbeat creation without recording either URL', async () => {
    vi.mocked(heartbeat.saveHeartbeatTarget).mockResolvedValueOnce({
      id: 5, name: 'External uptime', intervalSeconds: 60, enabled: true,
      pingUrlConfigured: true, failureUrlConfigured: true, lastAttemptAt: null, lastResult: null, lastReason: null,
    });
    const pingUrl = 'https://hc-ping.com/super-secret';
    const response = await fetch(`${baseUrl}/monitoring/heartbeats`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'External uptime', pingUrl, failureUrl: `${pingUrl}/fail`, intervalSeconds: 60 }),
    });
    expect(response.status).toBe(201);
    expect(await response.text()).not.toContain('super-secret');
    expect(JSON.stringify(vi.mocked(logAudit).mock.calls.map(([, action, details]) => ({ action, details })))).not.toContain('super-secret');
  });

  it('returns retryable capacity exhaustion instead of success or a generic server error', async () => {
    const error = new Error('Monitoring is busy');
    error.name = 'MonitoringCapacityError';
    vi.mocked(monitoringScheduler.runMonitoringCheckNow).mockRejectedValueOnce(error);
    const response = await fetch(`${baseUrl}/monitoring/checks/1/run`, { method: 'POST' });
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    await expect(response.json()).resolves.toMatchObject({ success: false, error: 'Monitoring is busy' });
  });
  it('allows authenticated non-admin users to read the monitoring summary', async () => {
    authState.admin = false;

    const response = await fetch(`${baseUrl}/monitoring`);

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: summary });
    expect(monitoringQueries.getMonitoringSummary).toHaveBeenCalledTimes(1);
  });

  it('requires authentication for the monitoring summary', async () => {
    authState.authenticated = false;

    const response = await fetch(`${baseUrl}/monitoring`);

    expect(response.status).toBe(401);
    expect(monitoringQueries.getMonitoringSummary).not.toHaveBeenCalled();
  });

  it.each([
    ['POST', '/targets', targetInput, monitoringQueries.createMonitoringTarget],
    ['PUT', '/targets/1', targetInput, monitoringQueries.updateMonitoringTarget],
    ['DELETE', '/targets/1', undefined, monitoringQueries.deleteMonitoringTarget],
    ['POST', '/checks', checkInput, monitoringQueries.createMonitoringCheck],
    ['PUT', '/checks/1', checkInput, monitoringQueries.updateMonitoringCheck],
    ['POST', '/checks/1/pause', { reason: 'maintenance' }, monitoringQueries.pauseMonitoringCheck],
    ['POST', '/checks/1/resume', undefined, monitoringQueries.resumeMonitoringCheck],
    ['POST', '/checks/1/run', undefined, monitoringScheduler.runMonitoringCheckNow],
    ['POST', '/issues/1/close-stale', undefined, monitoringQueries.closeStaleMonitoringIssue],
    ['DELETE', '/issues/1', undefined, monitoringQueries.deleteClosedMonitoringIssue],
    ['DELETE', '/checks/1', undefined, monitoringQueries.deleteMonitoringCheck],
  ])('keeps %s %s admin-only', async (method, path, body, handler) => {
    authState.admin = false;

    const response = await fetch(`${baseUrl}/monitoring${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });

    expect(response.status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('returns conflict when a monitoring issue is still firing', async () => {
    vi.mocked(monitoringQueries.closeStaleMonitoringIssue).mockResolvedValue('active');

    const response = await fetch(`${baseUrl}/monitoring/issues/55/close-stale`, { method: 'POST' });

    expect(response.status).toBe(409);
    await expect(response.json()).resolves.toMatchObject({ success: false, error: 'Issue is still firing. Run or pause the check instead.' });
    expect(monitoringQueries.closeStaleMonitoringIssue).toHaveBeenCalledWith(55);
  });

  it('closes a stale monitoring issue', async () => {
    const issue = {
      id: 55,
      checkId: 7,
      checkName: 'Suite Robin SMTPS 465',
      targetName: 'Local Docker suite',
      status: 'closed',
      severity: 'warning',
      summary: 'Suite Robin SMTPS 465 is warning',
      details: { manuallyClosedAsStale: true },
      openedAt: new Date('2026-09-22T11:50:00.000Z'),
      closedAt: new Date('2026-09-22T12:00:00.000Z'),
      updatedAt: new Date('2026-09-22T12:00:00.000Z'),
      deliveries: [],
    } as const;
    vi.mocked(monitoringQueries.closeStaleMonitoringIssue).mockResolvedValue(issue);

    const response = await fetch(`${baseUrl}/monitoring/issues/55/close-stale`, { method: 'POST' });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: { id: 55, status: 'closed' } });
  });

  it('deletes closed issues and refuses open ones', async () => {
    vi.mocked(monitoringQueries.deleteClosedMonitoringIssue).mockResolvedValueOnce('open').mockResolvedValueOnce(true);

    const open = await fetch(`${baseUrl}/monitoring/issues/55`, { method: 'DELETE' });
    expect(open.status).toBe(409);
    await expect(open.json()).resolves.toMatchObject({ success: false, error: 'Only closed issues can be deleted.' });

    const closed = await fetch(`${baseUrl}/monitoring/issues/56`, { method: 'DELETE' });
    expect(closed.status).toBe(200);
    expect(monitoringQueries.deleteClosedMonitoringIssue).toHaveBeenLastCalledWith(56);
  });

  it('returns daily check history for admins within the allowed window', async () => {
    const days = [{ day: '2026-09-30', up: 1430, warning: 0, down: 10, availability: 1430 / 1440, averageResponseTimeMs: 82, maxResponseTimeMs: 950 }];
    vi.mocked(monitoringQueries.getMonitoringCheckHistory).mockResolvedValue(days);

    const response = await fetch(`${baseUrl}/monitoring/checks/7/history?days=30`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ success: true, data: days });
    expect(monitoringQueries.getMonitoringCheckHistory).toHaveBeenCalledWith(7, 30);

    expect((await fetch(`${baseUrl}/monitoring/checks/7/history?days=0`)).status).toBe(400);
    expect((await fetch(`${baseUrl}/monitoring/checks/7/history?days=401`)).status).toBe(400);
    authState.admin = false;
    expect((await fetch(`${baseUrl}/monitoring/checks/7/history`)).status).toBe(403);
  });
});

describe('numeric route ids', () => {
  it('accepts path ids for location updates and heartbeat tests, and rejects non-numeric ids', async () => {
    authState.admin = true;
    const location = { id: 9, name: 'Remote', region: null, locationType: 'remote', enabled: true, shadow: true, probeConcurrency: 4 };
    vi.mocked(monitoringProbes.listMonitoringProbeLocations).mockResolvedValue([location] as never);
    vi.mocked(monitoringProbes.updateMonitoringProbeLocation).mockResolvedValue(true as never);
    const promote = await fetch(`${baseUrl}/monitoring/locations/9`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shadow: false, region: 'Carlstadt, NJ' }) });
    expect(promote.status).toBe(200);
    expect(monitoringProbes.updateMonitoringProbeLocation).toHaveBeenCalledWith(9, { shadow: false, region: 'Carlstadt, NJ' });

    vi.mocked(heartbeat.sendHeartbeatTest).mockResolvedValue(true as never);
    expect((await fetch(`${baseUrl}/monitoring/heartbeats/3/test`, { method: 'POST' })).status).toBe(200);
    expect(heartbeat.sendHeartbeatTest).toHaveBeenCalledWith(3);

    for (const id of ['abc', '1.5', '0', '99999999999']) {
      const response = await fetch(`${baseUrl}/monitoring/locations/${id}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ shadow: false }) });
      expect(response.status).toBe(400);
    }
  });
});
