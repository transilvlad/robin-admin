import { beforeEach, describe, expect, it, vi } from 'vitest';

const { queryMock, sendMock, schedulerMock } = vi.hoisted(() => {
  process.env.ROBIN_HEARTBEAT_HEALTH_CACHE_MS = '0';
  return { queryMock: vi.fn(), sendMock: vi.fn(), schedulerMock: vi.fn() };
});

vi.mock('../../db/connection.js', () => ({ query: queryMock }));
vi.mock('../../db/queries/config.js', () => ({
  getConfig: async () => ({ monitoringEnabled: true, alertsEnabled: false, alertDeliveryIntervalMs: 5000 }),
}));
vi.mock('../../db/queries/secret-crypto.js', () => ({
  encryptStoredSecret: (value: string) => `enc:${value}`,
  decryptStoredSecret: (value: string) => value.replace(/^enc:/, ''),
}));
vi.mock('../alerts/delivery-worker.js', () => ({
  getAlertDeliveryWorkerHealth: () => ({ lastSuccessfulCycleAt: Date.now(), lastCycleErrorAt: null }),
}));
vi.mock('../alerts/webhook-transport.js', () => ({ sendAlertWebhook: sendMock }));
vi.mock('./scheduler.js', () => ({ getMonitoringSchedulerHealth: schedulerMock }));
vi.mock('../leader-lock.js', () => ({ isBackgroundJobsLeader: () => true }));
vi.mock('../../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { runHeartbeatsOnce } from './heartbeat.js';

function heartbeatRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 1, enabled: true, interval_seconds: 60, minimum_fresh_locations: 0, last_attempt_at: null,
    encrypted_ping_url: 'enc:https://ping.example.test/ok', encrypted_failure_url: 'enc:https://ping.example.test/fail',
    ...overrides,
  };
}

function wireQueries(row: Record<string, unknown>) {
  queryMock.mockImplementation(async (text: string) => {
    if (text.includes('FROM monitoring_heartbeats WHERE enabled')) return { rows: [row], rowCount: 1 };
    if (text.includes('FROM monitoring_checks c JOIN')) return { rows: [{ count: 0 }], rowCount: 1 };
    return { rows: [{ count: 0 }], rowCount: 1 };
  });
}

function lastResult(): unknown[] | undefined {
  return queryMock.mock.calls.map(call => call as [string, unknown[]]).find(([text]) => text.includes('SET last_result'))?.[1];
}

describe('heartbeat delivery loop', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    sendMock.mockResolvedValue({ accepted: true });
    schedulerMock.mockReturnValue({ lastSuccessfulTickAt: Date.now(), lastTickStartedAt: Date.now(), lastTickErrorAt: null });
  });

  it('pings the success URL when healthy', async () => {
    wireQueries(heartbeatRow());
    await runHeartbeatsOnce();
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({ webhookUrl: 'https://ping.example.test/ok', payload: { status: 'ok' } }));
    expect(lastResult()).toEqual([1, 'sent', null]);
  });

  it('calls the failure URL with the reason when the scheduler is blocked', async () => {
    schedulerMock.mockReturnValue({ lastSuccessfulTickAt: Date.now() - 60_000, lastTickStartedAt: null, lastTickErrorAt: null });
    wireQueries(heartbeatRow());
    await runHeartbeatsOnce();
    expect(sendMock).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://ping.example.test/fail', payload: { status: 'fail', reason: 'scheduler_lag' },
    }));
    expect(lastResult()).toEqual([1, 'failure_sent', 'scheduler_lag']);
  });

  it('stays silent when unhealthy and no failure URL is configured', async () => {
    schedulerMock.mockReturnValue({ lastSuccessfulTickAt: Date.now() - 60_000, lastTickStartedAt: null, lastTickErrorAt: null });
    wireQueries(heartbeatRow({ encrypted_failure_url: null }));
    await runHeartbeatsOnce();
    expect(sendMock).not.toHaveBeenCalled();
    expect(lastResult()).toEqual([1, 'silenced', 'scheduler_lag']);
  });

  it('records a rejected or throwing delivery as failed', async () => {
    wireQueries(heartbeatRow());
    sendMock.mockResolvedValueOnce({ accepted: false });
    await runHeartbeatsOnce();
    expect(lastResult()).toEqual([1, 'failed', null]);
    queryMock.mockClear();
    wireQueries(heartbeatRow());
    sendMock.mockRejectedValueOnce(new Error('network down'));
    await runHeartbeatsOnce();
    expect(lastResult()).toEqual([1, 'failed', null]);
  });

  it('skips targets attempted within their interval', async () => {
    wireQueries(heartbeatRow({ last_attempt_at: new Date() }));
    await runHeartbeatsOnce();
    expect(sendMock).not.toHaveBeenCalled();
  });

  it('sends Sentry Cron check-ins to the ping URL for both healthy and unhealthy states', async () => {
    const sentryUrl = 'https://o1.ingest.us.sentry.io/api/2/cron/robin-admin-heartbeat/abc123/';
    wireQueries(heartbeatRow({ format: 'sentry_crons', encrypted_ping_url: `enc:${sentryUrl}`, encrypted_failure_url: null }));
    await runHeartbeatsOnce();
    expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({
      webhookUrl: sentryUrl,
      payload: expect.objectContaining({ status: 'ok', monitor_config: expect.objectContaining({ schedule: { type: 'interval', value: 1, unit: 'minute' } }) }),
    }));

    queryMock.mockClear();
    schedulerMock.mockReturnValue({ lastSuccessfulTickAt: Date.now() - 60_000, lastTickStartedAt: null, lastTickErrorAt: null });
    wireQueries(heartbeatRow({ format: 'sentry_crons', encrypted_ping_url: `enc:${sentryUrl}`, encrypted_failure_url: null }));
    await runHeartbeatsOnce();
    expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ webhookUrl: sentryUrl, payload: expect.objectContaining({ status: 'error' }) }));
    expect(lastResult()).toEqual([1, 'failure_sent', 'scheduler_lag']);
  });
});
