import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './postgres.js';
import * as postgresService from '../services/postgres.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/audit.js', () => ({
  AuditActions: { CONFIG_UPDATE: 'config.update' },
  logAudit: vi.fn(async () => undefined),
}));

vi.mock('../services/postgres.js', () => ({
  analyzePostgres: vi.fn(),
  cancelPostgresBackend: vi.fn(),
  getPostgresActivity: vi.fn(),
  getPostgresConfigState: vi.fn(),
  getPostgresLocks: vi.fn(),
  getPostgresStatStatements: vi.fn(),
  getPostgresStatus: vi.fn(),
  getPostgresTableSizes: vi.fn(),
  reloadPostgres: vi.fn(),
  renderPostgresConfig: vi.fn(() => 'postgresql.conf-rendered'),
  resetPostgresStats: vi.fn(),
  savePostgresManagedConfig: vi.fn(),
  terminatePostgresBackend: vi.fn(),
  vacuumPostgres: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockSave = vi.mocked(postgresService.savePostgresManagedConfig);
const mockGetConfigState = vi.mocked(postgresService.getPostgresConfigState);
const mockGetStatus = vi.mocked(postgresService.getPostgresStatus);
const mockReload = vi.mocked(postgresService.reloadPostgres);
const mockGetActivity = vi.mocked(postgresService.getPostgresActivity);
const mockCancel = vi.mocked(postgresService.cancelPostgresBackend);
const mockTerminate = vi.mocked(postgresService.terminatePostgresBackend);
const mockGetLocks = vi.mocked(postgresService.getPostgresLocks);
const mockVacuum = vi.mocked(postgresService.vacuumPostgres);
const mockAnalyze = vi.mocked(postgresService.analyzePostgres);
const mockGetTableSizes = vi.mocked(postgresService.getPostgresTableSizes);
const mockGetStatStatements = vi.mocked(postgresService.getPostgresStatStatements);
const mockResetStats = vi.mocked(postgresService.resetPostgresStats);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/postgres', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/postgres`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('postgres route', () => {
  it('GET /config returns 400 without a serviceId', async () => {
    const res = await fetch(`${baseUrl}/config`);
    expect(res.status).toBe(400);
    expect(mockGetConfigState).not.toHaveBeenCalled();
  });

  it('GET /config returns the config state', async () => {
    const state = { serviceId: 'pg1', serviceName: 'Postgres', managed: { maxConnections: 100 } };
    mockGetConfigState.mockResolvedValue(state as never);

    const res = await fetch(`${baseUrl}/config?serviceId=pg1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: state });
  });

  it('PUT /config saves and returns the managed state', async () => {
    const state = { serviceId: 'pg1', serviceName: 'Postgres', managed: { maxConnections: 200 } };
    mockSave.mockResolvedValue(state as never);

    const res = await fetch(`${baseUrl}/config?serviceId=pg1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConnections: 200 }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: state });
    expect(mockSave).toHaveBeenCalledWith('pg1', { maxConnections: 200 });
  });

  it('PUT /config surfaces a failed live apply via applyError without failing the request', async () => {
    const state = {
      serviceId: 'pg1',
      serviceName: 'Postgres',
      managed: { maxConnections: 200 },
      rendered: "ALTER SYSTEM SET max_connections = '200';\n",
      applyError: 'No Postgres admin DSN configured for this service',
    };
    mockSave.mockResolvedValue(state as never);

    const res = await fetch(`${baseUrl}/config?serviceId=pg1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConnections: 200 }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.applyError).toBe('No Postgres admin DSN configured for this service');
  });

  it('PUT /config returns 400 without a serviceId', async () => {
    const res = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxConnections: 200 }),
    });
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('GET /status returns the status payload', async () => {
    const status = { serviceId: 'pg1', serviceName: 'Postgres', reachable: true, managed: {}, metrics: null };
    mockGetStatus.mockResolvedValue(status as never);

    const res = await fetch(`${baseUrl}/status?serviceId=pg1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: status });
  });

  it('GET /config/rendered returns the rendered config', async () => {
    mockGetConfigState.mockResolvedValue({ serviceId: 'pg1', serviceName: 'Postgres', managed: {} } as never);

    const res = await fetch(`${baseUrl}/config/rendered?serviceId=pg1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ managed: 'postgresql.conf-rendered' });
  });

  it('POST /reload returns the reload response', async () => {
    mockReload.mockResolvedValue('Configuration reload signal sent');

    const res = await fetch(`${baseUrl}/reload?serviceId=pg1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'Configuration reload signal sent' } });
    expect(mockReload).toHaveBeenCalledWith('pg1');
  });

  it('GET /activity returns rows', async () => {
    mockGetActivity.mockResolvedValue([{ pid: 1, usename: 'robin', state: 'active', waitEventType: null, waitEvent: null, query: 'SELECT 1', ageSecs: 1 }] as never);

    const res = await fetch(`${baseUrl}/activity?serviceId=pg1&limit=10`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetActivity).toHaveBeenCalledWith('pg1', 10);
    expect(body.data).toHaveLength(1);
  });

  it('POST /activity/cancel returns 400 without a pid', async () => {
    const res = await fetch(`${baseUrl}/activity/cancel?serviceId=pg1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('POST /activity/cancel cancels the backend', async () => {
    mockCancel.mockResolvedValue(true);

    const res = await fetch(`${baseUrl}/activity/cancel?serviceId=pg1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: 123 }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { cancelled: true } });
    expect(mockCancel).toHaveBeenCalledWith('pg1', 123);
  });

  it('POST /activity/terminate terminates the backend', async () => {
    mockTerminate.mockResolvedValue(true);

    const res = await fetch(`${baseUrl}/activity/terminate?serviceId=pg1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ pid: 123 }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { terminated: true } });
    expect(mockTerminate).toHaveBeenCalledWith('pg1', 123);
  });

  it('GET /locks returns rows', async () => {
    mockGetLocks.mockResolvedValue([{ pid: 1, relation: 'orders', mode: 'AccessShareLock', granted: true, blockedByPids: [] }] as never);

    const res = await fetch(`${baseUrl}/locks?serviceId=pg1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
  });

  it('POST /vacuum returns the response', async () => {
    mockVacuum.mockResolvedValue('VACUUM completed');

    const res = await fetch(`${baseUrl}/vacuum?serviceId=pg1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'orders', analyze: true }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'VACUUM completed' } });
    expect(mockVacuum).toHaveBeenCalledWith('pg1', { table: 'orders', analyze: true });
  });

  it('POST /analyze returns the response', async () => {
    mockAnalyze.mockResolvedValue('ANALYZE completed');

    const res = await fetch(`${baseUrl}/analyze?serviceId=pg1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ table: 'orders' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'ANALYZE completed' } });
    expect(mockAnalyze).toHaveBeenCalledWith('pg1', { table: 'orders' });
  });

  it('GET /tables returns rows', async () => {
    mockGetTableSizes.mockResolvedValue([{ schema: 'public', table: 'orders', totalBytes: 1024 }] as never);

    const res = await fetch(`${baseUrl}/tables?serviceId=pg1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
  });

  it('GET /statements returns the statements result', async () => {
    mockGetStatStatements.mockResolvedValue({ available: true, rows: [] } as never);

    const res = await fetch(`${baseUrl}/statements?serviceId=pg1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ available: true, rows: [] });
  });

  it('POST /stats/reset returns the response', async () => {
    mockResetStats.mockResolvedValue('Statistics reset');

    const res = await fetch(`${baseUrl}/stats/reset?serviceId=pg1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'Statistics reset' } });
  });
});
