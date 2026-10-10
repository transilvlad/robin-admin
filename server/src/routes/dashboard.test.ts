import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './dashboard.js';
import * as usersQueries from '../db/queries/users.js';
import * as aliasesQueries from '../db/queries/aliases.js';
import * as queueQueries from '../db/queries/queue.js';
import * as configQueries from '../db/queries/config.js';
import * as robinConfigMeta from '../db/queries/robin-config-meta.js';
import * as instanceQueries from '../db/queries/fleet-services.js';
import * as authMiddleware from '../middleware/auth.js';
vi.mock('../services/telemetry/store-client.js', () => ({ telemetryStoreConfigured: vi.fn(async () => false) }));

vi.mock('../db/queries/users.js', () => ({
  countUsers: vi.fn(),
  tableExists: vi.fn(),
}));

vi.mock('../db/queries/aliases.js', () => ({
  countAliases: vi.fn(),
  countAutoAliases: vi.fn(),
  aliasesTableExists: vi.fn(),
  autoAliasesTableExists: vi.fn(),
}));

vi.mock('../db/queries/queue.js', () => ({
  getQueueStats: vi.fn(),
  queueTableExists: vi.fn(),
}));

vi.mock('../db/queries/admins.js', () => ({
  countActiveAdmins: vi.fn(),
}));

vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  SETUP_GUIDE_PENDING_KEY: 'setup_guide_pending',
}));

vi.mock('../db/queries/admin-preferences.js', () => ({
  getAdminPreference: vi.fn(),
  setAdminPreference: vi.fn(),
}));

vi.mock('../db/queries/dmarc.js', () => ({
  getDmarcStats: vi.fn(),
}));

vi.mock('../db/queries/tlsrpt.js', () => ({
  getTlsrptStats: vi.fn(),
}));

vi.mock('../db/queries/forensic.js', () => ({
  getForensicStats: vi.fn(),
}));

vi.mock('../services/robin-api.js', () => ({
  checkRobinHealth: vi.fn(),
}));

vi.mock('../services/metrics-poller.js', () => ({
  getLiveRobinMetrics: vi.fn(),
  getLiveRspamdMetrics: vi.fn(),
  getRobinMetricsHistory: vi.fn(),
  getRspamdMetricsHistory: vi.fn(),
}));

vi.mock('../db/queries/robin-config-meta.js', () => ({
  robinConfigTableHasSchema: vi.fn(),
  getRobinConfigTableName: vi.fn(async () => 'robin_config_store'),
}));

vi.mock('../db/queries/service-metrics.js', () => ({
  getEnabledMetricsFleetServices: vi.fn(),
}));

vi.mock('../db/queries/reporting.js', () => ({
  getOverviewStats: vi.fn(),
}));

vi.mock('../db/connection.js', () => ({
  query: vi.fn(),
}));

vi.mock('../db/queries/fleet-services.js', () => ({
  getFleetServiceCount: vi.fn(),
}));

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  getCurrentAdmin: vi.fn(() => ({ adminId: 1, name: 'Admin', email: 'admin@example.com', role: 'admin' })),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireViewer: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    error: vi.fn(),
  },
}));

