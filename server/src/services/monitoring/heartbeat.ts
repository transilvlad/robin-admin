import { randomUUID } from 'node:crypto';
import { decryptStoredSecret, encryptStoredSecret } from '../../db/queries/secret-crypto.js';
import { query } from '../../db/connection.js';
import { getConfig } from '../../db/queries/config.js';
import { getAlertDeliveryWorkerHealth } from '../alerts/delivery-worker.js';
import { sendAlertWebhook } from '../alerts/webhook-transport.js';
import { isSentryCronCheckInUrl, sentryCronCheckIn } from '../alerts/sentry.js';
import { validateOutboundUrl } from '../../middleware/security.js';
import { MonitoringInputError } from './options.js';
import { getMonitoringSchedulerHealth } from './scheduler.js';
import { logger } from '../../logger.js';
import { isBackgroundJobsLeader } from '../leader-lock.js';

// The scheduler ticks every 500 ms, so a staleness threshold below 1 s would flap.
export function parseHeartbeatMs(raw: string | undefined, fallback: number, min: number, max: number): number {
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min && value <= max ? Math.floor(value) : fallback;
}

function envMs(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  const value = parseHeartbeatMs(raw, fallback, min, max);
  if (raw !== undefined && raw.trim() !== '' && value === fallback && Number(raw) !== fallback) {
    logger.warn(`Ignoring ${name}=${raw}: expected ${min}-${max} ms, using ${fallback}`);
  }
  return value;
}

// Operators can tune these without a code change; out-of-range values fall back to the defaults.
const LOOP_INTERVAL_MS = envMs('ROBIN_HEARTBEAT_LOOP_MS', 5000, 1000, 300_000);
const HEALTH_CACHE_MS = envMs('ROBIN_HEARTBEAT_HEALTH_CACHE_MS', 10000, 0, 300_000);
const SCHEDULER_STALE_MS = envMs('ROBIN_HEARTBEAT_SCHEDULER_STALE_MS', 10000, 1000, 3_600_000);
const ALERT_STALE_MIN_MS = envMs('ROBIN_HEARTBEAT_ALERT_STALE_MS', 120000, 1000, 3_600_000);
const MAX_HEARTBEATS = 10;
const REASON_CODES = ['database', 'monitoring_disabled', 'scheduler_lag', 'alert_backlog', 'locations'] as const;
type HeartbeatReason = typeof REASON_CODES[number];

export type HeartbeatFormat = 'generic' | 'sentry_crons';

interface HeartbeatRow {
  id: number;
  name: string;
  format: HeartbeatFormat;
  encrypted_ping_url: string;
  encrypted_failure_url: string | null;
  interval_seconds: number;
  minimum_fresh_locations: number;
  enabled: boolean;
  last_attempt_at: Date | null;
  last_result: string | null;
  last_reason: string | null;
}

export interface HeartbeatTarget {
  id: number;
  name: string;
  format: HeartbeatFormat;
  intervalSeconds: number;
  minimumFreshLocations: number;
  enabled: boolean;
  pingUrlConfigured: boolean;
  failureUrlConfigured: boolean;
  lastAttemptAt: Date | null;
  lastResult: string | null;
  lastReason: string | null;
}

export interface HeartbeatHealth {
  healthy: boolean;
  reason: HeartbeatReason | null;
  checkedAt: number;
}

let timer: NodeJS.Timeout | null = null;
// When this process started: a scheduler or alert worker that has not finished
// its first cycle yet is only late once its usual window has passed since then.
const processStartedAt = Date.now();
let running = false;
let cachedHealth: HeartbeatHealth = { healthy: false, reason: 'database', checkedAt: 0 };
const healthCache = new Map<number, { refreshAt: number; health: HeartbeatHealth }>();

function publicTarget(row: HeartbeatRow): HeartbeatTarget {
  return {
    id: row.id,
    name: row.name,
    format: row.format,
    intervalSeconds: row.interval_seconds,
    minimumFreshLocations: row.minimum_fresh_locations,
    enabled: row.enabled,
    pingUrlConfigured: Boolean(row.encrypted_ping_url),
    failureUrlConfigured: Boolean(row.encrypted_failure_url),
    lastAttemptAt: row.last_attempt_at,
    lastResult: row.last_result,
    lastReason: row.last_reason,
  };
}

