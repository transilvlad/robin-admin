import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './postfix.js';
import * as postfixService from '../services/postfix.js';

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

vi.mock('../db/queries/fleet-services.js', () => ({
  getFleetServiceById: vi.fn(async (id: string) => (id === 'pf1' ? { serviceId: 'pf1', serviceType: 'postfix', name: 'Postfix' } : null)),
  getFleetServicesByType: vi.fn(async () => [{ serviceId: 'pf1', serviceType: 'postfix', enabled: true }]),
}));

vi.mock('../services/service-logs.js', () => ({
  agentLogsLive: vi.fn(async () => true),
}));

vi.mock('../services/postfix.js', () => ({
  applyPostfixQueueAction: vi.fn(),
  deliverPostfixMessage: vi.fn(),
  flushPostfixQueue: vi.fn(),
  getPostfixCapabilities: vi.fn(() => ({ queue: true, flush: true, reload: false, messageCounters: true })),
  getPostfixConfigState: vi.fn(),
  listPostfixQueue: vi.fn(),
  showPostfixMessage: vi.fn(),
  reloadPostfix: vi.fn(),
  renderPostfixConfig: vi.fn(() => 'main.cf-rendered'),
  renderPostfixCheckFile: vi.fn((kind: string) => `${kind}-checks-rendered`),
  savePostfixManagedConfig: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockSave = vi.mocked(postfixService.savePostfixManagedConfig);
const mockGetConfigState = vi.mocked(postfixService.getPostfixConfigState);
const mockReload = vi.mocked(postfixService.reloadPostfix);
const mockFlush = vi.mocked(postfixService.flushPostfixQueue);
const mockQueueAction = vi.mocked(postfixService.applyPostfixQueueAction);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/postfix', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/postfix`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('postfix route', () => {
  it('PUT /config saves and returns the managed state', async () => {
    const state = { serviceId: 'pf1', serviceName: 'Postfix', managed: { messageSizeLimit: 100 } };
    mockSave.mockResolvedValue(state as never);

    const res = await fetch(`${baseUrl}/config?serviceId=pf1`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageSizeLimit: 100 }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: state });
    expect(mockSave).toHaveBeenCalledWith('pf1', { messageSizeLimit: 100 });
  });

  it('PUT /config returns 400 without a serviceId', async () => {
    const res = await fetch(`${baseUrl}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ messageSizeLimit: 100 }),
    });
    expect(res.status).toBe(400);
    expect(mockSave).not.toHaveBeenCalled();
  });

  it('GET /config/rendered returns the rendered artifacts', async () => {
    mockGetConfigState.mockResolvedValue({ serviceId: 'pf1', serviceName: 'Postfix', managed: {} } as never);

    const res = await fetch(`${baseUrl}/config/rendered?serviceId=pf1`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      mainCf: 'main.cf-rendered',
      headerChecks: 'header-checks-rendered',
      bodyChecks: 'body-checks-rendered',
    });
  });

  it('POST /reload returns the reload response', async () => {
    mockReload.mockResolvedValue('reload ok');

    const res = await fetch(`${baseUrl}/reload?serviceId=pf1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'reload ok' } });
    expect(mockReload).toHaveBeenCalledWith('pf1');
  });

  it('POST /flush returns the flush response', async () => {
    mockFlush.mockResolvedValue('Queue flushed');

    const res = await fetch(`${baseUrl}/flush?serviceId=pf1`, { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { response: 'Queue flushed' } });
    expect(mockFlush).toHaveBeenCalledWith('pf1');
  });

  it('POST /queue/actions validates the action and queue IDs before calling the agent', async () => {
    const post = (body: unknown) => fetch(`${baseUrl}/queue/actions?serviceId=pf1`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    expect((await post({ action: 'purge', queueIds: ['AAAAA1'] })).status).toBe(400);
    expect((await post({ action: 'delete', queueIds: [] })).status).toBe(400);
    expect(mockQueueAction).not.toHaveBeenCalled();

    mockQueueAction.mockResolvedValue('postsuper: Deleted: 1 message');
    const res = await post({ action: 'delete', queueIds: ['AAAAA1'] });
    expect(await res.json()).toEqual({ success: true, data: { response: 'postsuper: Deleted: 1 message' } });
    expect(mockQueueAction).toHaveBeenCalledWith('pf1', 'delete', ['AAAAA1']);
  });

});
