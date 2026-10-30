import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteUser, getUserById } from '../db/queries/users.js';
import { logAudit } from '../middleware/audit.js';
import router from './users.js';

vi.mock('../middleware/auth.js', () => ({ requireAuth: (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../middleware/mailboxes.js', () => ({ requireMailboxBackend: () => (_req: unknown, _res: unknown, next: () => void) => next() }));
vi.mock('../middleware/audit.js', () => ({ logAudit: vi.fn(), AuditActions: { USER_DELETE: 'user.delete' } }));
vi.mock('../db/queries/users.js', async (original) => ({
  ...await original<typeof import('../db/queries/users.js')>(), deleteUser: vi.fn(), getUserById: vi.fn(),
}));
vi.mock('../logger.js', () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

let server: Server;
let base: string;
beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { Object.assign(req, { session: { admin: { id: 1, role: 'admin' } } }); next(); });
  app.use('/users', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/users`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve())); });
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getUserById).mockResolvedValue({ id: 1, email: 'catchall@example.test' });
});

describe('mailbox deletion policy references', () => {
  it('reports restrictive policy references as actionable conflicts, not deletion success', async () => {
    vi.mocked(deleteUser).mockRejectedValueOnce(Object.assign(new Error('foreign key constraint'), { code: '23503' }));
    const res = await fetch(`${base}/1`, { method: 'DELETE' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('Remove catch-all destinations');
    expect(logAudit).not.toHaveBeenCalled();
  });

  it('does not misclassify unrelated database failures as policy conflicts', async () => {
    vi.mocked(deleteUser).mockRejectedValueOnce(new Error('database connection unavailable'));
    expect((await fetch(`${base}/1`, { method: 'DELETE' })).status).toBe(500);
  });
});