function validateHeartbeatUrl(value: unknown, field: string, required: boolean): string | null {
  if (value === undefined || value === null || value === '') {
    if (required) throw new MonitoringInputError(`${field} is required`);
    return null;
  }
  if (typeof value !== 'string' || value.length > 2048) throw new MonitoringInputError(`${field} must be a URL of at most 2048 characters`);
  const issue = validateOutboundUrl(value, false, ['https:']);
  if (issue) throw new MonitoringInputError(`${field}: ${issue}`);
  const url = new URL(value);
  if (url.username || url.password || url.hash) throw new MonitoringInputError(`${field} must not contain credentials or a fragment`);
  return value;
}

export async function listHeartbeatTargets(): Promise<HeartbeatTarget[]> {
  const result = await query<HeartbeatRow>('SELECT * FROM monitoring_heartbeats ORDER BY id');
  return result.rows.map(publicTarget);
}

export async function saveHeartbeatTarget(input: {
  id?: number;
  name: unknown;
  format?: unknown;
  pingUrl?: unknown;
  failureUrl?: unknown;
  intervalSeconds?: unknown;
  minimumFreshLocations?: unknown;
  enabled?: unknown;
}): Promise<HeartbeatTarget> {
  if (typeof input.name !== 'string' || !input.name.trim() || input.name.trim().length > 100 || /[\r\n\x00]/.test(input.name)) {
    throw new MonitoringInputError('name must be a single-line value of 1 to 100 characters');
  }
  if (input.enabled !== undefined && typeof input.enabled !== 'boolean') throw new MonitoringInputError('enabled must be boolean');
  let existing: HeartbeatRow | null = null;
  if (input.id !== undefined) {
    existing = (await query<HeartbeatRow>('SELECT * FROM monitoring_heartbeats WHERE id = $1', [input.id])).rows[0] ?? null;
    if (!existing) throw new MonitoringInputError('Heartbeat target not found');
  }
  const intervalSeconds = input.intervalSeconds ?? existing?.interval_seconds ?? 60;
  if (typeof intervalSeconds !== 'number' || !Number.isInteger(intervalSeconds) || intervalSeconds < 15 || intervalSeconds > 3600) {
    throw new MonitoringInputError('intervalSeconds must be an integer between 15 and 3600');
  }
  const format = input.format ?? existing?.format ?? 'generic';
  if (format !== 'generic' && format !== 'sentry_crons') throw new MonitoringInputError('format must be generic or sentry_crons');
  const minimumFreshLocations = input.minimumFreshLocations ?? existing?.minimum_fresh_locations ?? 0;
  if (typeof minimumFreshLocations !== 'number' || !Number.isInteger(minimumFreshLocations)
    || minimumFreshLocations < 0 || minimumFreshLocations > 128) {
    throw new MonitoringInputError('minimumFreshLocations must be an integer between 0 and 128');
  }
  const pingUrlValue = input.pingUrl === undefined && existing ? null : validateHeartbeatUrl(input.pingUrl, 'pingUrl', true)!;
  if (format === 'sentry_crons') {
    const url = pingUrlValue ?? decryptStoredSecret(existing!.encrypted_ping_url);
    if (!isSentryCronCheckInUrl(url)) {
      throw new MonitoringInputError('pingUrl must be a Sentry Cron check-in URL (https://…/api/<project>/cron/<monitor>/<key>/)');
    }
  }
  const pingUrl = pingUrlValue === null ? existing!.encrypted_ping_url : encryptStoredSecret(pingUrlValue);
  // Sentry Crons takes failures on the same URL (status=error), so no separate failure URL.
  const failureUrl = format === 'sentry_crons'
    ? null
    : input.failureUrl === undefined
      ? existing?.encrypted_failure_url ?? null
      : input.failureUrl === null || input.failureUrl === ''
        ? null
        : encryptStoredSecret(validateHeartbeatUrl(input.failureUrl, 'failureUrl', true)!);
  if (input.id === undefined) {
    const count = await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM monitoring_heartbeats');
    if ((count.rows[0]?.count ?? 0) >= MAX_HEARTBEATS) throw new MonitoringInputError(`At most ${MAX_HEARTBEATS} heartbeat targets are supported`);
  }
  const result = input.id === undefined
    ? await query<HeartbeatRow>(
      `INSERT INTO monitoring_heartbeats
         (name, encrypted_ping_url, encrypted_failure_url, interval_seconds, minimum_fresh_locations, enabled, format)
       VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
      [input.name.trim(), pingUrl, failureUrl, intervalSeconds, minimumFreshLocations, input.enabled ?? true, format],
    )
    : await query<HeartbeatRow>(
      `UPDATE monitoring_heartbeats
       SET name = $2, encrypted_ping_url = $3, encrypted_failure_url = $4,
           interval_seconds = $5, minimum_fresh_locations = $6, enabled = $7, format = $8, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 RETURNING *`,
      [input.id, input.name.trim(), pingUrl, failureUrl, intervalSeconds, minimumFreshLocations, input.enabled ?? existing!.enabled, format],
    );
  if (!result.rows[0]) throw new MonitoringInputError('Heartbeat target not found');
  return publicTarget(result.rows[0]);
}

export async function deleteHeartbeatTarget(id: number): Promise<boolean> {
  const result = await query('DELETE FROM monitoring_heartbeats WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export function evaluateHeartbeatHealth(input: {
  now: number;
  databaseReachable: boolean;
  monitoringEnabled: boolean;
  lastSchedulerTickAt: number | null;
  overdueChecks: number;
  alertsEnabled: boolean;
  lastAlertCycleAt: number | null;
  alertIntervalMs: number;
  stuckDeliveries: number;
  minimumFreshLocations?: number;
  freshProbeLocations?: number;
  /** Local scheduler and delivery-worker signals only exist on the background-jobs leader. */
  isLeader?: boolean;
  /** When the process started; a first cycle not finished yet counts from here. */
  startedAt?: number;
}): HeartbeatHealth {
  const leader = input.isLeader ?? true;
  const since = (at: number | null) => input.now - (at ?? input.startedAt ?? Number.NEGATIVE_INFINITY);
  let reason: HeartbeatReason | null = null;
  if (!input.databaseReachable) reason = 'database';
  else if (!input.monitoringEnabled) reason = 'monitoring_disabled';
  else if ((leader && since(input.lastSchedulerTickAt) > SCHEDULER_STALE_MS)
    || input.overdueChecks > 0) reason = 'scheduler_lag';
  else if (input.alertsEnabled && ((leader && since(input.lastAlertCycleAt) > Math.max(input.alertIntervalMs * 3, ALERT_STALE_MIN_MS))
    || input.stuckDeliveries > 0)) reason = 'alert_backlog';
  else if ((input.minimumFreshLocations ?? 0) > (input.freshProbeLocations ?? 0)) reason = 'locations';
  return { healthy: reason === null, reason, checkedAt: input.now };
}

async function refreshHealth(minimumFreshLocations: number): Promise<HeartbeatHealth> {
  const now = Date.now();
  const cached = healthCache.get(minimumFreshLocations);
  if (cached && now < cached.refreshAt) return cached.health;
  try {
    await query('SELECT 1');
    const config = await getConfig();
    const scheduler = getMonitoringSchedulerHealth();
    const alerts = getAlertDeliveryWorkerHealth();
    const [overdue, backlog, freshLocations] = await Promise.all([
      config.monitoringEnabled
        ? query<{ count: number }>(
          `SELECT COUNT(*)::int AS count
           FROM monitoring_checks c JOIN monitoring_targets t ON t.id = c.target_id
           WHERE c.enabled AND t.enabled AND c.paused_at IS NULL
             AND EXISTS (
               SELECT 1 FROM monitoring_locations l
               WHERE l.location_key = 'local' AND l.enabled
                 AND (c.placement_mode = 'all' OR l.id = ANY(c.location_ids))
             )
             AND c.next_run_at < CURRENT_TIMESTAMP
               - GREATEST((CASE WHEN c.check_type = 'push' THEN LEAST(c.interval_seconds, 60) ELSE c.interval_seconds END) * 2, 120)
               * INTERVAL '1 second'`,
        )
        : Promise.resolve({ rows: [{ count: 0 }] }),
      config.alertsEnabled
        ? query<{ count: number }>(
          `SELECT COUNT(*)::int AS count FROM alert_deliveries
           WHERE (status = 'pending' AND attempts = 0 AND created_at < CURRENT_TIMESTAMP - ($1::double precision * INTERVAL '1 millisecond'))
              OR (status = 'processing' AND COALESCE(claimed_at, updated_at) < CURRENT_TIMESTAMP - ($1::double precision * INTERVAL '1 millisecond'))`,
          [Math.max(config.alertDeliveryIntervalMs * 3, 300_000)],
        )
        : Promise.resolve({ rows: [{ count: 0 }] }),
      minimumFreshLocations > 0
        ? query<{ count: number }>(
          `SELECT COUNT(DISTINCT l.id)::int AS count
           FROM monitoring_locations l
           JOIN monitoring_checks c ON c.enabled AND c.paused_at IS NULL
           JOIN monitoring_targets t ON t.id = c.target_id AND t.enabled
             AND (c.placement_mode = 'all' OR l.id = ANY(c.location_ids))
           JOIN LATERAL (
             SELECT o.received_at FROM monitoring_observations o
             WHERE o.check_id = c.id AND o.location_id = l.id
             ORDER BY o.observed_at DESC, o.id DESC LIMIT 1
           ) latest ON latest.received_at >= CURRENT_TIMESTAMP - GREATEST(c.interval_seconds * 2, 120) * INTERVAL '1 second'
           WHERE l.enabled AND NOT l.shadow`,
        )
        : Promise.resolve({ rows: [{ count: 0 }] }),
    ]);
    cachedHealth = evaluateHeartbeatHealth({
      now,
      databaseReachable: true,
      monitoringEnabled: config.monitoringEnabled,
      lastSchedulerTickAt: scheduler.lastSuccessfulTickAt,
      overdueChecks: overdue.rows[0]?.count ?? 0,
      alertsEnabled: config.alertsEnabled,
      lastAlertCycleAt: alerts.lastSuccessfulCycleAt,
      alertIntervalMs: config.alertDeliveryIntervalMs,
      stuckDeliveries: backlog.rows[0]?.count ?? 0,
      minimumFreshLocations,
      freshProbeLocations: freshLocations.rows[0]?.count ?? 0,
      isLeader: isBackgroundJobsLeader(),
      startedAt: processStartedAt,
    });
  } catch {
    cachedHealth = { healthy: false, reason: 'database', checkedAt: now };
  }
  healthCache.set(minimumFreshLocations, { refreshAt: now + HEALTH_CACHE_MS, health: cachedHealth });
  return cachedHealth;
}

export async function getHeartbeatHealth(): Promise<HeartbeatHealth> {
  return refreshHealth(0);
}

async function deliver(row: Pick<HeartbeatRow, 'format' | 'interval_seconds'>, url: string, status: 'ok' | 'fail' | 'test', reason: string | null): Promise<boolean> {
  const response = await sendAlertWebhook({
    adapter: 'generic',
    webhookUrl: url,
    payload: row.format === 'sentry_crons'
      ? sentryCronCheckIn(status === 'fail' ? 'error' : 'ok', row.interval_seconds)
      : { status, ...(reason ? { reason } : {}) },
    notificationId: randomUUID(),
    timeoutMs: 10000,
  });
  return response.accepted;
}

export async function sendHeartbeatTest(id: number): Promise<boolean> {
  const result = await query<HeartbeatRow>('SELECT * FROM monitoring_heartbeats WHERE id = $1', [id]);
  const row = result.rows[0];
  if (!row) throw new MonitoringInputError('Heartbeat target not found');
  return deliver(row, decryptStoredSecret(row.encrypted_ping_url), 'test', null);
}

export async function runHeartbeatsOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const rows = await query<HeartbeatRow>('SELECT * FROM monitoring_heartbeats WHERE enabled = true ORDER BY id');
    for (const row of rows.rows) {
      if (row.last_attempt_at && Date.now() - row.last_attempt_at.getTime() < row.interval_seconds * 1000) continue;
      const health = await refreshHealth(row.minimum_fresh_locations);
      await query('UPDATE monitoring_heartbeats SET last_attempt_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
      const reason = health.healthy ? null : health.reason;
      const destination = health.healthy || row.format === 'sentry_crons' ? row.encrypted_ping_url : row.encrypted_failure_url;
      let result: string;
      if (!destination) result = 'silenced';
      else {
        try {
          const accepted = await deliver(row, decryptStoredSecret(destination), health.healthy ? 'ok' : 'fail', reason);
          result = accepted ? (health.healthy ? 'sent' : 'failure_sent') : 'failed';
          if (!accepted) logger.warn('Monitoring heartbeat delivery was rejected', { heartbeatId: row.id, reason });
        } catch (error) {
          result = 'failed';
          logger.error('Monitoring heartbeat delivery failed', { heartbeatId: row.id, error: (error as Error).message });
        }
      }
      await query('UPDATE monitoring_heartbeats SET last_result = $2, last_reason = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id, result, reason]);
    }
  } catch (error) {
    logger.error('Monitoring heartbeat loop failed', { error: (error as Error).message });
  } finally {
    running = false;
  }
}

export function startMonitoringHeartbeats(): void {
  if (timer) return;
  timer = setInterval(() => void runHeartbeatsOnce(), LOOP_INTERVAL_MS);
  timer.unref();
  void runHeartbeatsOnce();
}

export function stopMonitoringHeartbeats(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}
