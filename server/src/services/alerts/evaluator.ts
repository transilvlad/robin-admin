import { randomUUID } from 'crypto';
import type { PoolClient } from 'pg';
import { operationsPolicy } from '../operations-settings.js';
import { getClient } from '../../db/connection.js';
import { clearExpiredAlertPauses, createAlertDelivery } from '../../db/queries/alerts.js';
import type {
  AlertCatalogEntry,
  AlertEvidence,
  AlertEventKind,
  AlertSubscription,
  AlertType,
  AlertWebhookAdapter,
  JsonRecord,
} from '../../types/alerts.js';
import type { FleetServiceType } from '../service-types.js';
import { ALERT_CATALOG } from './alert-types.js';
import { buildSentryAlertPayload } from './sentry.js';

const EVALUATOR_LOCK_ID = 846_255_031;
// Rate alerts (bounce/deferral share, auth failures) look back this far.
const RATE_WINDOW_MINUTES = 15;
// Below this many delivery attempts in the window a bounce rate is noise.
const BOUNCE_RATE_MIN_ATTEMPTS = 20;
// Below this many buffer pool reads in the window a hit ratio is noise (an
// idle server, or one still warming up after a restart).
const BUFFER_POOL_MIN_READ_REQUESTS = 1000;

export interface EvaluationRow {
  fleet_service_id: number;
  service_id: string;
  service_name: string;
  service_type: FleetServiceType;
  observation_key: string | null;
  observed_at: Date | null;
  reachable: boolean | null;
  postfix_timestamp: Date | null;
  queue_total: string | null;
  queue_deferred: string | null;
  oldest_deferred_age_secs: string | null;
  postfix_window_delivered: string | null;
  postfix_window_deferred: string | null;
  postfix_window_bounced: string | null;
  cyrus_timestamp: Date | null;
  cyrus_window_auth_failures: string | null;
  dovecot_timestamp: Date | null;
  dovecot_window_auth_failures: string | null;
  postgres_timestamp: Date | null;
  connection_saturation_pct: number | null;
  pg_blks_hit: string | null;
  pg_blks_read: string | null;
  pg_cache_hit_ratio: number | null;
  mariadb_timestamp: Date | null;
  mariadb_saturation_pct: number | null;
  mariadb_window_read_requests: string | null;
  mariadb_window_reads: string | null;
  mariadb_oldest_trx_age_secs: string | null;
  mariadb_is_replica: boolean | null;
  mariadb_replica_running: boolean | null;
  mariadb_seconds_behind_source: string | null;
  redis_timestamp: Date | null;
  keyspace_hits: string | null;
  keyspace_misses: string | null;
  redis_hit_ratio: number | null;
  clamav_timestamp: Date | null;
  database_updated_at: Date | null;
}

interface WebhookEvaluationRow {
  id: number;
  name: string;
  adapter: AlertWebhookAdapter;
  subscriptions_json: unknown;
  consecutive_failures: number;
  repeat_interval_seconds: number | null;
  notify_recovery: boolean;
  paused_at: Date | null;
  paused_until: Date | null;
}

interface StateRow {
  failing: boolean;
  consecutive_failures: number;
  generation: string;
  last_observation_key: string | null;
  failure_started_at: Date | null;
  last_notification_at: Date | null;
  failure_notified: boolean;
}

export interface AlertStateSnapshot {
  failing: boolean;
  consecutiveFailures: number;
  generation: number;
  lastObservationKey: string | null;
  failureStartedAt: Date | null;
  lastNotificationAt: Date | null;
  failureNotified: boolean;
}

export interface AlertStateTransition {
  state: AlertStateSnapshot;
  eventKind: AlertEventKind | null;
}

