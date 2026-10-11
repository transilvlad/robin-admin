import type { PoolClient } from 'pg';
import { pool } from '../db/connection.js';
import { getConfig, invalidateConfigCache, type AdminConfig } from '../db/queries/config.js';
import { OPERATIONS_KEYS } from './operations-settings.js';
import { logger } from '../logger.js';
import { isBackgroundJobsLeader } from './leader-lock.js';
import { startAlertDeliveryWorker, stopAlertDeliveryWorker } from './alerts/delivery-worker.js';
import { startAlertScheduler, stopAlertScheduler } from './alerts/scheduler.js';
import { reconfigureMetricsPoller } from './metrics-poller.js';
import { startMonitoringScheduler, stopMonitoringScheduler } from './monitoring/scheduler.js';

const CHANNEL = 'config_changed';
const RETRY_MS = 5000;
const RECONCILE_MS = 5000;
const ALERT_CONFIG_KEYS = OPERATIONS_KEYS.filter(key => key.startsWith('alert'));

interface BackgroundConfigSnapshot {
  metricsPollIntervalMs: number;
  operations: string;
  monitoringEnabled: boolean;
}

let listenerClient: PoolClient | null = null;
let connecting = false;
let stopped = true;
let reconnectTimer: NodeJS.Timeout | null = null;
let reconcileTimer: NodeJS.Timeout | null = null;
let leaderSnapshot: BackgroundConfigSnapshot | null = null;
let workerUpdateQueue = Promise.resolve();

function serializeWorkerUpdate(operation: () => Promise<void>): Promise<void> {
  workerUpdateQueue = workerUpdateQueue.then(operation).catch(error => {
    logger.error('Failed to apply configuration change on background-jobs leader', { error: (error as Error).message });
  });
  return workerUpdateQueue;
}

function snapshot(config: AdminConfig): BackgroundConfigSnapshot {
  return {
    metricsPollIntervalMs: config.metricsPollIntervalMs,
    operations: JSON.stringify(ALERT_CONFIG_KEYS.map(key => config[key as keyof AdminConfig])),
    monitoringEnabled: config.monitoringEnabled,
  };
}

function restartAlertWorkers(): void {
  stopAlertScheduler();
  stopAlertDeliveryWorker();
  startAlertScheduler();
  startAlertDeliveryWorker();
}

function applyWorkerChanges(previous: BackgroundConfigSnapshot | null, current: BackgroundConfigSnapshot, force = false): void {
  if (force || (previous && previous.metricsPollIntervalMs !== current.metricsPollIntervalMs)) {
    reconfigureMetricsPoller();
  }
  if (force || (previous && previous.operations !== current.operations)) {
    restartAlertWorkers();
  }
  if (force || (previous && previous.monitoringEnabled !== current.monitoringEnabled)) {
    if (current.monitoringEnabled) startMonitoringScheduler();
    else stopMonitoringScheduler();
  }
}

async function applyNotification(notification: { channel?: string; payload?: string }): Promise<void> {
  if (notification.channel !== CHANNEL || !notification.payload) return;
  let keys: unknown;
  try {
    const payload = JSON.parse(notification.payload) as { keys?: unknown };
    keys = payload.keys;
  } catch {
    logger.warn('Ignoring malformed configuration-change notification');
    return;
  }
  if (!Array.isArray(keys) || keys.length > 512 || keys.some(key => typeof key !== 'string' || key.length > 128)) {
    logger.warn('Ignoring malformed configuration-change notification');
    return;
  }

  await serializeWorkerUpdate(async () => {
    invalidateConfigCache();
    const config = await getConfig();
    if (!isBackgroundJobsLeader()) {
      leaderSnapshot = null;
      return;
    }
    const current = snapshot(config);
    const previous = leaderSnapshot;
    const force = keys.includes('*');
    if (force) {
      applyWorkerChanges(previous, current, true);
    } else {
      const changed = new Set(keys as string[]);
      if (changed.has('metricsPollIntervalMs') && (!previous || previous.metricsPollIntervalMs !== current.metricsPollIntervalMs)) reconfigureMetricsPoller();
      if (keys.some(key => ALERT_CONFIG_KEYS.includes(key as typeof ALERT_CONFIG_KEYS[number])) && (!previous || previous.operations !== current.operations)) restartAlertWorkers();
      if (changed.has('monitoringEnabled') && (!previous || previous.monitoringEnabled !== current.monitoringEnabled)) {
        if (config.monitoringEnabled) startMonitoringScheduler();
        else stopMonitoringScheduler();
      }
    }
    leaderSnapshot = current;
  });
}

async function refreshLeaderConfig(): Promise<void> {
  await serializeWorkerUpdate(async () => {
    if (!isBackgroundJobsLeader()) {
      leaderSnapshot = null;
      return;
    }
    invalidateConfigCache();
    const current = snapshot(await getConfig());
    if (leaderSnapshot) applyWorkerChanges(leaderSnapshot, current);
    leaderSnapshot = current;
  });
}

function scheduleReconnect(): void {
  if (stopped || reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connectListener();
  }, RETRY_MS);
  reconnectTimer.unref();
}

async function connectListener(): Promise<void> {
  if (stopped || connecting || listenerClient) return;
  connecting = true;
  let client: PoolClient | null = null;
  try {
    client = await pool.connect();
    await client.query(`LISTEN ${CHANNEL}`);
    if (stopped) {
      await client.query(`UNLISTEN ${CHANNEL}`);
      client.release();
      return;
    }
    const activeClient = client;
    if (!activeClient) throw new Error('PostgreSQL listener connection was not established');
    listenerClient = activeClient;
    activeClient.on('notification', notification => {
      void applyNotification(notification).catch(error => {
        logger.error('Failed to process configuration-change notification', { error: (error as Error).message });
      });
    });
    activeClient.on('error', error => {
      if (listenerClient !== activeClient) return;
      logger.warn('Configuration-change listener disconnected', { error: error.message });
      listenerClient = null;
      activeClient.release(true);
      scheduleReconnect();
    });
    activeClient.on('end', () => {
      if (listenerClient !== activeClient) return;
      listenerClient = null;
      activeClient.release(true);
      scheduleReconnect();
    });
  } catch (error) {
    client?.release(true);
    logger.warn('Could not start configuration-change listener; timed refresh remains active', { error: (error as Error).message });
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

export function startConfigChangeListener(): void {
  if (!stopped) return;
  stopped = false;
  void connectListener();
  reconcileTimer = setInterval(() => void refreshLeaderConfig(), RECONCILE_MS);
  reconcileTimer.unref();
}

export async function stopConfigChangeListener(): Promise<void> {
  stopped = true;
  if (reconnectTimer) clearTimeout(reconnectTimer);
  if (reconcileTimer) clearInterval(reconcileTimer);
  reconnectTimer = null;
  reconcileTimer = null;
  leaderSnapshot = null;
  const client = listenerClient;
  listenerClient = null;
  if (!client) return;
  client.removeAllListeners('notification');
  try {
    await client.query(`UNLISTEN ${CHANNEL}`);
    client.release();
  } catch (error) {
    client.release(true);
    logger.warn('Configuration-change listener could not shut down cleanly', { error: (error as Error).message });
  }
}
