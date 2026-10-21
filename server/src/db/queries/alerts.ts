import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { getClient, query } from '../connection.js';
import { decryptStoredSecret, encryptStoredSecret } from './secret-crypto.js';
import { defaultAlertSubscriptions, normalizeAlertSubscriptions } from '../../services/alerts/alert-types.js';
import type {
  AlertDelivery,
  AlertDeliveryStatus,
  AlertEventKind,
  AlertServiceType,
  AlertSubscription,
  AlertType,
  AlertWebhook,
  AlertWebhookAdapter,
  JsonRecord,
} from '../../types/alerts.js';
type DbValue = string | number | boolean | Date | null;

interface WebhookRow {
  id: number;
  name: string;
  adapter: AlertWebhookAdapter;
  enabled: boolean;
  encrypted_url: string | null;
  subscriptions_json: unknown;
  consecutive_failures: number;
  repeat_interval_seconds: number | null;
  notify_recovery: boolean;
  paused_at: Date | null;
  paused_until: Date | null;
  pause_reason: string | null;
  sentry_org: string | null;
  sentry_api_url: string | null;
  encrypted_sentry_token: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DeliveryRow {
  id: number;
  notification_id: string;
  webhook_id: number | null;
  webhook_name: string;
  fleet_service_id: number | null;
  monitoring_issue_id: number | null;
  telemetry_alert_issue_id: string | null;
  service_id: string;
  service_name: string;
  service_type: AlertServiceType;
  alert_type: AlertType;
  event_kind: AlertEventKind;
  status: AlertDeliveryStatus;
  adapter: AlertWebhookAdapter;
  payload_json: unknown;
  attempts: number;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  claimed_at: Date | null;
  claim_token: string | null;
  response_status: number | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface ClaimedDeliveryRow extends DeliveryRow {
  encrypted_url: string | null;
  sentry_org: string | null;
  sentry_api_url: string | null;
  encrypted_sentry_token: string | null;
}

const WEBHOOK_COLUMNS = `
  id, name, adapter, enabled, encrypted_url, subscriptions_json, consecutive_failures,
  repeat_interval_seconds, notify_recovery, paused_at, paused_until, pause_reason,
  sentry_org, sentry_api_url, encrypted_sentry_token, created_at, updated_at
`;

const DELIVERY_COLUMNS = `
  id, notification_id, webhook_id, webhook_name, fleet_service_id, monitoring_issue_id,
  telemetry_alert_issue_id, telemetry_alert_issue_revision,
  service_id, service_name, service_type, alert_type, event_kind, status, adapter, payload_json,
  attempts, next_attempt_at, last_attempt_at, claimed_at, claim_token, response_status, error,
  created_at, updated_at, completed_at
`;

function telemetryIssueDeliveryIsCurrent(alias: string): string {
  return `EXISTS (
    SELECT 1 FROM telemetry_alert_issues i
    WHERE i.id = ${alias}.telemetry_alert_issue_id
      AND (
        (${alias}.event_kind = 'failure' AND i.status = 'active' AND i.dismissed_at IS NULL
          AND ${alias}.telemetry_alert_issue_revision = i.revision)
        OR (${alias}.event_kind = 'dismissed' AND (
          (i.status = 'dismissed' AND ${alias}.telemetry_alert_issue_revision = i.revision)
          OR i.status = 'resolved'
        ))
      )
  )`;
}

function mapWebhook(row: WebhookRow): AlertWebhook {
  return {
    id: row.id,
    name: row.name,
    adapter: row.adapter,
    enabled: row.enabled,
    hasSecret: Boolean(row.encrypted_url),
    subscriptions: normalizeAlertSubscriptions(row.subscriptions_json),
    consecutiveFailures: row.consecutive_failures,
    repeatIntervalSeconds: row.repeat_interval_seconds,
    notifyRecovery: row.notify_recovery,
    pausedAt: row.paused_at,
    pausedUntil: row.paused_until,
    pauseReason: row.pause_reason,
    sentryOrg: row.sentry_org,
    sentryApiUrl: row.sentry_api_url,
    hasSentryToken: Boolean(row.encrypted_sentry_token),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapDelivery(row: DeliveryRow): AlertDelivery {
  return {
    id: row.id,
    notificationId: row.notification_id,
    webhookId: row.webhook_id,
    webhookName: row.webhook_name,
    fleetServiceId: row.fleet_service_id,
    monitoringIssueId: row.monitoring_issue_id,
    telemetryAlertIssueId: row.telemetry_alert_issue_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    serviceType: row.service_type,
    alertType: row.alert_type,
    eventKind: row.event_kind,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    responseStatus: row.response_status,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export async function listAlertWebhooks(): Promise<AlertWebhook[]> {
  const result = await query<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM alert_webhooks ORDER BY name ASC, id ASC`
  );
  return result.rows.map(mapWebhook);
}

export async function getAlertWebhook(id: number): Promise<AlertWebhook | null> {
  const result = await query<WebhookRow>(
    `SELECT ${WEBHOOK_COLUMNS} FROM alert_webhooks WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? mapWebhook(result.rows[0]) : null;
}

export async function createAlertWebhook(input: {
  name: string;
  adapter: AlertWebhookAdapter;
  webhookUrl: string;
  enabled: boolean;
  subscriptions?: AlertSubscription[];
  consecutiveFailures?: number;
  repeatIntervalSeconds?: number | null;
  notifyRecovery?: boolean;
  sentryOrg?: string | null;
  sentryApiUrl?: string | null;
  sentryApiToken?: string | null;
  actorId?: number | null;
}): Promise<AlertWebhook> {
  const result = await query<WebhookRow>(
    `INSERT INTO alert_webhooks (
       name, adapter, encrypted_url, enabled, subscriptions_json, consecutive_failures,
       repeat_interval_seconds, notify_recovery, created_by, updated_by,
       sentry_org, sentry_api_url, encrypted_sentry_token
     )
     VALUES ($1, $2, $3, $4, $5::jsonb, $6, $7, $8, $9, $9, $10, $11, $12)
     RETURNING ${WEBHOOK_COLUMNS}`,
    [
      input.name,
      input.adapter,
      encryptStoredSecret(input.webhookUrl),
      input.enabled,
      JSON.stringify(input.subscriptions ?? defaultAlertSubscriptions()),
      input.consecutiveFailures ?? 3,
      input.repeatIntervalSeconds ?? 14400,
      input.notifyRecovery ?? true,
      input.actorId ?? null,
      input.sentryOrg ?? null,
      input.sentryApiUrl ?? null,
      input.sentryApiToken ? encryptStoredSecret(input.sentryApiToken) : null,
    ]
  );
  return mapWebhook(result.rows[0]);
}

export async function updateAlertWebhook(id: number, input: {
  name?: string;
  adapter?: AlertWebhookAdapter;
  webhookUrl?: string;
  enabled?: boolean;
  subscriptions?: AlertSubscription[];
  consecutiveFailures?: number;
  repeatIntervalSeconds?: number | null;
  notifyRecovery?: boolean;
  sentryOrg?: string | null;
  sentryApiUrl?: string | null;
  /** Write-only: undefined keeps the stored token, null clears it. */
  sentryApiToken?: string | null;
  actorId?: number | null;
}): Promise<AlertWebhook | null> {
  const sets: string[] = [];
  const values: DbValue[] = [];
  let index = 1;
  const add = (column: string, value: DbValue, cast = '') => {
    sets.push(`${column} = $${index++}${cast}`);
    values.push(value);
  };
  if (input.name !== undefined) add('name', input.name);
  if (input.adapter !== undefined) add('adapter', input.adapter);
  if (input.webhookUrl !== undefined) add('encrypted_url', encryptStoredSecret(input.webhookUrl));
  if (input.enabled !== undefined) add('enabled', input.enabled);
  if (input.subscriptions !== undefined) add('subscriptions_json', JSON.stringify(input.subscriptions), '::jsonb');
  if (input.consecutiveFailures !== undefined) add('consecutive_failures', input.consecutiveFailures);
  if (input.repeatIntervalSeconds !== undefined) add('repeat_interval_seconds', input.repeatIntervalSeconds);
  if (input.notifyRecovery !== undefined) add('notify_recovery', input.notifyRecovery);
  if (input.sentryOrg !== undefined) add('sentry_org', input.sentryOrg);
  if (input.sentryApiUrl !== undefined) add('sentry_api_url', input.sentryApiUrl);
  if (input.sentryApiToken !== undefined) add('encrypted_sentry_token', input.sentryApiToken ? encryptStoredSecret(input.sentryApiToken) : null);
  if (input.actorId !== undefined) add('updated_by', input.actorId);
  if (sets.length === 0) {
    return getAlertWebhook(id);
  }
  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  const result = await query<WebhookRow>(
    `UPDATE alert_webhooks SET ${sets.join(', ')} WHERE id = $${index} RETURNING ${WEBHOOK_COLUMNS}`,
    values
  );
  if (input.enabled === false) {
    await cancelPendingDeliveries(id, 'Webhook disabled');
  }
  return result.rows[0] ? mapWebhook(result.rows[0]) : null;
}

export async function deleteAlertWebhook(id: number): Promise<boolean> {
  await cancelPendingDeliveries(id, 'Webhook deleted');
  const result = await query('DELETE FROM alert_webhooks WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function pauseAlertWebhook(id: number, pausedUntil: Date | null, reason: string | null): Promise<AlertWebhook | null> {
  const result = await query<WebhookRow>(
    `UPDATE alert_webhooks
     SET paused_at = CURRENT_TIMESTAMP, paused_until = $2, pause_reason = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${WEBHOOK_COLUMNS}`,
    [id, pausedUntil, reason]
  );
  if (result.rows[0]) {
    await cancelPendingDeliveries(id, 'Webhook paused');
  }
  return result.rows[0] ? mapWebhook(result.rows[0]) : null;
}

export async function resumeAlertWebhook(id: number): Promise<AlertWebhook | null> {
  const result = await query<WebhookRow>(
    `UPDATE alert_webhooks
     SET paused_at = NULL, paused_until = NULL, pause_reason = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${WEBHOOK_COLUMNS}`,
    [id]
  );
  return result.rows[0] ? mapWebhook(result.rows[0]) : null;
}

export async function clearExpiredAlertPauses(client?: PoolClient): Promise<void> {
  const text = `UPDATE alert_webhooks
     SET paused_at = NULL, paused_until = NULL, pause_reason = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE paused_at IS NOT NULL AND paused_until IS NOT NULL AND paused_until <= CURRENT_TIMESTAMP`;
  if (client) {
    await client.query(text);
  } else {
    await query(text);
  }
}

async function cancelPendingDeliveries(webhookId: number, reason: string): Promise<void> {
  await query(
    `UPDATE alert_deliveries
     SET status = 'cancelled', error = $2, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE webhook_id = $1 AND status = 'pending'`,
    [webhookId, reason]
  );
}

export async function cancelUnavailableAlertDeliveries(): Promise<void> {
  await query(`
    UPDATE alert_deliveries d
    SET status = 'cancelled',
        error = CASE WHEN w.id IS NULL THEN 'Webhook deleted' ELSE 'Webhook unavailable' END,
        completed_at = CURRENT_TIMESTAMP,
        updated_at = CURRENT_TIMESTAMP
    FROM alert_deliveries candidate
    LEFT JOIN alert_webhooks w ON w.id = candidate.webhook_id
    WHERE d.id = candidate.id
      AND d.status = 'pending'
      AND (w.id IS NULL OR w.enabled = false
        OR (w.paused_at IS NOT NULL AND (w.paused_until IS NULL OR w.paused_until > CURRENT_TIMESTAMP)))
  `);
}

export async function expireStaleAlertDeliveries(maxAgeMs: number): Promise<number> {
  if (!Number.isInteger(maxAgeMs) || maxAgeMs < 1) throw new Error('Delivery expiry must be a positive whole number of milliseconds');
  const result = await query(
    `UPDATE alert_deliveries
     SET status = 'expired', error = 'Expired before delivery because the alert backlog exceeded its age limit',
         completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE status = 'pending'
       AND attempts = 0
       AND created_at <= CURRENT_TIMESTAMP - ($1::double precision * INTERVAL '1 millisecond')`,
    [maxAgeMs]
  );
  return result.rowCount ?? 0;
}

export async function createAlertDelivery(input: {
  notificationId?: string;
  dedupeKey: string;
  webhookId: number;
  webhookName: string;
  fleetServiceId: number | null;
  monitoringIssueId?: number | null;
  telemetryAlertIssueId?: string | null;
  telemetryAlertIssueRevision?: number | null;
  serviceId: string;
  serviceName: string;
  serviceType: AlertServiceType;
  alertType: AlertType;
  eventKind: AlertEventKind;
  adapter: AlertWebhookAdapter;
  payload: JsonRecord;
  client?: PoolClient;
}): Promise<AlertDelivery> {
  const notificationId = input.notificationId ?? randomUUID();
  const text = `WITH inserted AS (
       INSERT INTO alert_deliveries (
         notification_id, dedupe_key, webhook_id, webhook_name, fleet_service_id, monitoring_issue_id,
         telemetry_alert_issue_id, telemetry_alert_issue_revision,
         service_id, service_name, service_type, alert_type, event_kind, adapter, payload_json
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15::jsonb)
       ON CONFLICT (dedupe_key) DO NOTHING
       RETURNING ${DELIVERY_COLUMNS}
     )
     SELECT * FROM inserted
     UNION ALL
     SELECT ${DELIVERY_COLUMNS} FROM alert_deliveries WHERE dedupe_key = $2
     LIMIT 1`;
  const values = [
      notificationId,
      input.dedupeKey,
      input.webhookId,
      input.webhookName,
      input.fleetServiceId,
      input.monitoringIssueId ?? null,
      input.telemetryAlertIssueId ?? null,
      input.telemetryAlertIssueRevision ?? null,
      input.serviceId,
      input.serviceName,
      input.serviceType,
      input.alertType,
      input.eventKind,
      input.adapter,
      JSON.stringify(input.payload),
    ];
  const result = input.client
    ? await input.client.query<DeliveryRow>(text, values)
    : await query<DeliveryRow>(text, values);
  return mapDelivery(result.rows[0]);
}

export async function listAlertDeliveries(limit = 50): Promise<AlertDelivery[]> {
  const result = await query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
     FROM alert_deliveries
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 100))]
  );
  return result.rows.map(mapDelivery);
}

export interface ClaimedAlertDelivery extends AlertDelivery {
  adapter: AlertWebhookAdapter;
  payload: JsonRecord;
  webhookUrl: string | null;
  sentry: { org: string | null; apiUrl: string | null; apiToken: string | null };
  claimToken: string;
  claimError: string | null;
}

export async function claimDueAlertDeliveries(limit: number): Promise<ClaimedAlertDelivery[]> {
  await cancelUnavailableAlertDeliveries();
  const client = await getClient();
  const claimToken = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE alert_deliveries
      SET status = CASE WHEN telemetry_alert_issue_id IS NOT NULL
          AND event_kind IN ('failure', 'dismissed')
          AND NOT ${telemetryIssueDeliveryIsCurrent('alert_deliveries')}
          THEN 'cancelled' ELSE 'pending' END,
          error = CASE WHEN telemetry_alert_issue_id IS NOT NULL
              AND event_kind IN ('failure', 'dismissed')
              AND NOT ${telemetryIssueDeliveryIsCurrent('alert_deliveries')}
              THEN 'Telemetry alert issue changed before delivery' ELSE error END,
          claim_token = NULL, claimed_at = NULL,
          next_attempt_at = CASE WHEN telemetry_alert_issue_id IS NOT NULL
              AND event_kind IN ('failure', 'dismissed')
              AND NOT ${telemetryIssueDeliveryIsCurrent('alert_deliveries')}
              THEN NULL ELSE CURRENT_TIMESTAMP END,
          completed_at = CASE WHEN telemetry_alert_issue_id IS NOT NULL
              AND event_kind IN ('failure', 'dismissed')
              AND NOT ${telemetryIssueDeliveryIsCurrent('alert_deliveries')}
              THEN CURRENT_TIMESTAMP ELSE NULL END,
          updated_at = CURRENT_TIMESTAMP
      WHERE status = 'processing' AND claimed_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
    `);
    const result = await client.query<ClaimedDeliveryRow>(
      `WITH due AS (
         SELECT d.id, w.encrypted_url, w.sentry_org, w.sentry_api_url, w.encrypted_sentry_token
         FROM alert_deliveries d
         JOIN alert_webhooks w ON w.id = d.webhook_id
         WHERE d.status = 'pending'
           AND (d.next_attempt_at IS NULL OR d.next_attempt_at <= CURRENT_TIMESTAMP)
           AND w.enabled = true
           AND w.encrypted_url IS NOT NULL
           AND (w.paused_at IS NULL OR (w.paused_until IS NOT NULL AND w.paused_until <= CURRENT_TIMESTAMP))
           AND (d.telemetry_alert_issue_id IS NULL OR d.event_kind NOT IN ('failure', 'dismissed')
             OR ${telemetryIssueDeliveryIsCurrent('d')})
         ORDER BY d.created_at ASC, d.id ASC
         LIMIT $1
         FOR UPDATE OF d SKIP LOCKED
       )
       UPDATE alert_deliveries d
       SET status = 'processing', attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP,
           claimed_at = CURRENT_TIMESTAMP, claim_token = $2, updated_at = CURRENT_TIMESTAMP
       FROM due
       WHERE d.id = due.id
       RETURNING ${DELIVERY_COLUMNS.split(',').map((column) => `d.${column.trim()}`).join(', ')}, due.encrypted_url,
         due.sentry_org, due.sentry_api_url, due.encrypted_sentry_token`,
      [Math.max(1, Math.min(limit, 25)), claimToken]
    );
    await client.query('COMMIT');
    return result.rows.map((row) => {
      try {
        return {
          ...mapDelivery(row),
          adapter: row.adapter,
          payload: row.payload_json && typeof row.payload_json === 'object' ? row.payload_json as JsonRecord : {},
          webhookUrl: decryptStoredSecret(row.encrypted_url ?? ''),
          sentry: {
            org: row.sentry_org,
            apiUrl: row.sentry_api_url,
            apiToken: row.encrypted_sentry_token ? decryptStoredSecret(row.encrypted_sentry_token) : null,
          },
          claimToken,
          claimError: null,
        };
      } catch {
        return {
          ...mapDelivery(row),
          adapter: row.adapter,
          payload: row.payload_json && typeof row.payload_json === 'object' ? row.payload_json as JsonRecord : {},
          webhookUrl: null,
          sentry: { org: null, apiUrl: null, apiToken: null },
          claimToken,
          claimError: 'Webhook secret could not be decrypted',
        };
      }
    });
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeAlertDelivery(input: {
  id: number;
  claimToken: string;
  status: Extract<AlertDeliveryStatus, 'pending' | 'accepted' | 'failed' | 'cancelled' | 'expired'>;
  responseStatus?: number | null;
  error?: string | null;
  nextAttemptAt?: Date | null;
}): Promise<boolean> {
  const terminal = input.status !== 'pending';
  const result = await query(
    `UPDATE alert_deliveries AS d
     SET status = CASE WHEN $3 = 'pending' AND d.telemetry_alert_issue_id IS NOT NULL
         AND d.event_kind IN ('failure', 'dismissed')
         AND NOT ${telemetryIssueDeliveryIsCurrent('d')} THEN 'cancelled' ELSE $3::varchar END,
         response_status = $4,
         error = CASE WHEN $3 = 'pending' AND d.telemetry_alert_issue_id IS NOT NULL
             AND d.event_kind IN ('failure', 'dismissed')
             AND NOT ${telemetryIssueDeliveryIsCurrent('d')}
             THEN 'Telemetry alert issue changed before delivery' ELSE $5::text END,
         next_attempt_at = CASE WHEN $3 = 'pending' AND d.telemetry_alert_issue_id IS NOT NULL
             AND d.event_kind IN ('failure', 'dismissed')
             AND NOT ${telemetryIssueDeliveryIsCurrent('d')} THEN NULL ELSE $6::timestamptz END,
         claim_token = NULL, claimed_at = NULL,
         completed_at = CASE WHEN $7::boolean OR ($3 = 'pending' AND d.telemetry_alert_issue_id IS NOT NULL
             AND d.event_kind IN ('failure', 'dismissed')
             AND NOT ${telemetryIssueDeliveryIsCurrent('d')}) THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE d.id = $1 AND d.claim_token = $2 AND d.status = 'processing'
    `,
    [
      input.id,
      input.claimToken,
      input.status,
      input.responseStatus ?? null,
      input.error?.slice(0, 500) ?? null,
      input.nextAttemptAt ?? null,
      terminal,
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getAlertRuntimeSummary(): Promise<{
  enabledWebhooks: number;
  pausedWebhooks: number;
  pendingDeliveries: number;
  failedDeliveries: number;
}> {
  const result = await query<{
    enabled_webhooks: string;
    paused_webhooks: string;
    pending_deliveries: string;
    failed_deliveries: string;
  }>(`
    SELECT
      (SELECT COUNT(*) FROM alert_webhooks WHERE enabled = true) AS enabled_webhooks,
      (SELECT COUNT(*) FROM alert_webhooks WHERE paused_at IS NOT NULL
        AND (paused_until IS NULL OR paused_until > CURRENT_TIMESTAMP)) AS paused_webhooks,
      (SELECT COUNT(*) FROM alert_deliveries WHERE status IN ('pending', 'processing')) AS pending_deliveries,
      (SELECT COUNT(*) FROM alert_deliveries WHERE status = 'failed') AS failed_deliveries
  `);
  return {
    enabledWebhooks: Number(result.rows[0]?.enabled_webhooks ?? 0),
    pausedWebhooks: Number(result.rows[0]?.paused_webhooks ?? 0),
    pendingDeliveries: Number(result.rows[0]?.pending_deliveries ?? 0),
    failedDeliveries: Number(result.rows[0]?.failed_deliveries ?? 0),
  };
}
