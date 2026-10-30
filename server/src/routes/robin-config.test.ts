import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRobinConfigStatus, reloadRobinConfig } from '../services/robin-api.js';
import { logAudit } from '../middleware/audit.js';
import router from './robin-config.js';

vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../middleware/audit.js', () => ({ logAudit: vi.fn(), AuditActions: { CONFIG_UPDATE: 'config.update' } }));
vi.mock('../services/robin-api.js', async original => ({
  ...await original<typeof import('../services/robin-api.js')>(), reloadRobinConfig: vi.fn(), getRobinConfigStatus: vi.fn(),
}));
let server: Server;
let base: string;
let role = 'admin';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { session: { admin: { id: 1, role } } }); next(); });
  app.use('/config', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/config`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); });
beforeEach(() => { vi.clearAllMocks(); role = 'admin'; });
const reload = (body: object) => fetch(`${base}/reload`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

describe('honest runtime configuration application', () => {
  it('rejects configuration server IDs as ambiguous management targets', async () => {
    expect((await reload({ serverId: 'node-1' })).status).toBe(400);
    expect((await reload({ serviceId: ['node-1'] })).status).toBe(400);
    expect(reloadRobinConfig).not.toHaveBeenCalled();
  });

  it('requires explicit application confirmation, even for an HTTP 200 response', async () => {
    vi.mocked(reloadRobinConfig).mockResolvedValueOnce({ ok: true, status: 200, body: { status: 'success' }, url: 'http://fixture/config/reload' });
    const response = await reload({ serviceId: 'fleet-west' });
    expect(response.status).toBe(502);
    expect((await response.json()).data.applied).toBe(false);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'config.update', expect.objectContaining({ entityId: 'fleet-west', newValues: expect.objectContaining({ applied: false }) }));
  });

  it('preserves restart-needed and snapshot-only scope without claiming live reconstruction', async () => {
    const body = { status: 'success', applied: true, scope: 'configuration-snapshot', restartRequired: true, restartRequiredComponents: ['listeners'], failed: [] };
    vi.mocked(reloadRobinConfig).mockResolvedValueOnce({ ok: true, status: 200, body, url: 'http://fixture/config/reload' });
    const response = await reload({ serviceId: 'fleet-west' });
    expect(response.status).toBe(200);
    expect((await response.json()).data).toEqual(body);
    expect(reloadRobinConfig).toHaveBeenCalledWith('fleet-west');
  });

  it('does not accept applied:true on a failed HTTP response', async () => {
    vi.mocked(reloadRobinConfig).mockResolvedValueOnce({ ok: false, status: 500, body: { applied: true }, url: 'http://fixture/config/reload' });
    expect((await reload({})).status).toBe(502);
  });

  it('reads runtime state from the selected process rather than database contents', async () => {
    const body = { manualReloadAvailable: true, loaded: { 'server.json5': 'hash-only' } };
    vi.mocked(getRobinConfigStatus).mockResolvedValueOnce({ ok: true, status: 200, body, url: 'http://fixture/config/status' });
    const response = await fetch(`${base}/runtime-status?serviceId=fleet-west`);
    expect((await response.json()).data).toEqual(body);
    expect(getRobinConfigStatus).toHaveBeenCalledWith('fleet-west');
  });

  it('requires admin role for readback and reload', async () => {
    role = 'editor';
    expect((await reload({})).status).toBe(403);
    expect((await fetch(`${base}/runtime-status`)).status).toBe(403);
    expect(reloadRobinConfig).not.toHaveBeenCalled();
    expect(getRobinConfigStatus).not.toHaveBeenCalled();
  });
});
