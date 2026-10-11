import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  connect: vi.fn(),
  getConfig: vi.fn(),
  invalidateConfigCache: vi.fn(),
  isLeader: true,
  restartMetrics: vi.fn(),
  startAlertDelivery: vi.fn(),
  stopAlertDelivery: vi.fn(),
  startAlertScheduler: vi.fn(),
  stopAlertScheduler: vi.fn(),
  startMonitoring: vi.fn(),
  stopMonitoring: vi.fn(),
  logger: { error: vi.fn(), warn: vi.fn() },
}));

vi.mock('../db/connection.js', () => ({ pool: { connect: mocks.connect } }));
vi.mock('../db/queries/config.js', () => ({
  getConfig: mocks.getConfig,
  invalidateConfigCache: mocks.invalidateConfigCache,
}));
vi.mock('./leader-lock.js', () => ({ isBackgroundJobsLeader: () => mocks.isLeader }));
vi.mock('./alerts/delivery-worker.js', () => ({
  startAlertDeliveryWorker: mocks.startAlertDelivery,
  stopAlertDeliveryWorker: mocks.stopAlertDelivery,
}));
vi.mock('./alerts/scheduler.js', () => ({
  startAlertScheduler: mocks.startAlertScheduler,
  stopAlertScheduler: mocks.stopAlertScheduler,
}));
vi.mock('./metrics-poller.js', () => ({ reconfigureMetricsPoller: mocks.restartMetrics }));
vi.mock('./monitoring/scheduler.js', () => ({
  startMonitoringScheduler: mocks.startMonitoring,
  stopMonitoringScheduler: mocks.stopMonitoring,
}));
vi.mock('../logger.js', () => ({ logger: mocks.logger }));

const { startConfigChangeListener, stopConfigChangeListener } = await import('./config-change-listener.js');

class ListenerClient extends EventEmitter {
  query = vi.fn().mockResolvedValue({});
  release = vi.fn();
}

let client: ListenerClient;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.isLeader = true;
  client = new ListenerClient();
  mocks.connect.mockResolvedValue(client);
  mocks.getConfig.mockResolvedValue({
    metricsPollIntervalMs: 60_000,
    monitoringEnabled: true,
    ...Object.fromEntries([
      'alertsEnabled', 'alertEvaluationIntervalMs', 'alertDeliveryIntervalMs', 'alertDeliveryConcurrency',
      'alertDeliveryExpiryMs', 'alertDeliveryMaxAttempts', 'alertRetryBaseMs', 'alertRetryMaxMs', 'alertInstanceName',
    ].map(key => [key, key === 'alertsEnabled' ? true : 1])),
  });
});

afterEach(async () => {
  vi.useRealTimers();
  await stopConfigChangeListener();
});

describe('PostgreSQL configuration-change listener', () => {
  it('invalidates configuration and restarts affected leader workers', async () => {
    startConfigChangeListener();
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledWith('LISTEN config_changed'));
    client.emit('notification', {
      channel: 'config_changed',
      payload: JSON.stringify({ keys: ['alertsEnabled', 'metricsPollIntervalMs', 'monitoringEnabled'] }),
    });
    await vi.waitFor(() => {
      expect(mocks.invalidateConfigCache).toHaveBeenCalledOnce();
      expect(mocks.restartMetrics).toHaveBeenCalledOnce();
      expect(mocks.stopAlertScheduler).toHaveBeenCalledOnce();
      expect(mocks.startAlertScheduler).toHaveBeenCalledOnce();
      expect(mocks.stopAlertDelivery).toHaveBeenCalledOnce();
      expect(mocks.startAlertDelivery).toHaveBeenCalledOnce();
      expect(mocks.startMonitoring).toHaveBeenCalledOnce();
    });
  });

  it('invalidates follower caches without touching singleton workers', async () => {
    mocks.isLeader = false;
    startConfigChangeListener();
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledWith('LISTEN config_changed'));
    client.emit('notification', { channel: 'config_changed', payload: JSON.stringify({ keys: ['alertsEnabled'] }) });
    await vi.waitFor(() => expect(mocks.invalidateConfigCache).toHaveBeenCalledOnce());
    expect(mocks.stopAlertScheduler).not.toHaveBeenCalled();
    expect(mocks.startAlertDelivery).not.toHaveBeenCalled();
  });

  it('reconciles missed notifications from the leader refresh timer', async () => {
    vi.useFakeTimers();
    startConfigChangeListener();
    await Promise.resolve();
    await Promise.resolve();
    expect(client.query).toHaveBeenCalledWith('LISTEN config_changed');
    await vi.advanceTimersByTimeAsync(5000);
    mocks.getConfig.mockResolvedValue({
      metricsPollIntervalMs: 30_000,
      monitoringEnabled: false,
      alertsEnabled: true,
      alertEvaluationIntervalMs: 2,
      alertDeliveryConcurrency: 1,
      alertInstanceName: 'Replica test',
    });
    await vi.advanceTimersByTimeAsync(5000);
    expect(mocks.restartMetrics).toHaveBeenCalledOnce();
    expect(mocks.stopMonitoring).toHaveBeenCalledOnce();
    expect(mocks.stopAlertScheduler).toHaveBeenCalledOnce();
    expect(mocks.startAlertDelivery).toHaveBeenCalledOnce();
  });

  it.each(['error', 'end'] as const)('releases its pool client after a listener %s event', async event => {
    startConfigChangeListener();
    await vi.waitFor(() => expect(client.query).toHaveBeenCalledWith('LISTEN config_changed'));
    if (event === 'error') client.emit('error', new Error('database disconnected'));
    else client.emit('end');
    expect(client.release).toHaveBeenCalledWith(true);
  });

  it('serializes notification restarts with the reconciliation timer', async () => {
    vi.useFakeTimers();
    let releaseConfig: ((value: Record<string, unknown>) => void) | null = null;
    mocks.getConfig.mockImplementationOnce(() => new Promise(resolve => { releaseConfig = resolve; }));
    startConfigChangeListener();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(client.listenerCount('notification')).toBe(1);
    client.emit('notification', { channel: 'config_changed', payload: JSON.stringify({ keys: ['alertsEnabled'] }) });
    await vi.advanceTimersByTimeAsync(5000);
    const resolveConfig = releaseConfig as ((value: Record<string, unknown>) => void) | null;
    resolveConfig?.({
      metricsPollIntervalMs: 60_000,
      monitoringEnabled: true,
      ...Object.fromEntries([
        'alertsEnabled', 'alertEvaluationIntervalMs', 'alertDeliveryIntervalMs', 'alertDeliveryConcurrency',
        'alertDeliveryExpiryMs', 'alertDeliveryMaxAttempts', 'alertRetryBaseMs', 'alertRetryMaxMs', 'alertInstanceName',
      ].map(key => [key, key === 'alertsEnabled' ? true : 1])),
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(mocks.startAlertScheduler).toHaveBeenCalledOnce();
  });
});
