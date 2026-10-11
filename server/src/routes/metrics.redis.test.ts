import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './metrics.js';
import * as poller from '../services/metrics-poller.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireViewer: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Note: service-types.js is NOT mocked — the real parseServiceType drives the
// `serviceType=bogus` -> 400 path.
vi.mock('../services/metrics-poller.js', () => ({
  getRawServiceMetrics: vi.fn(),
  getClamavMetricsHistory: vi.fn(),
  getDovecotMetricsHistory: vi.fn(),
  getPostfixMetricsHistory: vi.fn(),
  getRedisMetricsHistory: vi.fn(),
  getPostgresMetricsHistory: vi.fn(),
  getLiveClamavMetrics: vi.fn(),
  getLiveDovecotMetrics: vi.fn(),
  getLivePostfixMetrics: vi.fn(),
  getLiveRedisMetrics: vi.fn(),
  getLivePostgresMetrics: vi.fn(),
  getLiveRobinMetrics: vi.fn(),
  getLiveRspamdMetrics: vi.fn(),
  getRobinMetricsHistory: vi.fn(),
  getRspamdMetricsHistory: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockLiveRedis = vi.mocked(poller.getLiveRedisMetrics);
const mockRedisHistory = vi.mocked(poller.getRedisMetricsHistory);
const mockRawRedis = vi.mocked(poller.getRawServiceMetrics);

function liveMetrics(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: 'redis1',
    serviceType: 'redis',
    timestamp: new Date(),
    reachable: true,
    role: 'master',
    uptimeSecs: 100,
    connectedClients: 5,
    blockedClients: 0,
    maxClients: 10000,
    memoryUsedBytes: 1024,
    memoryPeakBytes: 2048,
    memoryRssBytes: 1500,
    maxMemoryBytes: 0,
    memFragmentationRatio: 1.1,
    evictedKeys: 0,
    expiredKeys: 0,
    keyspaceHits: 100,
    keyspaceMisses: 10,
    hitRatio: 0.9,
    instantaneousOpsPerSec: 42,
    totalCommandsProcessed: 1000,
    totalConnectionsReceived: 50,
    rejectedConnections: 0,
    totalNetInputBytes: 0,
    totalNetOutputBytes: 0,
    connectedSlaves: 0,
    masterLinkStatus: '',
    rdbChangesSinceLastSave: 0,
    rdbLastSaveTime: 0,
    rdbLastBgsaveStatus: 'ok',
    aofEnabled: false,
    aofLastWriteStatus: 'ok',
    dbKeys: 20,
    dbExpires: 5,
    pubsubChannels: 0,
    rawInfo: '',
    ...overrides,
  };
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    connectedClients: 5,
    memoryUsedBytes: 1024,
    totalCommandsProcessed: 1000,
    totalConnectionsReceived: 50,
    keyspaceHits: 100,
    keyspaceMisses: 10,
    evictedKeys: 0,
    expiredKeys: 0,
    rejectedConnections: 0,
    reachable: true,
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/metrics', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/metrics`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('metrics route (redis)', () => {
  it('GET /live?serviceType=redis returns the live metrics payload', async () => {
    mockLiveRedis.mockResolvedValue(liveMetrics() as never);

    const res = await fetch(`${baseUrl}/live?serviceType=redis`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      serviceType: 'redis',
      reachable: true,
      connectedClients: 5,
      dbKeys: 20,
    });
  });

  it('GET /live returns data:null with a message when the endpoint is unavailable', async () => {
    mockLiveRedis.mockResolvedValue(null as never);

    const res = await fetch(`${baseUrl}/live?serviceType=redis`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.message).toMatch(/Redis/);
  });

  it('GET /history?serviceType=redis returns the history array', async () => {
    mockRedisHistory.mockResolvedValue([historyRow(), historyRow({ connectedClients: 8 })] as never);

    const res = await fetch(`${baseUrl}/history?serviceType=redis`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it('GET /stats?serviceType=redis returns totals24h shape', async () => {
    mockLiveRedis.mockResolvedValue(liveMetrics() as never);
    mockRedisHistory.mockResolvedValue([
      historyRow({
        totalCommandsProcessed: 1000,
        totalConnectionsReceived: 50,
        keyspaceHits: 100,
        keyspaceMisses: 10,
        evictedKeys: 1,
        expiredKeys: 2,
        rejectedConnections: 0,
        connectedClients: 5,
        memoryUsedBytes: 1024,
        reachable: true,
      }),
      historyRow({
        totalCommandsProcessed: 1500,
        totalConnectionsReceived: 80,
        keyspaceHits: 200,
        keyspaceMisses: 15,
        evictedKeys: 3,
        expiredKeys: 4,
        rejectedConnections: 1,
        connectedClients: 12,
        memoryUsedBytes: 2048,
        reachable: false,
      }),
    ] as never);

    const res = await fetch(`${baseUrl}/stats?serviceType=redis`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.serviceType).toBe('redis');
    expect(body.data.totals24h).toEqual({
      opsProcessed: 500,
      connectionsReceived: 30,
      keyspaceHits: 100,
      keyspaceMisses: 5,
      evictedKeys: 2,
      expiredKeys: 2,
      rejectedConnections: 1,
      peakConnectedClients: 12,
      peakMemoryUsedBytes: 2048,
      unreachableSamples: 1,
    });
    expect(body.data.live).toMatchObject({ reachable: true, connectedClients: 5 });
  });

  it('GET /raw?serviceType=redis returns text/plain', async () => {
    mockRawRedis.mockResolvedValue('# Server\nredis_version:7.0.0\n');

    const res = await fetch(`${baseUrl}/raw?serviceType=redis`);
    const text = await res.text();

    expect(mockRawRedis).toHaveBeenCalledWith('redis', undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(text).toContain('redis_version');
  });
});
