/**
 * Monitoring scheduler. Every tick claims as many due checks as there are free
 * probe slots and starts them without waiting for earlier probes, so a slow or
 * timing-out target only holds its own slot. Scheduled and manual checks share
 * UI-managed probe slots; manual work has its own concurrency/queue policy.
 * Raw observations are pruned hourly with the persisted retention policy.
 */
import { getConfig } from '../../db/queries/config.js';
import { observabilityDefaults } from '../observability-settings.js';
import { logger } from '../../logger.js';
import {
  getMonitoringCheck,
  getMonitoringCheckSecrets,
  listDueMonitoringChecks,
  pruneMonitoringHistory,
  recordMonitoringObservation,
  evaluateAllMonitoringChecks,
} from '../../db/queries/monitoring.js';
import { runMonitoringProbe } from './probes.js';
import type { MonitoringObservation } from '../../types/monitoring.js';
import { reportError } from '../error-reporting.js';

const SCHEDULER_INTERVAL_MS = 500;
const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;
const LOCATION_EVALUATION_INTERVAL_MS = 30 * 1000;
let policy = observabilityDefaults();

type CheckResult = MonitoringObservation | null;
interface PendingCheck {
  id: number;
  scheduled: boolean;
  resolve: (value: CheckResult) => void;
  reject: (error: unknown) => void;
  timer: ReturnType<typeof setTimeout>;
}
const pending: PendingCheck[] = [];
const checksInFlight = new Map<number, Promise<CheckResult>>();
let active = 0;
let manualActive = 0;
let lastSuccessfulTickAt: number | null = null;
let lastTickStartedAt: number | null = null;
let lastTickErrorAt: number | null = null;

function capacityError(message: string): Error {
  const error = new Error(message);
  error.name = 'MonitoringCapacityError';
  return error;
}

function enqueueCheck(id: number, scheduled: boolean): Promise<CheckResult> {
  const existing = checksInFlight.get(id);
  if (existing) return existing;
  if (!scheduled && pending.filter(item => !item.scheduled).length >= policy.monitoringManualQueueSize) {
    return Promise.reject(capacityError('Monitoring is busy; retry this check later'));
  }
  let item: PendingCheck;
  const work = new Promise<CheckResult>((resolve, reject) => {
    item = {
      id, scheduled, resolve, reject,
      timer: setTimeout(() => {
        const index = pending.indexOf(item);
        if (index >= 0) pending.splice(index, 1);
        reject(capacityError('Monitoring check waited too long; retry later'));
      }, policy.monitoringQueueWaitMs),
    };
    pending.push(item);
  });
  const result = work.finally(() => { checksInFlight.delete(id); });
  checksInFlight.set(id, result);
  drainChecks();
  return result;
}

function drainChecks(): void {
  while (active < policy.monitoringConcurrency) {
    // Manual bursts leave the remaining slots to scheduled work.
    const index = pending.findIndex(item => item.scheduled || manualActive < policy.monitoringManualConcurrency);
    if (index < 0) return;
    const [item] = pending.splice(index, 1);
    clearTimeout(item.timer);
    active += 1;
    if (!item.scheduled) manualActive += 1;
    void executeCheck(item).then(item.resolve, item.reject).finally(() => {
      active -= 1;
      if (!item.scheduled) manualActive -= 1;
      drainChecks();
      // A full claim means more checks were probably due: refill now rather
      // than waiting for the next tick.
      if (timer && backlog) void runOnce();
    });
  }
}

async function executeCheck(item: PendingCheck): Promise<CheckResult> {
  const check = await getMonitoringCheck(item.id);
  if (!check || (item.scheduled && (!check.enabled || check.pausedAt))) return null;
  // Observations carry the probe's start time, so the next run is one interval
  // after this one started and slow probes do not push the schedule back.
  const observedAt = new Date();
  let secrets: Record<string, string>;
  try { secrets = check.secretHeaderNames.length ? await getMonitoringCheckSecrets(check.id) : {}; }
  catch {
    return recordMonitoringObservation({ check, observedAt, status: 'down', responseTimeMs: 0, error: 'Stored check credentials unavailable', details: {} });
  }
  const result = await runMonitoringProbe(check, secrets);
  return recordMonitoringObservation({ check, ...result, observedAt });
}

