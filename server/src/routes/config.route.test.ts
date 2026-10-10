import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './config.js';
import * as configQueries from '../db/queries/config.js';
import * as robinConfigMeta from '../db/queries/robin-config-meta.js';
import { observabilityDefaults } from '../services/observability-settings.js';
import { reportingDefaults } from '../services/reporting-settings.js';
import { DISCOVERY_DEFAULTS } from '../services/telemetry/discovery.js';
import { logAudit } from '../middleware/audit.js';

vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(),
  getConfigValidationError: vi.fn(() => null),
  updateConfig: vi.fn(),
  cleanupOldReportingReports: vi.fn(),
  cleanupOldAuditLog: vi.fn(),
  getReportingUsageStats: vi.fn(),
  setConfigValue: vi.fn(),
}));
vi.mock('../db/queries/robin-config-meta.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/queries/robin-config-meta.js')>();
  return {
    ...actual,
    checkTableHasSchema: vi.fn(),
  };
});
vi.mock('../db/queries/security.js', () => ({
  hashSecret: vi.fn(),
  clearLoginLocks: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (
    req: { session?: { admin?: { id: number; role: string } } },
    _res: unknown,
    next: () => void
  ) => {
    req.session = { admin: { id: 1, role: 'admin' } };
    next();
  },
}));
vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../middleware/audit.js', () => ({
  AuditActions: { CONFIG_UPDATE: 'config.update' },
  logAudit: vi.fn(),
}));

const mockGetConfig = vi.mocked(configQueries.getConfig);
const mockGetConfigValidationError = vi.mocked(configQueries.getConfigValidationError);
const mockUpdateConfig = vi.mocked(configQueries.updateConfig);
const mockCheckTableHasSchema = vi.mocked(robinConfigMeta.checkTableHasSchema);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/config', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfigValidationError.mockReturnValue(null);
  mockGetConfig.mockResolvedValue({
    ...DISCOVERY_DEFAULTS,
    ...observabilityDefaults(),
    ...reportingDefaults(),
    sessionTimeoutMinutes: 60,
    sessionAbsoluteLifetimeMinutes: 1440,
    robinConfigTableName: 'robin_config_store',
  } as Awaited<ReturnType<typeof configQueries.getConfig>>);
  mockCheckTableHasSchema.mockResolvedValue(true);
  mockUpdateConfig.mockImplementation(async (updates) => ({
    ...await mockGetConfig(),
    ...updates,
  } as Awaited<ReturnType<typeof configQueries.getConfig>>));
});

