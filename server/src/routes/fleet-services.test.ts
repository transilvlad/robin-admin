import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './fleet-services.js';
import * as instancesQueries from '../db/queries/fleet-services.js';
import * as fleetAgentSyncQueries from '../db/queries/fleet-agent-sync.js';
import * as configQueries from '../db/queries/config.js';
import * as robinApi from '../services/robin-api.js';
import * as metricsPoller from '../services/metrics-poller.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/security.js', () => ({
  validateOutboundUrl: vi.fn(() => null),
}));

vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(),
}));

vi.mock('../db/queries/fleet-agent-sync.js', () => ({
  getFleetServiceSyncStatus: vi.fn(),
  listFleetServiceSyncLog: vi.fn(async () => []),
  appendFleetServiceSyncLog: vi.fn(async () => undefined),
  requestFleetServiceSync: vi.fn(async () => null),
}));

vi.mock('../db/queries/fleet-services.js', () => ({
  createFleetService: vi.fn(),
  deleteFleetService: vi.fn(),
  fleetServiceExists: vi.fn(),
  getAllFleetServices: vi.fn(),
  getEnabledFleetServices: vi.fn(),
  getFleetServiceById: vi.fn(),
  getFleetServiceCount: vi.fn(),
  getInstanceById: vi.fn(),
  updateFleetService: vi.fn(),
}));

vi.mock('../services/robin-api.js', () => ({
  clearInstanceCache: vi.fn(),
}));

// The health route uses the agent-aware live-metrics wrappers from the poller.
vi.mock('../services/metrics-poller.js', () => ({
  getLiveClamavMetrics: vi.fn(),
  getLiveDovecotMetrics: vi.fn(),
  getLivePostfixMetrics: vi.fn(),
  getLiveRedisMetrics: vi.fn(),
  getLivePostgresMetrics: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    debug: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
  },
}));

const mockGetConfig = vi.mocked(configQueries.getConfig);
const mockGetFleetServiceSyncStatus = vi.mocked(fleetAgentSyncQueries.getFleetServiceSyncStatus);
const mockCreateFleetService = vi.mocked(instancesQueries.createFleetService);
const mockFleetServiceExists = vi.mocked(instancesQueries.fleetServiceExists);
const mockGetAllFleetServices = vi.mocked(instancesQueries.getAllFleetServices);
const mockGetFleetServiceById = vi.mocked(instancesQueries.getFleetServiceById);
const mockGetFleetServiceCount = vi.mocked(instancesQueries.getFleetServiceCount);
const mockUpdateFleetService = vi.mocked(instancesQueries.updateFleetService);
const mockClearInstanceCache = vi.mocked(robinApi.clearInstanceCache);
const mockGetClamavLiveMetrics = vi.mocked(metricsPoller.getLiveClamavMetrics);

let server: Server;
let baseUrl: string;

