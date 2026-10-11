import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { requireMailboxBackend } from './mailboxes.js';
import { getConfig } from '../db/queries/config.js';
import { tableExists } from '../db/queries/users.js';
import { aliasesTableExists, autoAliasesTableExists } from '../db/queries/aliases.js';

vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../db/queries/users.js', () => ({ tableExists: vi.fn() }));
vi.mock('../db/queries/aliases.js', () => ({ aliasesTableExists: vi.fn(), autoAliasesTableExists: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: { error: vi.fn() } }));

let server: Server;
let baseUrl: string;
const handler = vi.fn();
beforeAll(async () => {
  const app = express();
  app.use('/users', requireMailboxBackend('users'));
  app.use('/aliases', requireMailboxBackend('aliases'));
  app.use((_req, res) => { handler(); res.json({ success: true }); });
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterAll(async () => { await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); });
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(getConfig).mockResolvedValue({ mailboxesEnabled: true, fleetEnabled: false } as never);
  vi.mocked(tableExists).mockResolvedValue(true);
  vi.mocked(aliasesTableExists).mockResolvedValue(true);
  vi.mocked(autoAliasesTableExists).mockResolvedValue(true);
});

describe('Mailbox access guards', () => {
  it.each(['GET', 'POST', 'PUT', 'DELETE'])('blocks every %s operation while disabled, without accessing mailbox data', async method => {
    vi.mocked(getConfig).mockResolvedValue({ mailboxesEnabled: false } as never);
    for (const path of ['/users', '/users/schema', '/users/1', '/aliases', '/aliases/1', '/aliases/auto', '/aliases/auto/1']) {
      const response = await fetch(`${baseUrl}${path}`, { method });
      expect(response.status).toBe(403);
      expect((await response.json()).error).toContain('Mailboxes is disabled');
    }
    expect(handler).not.toHaveBeenCalled();
    expect(tableExists).not.toHaveBeenCalled();
    expect(aliasesTableExists).not.toHaveBeenCalled();
    expect(autoAliasesTableExists).not.toHaveBeenCalled();
  });

  it('allows a configured backend independently of Fleet', async () => {
    expect((await fetch(`${baseUrl}/users`)).status).toBe(200);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('reports unsupported users without running the handler', async () => {
    vi.mocked(tableExists).mockResolvedValue(false);
    const response = await fetch(`${baseUrl}/users`);
    expect(response.status).toBe(503);
    expect((await response.json()).error).toContain('schema is unsupported');
    expect(handler).not.toHaveBeenCalled();
  });

  it('checks each alias backend independently', async () => {
    vi.mocked(aliasesTableExists).mockResolvedValue(false);
    expect((await fetch(`${baseUrl}/aliases/1`)).status).toBe(503);
    expect((await fetch(`${baseUrl}/aliases/auto`)).status).toBe(200);
    vi.mocked(autoAliasesTableExists).mockResolvedValue(false);
    expect((await fetch(`${baseUrl}/aliases/auto/1`)).status).toBe(503);
  });

  it('fails closed when the configuration or backend cannot be read', async () => {
    vi.mocked(getConfig).mockRejectedValueOnce(new Error('connection unavailable'));
    expect((await fetch(`${baseUrl}/users`)).status).toBe(503);
    vi.mocked(tableExists).mockRejectedValueOnce(new Error('connection unavailable'));
    expect((await fetch(`${baseUrl}/users`)).status).toBe(503);
    expect(handler).not.toHaveBeenCalled();
  });
});
