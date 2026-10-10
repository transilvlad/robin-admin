import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import router, { moduleAssetRoutes } from './module-backends.js';

const mocks = vi.hoisted(() => ({ runtime: vi.fn(), sign: vi.fn<(...args: unknown[]) => Promise<string>>(async () => 'signed-identity') }));
vi.mock('../config.js', () => ({ config: { moduleProxySecrets: { 'example-module': 'test-module-secret' } } }));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  getCurrentAdmin: () => ({ adminId: 1, uid: 'test-user', role: 'admin', email: 'admin@example.test', name: 'Admin' }),
}));
vi.mock('../middleware/rbac.js', () => ({ requireViewer: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../services/module-identity.js', () => ({ signModuleIdentity: mocks.sign }));
vi.mock('../services/module-host-policy.js', () => ({ getModuleHostPolicy: async () => ({ timeoutSeconds: 5 }) }));
vi.mock('../services/modules.js', () => ({
  assertModuleRuntimeAccess: mocks.runtime,
  getLocalInstanceFingerprint: async () => 'test-instance',
  ModuleAccessError: class extends Error { constructor(message: string, public status = 403) { super(message); } },
}));

let upstream: Server;
let server: Server;
let target: string;
let base: string;
const requests: Array<{ path: string; secret: string | undefined; identity: string | undefined; cookie: string | undefined }> = [];
const address = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
const listening = (s: Server) => new Promise<void>(resolve => s.once('listening', resolve));
const close = (s: Server) => new Promise<void>((resolve, reject) => s.close(error => error ? reject(error) : resolve()));

beforeAll(async () => {
  const remote = express();
  remote.use((req, res) => {
    requests.push({ path: req.originalUrl, secret: req.get('x-robin-module-secret'), identity: req.get('x-robin-module-identity'), cookie: req.get('cookie') });
    if (req.originalUrl.endsWith('/large.bin')) {
      res.setHeader('content-length', String(26 * 1024 * 1024));
      res.end();
      return;
    }
    res.setHeader('cache-control', 'public, max-age=3600');
    res.send('module response');
  });
  upstream = remote.listen(0, '127.0.0.1');
  await listening(upstream);
  target = address(upstream);
  const app = express();
  app.use('/api/modules', router);
  app.use('/modules', moduleAssetRoutes);
  app.use((_req, res) => res.send('Admin SPA'));
  server = app.listen(0, '127.0.0.1');
  await listening(server);
  base = address(server);
});
afterAll(async () => { await close(server); await close(upstream); });
beforeEach(() => { vi.clearAllMocks(); requests.length = 0; mocks.runtime.mockResolvedValue({ backendUrl: `${target}/module`, assetBaseUrl: target }); });

it('proxies an arbitrary module using stored backend and asset targets', async () => {
  const response = await fetch(`${base}/api/modules/example-module/users?limit=5`, { headers: { cookie: 'session-secret' } });
  expect(response.status).toBe(200);
  expect(requests[0]).toEqual({ path: '/module/users?limit=5', secret: 'test-module-secret', identity: 'signed-identity', cookie: undefined });
  expect(mocks.sign.mock.calls[0][4]).toBe('/module/users?limit=5');
  const asset = await fetch(`${base}/modules/example-module/remoteEntry.js`);
  expect(asset.status).toBe(200);
  expect(asset.headers.get('cache-control')).toBe('private, no-store');
  expect(requests[1].path).toBe('/modules/example-module/remoteEntry.js');
  expect(requests[1].secret).toBeUndefined();
  expect(await (await fetch(`${base}/modules/example-module/settings`)).text()).toBe('Admin SPA');
});

it('does not manufacture first-party targets for incomplete stored installs', async () => {
  mocks.runtime.mockResolvedValue({ backendUrl: null, assetBaseUrl: null });
  expect((await fetch(`${base}/api/modules/robin-tools/users`)).status).toBe(404);
  expect((await fetch(`${base}/modules/robin-qa/remoteEntry.js`)).status).toBe(404);
  expect(requests).toEqual([]);
});

it('serves frontend-only modules without a backend target or credential', async () => {
  mocks.runtime.mockResolvedValue({ backendUrl: null, assetBaseUrl: target });
  expect((await fetch(`${base}/modules/frontend-only/remoteEntry.js`)).status).toBe(200);
  expect((await fetch(`${base}/api/modules/frontend-only/users`)).status).toBe(404);
  expect(requests).toHaveLength(1);
});

it('rejects oversized module asset responses before buffering them', async () => {
  const response = await fetch(`${base}/modules/example-module/large.bin`);

  expect(response.status).toBe(502);
  expect(await response.json()).toMatchObject({ success: false, error: 'Module response is too large.' });
});