export function transitionAlertState(input: {
  previous: AlertStateSnapshot;
  evidence: AlertEvidence;
  requiredFailures: number;
  repeatIntervalSeconds: number | null;
  notifyRecovery: boolean;
  paused: boolean;
  now: Date;
}): AlertStateTransition {
  const { previous, evidence, now } = input;
  if (evidence.failing === null) {
    return {
      state: previous.failing
        ? previous
        : { ...previous, consecutiveFailures: 0, lastObservationKey: evidence.observationKey },
      eventKind: null,
    };
  }

  const isNewObservation = evidence.observationKey !== previous.lastObservationKey;
  if (evidence.failing) {
    const newlyFailing = !previous.failing;
    const generation = newlyFailing ? previous.generation + 1 : previous.generation;
    const consecutiveFailures = newlyFailing
      ? 1
      : previous.consecutiveFailures + (isNewObservation ? 1 : 0);
    const state: AlertStateSnapshot = {
      failing: true,
      consecutiveFailures,
      generation,
      lastObservationKey: evidence.observationKey,
      failureStartedAt: newlyFailing ? now : previous.failureStartedAt,
      lastNotificationAt: previous.lastNotificationAt,
      failureNotified: newlyFailing ? false : previous.failureNotified,
    };
    if (input.paused || consecutiveFailures < input.requiredFailures) {
      return { state, eventKind: null };
    }
    if (!state.failureNotified) {
      state.failureNotified = true;
      state.lastNotificationAt = now;
      return { state, eventKind: 'failure' };
    }
    if (input.repeatIntervalSeconds !== null && state.lastNotificationAt
      && now.getTime() - state.lastNotificationAt.getTime() >= input.repeatIntervalSeconds * 1000) {
      state.lastNotificationAt = now;
      return { state, eventKind: 'repeat' };
    }
    return { state, eventKind: null };
  }

  if (!previous.failing) {
    return {
      state: { ...previous, consecutiveFailures: 0, lastObservationKey: evidence.observationKey },
      eventKind: null,
    };
  }
  const shouldRecover = previous.failureNotified && input.notifyRecovery && !input.paused;
  return {
    state: {
      failing: false,
      consecutiveFailures: 0,
      generation: previous.generation,
      lastObservationKey: evidence.observationKey,
      failureStartedAt: null,
      lastNotificationAt: previous.lastNotificationAt,
      failureNotified: false,
    },
    eventKind: shouldRecover ? 'recovery' : null,
  };
}

