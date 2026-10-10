import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './queue.js';
import * as robinApi from '../services/robin-api.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireEditor: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireViewer: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/audit.js', () => ({
  AuditActions: new Proxy({}, { get: (_target, name) => String(name) }),
  logAudit: vi.fn(),
}));

vi.mock('../services/robin-api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/robin-api.js')>(),
  retryQueueItem: vi.fn(),
  retryQueueItems: vi.fn(),
  deleteQueueItem: vi.fn(),
  deleteQueueItems: vi.fn(),
  bounceQueueItem: vi.fn(),
  bounceQueueItems: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/queue', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/queue`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
});

beforeEach(() => {
  vi.clearAllMocks();
});

function post(path: string, body: unknown): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('queue routes', () => {
  it.each([
    ['retry', robinApi.retryQueueItems, robinApi.retryQueueItem],
    ['bounce', robinApi.bounceQueueItems, robinApi.bounceQueueItem],
    ['delete', robinApi.deleteQueueItems, robinApi.deleteQueueItem],
  ] as const)('routes /bulk/%s to the bulk action, not the single-item one', async (action, bulk, single) => {
    vi.mocked(bulk).mockResolvedValueOnce({ success: true });

    const response = await post(`/bulk/${action}?serviceId=robin-east`, { uids: ['a', 'b'] });

    expect(response.status).toBe(200);
    expect(bulk).toHaveBeenCalledWith(['a', 'b'], 'robin-east');
    expect(single).not.toHaveBeenCalled();
  });

  it("returns Robin's refusal as a 502", async () => {
    vi.mocked(robinApi.retryQueueItem).mockRejectedValueOnce(new robinApi.RobinApiRejectedError(404, 'No such queue item'));

    const response = await post('/abc/retry', {});

    expect(response.status).toBe(502);
    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Robin rejected the request (HTTP 404): No such queue item',
    });
  });

  it('returns 503 when Robin cannot be reached', async () => {
    vi.mocked(robinApi.retryQueueItems).mockRejectedValueOnce(new robinApi.RobinApiUnavailableError(new Error('down')));

    const response = await post('/bulk/retry', { uids: ['a'] });

    expect(response.status).toBe(503);
  });
});
