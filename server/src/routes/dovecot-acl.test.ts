import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DovecotAclError, manageDovecotAcl } from '../services/dovecot.js';
import { logAudit } from '../middleware/audit.js';
import router from './dovecot.js';

vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../middleware/audit.js', () => ({ logAudit: vi.fn(), AuditActions: { CONFIG_UPDATE: 'config.update' } }));
vi.mock('../services/dovecot.js', async (original) => ({
  ...await original<typeof import('../services/dovecot.js')>(), manageDovecotAcl: vi.fn(),
}));

let server: Server;
let base: string;
let role = 'admin';
const state = { owner: 'owner@example.test', mailbox: 'INBOX', entries: [] };
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { session: { admin: { id: 1, role } } }); next(); });
  app.use('/dovecot', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/dovecot`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  role = 'admin';
  vi.mocked(manageDovecotAcl).mockResolvedValue(state);
});
const change = (method: string, body: unknown = {}) => fetch(`${base}/acl?serviceId=dc1`, {
  method, headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
});

describe('Dovecot ACL access and audit', () => {
  it('requires admin even for readback', async () => {
    for (role of ['viewer', 'editor']) {
      expect((await fetch(`${base}/acl?serviceId=dc1`)).status).toBe(403);
      expect((await change('PUT')).status).toBe(403);
      expect((await change('DELETE')).status).toBe(403);
    }
    expect(manageDovecotAcl).not.toHaveBeenCalled();
  });

  it('requires an explicit service target', async () => {
    expect((await fetch(`${base}/acl`)).status).toBe(400);
    expect(manageDovecotAcl).not.toHaveBeenCalled();
  });

  it('reports readback without implying it was a mutation', async () => {
    const res = await fetch(`${base}/acl?serviceId=dc1&owner=owner%40example.test&mailbox=INBOX`);
    expect(await res.json()).toEqual({ success: true, data: state });
    expect(manageDovecotAcl).toHaveBeenCalledWith('dc1', 'get', expect.objectContaining({ owner: state.owner }));
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('audits only confirmed changes as applied', async () => {
    const res = await change('PUT', { owner: state.owner, mailbox: 'INBOX', member: 'member@example.test', rights: ['lookup', 'read'] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: { ...state, applied: true } });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'config.update', expect.objectContaining({
      entityType: 'dovecot_acl', entityId: 'dc1', newValues: expect.objectContaining({ action: 'set', applied: true }),
    }));
  });

  it('returns and audits an unconfirmed partial failure as non-success', async () => {
    vi.mocked(manageDovecotAcl).mockRejectedValueOnce(new DovecotAclError('Read back before retrying', 502, true));
    const res = await change('DELETE');
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ success: false, applied: false, outcomeUnknown: true, error: 'Read back before retrying' });
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'config.update', expect.objectContaining({
      newValues: { action: 'delete', applied: false, outcomeUnknown: true, status: 502 },
    }));
  });
});