let timer: NodeJS.Timeout | null = null;
let maintenanceTimer: NodeJS.Timeout | null = null;
let locationEvaluationTimer: NodeJS.Timeout | null = null;
let claiming = false;
let backlog = false;

export function startMonitoringScheduler(): void {
  if (timer) {
    return;
  }
  timer = setInterval(() => void runOnce(), SCHEDULER_INTERVAL_MS);
  timer.unref();
  maintenanceTimer = setInterval(() => void runMonitoringMaintenance(), MAINTENANCE_INTERVAL_MS);
  maintenanceTimer.unref();
  locationEvaluationTimer = setInterval(() => {
    void evaluateAllMonitoringChecks().catch(error => {
      logger.error('Monitoring location evaluation failed', { error: (error as Error).message });
      reportError(error, 'monitoring-locations');
    });
  }, LOCATION_EVALUATION_INTERVAL_MS);
  locationEvaluationTimer.unref();
  void runOnce();
  void runMonitoringMaintenance();
  logger.info('Monitoring scheduler started', {
    intervalMs: SCHEDULER_INTERVAL_MS,
    concurrency: policy.monitoringConcurrency,
  });
}

export function stopMonitoringScheduler(): void {
  if (!timer) {
    return;
  }
  clearInterval(timer);
  timer = null;
  if (maintenanceTimer) clearInterval(maintenanceTimer);
  maintenanceTimer = null;
  if (locationEvaluationTimer) clearInterval(locationEvaluationTimer);
  locationEvaluationTimer = null;
  logger.info('Monitoring scheduler stopped');
}

export async function runMonitoringMaintenance(): Promise<void> {
  try {
    const settings = await getConfig();
    const removed = await pruneMonitoringHistory(settings.monitoringObservationRetentionDays, settings.monitoringHistoryRetentionDays);
    if (removed.observations > 0 || removed.days > 0) {
      logger.info('Pruned monitoring history', removed);
    }
  } catch (error) {
    logger.error('Monitoring maintenance failed', { error: (error as Error).message });
  }
}

export async function runMonitoringSchedulerOnce(): Promise<void> {
  await runOnce();
}

export function getMonitoringSchedulerHealth(): { lastSuccessfulTickAt: number | null; lastTickStartedAt: number | null; lastTickErrorAt: number | null } {
  return { lastSuccessfulTickAt, lastTickStartedAt, lastTickErrorAt };
}

export async function runMonitoringCheckNow(id: number) {
  policy = await getConfig();
  return enqueueCheck(id, false);
}

/** Slots a newly claimed scheduled check could start in right now. */
function freeScheduledSlots(): number {
  const waitingScheduled = pending.filter(item => item.scheduled).length;
  // Waiting manual checks only take slots the manual limit still allows.
  const waitingManual = Math.min(pending.length - waitingScheduled, Math.max(0, policy.monitoringManualConcurrency - manualActive));
  return policy.monitoringConcurrency - active - waitingScheduled - waitingManual;
}

async function runOnce(): Promise<void> {
  if (claiming) {
    return;
  }
  claiming = true;
  lastTickStartedAt = Date.now();
  try {
    policy = await getConfig();
    drainChecks();
    const free = freeScheduledSlots();
    if (free <= 0) {
      lastSuccessfulTickAt = Date.now();
      return;
    }
    // Claiming moves next_run_at forward, so only claim what can start now.
    const checks = await listDueMonitoringChecks(free);
    backlog = checks.length === free;
    for (const check of checks) {
      enqueueCheck(check.id, true).catch((error: unknown) => {
        logger.error('Monitoring check failed', { checkId: check.id, error: String(error) });
      });
    }
    lastSuccessfulTickAt = Date.now();
  } catch (error) {
    lastTickErrorAt = Date.now();
    logger.error('Monitoring scheduler failed', { error: (error as Error).message });
    reportError(error, 'monitoring-scheduler');
  } finally {
    claiming = false;
  }
}
