import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const { recordPing, runNow, startRun, finishRun } = vi.hoisted(() => ({
  recordPing: vi.fn(), runNow: vi.fn(), startRun: vi.fn(), finishRun: vi.fn(),
}));
vi.mock('../db/queries/monitoring.js', () => ({
  recordMonitoringCheckPing: recordPing,
  startMonitoringPushRun: startRun,
  finishMonitoringPushRun: finishRun,
}));
vi.mock('../services/monitoring/scheduler.js', () => ({ runMonitoringCheckNow: runNow }));
vi.mock('../config.js', () => ({ config: { publicBaseUrl: 'https://admin.example.test/admin' } }));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import router, { pushUrl } from './monitoring-ping.js';

const TOKEN = 'a'.repeat(43);
const RUN_ID = '550e8400-e29b-41d4-a716-446655440000';
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
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

  it('starts independent runs and finishes each run with its own status', async () => {
    startRun.mockResolvedValue({
      run: { id: RUN_ID, startedAt: new Date('2026-10-08T09:00:00Z') },
      maxRuntimeSeconds: 3600,
    });
    const started = await fetch(`${baseUrl}/${TOKEN}/runs`, { method: 'POST' });
    expect(started.status).toBe(201);
    expect(await started.json()).toMatchObject({
      success: true,
      data: { runId: RUN_ID, maxRuntimeSeconds: 3600 },
    });
    expect(startRun).toHaveBeenCalledWith(TOKEN);

    finishRun.mockResolvedValue(12);
    expect((await fetch(`${baseUrl}/${TOKEN}/runs/${RUN_ID}/complete`, { method: 'POST' })).status).toBe(200);
    expect(finishRun).toHaveBeenLastCalledWith(TOKEN, RUN_ID, 'succeeded', null);
    expect((await fetch(`${baseUrl}/${TOKEN}/runs/${RUN_ID}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Backup failed' }),
    })).status).toBe(200);
    expect(finishRun).toHaveBeenLastCalledWith(TOKEN, RUN_ID, 'failed', 'Backup failed');
  });

  it('rejects malformed run IDs and unsupported failure payloads', async () => {
    expect((await fetch(`${baseUrl}/${TOKEN}/runs/not-a-uuid/complete`, { method: 'POST' })).status).toBe(404);
    expect(finishRun).not.toHaveBeenCalled();
    expect((await fetch(`${baseUrl}/${TOKEN}/runs/${RUN_ID}/fail`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ unexpected: true }),
    })).status).toBe(400);
    expect(finishRun).not.toHaveBeenCalled();
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
