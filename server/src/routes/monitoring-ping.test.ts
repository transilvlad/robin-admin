import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { recordPing, runNow } = vi.hoisted(() => ({ recordPing: vi.fn(), runNow: vi.fn() }));
vi.mock('../db/queries/monitoring.js', () => ({ recordMonitoringCheckPing: recordPing }));
vi.mock('../services/monitoring/scheduler.js', () => ({ runMonitoringCheckNow: runNow }));
vi.mock('../config.js', () => ({ config: { publicBaseUrl: 'https://admin.example.test/admin' } }));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import router, { pushUrl } from './monitoring-ping.js';

const TOKEN = 'a'.repeat(43);
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/api/monitoring/ping', router);
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/monitoring/ping`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  runNow.mockResolvedValue(null);
});

describe('push check ping URLs', () => {
  it('records a successful ping by GET or POST and evaluates the check', async () => {
    recordPing.mockResolvedValue(12);
    const get = await fetch(`${baseUrl}/${TOKEN}`);
    expect(get.status).toBe(200);
    expect(await get.text()).toBe('OK\n');
    expect(recordPing).toHaveBeenLastCalledWith(TOKEN, 'ok');
    expect(runNow).toHaveBeenCalledWith(12);
    expect((await fetch(`${baseUrl}/${TOKEN}`, { method: 'POST' })).status).toBe(200);
  });

  it('records a reported failure', async () => {
    recordPing.mockResolvedValue(12);
    expect((await fetch(`${baseUrl}/${TOKEN}/fail`)).status).toBe(200);
    expect(recordPing).toHaveBeenCalledWith(TOKEN, 'fail');
  });

  it('answers 404 for malformed and unknown tokens without evaluating anything', async () => {
    expect((await fetch(`${baseUrl}/not-a-token`)).status).toBe(404);
    expect(recordPing).not.toHaveBeenCalled();
    recordPing.mockResolvedValue(null);
    expect((await fetch(`${baseUrl}/${TOKEN}`)).status).toBe(404);
    expect(runNow).not.toHaveBeenCalled();
  });

  it('builds the URL under the public base URL', () => {
    expect(pushUrl(TOKEN)).toBe(`https://admin.example.test/admin/api/monitoring/ping/${TOKEN}`);
  });
});
