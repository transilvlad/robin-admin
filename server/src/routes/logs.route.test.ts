import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './logs.js';
import * as serviceLogs from '../services/service-logs.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// logs route gates on requireAdmin.
vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// service-types.js is NOT mocked — the real parseServiceType drives validation.
vi.mock('../services/service-logs.js', () => ({
  getServiceLogs: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockGetServiceLogs = vi.mocked(serviceLogs.getServiceLogs);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/logs', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/logs`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('logs route', () => {
  it('GET / returns the logs payload for a co-located service', async () => {
    const payload = {
      available: true,
      source: 'journalctl -u postfix',
      lines: ['2026-01-01 postfix/smtpd: connect'],
    };
    mockGetServiceLogs.mockResolvedValue(payload as never);

    const res = await fetch(`${baseUrl}/?serviceType=postfix&serviceId=s1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: payload });
    expect(mockGetServiceLogs).toHaveBeenCalledWith('postfix', 's1', expect.any(Number));
  });

  it('GET / returns 400 when serviceId is missing', async () => {
    const res = await fetch(`${baseUrl}/?serviceType=postfix`);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/serviceId/);
    expect(mockGetServiceLogs).not.toHaveBeenCalled();
  });

  it('GET / returns 400 for an invalid serviceType', async () => {
    const res = await fetch(`${baseUrl}/?serviceType=bogus&serviceId=s1`);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error).toMatch(/serviceType/);
    expect(mockGetServiceLogs).not.toHaveBeenCalled();
  });
});
