import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import { databaseReady } from './health.js';
import { pool } from '../db/connection.js';
import healthRoutes from './health.js';
import { getHeartbeatHealth } from '../services/monitoring/heartbeat.js';

vi.mock('../db/connection.js', () => ({
  pool: { query: vi.fn() },
}));
vi.mock('../services/monitoring/heartbeat.js', () => ({
  getHeartbeatHealth: vi.fn(),
}));

const queryMock = vi.mocked(pool.query);
const heartbeatMock = vi.mocked(getHeartbeatHealth);

describe('health routes', () => {
  let server: Server;
  let url: string;
  beforeEach(async () => {
    vi.clearAllMocks();
    const app = express();
    app.use(healthRoutes);
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Health test server failed to bind');
    url = `http://127.0.0.1:${address.port}`;
  });

  afterEach(async () => {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });

  it('reports ready when PostgreSQL responds', async () => {
    queryMock.mockResolvedValue({} as never);
    await expect(databaseReady()).resolves.toBe(true);
    expect(queryMock).toHaveBeenCalledWith('SELECT 1');
  });

  it('reports unavailable when PostgreSQL fails', async () => {
    queryMock.mockRejectedValue(new Error('offline'));
    await expect(databaseReady()).resolves.toBe(false);
  });

  it('serves the cached healthy verdict as a public single-word response', async () => {
    heartbeatMock.mockResolvedValue({ healthy: true, reason: null, checkedAt: Date.now() });
    const response = await fetch(`${url}/monitoring`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('ok');
    expect(heartbeatMock).toHaveBeenCalledOnce();
  });

  it('serves an unhealthy verdict without exposing its reason', async () => {
    heartbeatMock.mockResolvedValue({ healthy: false, reason: 'database', checkedAt: Date.now() });
    const response = await fetch(`${url}/monitoring`);
    expect(response.status).toBe(503);
    expect(await response.text()).toBe('unhealthy');
  });
});