const mockUsersTableExists = vi.mocked(usersQueries.tableExists);
const mockAliasesTableExists = vi.mocked(aliasesQueries.aliasesTableExists);
const mockAutoAliasesTableExists = vi.mocked(aliasesQueries.autoAliasesTableExists);
const mockQueueTableExists = vi.mocked(queueQueries.queueTableExists);
const mockGetConfig = vi.mocked(configQueries.getConfig);
const mockGetConfigValue = vi.mocked(configQueries.getConfigValue);
const mockSetConfigValue = vi.mocked(configQueries.setConfigValue);
const mockRobinConfigTableHasSchema = vi.mocked(robinConfigMeta.robinConfigTableHasSchema);
const mockGetFleetServiceCount = vi.mocked(instanceQueries.getFleetServiceCount);
const mockGetCurrentAdmin = vi.mocked(authMiddleware.getCurrentAdmin);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/dashboard', router);
  server = app.listen(0);

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/dashboard`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockUsersTableExists.mockResolvedValue(true as never);
  mockAliasesTableExists.mockResolvedValue(true as never);
  mockAutoAliasesTableExists.mockResolvedValue(true as never);
  mockQueueTableExists.mockResolvedValue(true as never);
  mockRobinConfigTableHasSchema.mockResolvedValue(true as never);
  mockGetConfig.mockResolvedValue({
    mailboxesEnabled: true,
    fleetEnabled: true,
    monitoringEnabled: true,
    modulesEnabled: true,
    reportingIntegrationEnabled: true,
  } as never);
  mockGetFleetServiceCount.mockResolvedValue({
    total: 0,
    enabled: 0,
    byType: {
      robin: { total: 0, enabled: 0 },
      rspamd: { total: 0, enabled: 0 },
      clamav: { total: 0, enabled: 0 },
      dovecot: { total: 0, enabled: 0 },
      postfix: { total: 0, enabled: 0 },
      redis: { total: 0, enabled: 0 },
      postgres: { total: 0, enabled: 0 },
      mariadb: { total: 0, enabled: 0 },
    },
  } as never);
  mockGetCurrentAdmin.mockReturnValue({ adminId: 1, name: 'Admin', email: 'admin@example.com', role: 'admin' });
});

describe('dashboard features route', () => {
  it('keeps enabled Mailboxes visible without Fleet or compatible tables', async () => {
    mockGetConfig.mockResolvedValue({ mailboxesEnabled: true, fleetEnabled: false } as never);
    mockUsersTableExists.mockResolvedValue(false as never);
    mockAliasesTableExists.mockResolvedValue(false as never);
    mockAutoAliasesTableExists.mockResolvedValue(false as never);
    const response = await fetch(`${baseUrl}/features`);
    expect((await response.json()).data).toMatchObject({ mailboxes: true, users: false, aliases: false, autoAliases: false, fleet: false });
  });

  it('separates disabled Mailboxes from schema readiness', async () => {
    mockGetConfig.mockResolvedValue({ mailboxesEnabled: false } as never);
    const response = await fetch(`${baseUrl}/features`);
    expect((await response.json()).data).toMatchObject({ mailboxes: false, users: true, aliases: true, autoAliases: true });
  });
  it('keeps enabled Telemetry visible without a configured store', async () => {
    mockGetConfig.mockResolvedValue({ telemetryEnabled: true, reportingIntegrationEnabled: true } as never);
    const response = await fetch(`${baseUrl}/features`);
    const body = await response.json();
    expect(body.data).toMatchObject({ telemetry: true, telemetryEnabled: true, reporting: true });
  });

  it('hides disabled optional workspaces', async () => {
    mockGetConfig.mockResolvedValue({ telemetryEnabled: false, reportingIntegrationEnabled: false } as never);
    const response = await fetch(`${baseUrl}/features`);
    const body = await response.json();
    expect(body.data).toMatchObject({ telemetry: false, reporting: false });
  });

  it('keeps Fleet visible before any service exists', async () => {
    const response = await fetch(`${baseUrl}/features`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      fleet: true,
      robin: false,
      rspamd: false,
      clamav: false,
      fleetServices: {
        total: 0,
        robin: 0,
        rspamd: 0,
        clamav: 0,
      },
    });
  });

  it('gates Robin from service presence while leaving queue and config as separate flags', async () => {
    mockQueueTableExists.mockResolvedValue(false as never);
    mockRobinConfigTableHasSchema.mockResolvedValue(false as never);
    mockGetFleetServiceCount.mockResolvedValue({
      total: 1,
      enabled: 1,
      byType: {
        robin: { total: 1, enabled: 1 },
        rspamd: { total: 0, enabled: 0 },
        clamav: { total: 0, enabled: 0 },
        dovecot: { total: 0, enabled: 0 },
        postfix: { total: 0, enabled: 0 },
        redis: { total: 0, enabled: 0 },
        postgres: { total: 0, enabled: 0 },
        mariadb: { total: 0, enabled: 0 },
      },
    } as never);

    const response = await fetch(`${baseUrl}/features`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      fleet: true,
      robin: true,
      queue: false,
      robinConfig: false,
      rspamd: false,
      clamav: false,
      fleetServices: {
        total: 1,
        robin: 1,
        rspamd: 0,
        clamav: 0,
      },
    });
  });

  it('reports every registered service type independently from the fleet control-plane switch', async () => {
    mockGetConfig.mockResolvedValue({
      fleetEnabled: false,
      monitoringEnabled: true,
      modulesEnabled: true,
      reportingIntegrationEnabled: true,
    } as never);
    mockGetFleetServiceCount.mockResolvedValue({
      total: 8,
      enabled: 8,
      byType: {
        robin: { total: 1, enabled: 1 },
        rspamd: { total: 1, enabled: 1 },
        clamav: { total: 1, enabled: 1 },
        dovecot: { total: 1, enabled: 1 },
        postfix: { total: 1, enabled: 1 },
        redis: { total: 1, enabled: 1 },
        postgres: { total: 1, enabled: 1 },
        mariadb: { total: 1, enabled: 1 },
      },
    } as never);

    const response = await fetch(`${baseUrl}/features`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      fleet: false,
      robin: true,
      rspamd: true,
      clamav: true,
      dovecot: true,
      postfix: true,
      redis: true,
      postgres: true,
      mariadb: true,
      fleetServices: {
        total: 8,
        robin: 1,
        rspamd: 1,
        clamav: 1,
        dovecot: 1,
        postfix: 1,
        redis: 1,
        postgres: 1,
        mariadb: 1,
      },
    });
  });

  it('hides fleet inventory details from anonymous feature probes', async () => {
    mockGetCurrentAdmin.mockReturnValue(null);
    mockGetFleetServiceCount.mockResolvedValue({
      total: 8,
      enabled: 8,
      byType: {
        robin: { total: 1, enabled: 1 },
        rspamd: { total: 1, enabled: 1 },
        clamav: { total: 1, enabled: 1 },
        dovecot: { total: 1, enabled: 1 },
        postfix: { total: 1, enabled: 1 },
        redis: { total: 1, enabled: 1 },
        postgres: { total: 1, enabled: 1 },
        mariadb: { total: 1, enabled: 1 },
      },
    } as never);

    const response = await fetch(`${baseUrl}/features`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      robin: false,
      rspamd: false,
      fleetServices: { total: 0, robin: 0, rspamd: 0 },
      telemetryStoreConfigured: false,
    });
    expect(mockGetFleetServiceCount).not.toHaveBeenCalled();
  });
});

describe('dashboard setup guide', () => {
  it('reports the install-wide setup guide flag with the preferences', async () => {
    mockGetConfigValue.mockResolvedValue('true');

    const response = await fetch(`${baseUrl}/preferences`);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toEqual({ hidden: [], setupGuide: true });
    expect(mockGetConfigValue).toHaveBeenCalledWith('setup_guide_pending');
  });

  it('clears the setup guide flag on dismiss', async () => {
    mockSetConfigValue.mockResolvedValue(undefined);

    const response = await fetch(`${baseUrl}/setup-guide`, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(mockSetConfigValue).toHaveBeenCalledWith('setup_guide_pending', 'false');
  });
});
