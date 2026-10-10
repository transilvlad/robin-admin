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

const mockLivePostgres = vi.mocked(poller.getLivePostgresMetrics);
const mockPostgresHistory = vi.mocked(poller.getPostgresMetricsHistory);
const mockRawPostgres = vi.mocked(poller.getRawServiceMetrics);

function liveMetrics(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: 'pg1',
    serviceType: 'postgres',
    timestamp: new Date(),
    reachable: true,
    serverVersionNum: 160001,
    connectionsTotal: 10,
    connectionsActive: 3,
    connectionsIdle: 6,
    connectionsIdleInTxn: 1,
    connectionsWaiting: 0,
    maxConnections: 100,
    connectionSaturationPct: 10,
    xactCommit: 500,
    xactRollback: 5,
    commitRatio: 0.99,
    blksHit: 1000,
    blksRead: 10,
    cacheHitRatio: 0.99,
    tupReturned: 0,
    tupFetched: 0,
    tupInserted: 100,
    tupUpdated: 50,
    tupDeleted: 10,
    deadlocks: 0,
    tempFiles: 0,
    tempBytes: 0,
    conflicts: 0,
    databaseSizeBytes: 1048576,
    oldestXactAgeSecs: 0,
    oldestIdleInTxnSecs: 0,
    blockedQueries: 0,
    checkpointsTimed: 0,
    checkpointsReq: 0,
    buffersCheckpoint: 0,
    replicationLagBytes: 0,
    deadTuplesTotal: 0,
    rawStats: '',
    ...overrides,
  };
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    connectionsTotal: 10,
    connectionSaturationPct: 10,
    xactCommit: 500,
    xactRollback: 5,
    tupInserted: 100,
    tupUpdated: 50,
    tupDeleted: 10,
    deadlocks: 0,
    tempFiles: 0,
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

describe('metrics route (postgres)', () => {
  it('GET /live?serviceType=postgres returns the live metrics payload', async () => {
    mockLivePostgres.mockResolvedValue(liveMetrics() as never);

    const res = await fetch(`${baseUrl}/live?serviceType=postgres`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      serviceType: 'postgres',
      reachable: true,
      connectionsActive: 3,
      databaseSizeBytes: 1048576,
    });
  });

  it('GET /live returns data:null with a message when the endpoint is unavailable', async () => {
    mockLivePostgres.mockResolvedValue(null as never);

    const res = await fetch(`${baseUrl}/live?serviceType=postgres`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.message).toMatch(/Postgres/);
  });

  it('GET /history?serviceType=postgres returns the history array', async () => {
    mockPostgresHistory.mockResolvedValue([historyRow(), historyRow({ connectionsTotal: 20 })] as never);

    const res = await fetch(`${baseUrl}/history?serviceType=postgres`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it('GET /stats?serviceType=postgres returns totals24h shape', async () => {
    mockLivePostgres.mockResolvedValue(liveMetrics() as never);
    mockPostgresHistory.mockResolvedValue([
      historyRow({
        xactCommit: 500,
        xactRollback: 5,
        tupInserted: 100,
        tupUpdated: 50,
        tupDeleted: 10,
        deadlocks: 0,
        tempFiles: 0,
        connectionsTotal: 10,
        connectionSaturationPct: 10,
        reachable: true,
      }),
      historyRow({
        xactCommit: 900,
        xactRollback: 8,
        tupInserted: 180,
        tupUpdated: 90,
        tupDeleted: 15,
        deadlocks: 1,
        tempFiles: 2,
        tempBytes: 0,
        connectionsTotal: 25,
        connectionSaturationPct: 25,
        reachable: false,
      }),
    ] as never);

    const res = await fetch(`${baseUrl}/stats?serviceType=postgres`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.serviceType).toBe('postgres');
    expect(body.data.totals24h).toEqual({
      xactCommit: 400,
      xactRollback: 3,
      tupInserted: 80,
      tupUpdated: 40,
      tupDeleted: 5,
      deadlocks: 1,
      tempFiles: 2,
      tempBytes: 0,
      peakConnectionsTotal: 25,
      peakConnectionSaturationPct: 25,
      unreachableSamples: 1,
    });
    expect(body.data.live).toMatchObject({ reachable: true, connectionsActive: 3 });
  });

  it('GET /raw?serviceType=postgres returns text/plain', async () => {
    mockRawPostgres.mockResolvedValue('datname|xact_commit\npostgres|500\n');

    const res = await fetch(`${baseUrl}/raw?serviceType=postgres`);
    const text = await res.text();

    expect(mockRawPostgres).toHaveBeenCalledWith('postgres', undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(text).toContain('xact_commit');
  });
});