function buildService(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    serviceId: 'service-1',
    serviceType: 'robin',
    name: 'Service 1',
    description: null,
    apiUrl: 'https://service.test',
    healthUrl: 'https://service.test/health',
    metricsUrl: 'https://service.test/metrics',
    controllerUrl: null,
    normalUrl: null,
    enabled: true,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-02T00:00:00Z'),
    ...overrides,
  };
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });

  return {
    response,
    body: await response.json(),
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/fleet/services', router);
  server = app.listen(0);

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/fleet/services`;
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
  mockGetConfig.mockResolvedValue({ allowPrivateServiceUrls: false } as never);
  mockGetFleetServiceSyncStatus.mockResolvedValue(null);
  mockFleetServiceExists.mockResolvedValue(false);
  mockGetClamavLiveMetrics.mockResolvedValue(null);
});

describe('fleet service routes', () => {
  it.each(['redis', 'postgres', 'mariadb'])('masks %s credentials on the service-detail route', async (serviceType) => {
    mockGetFleetServiceById.mockResolvedValue(buildService({ serviceType, metricsUrl: 'mysql://admin:private-secret@db.test/' }) as never);
    const { response, body } = await requestJson('/service-1');
    expect(response.status).toBe(200);
    expect(body.data.metricsUrl).toContain('********');
    expect(JSON.stringify(body)).not.toContain('private-secret');
  });
  it('filters generic fleet services by disabled state and service type', async () => {
    mockGetAllFleetServices.mockResolvedValue([
      buildService({ serviceId: 'robin-east', serviceType: 'robin', enabled: false }),
      buildService({ serviceId: 'rspamd-core', serviceType: 'rspamd', enabled: false }),
      buildService({ serviceId: 'rspamd-edge', serviceType: 'rspamd', enabled: true }),
    ] as never);

    const { response, body } = await requestJson('?serviceType=rspamd&enabled=false');

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      success: true,
      data: [
        expect.objectContaining({
          serviceId: 'rspamd-core',
          serviceType: 'rspamd',
          enabled: false,
        }),
      ],
    });
    expect(body.data).toHaveLength(1);
    expect(mockGetAllFleetServices).toHaveBeenCalledOnce();
  });

  it('returns service-type specific counts from the generic fleet registry', async () => {
    mockGetFleetServiceCount.mockResolvedValue({
      total: 5,
      enabled: 3,
      byType: {
        robin: { total: 2, enabled: 1 },
        rspamd: { total: 3, enabled: 2 },
        clamav: { total: 0, enabled: 0 },
      },
    });

    const { response, body } = await requestJson('/count?serviceType=rspamd');

    expect(response.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: {
        serviceType: 'rspamd',
        total: 3,
        enabled: 2,
      },
    });
  });

  it('checks ClamAV health with the ClamD protocol instead of HTTP fetch', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({
      serviceId: 'suite-clamav',
      serviceType: 'clamav',
      name: 'Suite ClamAV',
      apiUrl: 'http://antivirus-backend:3310',
      healthUrl: 'http://antivirus-backend:3310',
      metricsUrl: null,
    }) as never);
    mockGetClamavLiveMetrics.mockResolvedValue({
      serviceId: 'suite-clamav',
      serviceType: 'clamav',
      timestamp: new Date(),
      pingOk: true,
      versionText: 'ClamAV 1.5.1/28049/Fri Jul 3 06:24:34 2026',
      engineVersion: '1.5.1',
      databaseVersion: 28049,
      databaseUpdatedAt: new Date('2026-07-03T06:24:34Z'),
      statusText: 'VALID PRIMARY',
      pools: 1,
      threadsLive: 1,
      threadsIdle: 1,
      threadsMax: 12,
      queueItems: 0,
      memoryHeapMB: 0,
      memoryMmapMB: 0,
      memoryUsedMB: 0,
      memoryFreeMB: 0,
      memoryReleasableMB: 0,
      memoryPoolsUsedMB: 0,
      memoryPoolsTotalMB: 0,
      rawStats: '',
    });

    const { response, body } = await requestJson('/suite-clamav/health');

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      serviceId: 'suite-clamav',
      serviceType: 'clamav',
      healthy: true,
      status: 200,
    });
    expect(mockGetClamavLiveMetrics).toHaveBeenCalledWith('suite-clamav');
  });

  it('hydrates generic fleet service responses with sync status', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
      name: 'Rspamd Core',
    }) as never);
    mockGetFleetServiceSyncStatus.mockResolvedValue({
      serviceId: 'rspamd-core',
      manifestSha256: 'a'.repeat(64),
      manifestEtag: `"${'a'.repeat(64)}"`,
      manifestFileCount: 2,
      lastSeenAt: new Date('2024-01-01T00:00:00Z'),
      lastManifestPulledAt: null,
      lastFilePulledAt: null,
      lastApplyStartedAt: null,
      lastApplyFinishedAt: null,
      lastApplyStatus: 'succeeded',
      lastApplyError: null,
      lastAppliedSha256: null,
      lastAppliedFileCount: null,
      agentVersion: '1.2.3',
      metadataJson: { hostname: 'mx1' },
      createdAt: new Date('2024-01-01T00:00:00Z'),
      updatedAt: new Date('2024-01-01T00:00:05Z'),
    } as never);

    const { response, body } = await requestJson('/rspamd-core');

    expect(response.status).toBe(200);
    expect(body.data).toMatchObject({
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
      syncStatus: {
        lastApplyStatus: 'succeeded',
        agentVersion: '1.2.3',
        metadataJson: { hostname: 'mx1' },
      },
    });
  });

  it('creates generic rspamd services without touching the Robin instance cache', async () => {
    mockCreateFleetService.mockResolvedValue(buildService({
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
      name: 'Rspamd Core',
      apiUrl: 'https://rspamd.example.test',
      healthUrl: 'https://rspamd.example.test/health',
      metricsUrl: 'https://rspamd.example.test/metrics',
      controllerUrl: 'https://rspamd.example.test:11334',
      normalUrl: 'https://rspamd.example.test:11333',
    }) as never);

    const { response, body } = await requestJson('', {
      method: 'POST',
      body: JSON.stringify({
        serviceId: 'rspamd-core',
        serviceType: 'rspamd',
        name: 'Rspamd Core',
        apiUrl: 'https://rspamd.example.test',
        healthUrl: 'https://rspamd.example.test/health',
        metricsUrl: 'https://rspamd.example.test/metrics',
        controllerUrl: 'https://rspamd.example.test:11334',
        normalUrl: 'https://rspamd.example.test:11333',
        enabled: true,
      }),
    });

    expect(response.status).toBe(201);
    expect(mockCreateFleetService).toHaveBeenCalledWith({
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
      name: 'Rspamd Core',
      description: undefined,
      apiUrl: 'https://rspamd.example.test',
      healthUrl: 'https://rspamd.example.test/health',
      metricsUrl: 'https://rspamd.example.test/metrics',
      controllerUrl: 'https://rspamd.example.test:11334',
      normalUrl: 'https://rspamd.example.test:11333',
      enabled: true,
    });
    expect(body.data).toMatchObject({
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
    });
    expect(mockClearInstanceCache).not.toHaveBeenCalled();
  });

  it('returns a validation error for a malformed connection string edit', async () => {
    const { response, body } = await requestJson('/rspamd-core', {
      method: 'PUT',
      body: JSON.stringify({ metricsUrl: 'mysql://[bad' }),
    });
    expect(response.status).toBe(400);
    expect(body.error).toBe('Connection string must be a valid URL');
    expect(mockUpdateFleetService).not.toHaveBeenCalled();
  });

  it('allows editing a fleet service id while updating the existing service record', async () => {
    mockUpdateFleetService.mockResolvedValue(buildService({
      serviceId: 'rspamd-edge',
      serviceType: 'rspamd',
      name: 'Rspamd Edge',
      controllerUrl: 'https://rspamd-edge.example.test:11334',
      normalUrl: 'https://rspamd-edge.example.test:11333',
    }) as never);

    const { response, body } = await requestJson('/rspamd-core', {
      method: 'PUT',
      body: JSON.stringify({
        serviceId: 'rspamd-edge',
        name: 'Rspamd Edge',
        controllerUrl: 'https://rspamd-edge.example.test:11334',
        normalUrl: 'https://rspamd-edge.example.test:11333',
        enabled: true,
      }),
    });

    expect(response.status).toBe(200);
    expect(mockUpdateFleetService).toHaveBeenCalledWith('rspamd-core', expect.objectContaining({
      serviceId: 'rspamd-edge',
      name: 'Rspamd Edge',
      controllerUrl: 'https://rspamd-edge.example.test:11334',
      normalUrl: 'https://rspamd-edge.example.test:11333',
      enabled: true,
    }));
    expect(body.data).toMatchObject({
      serviceId: 'rspamd-edge',
      serviceType: 'rspamd',
    });
  });
});
