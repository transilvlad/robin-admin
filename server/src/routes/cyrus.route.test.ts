import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './cyrus.js';
import { getCyrusQuota, listCyrusSessions, lookupCyrusUser } from '../services/cyrus.js';

vi.mock('../services/cyrus.js', () => ({ getCyrusQuota: vi.fn(), listCyrusSessions: vi.fn(), lookupCyrusUser: vi.fn() }));
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use((req, _res, next) => {
    const role = req.headers['x-test-role'];
    if (role === 'admin' || role === 'viewer') req.session = { admin: { id: 1, uid: 'test', name: 'Test', email: 'test@example.com', role } } as never;
    next();
  });
  app.use('/api/cyrus', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/cyrus`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); });
beforeEach(() => vi.resetAllMocks());
const headers = { 'x-test-role': 'admin' };

describe('Cyrus routes', () => {
  it('requires authentication and administrator privileges on every operational endpoint', async () => {
    for (const endpoint of ['sessions', 'quota', 'users/happy']) {
      expect((await fetch(`${base}/${endpoint}?serviceId=imap`)).status).toBe(401);
      expect((await fetch(`${base}/${endpoint}?serviceId=imap`, { headers: { 'x-test-role': 'viewer' } })).status).toBe(403);
    }
    expect(listCyrusSessions).not.toHaveBeenCalled();
  });
  it('requires a service ID and returns process rows', async () => {
    expect((await fetch(`${base}/sessions`, { headers })).status).toBe(400);
    vi.mocked(listCyrusSessions).mockResolvedValue([]);
    expect(await (await fetch(`${base}/sessions?serviceId=imap`, { headers })).json()).toEqual({ success: true, data: [] });
    expect(listCyrusSessions).toHaveBeenCalledWith('imap');
  });
  it('returns all or per-user quota', async () => {
    vi.mocked(getCyrusQuota).mockResolvedValue({ available: true, reason: null, rows: [] });
    expect((await fetch(`${base}/quota?serviceId=imap&user=happy%40example.com`, { headers })).status).toBe(200);
    expect(getCyrusQuota).toHaveBeenCalledWith('imap', 'happy@example.com');
  });
  it('combines mailbox paths with quota and handles nonexistent users', async () => {
    vi.mocked(lookupCyrusUser).mockResolvedValueOnce({ path: '/mail/happy' }).mockResolvedValueOnce(null);
    vi.mocked(getCyrusQuota).mockResolvedValue({ available: true, reason: null, rows: [] });
    const response = await fetch(`${base}/users/happy%40example.com?serviceId=imap`, { headers });
    expect((await response.json()).data).toMatchObject({ user: 'happy@example.com', exists: true, fields: { path: '/mail/happy' }, quota: { rows: [] } });
    vi.mocked(getCyrusQuota).mockClear();
    expect((await (await fetch(`${base}/users/nobody?serviceId=imap`, { headers })).json()).data).toMatchObject({ exists: false, quota: null });
    expect(getCyrusQuota).not.toHaveBeenCalled();
  });
  it('does not expose configuration or disconnect endpoints and reports operational failures', async () => {
    expect((await fetch(`${base}/config`, { headers })).status).toBe(404);
    expect((await fetch(`${base}/sessions/kick`, { method: 'POST', headers })).status).toBe(404);
    vi.mocked(listCyrusSessions).mockRejectedValue(new Error('No metrics agent'));
    expect((await fetch(`${base}/sessions?serviceId=imap`, { headers })).status).toBe(400);
  });
});
