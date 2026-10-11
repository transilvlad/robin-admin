import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './fleet-services.js';
import * as instancesQueries from '../db/queries/fleet-services.js';
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

vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../db/queries/fleet-agent-sync.js', () => ({ getFleetServiceSyncStatus: vi.fn() }));

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

vi.mock('../services/robin-api.js', () => ({ clearInstanceCache: vi.fn() }));
// The health route uses the agent-aware live-metrics wrappers from the poller.
vi.mock('../services/metrics-poller.js', () => ({
  getLiveClamavMetrics: vi.fn(),
  getLiveDovecotMetrics: vi.fn(),
  getLivePostfixMetrics: vi.fn(),
  getLiveRedisMetrics: vi.fn(),
  getLivePostgresMetrics: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockGetFleetServiceById = vi.mocked(instancesQueries.getFleetServiceById);
const mockGetPostfixLiveMetrics = vi.mocked(metricsPoller.getLivePostfixMetrics);

function postfixSvc() {
  return { id: 1, serviceId: 'pf1', serviceType: 'postfix', name: 'Postfix', apiUrl: null };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/fleet', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/fleet`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('instances route — postfix health', () => {
  it('reports healthy when postfix metrics are reachable', async () => {
    mockGetFleetServiceById.mockResolvedValue(postfixSvc() as never);
    mockGetPostfixLiveMetrics.mockResolvedValue({ reachable: true } as never);

    const res = await fetch(`${baseUrl}/pf1/health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      serviceId: 'pf1',
      serviceType: 'postfix',
      healthy: true,
      status: 200,
    });
    expect(mockGetPostfixLiveMetrics).toHaveBeenCalledWith('pf1');
  });

  it('reports unhealthy when postfix metrics are unreachable', async () => {
    mockGetFleetServiceById.mockResolvedValue(postfixSvc() as never);
    mockGetPostfixLiveMetrics.mockResolvedValue({ reachable: false } as never);

    const res = await fetch(`${baseUrl}/pf1/health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({
      serviceId: 'pf1',
      serviceType: 'postfix',
      healthy: false,
      status: 503,
    });
    expect(body.data.error).toMatch(/Postfix/);
  });

  it('returns unhealthy (not a 500) when the metrics call throws', async () => {
    mockGetFleetServiceById.mockResolvedValue(postfixSvc() as never);
    mockGetPostfixLiveMetrics.mockRejectedValue(new Error('boom'));

    const res = await fetch(`${baseUrl}/pf1/health`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toMatchObject({ healthy: false, status: 503, error: 'boom' });
  });

  it('returns 404 when the service does not exist', async () => {
    mockGetFleetServiceById.mockResolvedValue(null as never);

    const res = await fetch(`${baseUrl}/missing/health`);
    expect(res.status).toBe(404);
  });
});