export async function runAlertEvaluation(now = new Date()): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const lock = await client.query<{ locked: boolean }>(
      'SELECT pg_try_advisory_xact_lock($1) AS locked',
      [EVALUATOR_LOCK_ID]
    );
    if (!lock.rows[0]?.locked) {
      await client.query('ROLLBACK');
      return false;
    }
    await clearExpiredAlertPauses(client);
    const webhooks = await client.query<WebhookEvaluationRow>(
      `SELECT id, name, adapter, subscriptions_json, consecutive_failures, repeat_interval_seconds,
              notify_recovery, paused_at, paused_until
       FROM alert_webhooks
       WHERE enabled = true AND encrypted_url IS NOT NULL
       ORDER BY id`
    );
    const services = await loadEvaluationRows(client);
    for (const webhook of webhooks.rows) {
      const subscriptions = normalizeStoredSubscriptions(webhook.subscriptions_json);
      const paused = webhook.paused_at !== null
        && (webhook.paused_until === null || webhook.paused_until > now);
      for (const subscription of subscriptions.filter((item) => item.enabled)) {
        for (const service of services.filter((item) => appliesTo(subscription.alertType, item.service_type))) {
          const evidence = buildEvidence(service, subscription, now);
          await evaluateOne(client, webhook, subscription, evidence, paused, now);
        }
      }
    }
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function evaluateOne(
  client: PoolClient,
  webhook: WebhookEvaluationRow,
  subscription: AlertSubscription,
  evidence: AlertEvidence,
  paused: boolean,
  now: Date
): Promise<void> {
  await client.query(
    `INSERT INTO alert_state (webhook_id, fleet_service_id, alert_type)
     VALUES ($1, $2, $3)
     ON CONFLICT (webhook_id, fleet_service_id, alert_type) DO NOTHING`,
    [webhook.id, evidence.fleetServiceId, subscription.alertType]
  );
  const stateResult = await client.query<StateRow>(
    `SELECT failing, consecutive_failures, generation, last_observation_key,
            failure_started_at, last_notification_at, failure_notified
     FROM alert_state
     WHERE webhook_id = $1 AND fleet_service_id = $2 AND alert_type = $3
     FOR UPDATE`,
    [webhook.id, evidence.fleetServiceId, subscription.alertType]
  );
  const row = stateResult.rows[0];
  const previous: AlertStateSnapshot = {
    failing: row.failing,
    consecutiveFailures: row.consecutive_failures,
    generation: Number(row.generation),
    lastObservationKey: row.last_observation_key,
    failureStartedAt: row.failure_started_at,
    lastNotificationAt: row.last_notification_at,
    failureNotified: row.failure_notified,
  };
  const transition = transitionAlertState({
    previous,
    evidence,
    requiredFailures: webhook.consecutive_failures,
    repeatIntervalSeconds: webhook.repeat_interval_seconds,
    notifyRecovery: webhook.notify_recovery,
    paused,
    now,
  });
  await client.query(
    `UPDATE alert_state
     SET failing = $4, consecutive_failures = $5, generation = $6, last_observation_key = $7,
         failure_started_at = $8, last_notification_at = $9, failure_notified = $10,
         updated_at = CURRENT_TIMESTAMP
     WHERE webhook_id = $1 AND fleet_service_id = $2 AND alert_type = $3`,
    [
      webhook.id,
      evidence.fleetServiceId,
      subscription.alertType,
      transition.state.failing,
      transition.state.consecutiveFailures,
      transition.state.generation,
      transition.state.lastObservationKey,
      transition.state.failureStartedAt,
      transition.state.lastNotificationAt,
      transition.state.failureNotified,
    ]
  );
  if (!transition.eventKind) {
    return;
  }
  const repeatSlot = transition.eventKind === 'repeat' && webhook.repeat_interval_seconds
    ? Math.floor(now.getTime() / (webhook.repeat_interval_seconds * 1000))
    : 0;
  const dedupeKey = [
    webhook.id,
    evidence.fleetServiceId,
    evidence.alertType,
    transition.state.generation,
    transition.eventKind,
    repeatSlot,
  ].join(':');
  const notificationId = randomUUID();
  const payload = buildPayload(webhook, evidence, transition.eventKind, notificationId);
  // Sentry destinations skip repeats: Sentry's alert rules re-notify.
  if (!payload) return;
  await createAlertDelivery({
    notificationId,
    dedupeKey,
    webhookId: webhook.id,
    webhookName: webhook.name,
    fleetServiceId: evidence.fleetServiceId,
    serviceId: evidence.serviceId,
    serviceName: evidence.serviceName,
    serviceType: evidence.serviceType,
    alertType: evidence.alertType,
    eventKind: transition.eventKind,
    adapter: webhook.adapter,
    payload,
    client,
  });
}

function normalizeStoredSubscriptions(value: unknown): AlertSubscription[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is AlertSubscription => (
    Boolean(item)
    && typeof item === 'object'
    && typeof (item as AlertSubscription).alertType === 'string'
    && typeof (item as AlertSubscription).enabled === 'boolean'
  ));
}

function appliesTo(alertType: AlertType, serviceType: FleetServiceType): boolean {
  return ALERT_CATALOG.find((entry) => entry.key === alertType)?.serviceTypes.includes(serviceType) ?? false;
}