describe('config route validation', () => {
  it('includes the persisted configuration warning in the admin response', async () => {
    mockGetConfigValidationError.mockReturnValue('Manual probe concurrency must leave one scheduled slot');
    const response = await fetch(`${baseUrl}/config`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      configurationError: 'Manual probe concurrency must leave one scheduled slot',
    });
  });

  it('saves Mailboxes enablement through the audited configuration route', async () => {
    const response = await fetch(`${baseUrl}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mailboxesEnabled: true }) });
    expect(response.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ mailboxesEnabled: true });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'config.update', expect.objectContaining({ newValues: expect.objectContaining({ mailboxesEnabled: true }) }));
  });

  it.each(['true', 'false', 1, null, []])('rejects non-boolean Mailboxes enablement: %s', async mailboxesEnabled => {
    const response = await fetch(`${baseUrl}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mailboxesEnabled }) });
    expect(response.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
  it('saves generic discovery through the existing audited administration route', async () => {
    const updates = { telemetrySourceLabel: 'host', telemetryGroupLabel: '', telemetrySourceSelector: '{job="metrics"}' };
    const response = await fetch(`${baseUrl}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates) });
    expect(response.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledWith(updates);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'config.update', expect.objectContaining({ newValues: expect.objectContaining(updates) }));
  });
  it.each([{ telemetrySourceLabel: '__name__' }, { telemetryGroupLabel: 'instance' }, { telemetrySourceSelector: 'up or vector(1)' }, { telemetryGroupLabel: 1 }])('rejects unsafe discovery without writing: %s', async updates => {
    const response = await fetch(`${baseUrl}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates) });
    expect(response.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });
  it('persists reporting capacity through the same audited administration route', async () => {
    const response = await fetch(`${baseUrl}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ reportingCacheMiB: 64, reportingSourceQueueSize: 0 }) });
    expect(response.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ reportingCacheMiB: 64, reportingSourceQueueSize: 0 });
  });
  it.each([{ reportingCacheMiB: 2048 }, { reportingCacheTtlSeconds: '60' }, { reportingSourceConcurrency: 1.5 }, { reportingSourceQueueSize: -1 }])('rejects invalid reporting capacity: %s', async updates => {
    const response = await fetch(`${baseUrl}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates) });
    expect(response.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
  it('persists bounded telemetry policy through the existing audited config route', async () => {
    const response = await fetch(`${baseUrl}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ telemetrySourceWindowDays: 14, telemetrySilentAfterSeconds: 1800 }) });
    expect(response.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ telemetrySourceWindowDays: 14, telemetrySilentAfterSeconds: 1800 });
  });
  it.each([{ telemetrySilentAfterSeconds: '1800' }, { monitoringConcurrency: 8 }, { monitoringHistoryRetentionDays: 2 }, { telemetrySourceLimit: 5001 }])('rejects invalid observability settings: %s', async updates => {
    const response = await fetch(`${baseUrl}/config`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(updates) });
    expect(response.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
  });
  it('persists a compatible custom Robin config-store table', async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ robinConfigTableName: 'existing_robin_configs' }),
    });

    expect(response.status).toBe(200);
    expect(mockCheckTableHasSchema).toHaveBeenCalledWith('existing_robin_configs');
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      robinConfigTableName: 'existing_robin_configs',
    });
    await expect(response.json()).resolves.toMatchObject({
      data: { robinConfigTableName: 'existing_robin_configs' },
    });
  });

  it('rejects unsafe Robin config-store table names', async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ robinConfigTableName: 'robin_config_store; DROP TABLE admins' }),
    });

    expect(response.status).toBe(400);
    expect(mockCheckTableHasSchema).not.toHaveBeenCalled();
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('must start with a letter or underscore'),
    });
  });

  it('rejects table names without the Robin config-store schema', async () => {
    mockCheckTableHasSchema.mockResolvedValue(false);

    const response = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ robinConfigTableName: 'unrelated_table' }),
    });

    expect(response.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('must be a base table'),
    });
  });

  it('does not couple unrelated saves to an unchanged Robin table schema check', async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        robinConfigTableName: 'robin_config_store',
        loginLockoutMinutes: 20,
      }),
    });

    expect(response.status).toBe(200);
    expect(mockCheckTableHasSchema).not.toHaveBeenCalled();
    expect(mockUpdateConfig).toHaveBeenCalledWith({
      robinConfigTableName: 'robin_config_store',
      loginLockoutMinutes: 20,
    });
  });

  it('rejects an absolute session lifetime shorter than idle timeout', async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        sessionTimeoutMinutes: 120,
        sessionAbsoluteLifetimeMinutes: 60,
      }),
    });

    expect(response.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: 'Absolute session lifetime cannot be shorter than the idle timeout',
    });
  });

  it('accepts a zero audit log retention (keep forever)', async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auditLogRetentionDays: 0 }),
    });

    expect(response.status).toBe(200);
    expect(mockUpdateConfig).toHaveBeenCalledWith({ auditLogRetentionDays: 0 });
  });

  it('rejects an audit log retention outside the 0-3650 day range', async () => {
    const response = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ auditLogRetentionDays: 3651 }),
    });

    expect(response.status).toBe(400);
    expect(mockUpdateConfig).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      error: expect.stringContaining('between 0 (keep forever) and 3650'),
    });
  });

  it('triggers audit log cleanup and reports the deleted count', async () => {
    const mockCleanupOldAuditLog = vi.mocked(configQueries.cleanupOldAuditLog);
    mockCleanupOldAuditLog.mockResolvedValue(42);

    const response = await fetch(`${baseUrl}/config/cleanup-audit-log`, { method: 'POST' });

    expect(response.status).toBe(200);
    expect(mockCleanupOldAuditLog).toHaveBeenCalledOnce();
    await expect(response.json()).resolves.toMatchObject({
      data: { deleted: 42 },
    });
  });
});
