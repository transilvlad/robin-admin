import express from 'express';
import { beforeAll, afterAll, beforeEach, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
vi.mock('../services/telemetry/connection.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/telemetry/connection.js')>();
  return { ...actual, getStoreConnection: vi.fn(), saveStoreConnection: vi.fn() };
});
vi.mock('../services/telemetry/store-client.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/telemetry/store-client.js')>();
  return { ...actual, checkTelemetryStore: vi.fn() };
});
vi.mock('../services/telemetry/snapshots.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../services/telemetry/snapshots.js')>();
  return { ...actual, listSnapshots: vi.fn(), createSnapshot: vi.fn(), deleteSnapshot: vi.fn() };
});
vi.mock('../middleware/audit.js', () => ({ AuditActions: { CONFIG_UPDATE: 'config.update' }, logAudit: vi.fn() }));
import router from './telemetry-settings.js';
import { getStoreConnection, publicConnection, saveStoreConnection } from '../services/telemetry/connection.js';
import { checkTelemetryStore } from '../services/telemetry/store-client.js';
import { createSnapshot, deleteSnapshot, listSnapshots, SnapshotUnavailableError } from '../services/telemetry/snapshots.js';
import { logAudit } from '../middleware/audit.js';
const connection = { revision: 'one', mode: 'disabled' as const, url: '', auth: 'none' as const, username: '', encryptedSecret: '', allowPrivate: false };
let server: Server;
let base: string;
beforeAll(async () => {
  const app = express(); app.use(express.json());
  app.use((req, _res, next) => { const role = req.get('x-fixture-role'); if (role) req.session = { admin: { id: 1, email: 'fixture@test', name: 'fixture', role } } as never; next(); });
  app.use('/api/config/telemetry', router);
  server = app.listen(0); await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/config/telemetry`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
beforeEach(() => {
  vi.clearAllMocks(); vi.mocked(getStoreConnection).mockResolvedValue(connection);
  vi.mocked(saveStoreConnection).mockImplementation(async value => publicConnection(value));
  vi.mocked(checkTelemetryStore).mockResolvedValue();
});
function post(path: string, value: unknown, role = 'admin') { return fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-fixture-role': role }, body: JSON.stringify(value) }); }
it('protects all settings from unauthenticated and non-admin users', async () => {
  for (const path of ['/connection', '/storage/snapshots']) {
    expect((await fetch(`${base}${path}`)).status).toBe(401);
    expect((await fetch(`${base}${path}`, { headers: { 'x-fixture-role': 'viewer' } })).status).toBe(403);
  }
  expect((await post('/connection/save', {}, 'editor')).status).toBe(403);
  expect((await post('/storage/snapshots', {}, 'editor')).status).toBe(403);
  expect(createSnapshot).not.toHaveBeenCalled(); expect(saveStoreConnection).not.toHaveBeenCalled();
});
it('returns only redacted connection metadata and tests without saving', async () => {
  expect(await (await fetch(`${base}/connection`, { headers: { 'x-fixture-role': 'admin' } })).json()).toEqual({ success: true, data: publicConnection(connection) });
  const update = { ...publicConnection(connection), mode: 'bundled' }; delete (update as Partial<typeof update>).secretConfigured;
  expect((await post('/connection/test', update)).status).toBe(200);
  expect(checkTelemetryStore).toHaveBeenCalled(); expect(saveStoreConnection).not.toHaveBeenCalled(); expect(logAudit).not.toHaveBeenCalled();
});
it('returns stale-edit conflicts and audits successful saves without URL or credentials', async () => {
  vi.stubEnv('ROBIN_ADMIN_ENCRYPTION_KEY', 'fixture-only-secret-encryption-key-32');
  const update = { revision: 'one', mode: 'external', url: 'https://fixture.test', auth: 'bearer', username: '', secret: 'fixture-credential', allowPrivate: false };
  expect((await post('/connection/save', { ...update, revision: 'stale' })).status).toBe(409);
  expect((await post('/connection/save', update)).status).toBe(200);
  const audit = JSON.stringify(vi.mocked(logAudit).mock.calls.map(call => call[2]));
  expect(audit).not.toContain('fixture-credential');
  expect(audit).not.toContain('https://fixture.test');
});
it('creates, lists and deletes snapshots with an audit trail', async () => {
  const snapshot = { name: '20261007081055-18DC310563C98334', createdAt: '2026-10-07T08:10:55Z' };
  vi.mocked(createSnapshot).mockResolvedValueOnce(snapshot);
  vi.mocked(listSnapshots).mockResolvedValueOnce([snapshot]);
  vi.mocked(deleteSnapshot).mockResolvedValueOnce();
  const created = await post('/storage/snapshots', {});
  expect(created.status).toBe(201);
  expect((await created.json()).data).toEqual(snapshot);
  expect((await (await fetch(`${base}/storage/snapshots`, { headers: { 'x-fixture-role': 'admin' } })).json()).data).toEqual([snapshot]);
  expect((await fetch(`${base}/storage/snapshots/${snapshot.name}`, { method: 'DELETE', headers: { 'x-fixture-role': 'admin' } })).status).toBe(200);
  expect(deleteSnapshot).toHaveBeenCalledWith(snapshot.name);
  expect(vi.mocked(logAudit).mock.calls.map(call => call[2])).toEqual([
    { entityType: 'telemetry-snapshot', entityId: snapshot.name, newValues: { action: 'create' } },
    { entityType: 'telemetry-snapshot', entityId: snapshot.name, newValues: { action: 'delete' } },
  ]);
});
it('maps snapshot failures to client errors', async () => {
  vi.mocked(createSnapshot).mockRejectedValueOnce(new SnapshotUnavailableError('Snapshots are available for the bundled store only'));
  const refused = await post('/storage/snapshots', {});
  expect(refused.status).toBe(409);
  expect((await refused.json()).error).toBe('Snapshots are available for the bundled store only');
  vi.mocked(deleteSnapshot).mockRejectedValueOnce(new RangeError('Invalid snapshot name'));
  expect((await fetch(`${base}/storage/snapshots/bad`, { method: 'DELETE', headers: { 'x-fixture-role': 'admin' } })).status).toBe(400);
  expect(logAudit).not.toHaveBeenCalled();
});
