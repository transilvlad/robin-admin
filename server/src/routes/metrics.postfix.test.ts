import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './metrics.js';
import * as poller from '../services/metrics-poller.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireViewer: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// Note: service-types.js is NOT mocked — the real parseServiceType drives the
// `serviceType=bogus` -> 400 path.
vi.mock('../services/metrics-poller.js', () => ({
  getRawServiceMetrics: vi.fn(),
  getClamavMetricsHistory: vi.fn(),
  getDovecotMetricsHistory: vi.fn(),
  getPostfixMetricsHistory: vi.fn(),
  getLiveClamavMetrics: vi.fn(),
  getLiveDovecotMetrics: vi.fn(),
  getLivePostfixMetrics: vi.fn(),
  getLiveRobinMetrics: vi.fn(),
  getLiveRspamdMetrics: vi.fn(),
  getRobinMetricsHistory: vi.fn(),
  getRspamdMetricsHistory: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() },
}));

const mockLivePostfix = vi.mocked(poller.getLivePostfixMetrics);
const mockPostfixHistory = vi.mocked(poller.getPostfixMetricsHistory);
const mockRawPostfix = vi.mocked(poller.getRawServiceMetrics);

function liveMetrics(overrides: Record<string, unknown> = {}) {
  return {
    serviceId: 'pf1',
    serviceType: 'postfix',
    timestamp: new Date(),
    reachable: true,
    queueActive: 1,
    queueDeferred: 2,
    queueHold: 0,
    queueIncoming: 0,
    queueTotal: 3,
    oldestDeferredAgeSecs: 600,
    messagesDelivered: 0,
    messagesDeferred: 0,
    messagesBounced: 0,
    messagesRejected: 0,
    rawStats: '',
    ...overrides,
  };
}

function historyRow(overrides: Record<string, unknown> = {}) {
  return {
    queueActive: 1,
    queueDeferred: 2,
    queueHold: 0,
    queueIncoming: 0,
    queueTotal: 3,
    oldestDeferredAgeSecs: 300,
    messagesDelivered: 0,
    messagesDeferred: 0,
    messagesBounced: 0,
    messagesRejected: 0,
    reachable: true,
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use('/metrics', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', () => resolve()));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/metrics`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => vi.clearAllMocks());

describe('metrics route (postfix)', () => {
  it('GET /live?serviceType=postfix returns the live metrics payload', async () => {
    mockLivePostfix.mockResolvedValue(liveMetrics() as never);

    const res = await fetch(`${baseUrl}/live?serviceType=postfix`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toMatchObject({
      serviceType: 'postfix',
      reachable: true,
      queueDeferred: 2,
      queueTotal: 3,
    });
  });

  it('GET /live returns data:null with a message when the endpoint is unavailable', async () => {
    mockLivePostfix.mockResolvedValue(null as never);

    const res = await fetch(`${baseUrl}/live?serviceType=postfix`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toBeNull();
    expect(body.message).toMatch(/Postfix/);
  });

  it('GET /history?serviceType=postfix returns the history array', async () => {
    mockPostfixHistory.mockResolvedValue([historyRow(), historyRow({ queueDeferred: 4 })] as never);

    const res = await fetch(`${baseUrl}/history?serviceType=postfix`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data).toHaveLength(2);
  });

  it('GET /stats?serviceType=postfix returns totals24h shape', async () => {
    mockLivePostfix.mockResolvedValue(liveMetrics() as never);
    mockPostfixHistory.mockResolvedValue([
      historyRow({ queueTotal: 3, queueDeferred: 2, oldestDeferredAgeSecs: 300, reachable: true, messagesDelivered: 10, messagesRejected: 1 }),
      historyRow({ queueTotal: 9, queueDeferred: 7, oldestDeferredAgeSecs: 1200, reachable: false, messagesDelivered: 25, messagesRejected: 4 }),
    ] as never);

    const res = await fetch(`${baseUrl}/stats?serviceType=postfix`);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.serviceType).toBe('postfix');
    expect(body.data.totals24h).toEqual({
      peakQueue: 9,
      peakDeferred: 7,
      maxDeferredAgeSecs: 1200,
      unreachableSamples: 1,
      delivered: 15,
      deferred: 0,
      bounced: 0,
      rejected: 3,
    });
    expect(body.data.live).toMatchObject({ reachable: true, queueDeferred: 2 });
  });

  it('GET /raw?serviceType=postfix returns text/plain', async () => {
    mockRawPostfix.mockResolvedValue('postfix_up 1\n');

    const res = await fetch(`${baseUrl}/raw?serviceType=postfix`);
    const text = await res.text();

    expect(mockRawPostfix).toHaveBeenCalledWith('postfix', undefined);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/text\/plain/);
    expect(text).toContain('postfix_up 1');
  });

  it('GET /live?serviceType=bogus returns 400', async () => {
    const res = await fetch(`${baseUrl}/live?serviceType=bogus`);
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error).toMatch(/serviceType/);
  });
});
