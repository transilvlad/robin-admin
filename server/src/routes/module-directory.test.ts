import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import router from './module-directory.js';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import { getModuleHostPolicy } from '../services/module-host-policy.js';
vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn(async () => ({ modulesEnabled: true })) }));
vi.mock('../services/modules.js', () => ({ assertModuleRuntimeAccess: vi.fn(async () => ({})) }));
vi.mock('../services/module-host-policy.js', () => ({ getModuleHostPolicy: vi.fn() }));
let server: Server;
let url: string;
const secret = 'directory-test-secret';
const uid = 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4';
beforeAll(async () => {
  config.moduleProxySecrets.example = secret;
  const app = express(); app.use('/api/module-host', router);
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/module-host/example`;
});
afterAll(async () => { delete config.moduleProxySecrets.example; await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getModuleHostPolicy).mockResolvedValue({ slug: 'example', directoryRead: true, lifecycleRead: false, maxBodyMiB: 5, timeoutSeconds: 30 });
  vi.mocked(query).mockResolvedValue({ rows: [{ uid, name: 'Admin', email: 'admin@example.test', role: 'admin', disabled: false }], rowCount: 1 } as never);
});
const get = (path: string, authenticated = true) => fetch(url + path, { headers: authenticated ? { 'x-robin-module-secret': secret } : { cookie: 'robin.admin.sid=fake', authorization: 'Bearer fake' } });
it('rejects session/API credentials and does not query account data', async () => {
  expect((await get('/admins', false)).status).toBe(401); expect(query).not.toHaveBeenCalled();
});
it('requires independently approved directory and lifecycle capabilities', async () => {
  expect((await get('/events')).status).toBe(403);
  vi.mocked(getModuleHostPolicy).mockResolvedValue({ slug: 'example', directoryRead: false, lifecycleRead: true, maxBodyMiB: 5, timeoutSeconds: 30 });
  expect((await get('/admins')).status).toBe(403);
  expect((await get('/events?after=0')).status).toBe(200);
});
it('returns only directory fields with no-store', async () => {
  const response = await get('/admins?search=admin&limit=20');
  expect(response.status).toBe(200); expect(response.headers.get('cache-control')).toBe('no-store');
  expect(await response.json()).toMatchObject({ data: [{ uid, name: 'Admin', disabled: false }], nextCursor: uid });
  expect(vi.mocked(query).mock.calls[0][0]).not.toContain('password');
});
it.each(['/admins?limit=0', '/admins?limit=201', '/admins?after=invalid', '/admins/invalid', '/events?after=9223372036854775808'])('rejects invalid query %s', async path => {
  vi.mocked(getModuleHostPolicy).mockResolvedValue({ slug: 'example', directoryRead: true, lifecycleRead: true, maxBodyMiB: 5, timeoutSeconds: 30 });
  expect((await get(path)).status).toBe(400); expect(query).not.toHaveBeenCalled();
});
