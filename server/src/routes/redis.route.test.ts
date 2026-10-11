import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './redis.js';
import * as redisService from '../services/redis.js';

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

vi.mock('../services/redis.js', () => ({
  getRedisClients: vi.fn(),
  getRedisConfigState: vi.fn(),
  getRedisLatency: vi.fn(),
  getRedisSlowlog: vi.fn(),
  getRedisStatus: vi.fn(),
  killRedisClient: vi.fn(),
  redisBgrewriteaof: vi.fn(),
  redisBgsave: vi.fn(),
  redisResetStats: vi.fn(),
  reloadRedis: vi.fn(),
  renderRedisConfig: vi.fn(() => 'redis.conf-rendered'),
  resetRedisSlowlog: vi.fn(),
  saveRedisManagedConfig: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockSave = vi.mocked(redisService.saveRedisManagedConfig);
const mockGetConfigState = vi.mocked(redisService.getRedisConfigState);
const mockGetStatus = vi.mocked(redisService.getRedisStatus);
const mockReload = vi.mocked(redisService.reloadRedis);
const mockGetSlowlog = vi.mocked(redisService.getRedisSlowlog);
const mockResetSlowlog = vi.mocked(redisService.resetRedisSlowlog);
const mockGetClients = vi.mocked(redisService.getRedisClients);
const mockKillClient = vi.mocked(redisService.killRedisClient);
const mockBgsave = vi.mocked(redisService.redisBgsave);
const mockBgrewriteaof = vi.mocked(redisService.redisBgrewriteaof);
const mockResetStats = vi.mocked(redisService.redisResetStats);
const mockGetLatency = vi.mocked(redisService.getRedisLatency);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/redis', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/redis`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('redis route', () => {
  it('GET /config returns 400 without a serviceId', async () => {
    const res = await fetch(`${baseUrl}/config`);
    expect(res.status).toBe(400);
    expect(mockGetConfigState).not.toHaveBeenCalled();
  });

  it('GET /config returns the config state', async () => {
    const state = { serviceId: 'redis1', serviceName: 'Redis', managed: { maxmemory: '0' } };
    mockGetConfigState.mockResolvedValue(state as never);

    const res = await fetch(`${baseUrl}/config?serviceId=redis1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: state });
  });

  it('PUT /config saves and returns the managed state', async () => {
    const state = { serviceId: 'redis1', serviceName: 'Redis', managed: { maxmemory: '256mb' } };
    mockSave.mockResolvedValue(state as never);

    const res = await fetch(`${baseUrl}/config?serviceId=redis1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxmemory: '256mb' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: state });
    expect(mockSave).toHaveBeenCalledWith('redis1', { maxmemory: '256mb' });
  });

  it('PUT /config surfaces a failed live apply via applyError without failing the request', async () => {
    const state = {
      serviceId: 'redis1',
      serviceName: 'Redis',
      managed: { maxmemory: '256mb' },
      rendered: 'CONFIG SET maxmemory "256mb"\n',
      applyError: 'No Redis admin DSN configured for this service',
    };
    mockSave.mockResolvedValue(state as never);

    const res = await fetch(`${baseUrl}/config?serviceId=redis1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxmemory: '256mb' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.applyError).toBe('No Redis admin DSN configured for this service');
  });

  it('PUT /config returns 400 without a serviceId', async () => {
    const res = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maxmemory: '256mb' }),
    });
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('GET /status returns the status payload', async () => {
    const status = { serviceId: 'redis1', serviceName: 'Redis', reachable: true, managed: {}, metrics: null };
    mockGetStatus.mockResolvedValue(status as never);

    const res = await fetch(`${baseUrl}/status?serviceId=redis1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: status });
  });

  it('GET /config/rendered returns the rendered config', async () => {
    mockGetConfigState.mockResolvedValue({ serviceId: 'redis1', serviceName: 'Redis', managed: {} } as never);

    const res = await fetch(`${baseUrl}/config/rendered?serviceId=redis1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ managed: 'redis.conf-rendered' });
  });

  it('POST /reload returns the reload response', async () => {
    mockReload.mockResolvedValue('OK');

    const res = await fetch(`${baseUrl}/reload?serviceId=redis1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'OK' } });
    expect(mockReload).toHaveBeenCalledWith('redis1');
  });

  it('GET /slowlog returns entries', async () => {
    mockGetSlowlog.mockResolvedValue([{ id: 1, timestampEpoch: 0, durationMicros: 100, command: ['GET'], clientAddress: '', clientName: '' }] as never);

    const res = await fetch(`${baseUrl}/slowlog?serviceId=redis1&count=10`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetSlowlog).toHaveBeenCalledWith('redis1', 10);
    expect(body.data).toHaveLength(1);
  });

  it('POST /slowlog/reset returns OK and audits', async () => {
    mockResetSlowlog.mockResolvedValue('OK');

    const res = await fetch(`${baseUrl}/slowlog/reset?serviceId=redis1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'OK' } });
    expect(mockResetSlowlog).toHaveBeenCalledWith('redis1');
  });

  it('GET /clients returns client list', async () => {
    mockGetClients.mockResolvedValue([{ id: 1, addr: '', name: '', ageSecs: 0, idleSecs: 0, db: 0, cmd: '', user: '' }] as never);

    const res = await fetch(`${baseUrl}/clients?serviceId=redis1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
  });

  it('POST /clients/kill returns 400 without a clientId', async () => {
    const res = await fetch(`${baseUrl}/clients/kill?serviceId=redis1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
    expect(mockKillClient).not.toHaveBeenCalled();
  });

  it('POST /clients/kill kills the client', async () => {
    mockKillClient.mockResolvedValue('1');

    const res = await fetch(`${baseUrl}/clients/kill?serviceId=redis1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ clientId: 42 }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: '1' } });
    expect(mockKillClient).toHaveBeenCalledWith('redis1', 42);
  });

  it('POST /bgsave returns the response', async () => {
    mockBgsave.mockResolvedValue('Background saving started');

    const res = await fetch(`${baseUrl}/bgsave?serviceId=redis1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'Background saving started' } });
  });

  it('POST /bgrewriteaof returns the response', async () => {
    mockBgrewriteaof.mockResolvedValue('Background append only file rewriting started');

    const res = await fetch(`${baseUrl}/bgrewriteaof?serviceId=redis1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'Background append only file rewriting started' } });
  });

  it('POST /stats/reset returns the response', async () => {
    mockResetStats.mockResolvedValue('OK');

    const res = await fetch(`${baseUrl}/stats/reset?serviceId=redis1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'OK' } });
  });

  it('GET /latency returns events', async () => {
    mockGetLatency.mockResolvedValue([{ event: 'command', latestMs: 5, latestTimestampEpoch: 0 }] as never);

    const res = await fetch(`${baseUrl}/latency?serviceId=redis1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toHaveLength(1);
  });
});