export function buildEvidence(row: EvaluationRow, subscription: AlertSubscription, now: Date): AlertEvidence {
  const definition = ALERT_CATALOG.find((entry) => entry.key === subscription.alertType)!;
  let value: number | boolean | null = null;
  let observedAt = row.observed_at ?? now;
  let observationKey = row.observation_key ?? 'missing';

  switch (subscription.alertType) {
    case 'availability':
      value = row.reachable;
      break;
    case 'telemetry_stale': {
      value = row.observed_at
        ? (now.getTime() - row.observed_at.getTime()) / 1000
        : Number.POSITIVE_INFINITY;
      const interval = operationsPolicy().alertEvaluationIntervalMs;
      observationKey = `stale:${Math.floor(now.getTime() / interval)}`;
      break;
    }
    case 'postfix_queue':
      value = row.reachable === true && row.postfix_timestamp ? numberValue(row.queue_total) : null;
      observedAt = row.postfix_timestamp ?? observedAt;
      observationKey = row.postfix_timestamp?.toISOString() ?? 'missing';
      break;
    case 'postfix_deferred_age': {
      const deferred = numberValue(row.queue_deferred);
      const age = numberValue(row.oldest_deferred_age_secs);
      value = row.reachable === true && row.postfix_timestamp && deferred !== null && age !== null && (deferred === 0 || age > 0) ? age : null;
      observedAt = row.postfix_timestamp ?? observedAt;
      observationKey = row.postfix_timestamp?.toISOString() ?? 'missing';
      break;
    }
    case 'postfix_bounce_rate': {
      const delivered = numberValue(row.postfix_window_delivered) ?? 0;
      const failed = (numberValue(row.postfix_window_deferred) ?? 0) + (numberValue(row.postfix_window_bounced) ?? 0);
      const attempts = delivered + failed;
      value = row.reachable === true && row.postfix_timestamp
        ? (attempts >= BOUNCE_RATE_MIN_ATTEMPTS ? (failed / attempts) * 100 : 0)
        : null;
      observedAt = row.postfix_timestamp ?? observedAt;
      observationKey = row.postfix_timestamp?.toISOString() ?? 'missing';
      break;
    }
    case 'cyrus_auth_failures':
      value = row.reachable === true && row.cyrus_timestamp ? numberValue(row.cyrus_window_auth_failures) ?? 0 : null;
      observedAt = row.cyrus_timestamp ?? observedAt;
      observationKey = row.cyrus_timestamp?.toISOString() ?? 'missing';
      break;
    case 'dovecot_auth_failures':
      value = row.reachable === true && row.dovecot_timestamp ? numberValue(row.dovecot_window_auth_failures) ?? 0 : null;
      observedAt = row.dovecot_timestamp ?? observedAt;
      observationKey = row.dovecot_timestamp?.toISOString() ?? 'missing';
      break;
    case 'postgres_connections':
      value = row.reachable === true && row.postgres_timestamp ? row.connection_saturation_pct : null;
      observedAt = row.postgres_timestamp ?? observedAt;
      observationKey = row.postgres_timestamp?.toISOString() ?? 'missing';
      break;
    case 'postgres_cache_hit': {
      const total = (numberValue(row.pg_blks_hit) ?? 0) + (numberValue(row.pg_blks_read) ?? 0);
      value = row.reachable === true && row.postgres_timestamp && total > 0 && row.pg_cache_hit_ratio !== null
        ? row.pg_cache_hit_ratio * 100
        : null;
      observedAt = row.postgres_timestamp ?? observedAt;
      observationKey = row.postgres_timestamp?.toISOString() ?? 'missing';
      break;
    }
    case 'mariadb_connections':
      value = row.reachable === true && row.mariadb_timestamp ? row.mariadb_saturation_pct : null;
      observedAt = row.mariadb_timestamp ?? observedAt;
      observationKey = row.mariadb_timestamp?.toISOString() ?? 'missing';
      break;
    case 'mariadb_buffer_pool_hit': {
      // Over the rate window, not since startup: a restart's cold cache
      // neither drags the ratio down for hours nor hides a fresh drop.
      const requests = numberValue(row.mariadb_window_read_requests) ?? 0;
      const reads = numberValue(row.mariadb_window_reads) ?? 0;
      value = row.reachable === true && row.mariadb_timestamp && requests >= BUFFER_POOL_MIN_READ_REQUESTS
        ? Math.max(0, 1 - reads / requests) * 100
        : null;
      observedAt = row.mariadb_timestamp ?? observedAt;
      observationKey = row.mariadb_timestamp?.toISOString() ?? 'missing';
      break;
    }
    case 'mariadb_long_transaction':
      value = row.reachable === true && row.mariadb_timestamp ? numberValue(row.mariadb_oldest_trx_age_secs) : null;
      observedAt = row.mariadb_timestamp ?? observedAt;
      observationKey = row.mariadb_timestamp?.toISOString() ?? 'missing';
      break;
    case 'mariadb_replica_lag':
      // Not a replica: nothing to measure. Stopped threads never catch up.
      value = row.reachable === true && row.mariadb_timestamp && row.mariadb_is_replica
        ? (row.mariadb_replica_running ? numberValue(row.mariadb_seconds_behind_source) ?? Number.POSITIVE_INFINITY : Number.POSITIVE_INFINITY)
        : null;
      observedAt = row.mariadb_timestamp ?? observedAt;
      observationKey = row.mariadb_timestamp?.toISOString() ?? 'missing';
      break;
    case 'redis_hit_ratio': {
      const total = (numberValue(row.keyspace_hits) ?? 0) + (numberValue(row.keyspace_misses) ?? 0);
      value = row.reachable === true && row.redis_timestamp && total > 0 && row.redis_hit_ratio !== null
        ? row.redis_hit_ratio * 100
        : null;
      observedAt = row.redis_timestamp ?? observedAt;
      observationKey = row.redis_timestamp?.toISOString() ?? 'missing';
      break;
    }
    case 'clamav_database_age':
      value = row.reachable === true && row.clamav_timestamp && row.database_updated_at
        ? (now.getTime() - row.database_updated_at.getTime()) / 1000
        : null;
      observedAt = row.clamav_timestamp ?? observedAt;
      observationKey = row.clamav_timestamp?.toISOString() ?? 'missing';
      break;
  }

  const failing = isAlertThresholdFailing(definition, value, subscription.threshold);
  return {
    alertType: subscription.alertType,
    fleetServiceId: row.fleet_service_id,
    serviceId: row.service_id,
    serviceName: row.service_name,
    serviceType: row.service_type,
    observationKey,
    failing,
    value,
    threshold: subscription.threshold,
    unit: definition.unit,
    observedAt,
  };
}

