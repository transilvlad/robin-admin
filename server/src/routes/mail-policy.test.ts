import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mailPolicyAvailable, saveSenderGrant, listMailDomains, MailPolicyInputError } from '../db/queries/mail-policy.js';
import { logAudit } from '../middleware/audit.js';
import router from './mail-policy.js';

vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../middleware/mailboxes.js', () => ({ requireMailboxBackend: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../middleware/audit.js', () => ({ logAudit: vi.fn() }));
vi.mock('../db/queries/mail-policy.js', async original => ({
  ...await original<typeof import('../db/queries/mail-policy.js')>(),
  mailPolicyAvailable: vi.fn(),
  listMailDomains: vi.fn(),
  saveSenderGrant: vi.fn(),
}));

let server: Server;
let base: string;
let role = 'admin';
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { session: { admin: { id: 1, role } } }); next(); });
  app.use('/policy', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/policy`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(err => err ? reject(err) : resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  role = 'admin';
  vi.mocked(mailPolicyAvailable).mockResolvedValue(true);
});

describe('mail policy access and audit', () => {
  it('reports absent schema and refuses writes without attempting migration', async () => {
    vi.mocked(mailPolicyAvailable).mockResolvedValue(false);
    expect(await (await fetch(`${base}/status`)).json()).toEqual({ success: true, data: { available: false } });
    expect((await fetch(`${base}/grants`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status).toBe(503);
    expect(saveSenderGrant).not.toHaveBeenCalled();
  });

  it('allows viewers to inspect but not change identity permissions', async () => {
    role = 'viewer';
    vi.mocked(listMailDomains).mockResolvedValue({ rows: [], total: 0 });
    expect((await fetch(`${base}/domains`)).status).toBe(200);
    expect((await fetch(`${base}/grants`, { method: 'PUT' })).status).toBe(403);
    role = 'editor';
    expect((await fetch(`${base}/grants`, { method: 'PUT' })).status).toBe(403);
    expect(saveSenderGrant).not.toHaveBeenCalled();
  });

  it('audits successful grants with their account and identity', async () => {
    const grant = { account: 'a@example.test', address: 'shared@example.test', grant_type: 'delegated' as const };
    vi.mocked(saveSenderGrant).mockResolvedValue(grant);
    const response = await fetch(`${base}/grants`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(grant) });
    expect(response.status).toBe(200);
    expect(logAudit).toHaveBeenCalledWith(expect.anything(), 'mail_policy.sender_grant', expect.objectContaining({ newValues: grant }));
  });

  it('returns actionable input errors rather than success-shaped responses', async () => {
    vi.mocked(saveSenderGrant).mockRejectedValue(new MailPolicyInputError('Grant requires an existing account'));
    const response = await fetch(`${base}/grants`, { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain('existing account');
    expect(logAudit).not.toHaveBeenCalled();
  });
});
