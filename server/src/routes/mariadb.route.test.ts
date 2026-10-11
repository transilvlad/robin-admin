import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './mariadb.js';
import * as mariadbService from '../services/mariadb.js';
import { logAudit } from '../middleware/audit.js';

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

vi.mock('../services/mariadb.js', () => ({
  analyzeMariadbTable: vi.fn(),
  getMariadbConfigState: vi.fn(),
  getMariadbProcesslist: vi.fn(),
  getMariadbSchemas: vi.fn(),
  getMariadbStatements: vi.fn(),
  getMariadbStatus: vi.fn(),
  getMariadbTables: vi.fn(),
  getMariadbTransactions: vi.fn(),
  killMariadbConnection: vi.fn(),
  listMariadbConfigScopes: vi.fn(),
  reapplyMariadbConfig: vi.fn(),
  renderMariadbConfig: vi.fn(() => '-- rendered'),
  resetMariadbConfig: vi.fn(),
  resetMariadbStats: vi.fn(),
  saveMariadbManagedConfig: vi.fn(),
}));

const service = vi.mocked(mariadbService);
const audit = vi.mocked(logAudit);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/mariadb', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mariadb`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => vi.clearAllMocks());

const post = (path: string, body: unknown) => fetch(`${baseUrl}${path}`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
});

describe('mariadb route', () => {
  it('requires a serviceId', async () => {
    const res = await fetch(`${baseUrl}/processes`);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('serviceId is required');
    expect(service.getMariadbProcesslist).not.toHaveBeenCalled();
  });

  it('saves config without the serviceId field, and audits it', async () => {
    service.saveMariadbManagedConfig.mockResolvedValue({ applyError: null } as never);
    const res = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId: 'db1', maxConnections: 300 }),
    });
    expect(res.status).toBe(200);
    expect(service.saveMariadbManagedConfig).toHaveBeenCalledWith('db1', { maxConnections: 300 });
    expect(audit).toHaveBeenCalledWith(expect.anything(), 'config.update', expect.objectContaining({ entityType: 'mariadb_config', entityId: 'db1' }));
  });

  it('returns a validation failure as a 400 and audits nothing', async () => {
    service.saveMariadbManagedConfig.mockRejectedValue(new Error('max_connections must be an integer from 10 to 100000'));
    const res = await fetch(`${baseUrl}/config?serviceId=db1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxConnections: 1 }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/max_connections/);
    expect(audit).not.toHaveBeenCalled();
  });

  it('kills a query by default, a connection when asked', async () => {
    service.killMariadbConnection.mockResolvedValue(undefined);
    await post('/processes/kill', { serviceId: 'db1', id: 42 });
    expect(service.killMariadbConnection).toHaveBeenLastCalledWith('db1', 42, 'query');
    const res = await post('/processes/kill', { serviceId: 'db1', id: 42, scope: 'connection' });
    expect((await res.json()).data).toEqual({ killed: true, scope: 'connection' });
    expect(service.killMariadbConnection).toHaveBeenLastCalledWith('db1', 42, 'connection');
    expect(audit).toHaveBeenLastCalledWith(expect.anything(), 'config.update', expect.objectContaining({
      entityType: 'mariadb_runtime',
      newValues: { action: 'kill_connection', id: 42 },
    }));
  });

  it('passes the schema filter and limit to the table listing', async () => {
    service.getMariadbTables.mockResolvedValue([]);
    await fetch(`${baseUrl}/tables?serviceId=db1&schema=app-tenant-1&limit=10`);
    expect(service.getMariadbTables).toHaveBeenCalledWith('db1', { schema: 'app-tenant-1', limit: 10 });
  });

  it('re-applies the managed variables on reload', async () => {
    service.reapplyMariadbConfig.mockResolvedValue('Managed variables applied');
    const res = await post('/reload', { serviceId: 'db1' });
    expect((await res.json()).data).toEqual({ response: 'Managed variables applied' });
  });

  it('renders the stored config', async () => {
    service.getMariadbConfigState.mockResolvedValue({ managed: {} } as never);
    const res = await fetch(`${baseUrl}/config/rendered?serviceId=default`);
    expect((await res.json()).data).toEqual({ managed: '-- rendered' });
  });
});