export function isAlertThresholdFailing(
  definition: AlertCatalogEntry,
  value: number | boolean | null,
  threshold: number | null
): boolean | null {
  if (value === null) return null;
  if (value === Number.POSITIVE_INFINITY) return definition.direction === 'above';
  if (definition.direction === 'boolean') return value === false;
  if (threshold === null) return null;
  return definition.direction === 'above'
    ? Number(value) > threshold
    : Number(value) < threshold;
}

function numberValue(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildPayload(
  webhook: Pick<WebhookEvaluationRow, 'id' | 'name' | 'adapter'>,
  evidence: AlertEvidence,
  eventKind: AlertEventKind,
  notificationId: string
): JsonRecord | null {
  const definition = ALERT_CATALOG.find((entry) => entry.key === evidence.alertType)!;
  const recovered = eventKind === 'recovery';
  const summary = recovered
    ? `${evidence.serviceName}: ${definition.label} recovered`
    : `${evidence.serviceName}: ${definition.label} alert`;
  if (webhook.adapter === 'sentry') {
    return buildSentryAlertPayload({
      alertKey: `${evidence.alertType}:${evidence.serviceId}`,
      alertType: evidence.alertType,
      eventKind,
      title: `${evidence.serviceName}: ${definition.label}`,
      message: `${summary} (${formatEvidence(evidence)})`,
      severity: definition.direction === 'boolean' ? 'critical' : 'warning',
      tags: { service: evidence.serviceId, service_type: evidence.serviceType },
      context: {
        value: typeof evidence.value === 'number' || typeof evidence.value === 'boolean' ? evidence.value : null,
        threshold: evidence.threshold,
        unit: evidence.unit,
        observedAt: evidence.observedAt.toISOString(),
      },
      linkPath: '/fleet/metrics',
      occurredAt: evidence.observedAt,
    });
  }
  const detail = {
    version: 1,
    notificationId,
    instance: operationsPolicy().alertInstanceName,
    eventKind,
    alertType: evidence.alertType,
    summary,
    service: {
      id: evidence.serviceId,
      name: evidence.serviceName,
      type: evidence.serviceType,
    },
    evidence: {
      value: evidence.value,
      threshold: evidence.threshold,
      unit: evidence.unit,
      observedAt: evidence.observedAt.toISOString(),
    },
    webhook: { id: webhook.id, name: webhook.name },
  };
  if (webhook.adapter === 'slack') {
    return {
      text: summary,
      blocks: [{
        type: 'section',
        text: { type: 'mrkdwn', text: `*${summary}*\n${formatEvidence(evidence)}` },
      }],
      robin_alert: detail,
    };
  }
  return detail;
}

function formatEvidence(evidence: AlertEvidence): string {
  if (evidence.value === null) return 'No measurement';
  if (evidence.unit === 'none') return evidence.value ? 'Reachable' : 'Unreachable';
  return `${Number(evidence.value).toLocaleString('en-US', { maximumFractionDigits: 2 })} ${evidence.unit}`;
}

// Sum of a cumulative counter's increases across a window, stepwise so a
// counter reset (service restart) doesn't produce a negative or zero total.
const windowIncrease = (column: string) =>
  `COALESCE(SUM(GREATEST(${column} - prev_${column}, 0)), 0)`;

async function loadEvaluationRows(client: PoolClient): Promise<EvaluationRow[]> {
  const result = await client.query<EvaluationRow>(`
    SELECT fs.id AS fleet_service_id, fs.service_id, fs.name AS service_name, fs.service_type,
           o.observation_key, o.observed_at, o.reachable,
           pf.timestamp AS postfix_timestamp, pf.queue_total, pf.queue_deferred, pf.oldest_deferred_age_secs,
           pgm.timestamp AS postgres_timestamp, pgm.connection_saturation_pct,
           pgm.blks_hit AS pg_blks_hit, pgm.blks_read AS pg_blks_read, pgm.cache_hit_ratio AS pg_cache_hit_ratio,
           md.timestamp AS mariadb_timestamp, md.connection_saturation_pct AS mariadb_saturation_pct,
           mdw.read_requests AS mariadb_window_read_requests, mdw.reads AS mariadb_window_reads,
           md.oldest_trx_age_secs AS mariadb_oldest_trx_age_secs, md.is_replica AS mariadb_is_replica,
           (md.replica_io_running AND md.replica_sql_running) AS mariadb_replica_running,
           md.seconds_behind_source AS mariadb_seconds_behind_source,
           rd.timestamp AS redis_timestamp, rd.keyspace_hits, rd.keyspace_misses, rd.hit_ratio AS redis_hit_ratio,
           cl.timestamp AS clamav_timestamp, cl.database_updated_at,
           pfw.delivered AS postfix_window_delivered, pfw.deferred AS postfix_window_deferred,
           pfw.bounced AS postfix_window_bounced,
           dv.timestamp AS dovecot_timestamp, dvw.auth_failures AS dovecot_window_auth_failures,
           cy.timestamp AS cyrus_timestamp, cyw.auth_failures AS cyrus_window_auth_failures
    FROM fleet_services fs
    LEFT JOIN fleet_service_observations o ON o.fleet_service_id = fs.id
    LEFT JOIN LATERAL (
      SELECT timestamp, queue_total, queue_deferred, oldest_deferred_age_secs
      FROM postfix_metrics_history WHERE fleet_service_id = fs.id ORDER BY timestamp DESC LIMIT 1
    ) pf ON fs.service_type = 'postfix'
    LEFT JOIN LATERAL (
      SELECT timestamp, connection_saturation_pct, blks_hit, blks_read, cache_hit_ratio
      FROM postgres_metrics_history WHERE fleet_service_id = fs.id ORDER BY timestamp DESC LIMIT 1
    ) pgm ON fs.service_type = 'postgres'
    LEFT JOIN LATERAL (
      SELECT timestamp, connection_saturation_pct, oldest_trx_age_secs,
             is_replica, replica_io_running, replica_sql_running, seconds_behind_source
      FROM mariadb_metrics_history WHERE fleet_service_id = fs.id ORDER BY timestamp DESC LIMIT 1
    ) md ON fs.service_type = 'mariadb'
    LEFT JOIN LATERAL (
      SELECT timestamp, keyspace_hits, keyspace_misses, hit_ratio
      FROM redis_metrics_history WHERE fleet_service_id = fs.id ORDER BY timestamp DESC LIMIT 1
    ) rd ON fs.service_type = 'redis'
    LEFT JOIN LATERAL (
      SELECT timestamp, database_updated_at
      FROM clamav_metrics_history WHERE fleet_service_id = fs.id ORDER BY timestamp DESC LIMIT 1
    ) cl ON fs.service_type = 'clamav'
    LEFT JOIN LATERAL (
      SELECT ${windowIncrease('messages_delivered')} AS delivered,
             ${windowIncrease('messages_deferred')} AS deferred,
             ${windowIncrease('messages_bounced')} AS bounced
      FROM (
        SELECT messages_delivered, messages_deferred, messages_bounced,
               LAG(messages_delivered) OVER w AS prev_messages_delivered,
               LAG(messages_deferred) OVER w AS prev_messages_deferred,
               LAG(messages_bounced) OVER w AS prev_messages_bounced
        FROM postfix_metrics_history
        WHERE fleet_service_id = fs.id AND timestamp >= NOW() - INTERVAL '${RATE_WINDOW_MINUTES} minutes'
        WINDOW w AS (ORDER BY timestamp)
      ) steps
    ) pfw ON fs.service_type = 'postfix'
    LEFT JOIN LATERAL (
      SELECT timestamp
      FROM dovecot_metrics_history WHERE fleet_service_id = fs.id ORDER BY timestamp DESC LIMIT 1
    ) dv ON fs.service_type = 'dovecot'
    LEFT JOIN LATERAL (
      SELECT ${windowIncrease('auth_failure')} AS auth_failures
      FROM (
        SELECT auth_failure, LAG(auth_failure) OVER (ORDER BY timestamp) AS prev_auth_failure
        FROM dovecot_metrics_history
        WHERE fleet_service_id = fs.id AND timestamp >= NOW() - INTERVAL '${RATE_WINDOW_MINUTES} minutes'
      ) steps
    ) dvw ON fs.service_type = 'dovecot'
    LEFT JOIN LATERAL (
      SELECT timestamp FROM cyrus_metrics_history WHERE fleet_service_id = fs.id ORDER BY timestamp DESC LIMIT 1
    ) cy ON fs.service_type = 'cyrus'
    LEFT JOIN LATERAL (
      SELECT ${windowIncrease('auth_failure')} AS auth_failures
      FROM (
        SELECT auth_failure, LAG(auth_failure) OVER (ORDER BY timestamp) AS prev_auth_failure
        FROM cyrus_metrics_history
        WHERE fleet_service_id = fs.id AND timestamp >= NOW() - INTERVAL '${RATE_WINDOW_MINUTES} minutes'
      ) steps
    ) cyw ON fs.service_type = 'cyrus'
    LEFT JOIN LATERAL (
      SELECT ${windowIncrease('buffer_pool_read_requests')} AS read_requests,
             ${windowIncrease('buffer_pool_reads')} AS reads
      FROM (
        SELECT buffer_pool_read_requests, buffer_pool_reads,
               LAG(buffer_pool_read_requests) OVER w AS prev_buffer_pool_read_requests,
               LAG(buffer_pool_reads) OVER w AS prev_buffer_pool_reads
        FROM mariadb_metrics_history
        WHERE fleet_service_id = fs.id AND reachable AND timestamp >= NOW() - INTERVAL '${RATE_WINDOW_MINUTES} minutes'
        WINDOW w AS (ORDER BY timestamp)
      ) steps
    ) mdw ON fs.service_type = 'mariadb'
    WHERE fs.enabled = true
    ORDER BY fs.id
  `);
  return result.rows;
}
