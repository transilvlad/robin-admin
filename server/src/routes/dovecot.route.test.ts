import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './dovecot.js';
import * as dovecotService from '../services/dovecot.js';

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

vi.mock('../db/queries/fleet-services.js', () => ({
  getFleetServiceById: vi.fn(),
}));

vi.mock('../services/dovecot.js', () => ({
  getDovecotCapabilities: vi.fn(),
  getDovecotConfigState: vi.fn(),
  getDovecotQuota: vi.fn(),
  kickDovecotUser: vi.fn(),
  listDovecotSessions: vi.fn(),
  lookupDovecotUser: vi.fn(),
  reloadDovecot: vi.fn(),
  renderDovecotConfig: vi.fn(() => 'dovecot-conf-rendered'),
  saveDovecotManagedConfig: vi.fn(),
  withDetectedDovecotVersion: vi.fn((managed: unknown) => managed),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockSave = vi.mocked(dovecotService.saveDovecotManagedConfig);
const mockLookup = vi.mocked(dovecotService.lookupDovecotUser);
const mockQuota = vi.mocked(dovecotService.getDovecotQuota);
const mockKick = vi.mocked(dovecotService.kickDovecotUser);
const mockGetConfigState = vi.mocked(dovecotService.getDovecotConfigState);
const mockReload = vi.mocked(dovecotService.reloadDovecot);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/dovecot', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/dovecot`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('dovecot route', () => {
  it('PUT /config saves and returns the managed state', async () => {
    const state = { serviceId: 'dc1', serviceName: 'Dovecot', managed: { protocols: 'imap lmtp' } };
    mockSave.mockResolvedValue(state as never);

    const res = await fetch(`${baseUrl}/config?serviceId=dc1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocols: 'imap lmtp' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: state });
    expect(mockSave).toHaveBeenCalledWith('dc1', { protocols: 'imap lmtp' });
  });

  it('PUT /config returns 400 without a serviceId', async () => {
    const res = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ protocols: 'imap' }),
    });
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('GET /config/rendered returns the rendered conf', async () => {
    mockGetConfigState.mockResolvedValue({ serviceId: 'dc1', serviceName: 'Dovecot', managed: {} } as never);

    const res = await fetch(`${baseUrl}/config/rendered?serviceId=dc1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ managed: 'dovecot-conf-rendered' });
  });

  it('POST /reload returns the reload response', async () => {
    mockReload.mockResolvedValue('reload ok');

    const res = await fetch(`${baseUrl}/reload?serviceId=dc1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'reload ok' } });
    expect(mockReload).toHaveBeenCalledWith('dc1');
  });

  it('GET /users/:user combines the userdb record with quota, skipping quota for unknown users', async () => {
    mockLookup.mockResolvedValueOnce({ home: '/var/mail/alice' });
    mockQuota.mockResolvedValueOnce({ available: false, reason: 'plugin disabled', rows: [] });
    const found = await (await fetch(`${baseUrl}/users/alice%40example.com?serviceId=dc1`)).json();
    expect(found.data).toEqual({
      user: 'alice@example.com', exists: true, fields: { home: '/var/mail/alice' },
      quota: { available: false, reason: 'plugin disabled', rows: [] },
    });
    expect(mockQuota).toHaveBeenCalledWith('dc1', 'alice@example.com');

    mockLookup.mockResolvedValueOnce(null);
    const missing = await (await fetch(`${baseUrl}/users/nobody?serviceId=dc1`)).json();
    expect(missing.data).toEqual({ user: 'nobody', exists: false, fields: {}, quota: null });
  });

  it('POST /sessions/kick requires a user', async () => {
    const kick = (body: unknown) => fetch(`${baseUrl}/sessions/kick?serviceId=dc1`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    expect((await kick({})).status).toBe(400);
    mockKick.mockResolvedValue('kicked 2 connections');
    expect(await (await kick({ user: 'alice@example.com' })).json()).toEqual({ success: true, data: { response: 'kicked 2 connections' } });
  });
});
