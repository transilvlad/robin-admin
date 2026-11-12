import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getClient, query } from '../connection.js';
import { createAlertDelivery } from './alerts.js';
import { listAdminEmailSubscriptions } from './email.js';
import { syncAutomaticStatusPageReports } from './status-page.js';
import { enqueueMonitoringIssueAdminEmail } from '../../services/email/messages.js';
import { logger } from '../../logger.js';
import { decryptStoredSecret, encryptStoredSecret } from './secret-crypto.js';
import { parseMonitoringOptions, validateMonitoringHeaders, validateMonitoringProtocol, MonitoringInputError } from '../../services/monitoring/options.js';
import { combineLocationVerdicts, type LocationVerdict } from '../../services/monitoring/quorum.js';
import { deliverMonitoringLocationIssue } from '../../services/monitoring/location-alerts.js';
import type { AlertWebhookAdapter, JsonRecord } from '../../types/alerts.js';
import type {
  MonitoringCheck,
  MonitoringCertificateErrorMode,
  MonitoringCheckDay,
  MonitoringCheckType,
  MonitoringCheckOptions,
  MonitoringIssue,
  MonitoringIssueDelivery,
  MonitoringObservation,
  MonitoringSilence,
  MonitoringStatus,
  MonitoringSummary,
  MonitoringTarget,
  MonitoringTargetType,
  MonitoringTlsMode,
} from '../../types/monitoring.js';
import { buildSentryAlertPayload } from '../../services/alerts/sentry.js';
import { evaluationIntervalSeconds, expiredPushOccurrence, generatePushToken, hashPushToken, PUSH_CHECKIN_SCAN_LIMIT, PUSH_EVALUATION_SECONDS, pushScheduledOccurrence, resolvePushSchedule } from '../../services/monitoring/push.js';
import { reportError } from '../../services/error-reporting.js';

interface TargetRow {
  id: number;
  name: string;
  target_type: MonitoringTargetType;
  environment: string;
  description: string | null;
  enabled: boolean;
  created_at: Date;
  updated_at: Date;
}

interface CheckRow {
  target_enabled: boolean;
  id: number;
  target_id: number;
  target_name: string;
  target_environment: string;
  name: string;
  check_type: MonitoringCheckType;
  endpoint: string;
  port: number | null;
  interval_seconds: number;
  timeout_seconds: number;
  confirmation_seconds: number;
  recovery_seconds: number;
  placement_mode: 'all' | 'selected';
  location_ids: number[];
  quorum: number;
  cert_expiry_days: number | null;
  tls_mode: MonitoringTlsMode;
  certificate_error_mode: MonitoringCertificateErrorMode;
  allow_private: boolean;
  options_json: MonitoringCheckOptions;
  secret_header_names: string[];
  enabled: boolean;
  paused_at: Date | null;
  pause_reason: string | null;
  current_status: MonitoringStatus;
  status_since: Date | null;
  last_run_at: Date | null;
  next_run_at: Date | null;
  last_response_time_ms: number | null;
  last_error: string | null;
  consecutive_failures: number;
  consecutive_successes: number;
  last_ping_at: Date | null;
  last_ping_status: 'ok' | 'fail' | null;
  push_cron_expression: string | null;
  push_timezone: string | null;
  push_schedule_started_at: Date | null;
  push_recovered_through: Date | null;
  push_schedule_cursor: Date | null;
  push_revision: number;
  created_at: Date;
  updated_at: Date;
}

interface ObservationRow {
  id: number;
  check_id: number;
  location_id: number | null;
  status: MonitoringStatus;
  error_code: string | null;
  response_time_ms: number | null;
  error: string | null;
  details_json: unknown;
  observed_at: Date;
}

interface IssueRow {
  id: number;
  check_id: number;
  check_name: string;
  target_name: string;
  status: 'open' | 'closed';
  severity: 'warning' | 'critical';
  summary: string;
  details_json: unknown;
  opened_at: Date;
  closed_at: Date | null;
  updated_at: Date;
}

interface MonitoringSilenceRow {
  id: number;
  name: string;
  scope_type: 'target' | 'check';
  target_id: number | null;
  target_name: string | null;
  check_id: number | null;
  check_name: string | null;
  reason: string | null;
  starts_at: Date;
  ends_at: Date;
  processed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

interface MonitoringDeliveryWebhookRow {
  id: number;
  name: string;
  adapter: AlertWebhookAdapter;
  subscriptions_json: unknown;
  notify_recovery: boolean;
}

interface IssueDeliveryRow {
  id: number;
  monitoring_issue_id: number;
  webhook_name: string;
  event_kind: MonitoringIssueDelivery['eventKind'];
  status: MonitoringIssueDelivery['status'];
  attempts: number;
  response_status: number | null;
  error: string | null;
  created_at: Date;
  completed_at: Date | null;
}

const TARGET_COLUMNS = 'id, name, target_type, environment, description, enabled, created_at, updated_at';
const CHECK_COLUMNS = `
  c.id, c.target_id, t.name AS target_name, t.environment AS target_environment, t.enabled AS target_enabled,
  c.name, c.check_type, c.endpoint, c.port,
  c.interval_seconds, c.timeout_seconds, c.confirmation_seconds, c.recovery_seconds,
  c.placement_mode, c.location_ids, c.quorum,
  c.cert_expiry_days, c.tls_mode, c.certificate_error_mode, c.allow_private, c.options_json, c.secret_header_names,
  c.enabled, c.paused_at, c.pause_reason, c.current_status,
  c.status_since, c.last_run_at, c.next_run_at, c.last_response_time_ms, c.last_error,
  c.consecutive_failures, c.consecutive_successes, c.last_ping_at, c.last_ping_status,
  c.push_cron_expression, c.push_timezone, c.push_schedule_started_at, c.push_recovered_through, c.push_schedule_cursor, c.push_revision, c.created_at, c.updated_at
`;
const ISSUE_COLUMNS = `
  i.id, i.check_id, c.name AS check_name, t.name AS target_name, i.status, i.severity,
  i.summary, i.details_json, i.opened_at, i.closed_at, i.updated_at
`;

function mapTarget(row: TargetRow): MonitoringTarget {
  return {
    id: row.id,
    name: row.name,
    targetType: row.target_type,
    environment: row.environment,
    description: row.description,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapCheck(row: CheckRow): MonitoringCheck {
  return {
    id: row.id,
    targetId: row.target_id,
    targetName: row.target_name,
    targetEnvironment: row.target_environment,
    name: row.name,
    checkType: row.check_type,
    endpoint: row.endpoint,
    port: row.port,
    intervalSeconds: row.interval_seconds,
    timeoutSeconds: row.timeout_seconds,
    confirmationSeconds: row.confirmation_seconds,
    recoverySeconds: row.recovery_seconds,
    placementMode: row.placement_mode,
    locationIds: row.location_ids,
    quorum: row.quorum,
    certExpiryDays: row.cert_expiry_days,
    tlsMode: row.tls_mode,
    certificateErrorMode: row.certificate_error_mode,
    allowPrivate: row.allow_private,
    options: parseMonitoringOptions(row.check_type, row.options_json, row.port),
    secretHeaderNames: row.secret_header_names,
    enabled: row.enabled,
    pausedAt: row.paused_at,
    pauseReason: row.pause_reason,
    currentStatus: row.current_status,
    targetEnabled: row.target_enabled,
    statusSince: row.status_since,
    lastRunAt: row.last_run_at,
    nextRunAt: row.next_run_at,
    lastResponseTimeMs: row.last_response_time_ms,
    lastError: row.last_error,
    lastPingAt: row.last_ping_at,
    lastPingStatus: row.last_ping_status,
    pushCronExpression: row.push_cron_expression,
    pushTimezone: row.push_timezone,
    pushScheduleStartedAt: row.push_schedule_started_at,
    pushRecoveredThrough: row.push_recovered_through,
    pushScheduleCursor: row.push_schedule_cursor,
    pushRevision: row.push_revision,
    consecutiveFailures: row.consecutive_failures,
    consecutiveSuccesses: row.consecutive_successes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function mapObservation(row: ObservationRow): MonitoringObservation {
  return {
    id: row.id,
    checkId: row.check_id,
    locationId: row.location_id,
    status: row.status,
    errorCode: row.error_code,
    responseTimeMs: row.response_time_ms,
    error: row.error,
    details: recordValue(row.details_json),
    observedAt: row.observed_at,
  };
}

function mapIssue(row: IssueRow): MonitoringIssue {
  return {
    id: row.id,
    checkId: row.check_id,
    checkName: row.check_name,
    targetName: row.target_name,
    status: row.status,
    severity: row.severity,
    summary: row.summary,
    details: recordValue(row.details_json),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    updatedAt: row.updated_at,
    deliveries: [],
  };
}

function mapIssueDelivery(row: IssueDeliveryRow): MonitoringIssueDelivery {
  return {
    id: row.id,
    webhookName: row.webhook_name,
    eventKind: row.event_kind,
    status: row.status,
    attempts: row.attempts,
    responseStatus: row.response_status,
    error: row.error,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapMonitoringSilence(row: MonitoringSilenceRow): MonitoringSilence {
  return {
    id: row.id,
    name: row.name,
    scopeType: row.scope_type,
    targetId: row.target_id,
    targetName: row.target_name,
    checkId: row.check_id,
    checkName: row.check_name,
    reason: row.reason,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    processedAt: row.processed_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const MONITORING_SILENCE_COLUMNS = `
  s.id, s.name, s.scope_type, s.target_id, t.name AS target_name,
  s.check_id, c.name AS check_name, s.reason, s.starts_at, s.ends_at,
  s.processed_at, s.created_at, s.updated_at
`;

export async function listMonitoringSilences(): Promise<MonitoringSilence[]> {
  const result = await query<MonitoringSilenceRow>(
    `SELECT ${MONITORING_SILENCE_COLUMNS}
     FROM monitoring_silences s
     LEFT JOIN monitoring_checks c ON c.id = s.check_id
     LEFT JOIN monitoring_targets t ON t.id = COALESCE(s.target_id, c.target_id)
     ORDER BY s.starts_at DESC, s.id DESC`,
  );
  return result.rows.map(mapMonitoringSilence);
}

export async function createMonitoringSilence(input: {
  name: string;
  scopeType: 'target' | 'check';
  targetId?: number;
  checkId?: number;
  reason: string | null;
  startsAt: Date;
  endsAt: Date;
  createdBy: number | null;
}): Promise<MonitoringSilence | null> {
  const result = await query<MonitoringSilenceRow>(
    `WITH inserted AS (
       INSERT INTO monitoring_silences (name, scope_type, target_id, check_id, reason, starts_at, ends_at, created_by)
       SELECT $1, $2, CASE WHEN $2 = 'target' THEN $3 END, CASE WHEN $2 = 'check' THEN $4 END,
              $5, $6, $7, $8
       WHERE ($2 = 'target' AND EXISTS (SELECT 1 FROM monitoring_targets WHERE id = $3))
          OR ($2 = 'check' AND EXISTS (SELECT 1 FROM monitoring_checks WHERE id = $4))
       RETURNING id
     )
     SELECT ${MONITORING_SILENCE_COLUMNS}
     FROM inserted i
     JOIN monitoring_silences s ON s.id = i.id
     LEFT JOIN monitoring_checks c ON c.id = s.check_id
     LEFT JOIN monitoring_targets t ON t.id = COALESCE(s.target_id, c.target_id)`,
    [input.name, input.scopeType, input.targetId ?? null, input.checkId ?? null, input.reason, input.startsAt, input.endsAt, input.createdBy],
  );
  return result.rows[0] ? mapMonitoringSilence(result.rows[0]) : null;
}

export async function endMonitoringSilence(id: number): Promise<MonitoringSilence | null> {
  const result = await query<MonitoringSilenceRow>(
    `WITH ended AS (
       UPDATE monitoring_silences
       SET starts_at = LEAST(starts_at, CURRENT_TIMESTAMP),
           ends_at = LEAST(ends_at, CURRENT_TIMESTAMP), processed_at = NULL, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1 AND ends_at > CURRENT_TIMESTAMP
       RETURNING id
     )
     SELECT ${MONITORING_SILENCE_COLUMNS}
     FROM ended e
     JOIN monitoring_silences s ON s.id = e.id
     LEFT JOIN monitoring_checks c ON c.id = s.check_id
     LEFT JOIN monitoring_targets t ON t.id = COALESCE(s.target_id, c.target_id)`,
    [id],
  );
  return result.rows[0] ? mapMonitoringSilence(result.rows[0]) : null;
}

async function isMonitoringCheckSilenced(checkId: number, targetId: number, client?: PoolClient): Promise<boolean> {
  const result = await monitoringQuery<{ silenced: boolean }>(client,
    `SELECT EXISTS (
       SELECT 1 FROM monitoring_silences s
       WHERE s.starts_at <= CURRENT_TIMESTAMP AND s.ends_at > CURRENT_TIMESTAMP
         AND ((s.scope_type = 'check' AND s.check_id = $1)
           OR (s.scope_type = 'target' AND s.target_id = $2))
     ) AS silenced`,
    [checkId, targetId],
  );
  return result.rows[0].silenced;
}

export async function listMonitoringTargets(): Promise<MonitoringTarget[]> {
  const result = await query<TargetRow>(
    `SELECT ${TARGET_COLUMNS} FROM monitoring_targets ORDER BY name ASC, id ASC`
  );
  return result.rows.map(mapTarget);
}

export async function listMonitoringChecks(): Promise<MonitoringCheck[]> {
  const result = await query<CheckRow>(
    `SELECT ${CHECK_COLUMNS}
     FROM monitoring_checks c
     JOIN monitoring_targets t ON t.id = c.target_id
     ORDER BY t.name ASC, c.name ASC, c.id ASC`
  );
  return result.rows.map(mapCheck);
}

export async function getMonitoringCheckObservations(id: number): Promise<MonitoringObservation[]> {
  const result = await query<ObservationRow>(
    'SELECT id, check_id, location_id, status, error_code, response_time_ms, error, details_json, observed_at FROM monitoring_observations WHERE check_id = $1 ORDER BY observed_at DESC, id DESC LIMIT 50', [id]);
  return result.rows.map(mapObservation);
}

export async function getMonitoringCheck(id: number, client?: PoolClient): Promise<MonitoringCheck | null> {
  const result = client ? await client.query<CheckRow>(
    `SELECT ${CHECK_COLUMNS}
     FROM monitoring_checks c
     JOIN monitoring_targets t ON t.id = c.target_id
     WHERE c.id = $1`,
    [id]
  ) : await query<CheckRow>(
    `SELECT ${CHECK_COLUMNS}
     FROM monitoring_checks c
     JOIN monitoring_targets t ON t.id = c.target_id
     WHERE c.id = $1`,
    [id]
  );
  return result.rows[0] ? mapCheck(result.rows[0]) : null;
}

export async function createMonitoringTarget(input: {
  name: string;
  targetType: MonitoringTargetType;
  environment?: string;
  description?: string | null;
  enabled?: boolean;
}): Promise<MonitoringTarget> {
  const result = await query<TargetRow>(
    `INSERT INTO monitoring_targets (name, target_type, environment, description, enabled)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING ${TARGET_COLUMNS}`,
    [
      input.name,
      input.targetType,
      input.environment ?? 'production',
      input.description ?? null,
      input.enabled ?? true,
    ]
  );
  return mapTarget(result.rows[0]);
}

export async function updateMonitoringTarget(id: number, input: {
  name?: string;
  targetType?: MonitoringTargetType;
  environment?: string;
  description?: string | null;
  enabled?: boolean;
}): Promise<MonitoringTarget | null> {
  const sets: string[] = [];
  const values: Array<string | boolean | number | null> = [];
  let index = 1;
  const add = (column: string, value: string | boolean | null) => {
    sets.push(`${column} = $${index++}`);
    values.push(value);
  };
  if (input.name !== undefined) add('name', input.name);
  if (input.targetType !== undefined) add('target_type', input.targetType);
  if (input.environment !== undefined) add('environment', input.environment);
  if (input.description !== undefined) add('description', input.description);
  if (input.enabled !== undefined) add('enabled', input.enabled);
  if (sets.length === 0) {
    const targets = await listMonitoringTargets();
    return targets.find((target) => target.id === id) ?? null;
  }
  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  const result = await query<TargetRow>(
    `UPDATE monitoring_targets SET ${sets.join(', ')} WHERE id = $${index} RETURNING ${TARGET_COLUMNS}`,
    values
  );
  return result.rows[0] ? mapTarget(result.rows[0]) : null;
}

export async function deleteMonitoringTarget(id: number): Promise<boolean> {
  const result = await query('DELETE FROM monitoring_targets WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

async function validateLocationPlacement(
  mode: 'all' | 'selected',
  locationIds: number[],
  quorum: number,
  verifyEnabledLocations = true,
): Promise<{ mode: 'all' | 'selected'; locationIds: number[]; quorum: number }> {
  if (!['all', 'selected'].includes(mode) || !Array.isArray(locationIds)
    || locationIds.some(id => !Number.isInteger(id) || id < 1)
    || !Number.isInteger(quorum) || quorum < 0 || quorum > 128) {
    throw new MonitoringInputError('Invalid probe location placement or quorum');
  }
  const uniqueIds = [...new Set(locationIds)];
  if (mode === 'all') uniqueIds.length = 0;
  if (mode === 'selected' && uniqueIds.length === 0) throw new MonitoringInputError('Select at least one enabled probe location');
  if (mode === 'selected' && quorum > uniqueIds.length) throw new MonitoringInputError('Quorum cannot exceed the selected location count');
  if (verifyEnabledLocations) {
    const locations = await query<{ id: number; enabled: boolean; shadow: boolean }>(
      uniqueIds.length
        ? 'SELECT id, enabled, shadow FROM monitoring_locations WHERE id = ANY($1::int[])'
        : 'SELECT id, enabled, shadow FROM monitoring_locations WHERE enabled',
      uniqueIds.length ? [uniqueIds] : [],
    );
    if (uniqueIds.length && (locations.rowCount !== uniqueIds.length || locations.rows.some(row => !row.enabled))) {
      throw new MonitoringInputError('Selected probe locations must all be enabled');
    }
    // Shadow locations probe but never vote, so only voting locations can satisfy a quorum.
    const voting = locations.rows.filter(row => row.enabled && !row.shadow).length;
    if (voting === 0) throw new MonitoringInputError('At least one voting (non-shadow) probe location is required');
    if (quorum > voting) throw new MonitoringInputError(`Quorum cannot exceed the ${voting} voting location${voting === 1 ? '' : 's'}`);
  }
  return { mode, locationIds: uniqueIds, quorum };
}

export async function createMonitoringCheck(input: {
  targetId: number;
  name: string;
  checkType: MonitoringCheckType;
  endpoint: string;
  port?: number | null;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  confirmationSeconds?: number;
  recoverySeconds?: number;
  placementMode?: 'all' | 'selected';
  locationIds?: number[];
  quorum?: number;
  certExpiryDays?: number | null;
  tlsMode?: MonitoringTlsMode;
  certificateErrorMode?: MonitoringCertificateErrorMode;
  allowPrivate?: boolean;
  options?: MonitoringCheckOptions;
  secretHeaders?: Record<string, string | null>;
  enabled?: boolean;
  pushCronExpression?: string | null;
  pushTimezone?: string | null;
}): Promise<MonitoringCheck> {
  if (input.checkType === 'push') input = { ...input, ...await pushCheckFields() };
  const schedule = resolvePushSchedule(input.checkType, input);
  const placement = await validateLocationPlacement(input.placementMode ?? 'all', input.locationIds ?? [], input.quorum ?? 0);
  const options = parseMonitoringOptions(input.checkType, input.options, input.port ?? null);
  const secrets = mergeSecretHeaders({}, input.secretHeaders);
  const pushToken = input.checkType === 'push' ? generatePushToken() : null;
  validateMonitoringProtocol({ ...input, options, port: input.port ?? null, certExpiryDays: input.certExpiryDays ?? null, tlsMode: input.tlsMode ?? 'strict' });
  validateSecretTransport(input.checkType, input.endpoint, secrets);
  checkHeaderOverlap(options, secrets);
  const result = await query<{ id: number }>(
    `INSERT INTO monitoring_checks (
       target_id, name, check_type, endpoint, port, interval_seconds, timeout_seconds,
       confirmation_seconds, recovery_seconds, placement_mode, location_ids, quorum,
       cert_expiry_days, tls_mode, certificate_error_mode, enabled,
       allow_private, options_json, encrypted_headers, secret_header_names, next_run_at,
       push_token_hash, encrypted_push_token, push_cron_expression, push_timezone, push_schedule_started_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, CURRENT_TIMESTAMP, $21, $22, $23, $24,
       CASE WHEN $23::varchar IS NULL THEN NULL ELSE CURRENT_TIMESTAMP END)
     RETURNING id`,
    [
      input.targetId,
      input.name,
      input.checkType,
      input.endpoint,
      input.port ?? null,
      input.intervalSeconds ?? 60,
      input.timeoutSeconds ?? (input.checkType === 'http' ? 10 : 5),
      input.confirmationSeconds ?? 180,
      input.recoverySeconds ?? 180,
      placement.mode,
      placement.locationIds,
      placement.quorum,
      input.certExpiryDays ?? null,
      input.tlsMode ?? 'strict',
      input.certificateErrorMode ?? 'down',
      input.enabled ?? true,
      input.allowPrivate ?? false,
      JSON.stringify(options),
      Object.keys(secrets).length ? encryptStoredSecret(JSON.stringify(secrets)) : null,
      JSON.stringify(Object.keys(secrets)),
      pushToken ? hashPushToken(pushToken) : null,
      pushToken ? encryptStoredSecret(pushToken) : null,
      schedule.pushCronExpression,
      schedule.pushTimezone,
    ]
  );
  return (await getMonitoringCheck(result.rows[0].id))!;
}

/** The fixed settings of a push check: no target, and only the Local location runs it. */
async function pushCheckFields(): Promise<{
  endpoint: string; port: null; certExpiryDays: null; options: MonitoringCheckOptions;
  placementMode: 'selected'; locationIds: number[]; quorum: number; secretHeaders: Record<string, string | null>;
}> {
  const local = await query<{ id: number }>("SELECT id FROM monitoring_locations WHERE location_key = 'local'");
  if (!local.rows[0]) throw new MonitoringInputError('The local probe location is missing');
  return { endpoint: 'push', port: null, certExpiryDays: null, options: {}, placementMode: 'selected', locationIds: [local.rows[0].id], quorum: 0, secretHeaders: {} };
}

/** The ping URL of a push check, for admins. */
export async function getMonitoringCheckPushToken(id: number): Promise<string | null> {
  const result = await query<{ encrypted_push_token: string | null }>(
    "SELECT encrypted_push_token FROM monitoring_checks WHERE id = $1 AND check_type = 'push'",
    [id],
  );
  const encrypted = result.rows[0]?.encrypted_push_token;
  return encrypted ? decryptStoredSecret(encrypted) : null;
}

export async function rotateMonitoringCheckPushToken(id: number): Promise<string | null> {
  const token = generatePushToken();
  const result = await query(
    `UPDATE monitoring_checks SET push_token_hash = $2, encrypted_push_token = $3, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND check_type = 'push'`,
    [id, hashPushToken(token), encryptStoredSecret(token)],
  );
  return (result.rowCount ?? 0) > 0 ? token : null;
}

/** Records a ping; returns the check ID, or null for an unknown token. */
export async function recordMonitoringCheckPing(token: string, status: 'ok' | 'fail'): Promise<number | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query<{
      id: number;
      current_status: MonitoringStatus;
      confirmation_seconds: number;
      push_cron_expression: string | null;
      push_timezone: string | null;
      push_schedule_started_at: Date | null;
      push_schedule_cursor: Date | null;
    }>(
      `SELECT id, current_status, confirmation_seconds, push_cron_expression, push_timezone, push_schedule_started_at, push_schedule_cursor
       FROM monitoring_checks WHERE push_token_hash = $1 AND check_type = 'push' FOR UPDATE`,
      [hashPushToken(token)],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('COMMIT');
      return null;
    }
    const updated = await client.query<{ last_ping_at: Date }>(
      `UPDATE monitoring_checks SET last_ping_at = clock_timestamp(), last_ping_status = $2, push_revision = push_revision + 1
       WHERE id = $1 RETURNING last_ping_at`,
      [row.id, status],
    );
    if (status === 'ok' && row.push_cron_expression) {
      const schedule = {
        pushCronExpression: row.push_cron_expression,
        pushTimezone: row.push_timezone,
        pushScheduleStartedAt: row.push_schedule_started_at,
        confirmationSeconds: row.confirmation_seconds,
      };
      const pingAt = updated.rows[0].last_ping_at;
      const scheduled = pushScheduledOccurrence(schedule, pingAt);
      if (scheduled) {
        await client.query(
          `INSERT INTO monitoring_push_checkins (check_id, scheduled_at, received_at)
           SELECT id, $2, last_ping_at FROM monitoring_checks WHERE id = $1
           ON CONFLICT (check_id, scheduled_at) DO UPDATE
             SET received_at = LEAST(monitoring_push_checkins.received_at, EXCLUDED.received_at)`,
          [row.id, scheduled],
        );
      }
      const expired = row.current_status === 'down' ? expiredPushOccurrence(schedule, pingAt) : null;
      const recoveredThrough = expired && row.push_schedule_cursor && row.push_schedule_cursor > expired ? row.push_schedule_cursor : expired;
      if (recoveredThrough) {
        await client.query(
          `UPDATE monitoring_checks SET push_recovered_through = GREATEST(push_recovered_through, $2::timestamptz) WHERE id = $1`,
          [row.id, recoveredThrough],
        );
      }
    }
    await client.query('COMMIT');
    return row.id;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function hasMonitoringPushCheckin(checkId: number, scheduledAt: Date): Promise<boolean> {
  const result = await query<{ received: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM monitoring_push_checkins p JOIN monitoring_checks c ON c.id = p.check_id
       WHERE p.check_id = $1 AND p.scheduled_at = $2 AND p.received_at >= c.push_schedule_started_at
         AND p.received_at <= p.scheduled_at + (c.confirmation_seconds * INTERVAL '1 second')
     ) AS received`,
    [checkId, scheduledAt],
  );
  return result.rows[0].received;
}

export async function listMonitoringPushCheckins(checkId: number, after: Date, through: Date): Promise<Date[]> {
  const result = await query<{ scheduled_at: Date }>(
    `SELECT p.scheduled_at FROM monitoring_push_checkins p JOIN monitoring_checks c ON c.id = p.check_id
     WHERE p.check_id = $1 AND p.received_at >= c.push_schedule_started_at
       AND p.scheduled_at > $2 AND p.scheduled_at <= $3
       AND p.received_at <= p.scheduled_at + (c.confirmation_seconds * INTERVAL '1 second')
     ORDER BY p.scheduled_at LIMIT $4`,
    [checkId, after, through, PUSH_CHECKIN_SCAN_LIMIT],
  );
  return result.rows.map(row => row.scheduled_at);
}

export async function updateMonitoringCheck(id: number, input: {
  targetId?: number;
  name?: string;
  checkType?: MonitoringCheckType;
  endpoint?: string;
  port?: number | null;
  intervalSeconds?: number;
  timeoutSeconds?: number;
  confirmationSeconds?: number;
  recoverySeconds?: number;
  placementMode?: 'all' | 'selected';
  locationIds?: number[];
  quorum?: number;
  certExpiryDays?: number | null;
  tlsMode?: MonitoringTlsMode;
  certificateErrorMode?: MonitoringCertificateErrorMode;
  allowPrivate?: boolean;
  options?: MonitoringCheckOptions;
  secretHeaders?: Record<string, string | null>;
  enabled?: boolean;
  pushCronExpression?: string | null;
  pushTimezone?: string | null;
}): Promise<MonitoringCheck | null> {
  const current = await getMonitoringCheck(id);
  if (!current) return null;
  const becomesPush = (input.checkType ?? current.checkType) === 'push';
  if (becomesPush) input = { ...input, ...await pushCheckFields(), secretHeaders: current.secretHeaderNames.length ? Object.fromEntries(current.secretHeaderNames.map((name) => [name, null])) : undefined };
  const schedule = resolvePushSchedule(input.checkType ?? current.checkType, input, current);
  const next = { ...current, ...Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)), ...schedule };
  const placement = await validateLocationPlacement(
    next.placementMode,
    next.locationIds,
    next.quorum,
    input.placementMode !== undefined || input.locationIds !== undefined || (input.quorum !== undefined && input.quorum !== current.quorum),
  );
  const options = parseMonitoringOptions(next.checkType, next.options, next.port);
  validateMonitoringProtocol({ ...next, options });
  const secrets = mergeSecretHeaders(current.secretHeaderNames.length ? await getMonitoringCheckSecrets(id) : {}, input.secretHeaders);
  validateSecretTransport(next.checkType, next.endpoint, secrets);
  checkHeaderOverlap(options, secrets);
  const sets: string[] = [];
  const values: unknown[] = [];
  let index = 1;
  const add = (column: string, value: string | number | boolean | number[] | null) => {
    sets.push(`${column} = $${index++}`);
    values.push(value);
  };
  if (input.targetId !== undefined) add('target_id', input.targetId);
  if (input.name !== undefined) add('name', input.name);
  if (input.checkType !== undefined) add('check_type', input.checkType);
  if (input.endpoint !== undefined) add('endpoint', input.endpoint);
  if (input.port !== undefined) add('port', input.port);
  if (input.intervalSeconds !== undefined) add('interval_seconds', input.intervalSeconds);
  if (input.timeoutSeconds !== undefined) add('timeout_seconds', input.timeoutSeconds);
  if (input.confirmationSeconds !== undefined) add('confirmation_seconds', input.confirmationSeconds);
  if (input.recoverySeconds !== undefined) add('recovery_seconds', input.recoverySeconds);
  if (input.placementMode !== undefined) {
    add('placement_mode', placement.mode);
    if (input.locationIds === undefined && placement.mode === 'all') add('location_ids', placement.locationIds);
  }
  if (input.locationIds !== undefined) add('location_ids', placement.locationIds);
  if (input.quorum !== undefined) add('quorum', placement.quorum);
  if (input.certExpiryDays !== undefined) add('cert_expiry_days', input.certExpiryDays);
  if (input.tlsMode !== undefined) add('tls_mode', input.tlsMode);
  if (input.certificateErrorMode !== undefined) add('certificate_error_mode', input.certificateErrorMode);
  if (input.allowPrivate !== undefined) add('allow_private', input.allowPrivate);
  if (input.options !== undefined) {
    add('options_json', JSON.stringify(options));
  }
  if (input.secretHeaders !== undefined) {
    add('encrypted_headers', Object.keys(secrets).length ? encryptStoredSecret(JSON.stringify(secrets)) : null);
    add('secret_header_names', JSON.stringify(Object.keys(secrets)));
  }
  if (input.enabled !== undefined) add('enabled', input.enabled);
  const scheduleChanged = schedule.pushCronExpression !== (current.pushCronExpression ?? null)
    || schedule.pushTimezone !== (current.pushTimezone ?? null)
    || (schedule.pushCronExpression !== null && input.confirmationSeconds !== undefined && input.confirmationSeconds !== current.confirmationSeconds);
  if (scheduleChanged) {
    add('push_cron_expression', schedule.pushCronExpression);
    add('push_timezone', schedule.pushTimezone);
    sets.push(`push_schedule_started_at = ${schedule.pushCronExpression ? 'clock_timestamp()' : 'NULL'}`);
    sets.push('push_recovered_through = NULL');
    sets.push('push_schedule_cursor = NULL');
    sets.push('push_revision = push_revision + 1');
    sets.push('next_run_at = CURRENT_TIMESTAMP');
  }
  if (becomesPush && current.checkType !== 'push') {
    const token = generatePushToken();
    add('push_token_hash', hashPushToken(token));
    add('encrypted_push_token', encryptStoredSecret(token));
  } else if (!becomesPush && current.checkType === 'push') {
    add('push_token_hash', null);
    add('encrypted_push_token', null);
    add('last_ping_at', null);
    add('last_ping_status', null);
  }
  if (sets.length === 0) {
    return getMonitoringCheck(id);
  }
  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  const result = await query<{ id: number }>(
    `UPDATE monitoring_checks SET ${sets.join(', ')} WHERE id = $${index} RETURNING id`,
    values
  );
  return result.rows[0] ? getMonitoringCheck(result.rows[0].id) : null;
}

export async function getMonitoringCheckSecrets(id: number): Promise<Record<string, string>> {
  const result = await query<{ encrypted_headers: string | null }>('SELECT encrypted_headers FROM monitoring_checks WHERE id = $1', [id]);
  const encrypted = result.rows[0]?.encrypted_headers;
  return encrypted ? JSON.parse(decryptStoredSecret(encrypted)) as Record<string, string> : {};
}

function validateSecretTransport(type: MonitoringCheckType, endpoint: string, secrets: Record<string, string>): void {
  if (Object.keys(secrets).length && (type !== 'http' || new URL(endpoint).protocol !== 'https:')) throw new MonitoringInputError('Credential headers require HTTPS');
}

function mergeSecretHeaders(current: Record<string, string>, patch?: Record<string, string | null>): Record<string, string> {
  const next = { ...current };
  if (patch !== undefined) {
    for (const [name, value] of Object.entries(validateMonitoringHeaders(patch, true))) {
      if (value === null) delete next[name];
      else next[name] = value;
    }
  }
  validateMonitoringHeaders(next, true);
  return next;
}

function checkHeaderOverlap(options: MonitoringCheckOptions, secrets: Record<string, string>): void {
  if (Object.keys(options.http?.headers ?? {}).some(name => Object.hasOwn(secrets, name))) {
    throw new MonitoringInputError('A header cannot be both public and secret');
  }
}

export async function pauseMonitoringCheck(id: number, reason: string | null): Promise<MonitoringCheck | null> {
  await query(
    `UPDATE monitoring_checks
     SET paused_at = CURRENT_TIMESTAMP, pause_reason = $2, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id, reason]
  );
  return getMonitoringCheck(id);
}

export async function resumeMonitoringCheck(id: number): Promise<MonitoringCheck | null> {
  await query(
    `UPDATE monitoring_checks
     SET paused_at = NULL, pause_reason = NULL, next_run_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [id]
  );
  return getMonitoringCheck(id);
}

export async function deleteMonitoringCheck(id: number): Promise<boolean> {
  const result = await query('DELETE FROM monitoring_checks WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listDueMonitoringChecks(limit = 25): Promise<MonitoringCheck[]> {
  const result = await query<CheckRow>(
    `WITH due AS (
       SELECT c.id
       FROM monitoring_checks c
       JOIN monitoring_targets t ON t.id = c.target_id
       WHERE c.enabled = true
         AND t.enabled = true
         AND c.paused_at IS NULL
         AND EXISTS (
           SELECT 1 FROM monitoring_locations l
           WHERE l.location_key = 'local' AND l.enabled
             AND (c.placement_mode = 'all' OR l.id = ANY(c.location_ids))
         )
         AND (c.next_run_at IS NULL OR c.next_run_at <= CURRENT_TIMESTAMP)
       ORDER BY COALESCE(c.next_run_at, c.created_at) ASC, c.id ASC
       LIMIT $1
       FOR UPDATE OF c SKIP LOCKED
     ),
     claimed AS (
       UPDATE monitoring_checks c
       SET next_run_at = CURRENT_TIMESTAMP
             + ((CASE WHEN c.check_type = 'push' THEN LEAST(c.interval_seconds, ${PUSH_EVALUATION_SECONDS}) ELSE c.interval_seconds END)
               * INTERVAL '1 second'),
           updated_at = CURRENT_TIMESTAMP
       FROM due
       WHERE c.id = due.id
       RETURNING c.*
     )
     SELECT ${CHECK_COLUMNS}
     FROM claimed c
     JOIN monitoring_targets t ON t.id = c.target_id
     ORDER BY COALESCE(c.next_run_at, c.created_at) ASC, c.id ASC`,
    [Math.max(1, Math.min(limit, 100))]
  );
  return result.rows.map(mapCheck);
}

export async function isMonitoringCheckPlacedLocally(check: Pick<MonitoringCheck, 'placementMode' | 'locationIds'>): Promise<boolean> {
  const result = await query<{ placed: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM monitoring_locations l
       WHERE l.location_key = 'local' AND l.enabled
         AND ($1 = 'all' OR l.id = ANY($2::int[]))
     ) AS placed`,
    [check.placementMode, check.locationIds],
  );
  return result.rows[0]?.placed === true;
}

export async function recordMonitoringObservation(input: {
  check: MonitoringCheck;
  status: Exclude<MonitoringStatus, 'unknown'>;
  responseTimeMs: number | null;
  error?: string | null;
  errorCode?: string | null;
  details?: Record<string, unknown>;
  observedAt?: Date;
}): Promise<MonitoringObservation> {
  const observedAt = input.observedAt ?? new Date();
  const result = await query<ObservationRow>(
    `INSERT INTO monitoring_observations (check_id, location_id, status, error_code, response_time_ms, error, details_json, observed_at)
     VALUES ($1, (SELECT id FROM monitoring_locations WHERE location_key = 'local'), $2, $3, $4, $5, $6::jsonb, $7)
     RETURNING id, check_id, location_id, status, error_code, response_time_ms, error, details_json, observed_at`,
    [
      input.check.id,
      input.status,
      input.errorCode ?? null,
      input.responseTimeMs,
      input.error?.slice(0, 500) ?? null,
      JSON.stringify(input.details ?? {}),
      observedAt,
    ]
  );
  const observation = mapObservation(result.rows[0]);
  await recordLocationDaily(observation);
  await evaluateMonitoringCheckLocations(input.check.id, true, input.check.checkType === 'push' ? undefined : input.check, true);
  return observation;
}

interface LocationObservationRow {
  id: number | null;
  location_id: number;
  location_name: string;
  region: string | null;
  status: Exclude<MonitoringStatus, 'unknown'> | null;
  error_code: string | null;
  error: string | null;
  details_json: unknown;
  response_time_ms: number | null;
  observed_at: Date | null;
  received_at: Date | null;
  clock_offset_ms: number | null;
}

function isCurrentPushScheduleObservation(check: MonitoringCheck, rawDetails: unknown): boolean {
  const details = recordValue(rawDetails);
  if (!Object.hasOwn(details, 'pushScheduleStartedAt')) {
    return check.checkType !== 'push' || !check.pushCronExpression;
  }
  return check.checkType === 'push'
    && details.pushScheduleStartedAt === (check.pushScheduleStartedAt?.toISOString() ?? null)
    && (!check.pushCronExpression || (details.pushRevision === check.pushRevision
      && details.pushObservedCursor === (check.pushScheduleCursor?.toISOString() ?? null)));
}

async function openUnmeetableQuorumIssue(check: MonitoringCheck, observation: MonitoringObservation, error: string | null): Promise<void> {
  const summary = `${check.name} cannot reach quorum`.slice(0, 255);
  const notificationSuppressed = await isMonitoringCheckSilenced(check.id, check.targetId);
  // Paused, disabled and disabled-target checks are not supposed to alert.
  const issue = await query<{ id: string }>(
    `INSERT INTO monitoring_issues (check_id, status, severity, summary, details_json, opened_at, notification_suppressed, updated_at)
     SELECT c.id, 'open', 'warning', $2, $3::jsonb, CURRENT_TIMESTAMP, $6, CURRENT_TIMESTAMP
     FROM monitoring_checks c JOIN monitoring_targets t ON t.id = c.target_id
     WHERE c.id = $1 AND c.enabled AND c.paused_at IS NULL AND t.enabled
       AND ($4::integer IS NULL OR (c.check_type = 'push' AND c.push_revision = $4
         AND date_trunc('milliseconds', c.push_schedule_cursor) IS NOT DISTINCT FROM $5::timestamptz))
     ON CONFLICT (check_id) WHERE status = 'open' DO NOTHING
     RETURNING id`,
    [check.id, summary, JSON.stringify({ error, details: observation.details }),
      check.checkType === 'push' && check.pushCronExpression ? check.pushRevision : null, check.pushScheduleCursor ?? null,
      notificationSuppressed],
  );
  if (!issue.rows[0] || notificationSuppressed) return;
  // The issue is a warning, so notifications must report a warning rather than an unknown-status failure.
  await enqueueMonitoringIssueDeliveries({ check, observation: { ...observation, status: 'warning' }, issueId: Number(issue.rows[0].id), eventKind: 'failure', summary });
  await syncStatusPageReportsAfterIssueChange();
}

export async function evaluateMonitoringCheckLocations(
  checkId: number,
  recordDaily = true,
  checkOverride?: MonitoringCheck,
  reschedule = false,
): Promise<void> {
  const check = checkOverride ?? await getMonitoringCheck(checkId);
  // Disabled, paused and disabled-target checks are not probed, so there is
  // nothing to combine; leave their state alone.
  if (!check || !check.enabled || check.pausedAt || !check.targetEnabled) return;
  const result = await query<LocationObservationRow>(
    `SELECT l.id AS location_id, l.name AS location_name, l.region, l.clock_offset_ms,
            latest.id, latest.status, latest.error_code, latest.error, latest.details_json,
            latest.response_time_ms, latest.observed_at, latest.received_at
     FROM monitoring_locations l
     LEFT JOIN LATERAL (
       SELECT o.id, o.status, o.error_code, o.error, o.details_json, o.response_time_ms, o.observed_at, o.received_at
       FROM monitoring_observations o
       WHERE o.check_id = $1 AND o.location_id = l.id
       ORDER BY o.observed_at DESC, o.id DESC LIMIT 1
     ) latest ON true
     WHERE l.enabled AND NOT l.shadow AND ($2 = 'all' OR l.id = ANY($3::int[]))
     ORDER BY l.id`,
    [check.id, check.placementMode, check.locationIds],
  );
  const now = Date.now();
  const freshnessMs = Math.max(evaluationIntervalSeconds(check) * 2_000, 120_000);
  // Freshness uses the server receipt time so a skewed agent clock cannot make a location look silent.
  // Freshness needs a recent receipt and a recent measurement, so a buffered result flushed after a restart cannot outvote current state.
  // The agent clock is corrected by its last reported offset; Local has no offset.
  const fresh: LocationVerdict[] = result.rows.flatMap(row => row.status && row.observed_at && row.received_at
    && now - row.received_at.getTime() <= freshnessMs
    && now - (row.observed_at.getTime() + (row.clock_offset_ms ?? 0)) <= freshnessMs
    && isCurrentPushScheduleObservation(check, row.details_json)
    ? [{
      locationId: row.location_id,
      locationName: row.location_name,
      status: row.status,
      errorCode: row.error_code,
      observedAt: row.observed_at,
    }]
    : []);
  if (check.checkType === 'push' && check.pushCronExpression && fresh.length === 0
    && result.rows.some(row => row.status && row.observed_at && row.received_at
      && now - row.received_at.getTime() <= freshnessMs
      && now - (row.observed_at.getTime() + (row.clock_offset_ms ?? 0)) <= freshnessMs
      && !isCurrentPushScheduleObservation(check, row.details_json))) return;
  const combined = combineLocationVerdicts(result.rows.length, fresh, check.quorum);
  const latestObservedAt = fresh.reduce<Date | null>(
    (latest, location) => !latest || location.observedAt > latest ? location.observedAt : latest,
    null,
  );
  const locationRows = result.rows.filter(row => row.status && row.observed_at);
  const responseTimes = fresh.map(location => result.rows.find(row => row.location_id === location.locationId)?.response_time_ms)
    .filter((value): value is number => value !== null && value !== undefined);
  const pushDetails = check.checkType === 'push' && check.pushCronExpression
    ? recordValue(result.rows.find(row => fresh.some(location => location.locationId === row.location_id))?.details_json)
    : {};
  const failingRows = locationRows.filter(row => combined.failingLocations.some(location => location.locationId === row.location_id));
  const error = failingRows.length
    ? failingRows.map(row => `${row.location_name}: ${row.error_code === 'cron_ping_missed' ? row.error : row.error_code ?? row.error ?? row.status}`).join('; ').slice(0, 500)
    : combined.quorum > combined.assignedCount
      ? `Quorum of ${combined.quorum} cannot be met by ${combined.assignedCount} voting location${combined.assignedCount === 1 ? '' : 's'}`
      : combined.status === 'unknown' ? `Waiting for ${combined.quorum} fresh probe locations` : null;
  const observation: MonitoringObservation = {
    id: Math.max(0, ...locationRows.map(row => row.id ?? 0)),
    checkId,
    locationId: null,
    status: combined.status,
    errorCode: null,
    responseTimeMs: responseTimes.length
      ? Math.round(responseTimes.reduce((sum, value) => sum + value, 0) / responseTimes.length)
      : null,
    error,
    details: {
      assignedLocations: combined.assignedCount,
      freshLocations: combined.freshCount,
      quorum: combined.quorum,
      locations: fresh.map(location => ({
        id: location.locationId,
        name: location.locationName,
        status: location.status,
        errorCode: location.errorCode,
        observedAt: location.observedAt.toISOString(),
      })),
      failingLocations: combined.failingLocations.map(location => ({
        id: location.locationId,
        name: location.locationName,
        status: location.status,
        errorCode: location.errorCode,
      })),
      unavailableWarning: failingRows.length > 0 && failingRows.every(row =>
        row.status === 'warning' && recordValue(row.details_json).certificateError === true),
      partialFailure: combined.status === 'warning' && combined.failingLocations.length < combined.freshCount,
      ...(typeof pushDetails.pushEvaluatedThrough === 'string' ? { pushEvaluatedThrough: pushDetails.pushEvaluatedThrough } : {}),
      ...(typeof pushDetails.pushRecoveryThrough === 'string' ? { pushRecoveryThrough: pushDetails.pushRecoveryThrough } : {}),
      ...(pushDetails.pushScanBacklog === true ? { pushScanBacklog: true } : {}),
    },
    observedAt: latestObservedAt ?? new Date(now),
  };
  if (combined.status === 'unknown') {
    if (check.currentStatus !== 'unknown' || check.lastError !== error) {
      const updated = await query(
        `UPDATE monitoring_checks SET current_status = 'unknown',
         status_since = CASE WHEN current_status = 'unknown' THEN status_since ELSE CURRENT_TIMESTAMP END,
         last_error = $2, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1 AND ($3::integer IS NULL OR (check_type = 'push' AND push_revision = $3
           AND date_trunc('milliseconds', push_schedule_cursor) IS NOT DISTINCT FROM $4::timestamptz
           AND current_status = $5 AND enabled AND paused_at IS NULL
           AND EXISTS (SELECT 1 FROM monitoring_targets t WHERE t.id = target_id AND t.enabled)))`,
        [checkId, error, check.checkType === 'push' && check.pushCronExpression ? check.pushRevision : null,
          check.pushScheduleCursor ?? null, check.currentStatus],
      );
      if (check.checkType === 'push' && check.pushCronExpression && (updated.rowCount ?? 0) === 0) return;
    }
    if (combined.quorum > combined.assignedCount) await openUnmeetableQuorumIssue(check, observation, error);
    return;
  }
  if (!recordDaily && check.currentStatus === combined.status) return;
  await updateCheckState(check, observation, recordDaily, reschedule);
}

export async function evaluateAllMonitoringChecks(): Promise<void> {
  const checks = await listMonitoringChecks();
  for (const check of checks) await evaluateMonitoringCheckLocations(check.id, false);
  await refreshMonitoringLocationSilence();
}

let evaluationRunning = false;
let evaluationQueued = false;

// Requests a re-evaluation without making the caller wait; overlapping requests coalesce into one extra pass.
export function requestMonitoringEvaluation(): void {
  if (evaluationRunning) { evaluationQueued = true; return; }
  evaluationRunning = true;
  void (async () => {
    try {
      do {
        evaluationQueued = false;
        await evaluateAllMonitoringChecks();
      } while (evaluationQueued);
    } catch (error) {
      logger.error('Background monitoring evaluation failed', { error: (error as Error).message });
      reportError(error, 'monitoring-evaluation');
    } finally {
      evaluationRunning = false;
    }
  })();
}

export async function refreshMonitoringLocationSilence(): Promise<void> {
  const result = await query<{
    location_id: number; name: string; assigned_count: number; has_fresh_report: boolean; last_report_at: Date;
  }>(
    `SELECT l.id AS location_id, l.name, COUNT(c.id)::int AS assigned_count,
            MAX(COALESCE(latest.received_at, l.created_at)) AS last_report_at,
            COALESCE(BOOL_OR(COALESCE(latest.received_at, l.created_at) >= CURRENT_TIMESTAMP
              - GREATEST(c.interval_seconds * 2, 120) * INTERVAL '1 second'), false) AS has_fresh_report
     FROM monitoring_locations l
     JOIN monitoring_checks c ON c.enabled AND c.paused_at IS NULL
     JOIN monitoring_targets t ON t.id = c.target_id AND t.enabled
       AND (c.placement_mode = 'all' OR l.id = ANY(c.location_ids))
     LEFT JOIN LATERAL (
       SELECT o.received_at FROM monitoring_observations o
       WHERE o.check_id = c.id AND o.location_id = l.id
       ORDER BY o.observed_at DESC, o.id DESC LIMIT 1
     ) latest ON true
     WHERE l.enabled
     GROUP BY l.id, l.name`,
  );
  for (const location of result.rows) {
    if (location.assigned_count === 0) continue;
    if (!location.has_fresh_report) {
      const silentMinutes = Math.max(1, Math.floor((Date.now() - location.last_report_at.getTime()) / 60_000));
      const issue = await query<{ id: number; opened_at: Date }>(
        `INSERT INTO monitoring_location_issues (location_id, status, summary, details_json)
         VALUES ($1, 'open', $2, $3::jsonb)
         ON CONFLICT (location_id) WHERE status = 'open' DO NOTHING
         RETURNING id, opened_at`,
        [
          location.location_id,
          `${location.name} has not reported for ${silentMinutes} minute${silentMinutes === 1 ? '' : 's'}`,
          JSON.stringify({ assignedChecks: location.assigned_count, lastReportAt: location.last_report_at.toISOString() }),
        ],
      );
      if (issue.rows[0]) {
        await deliverMonitoringLocationIssue({
          issueId: issue.rows[0].id,
          locationId: location.location_id,
          locationName: location.name,
          summary: `${location.name} has not reported for ${silentMinutes} minute${silentMinutes === 1 ? '' : 's'}`,
          openedAt: issue.rows[0].opened_at,
          eventKind: 'failure',
        });
      } else {
        await query(
          `UPDATE monitoring_location_issues
           SET summary = $2, details_json = $3::jsonb, updated_at = CURRENT_TIMESTAMP
           WHERE location_id = $1 AND status = 'open'`,
          [
            location.location_id,
            `${location.name} has not reported for ${silentMinutes} minute${silentMinutes === 1 ? '' : 's'}`,
            JSON.stringify({ assignedChecks: location.assigned_count, lastReportAt: location.last_report_at.toISOString() }),
          ],
        );
      }
    } else {
      const closed = await query<{ id: number; opened_at: Date; summary: string }>(
        `UPDATE monitoring_location_issues
         SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE location_id = $1 AND status = 'open'
         RETURNING id, opened_at, summary`,
        [location.location_id],
      );
      for (const issue of closed.rows) {
        await deliverMonitoringLocationIssue({
          issueId: issue.id,
          locationId: location.location_id,
          locationName: location.name,
          summary: `${location.name} probe results resumed`,
          openedAt: issue.opened_at,
          eventKind: 'recovery',
        });
      }
    }
  }
  await query(
    `UPDATE monitoring_location_issues i
     SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     FROM monitoring_locations l
     WHERE i.location_id = l.id AND i.status = 'open'
       AND (NOT l.enabled OR NOT EXISTS (
         SELECT 1 FROM monitoring_checks c
         JOIN monitoring_targets t ON t.id = c.target_id
         WHERE c.enabled AND c.paused_at IS NULL AND t.enabled
           AND (c.placement_mode = 'all' OR l.id = ANY(c.location_ids))
       ))`,
  );
}

async function recordLocationDaily(observation: MonitoringObservation): Promise<void> {
  if (observation.locationId === null) return;
  await query(
    `INSERT INTO monitoring_location_daily
       (check_id, location_id, day, up_count, warning_count, down_count, unavailable_warning_count,
        response_time_sum, response_time_count, response_time_max)
     SELECT $1, $2, ($3::timestamptz AT TIME ZONE 'UTC')::date,
            ($4 = 'up')::int, ($4 = 'warning')::int, ($4 = 'down')::int,
            ($4 = 'warning' AND COALESCE($6::jsonb->>'certificateError' = 'true', false))::int,
            COALESCE($5, 0), ($5 IS NOT NULL)::int, $5
     ON CONFLICT (check_id, location_id, day) DO UPDATE SET
       up_count = monitoring_location_daily.up_count + EXCLUDED.up_count,
       warning_count = monitoring_location_daily.warning_count + EXCLUDED.warning_count,
       down_count = monitoring_location_daily.down_count + EXCLUDED.down_count,
       unavailable_warning_count = monitoring_location_daily.unavailable_warning_count + EXCLUDED.unavailable_warning_count,
       response_time_sum = monitoring_location_daily.response_time_sum + EXCLUDED.response_time_sum,
       response_time_count = monitoring_location_daily.response_time_count + EXCLUDED.response_time_count,
       response_time_max = GREATEST(monitoring_location_daily.response_time_max, EXCLUDED.response_time_max)`,
    [observation.checkId, observation.locationId, observation.observedAt, observation.status, observation.responseTimeMs, JSON.stringify(observation.details)],
  );
}

function monitoringQuery<T extends QueryResultRow>(client: PoolClient | undefined, text: string, values?: unknown[]): Promise<QueryResult<T>> {
  return client ? client.query<T>(text, values) : query<T>(text, values);
}

async function updateCheckState(check: MonitoringCheck, observation: MonitoringObservation, recordDaily = true, reschedule = false): Promise<void> {
  if (check.checkType !== 'push' || !check.pushCronExpression) {
    if (await applyCheckState(check, observation, recordDaily, reschedule)) await syncStatusPageReportsAfterIssueChange();
    return;
  }

  const client = await getClient();
  let issueChanged = false;
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT c.id FROM monitoring_checks c JOIN monitoring_targets t ON t.id = c.target_id
       WHERE c.id = $1 FOR UPDATE OF c, t`, [check.id],
    );
    const current = await getMonitoringCheck(check.id, client);
    if (current?.checkType === 'push' && current.pushCronExpression && current.enabled && !current.pausedAt && current.targetEnabled
      && current.pushRevision === check.pushRevision
      && (current.pushScheduleCursor?.getTime() ?? null) === (check.pushScheduleCursor?.getTime() ?? null)) {
      issueChanged = await applyCheckState(current, observation, recordDaily, reschedule, client);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
  if (issueChanged) await syncStatusPageReportsAfterIssueChange();
}

async function applyCheckState(
  check: MonitoringCheck,
  observation: MonitoringObservation,
  recordDaily: boolean,
  reschedule: boolean,
  client?: PoolClient,
): Promise<boolean> {
  const failure = observation.status === 'down' || observation.status === 'warning';
  const activeIssue = await monitoringQuery<{ id: number; opened_at: Date; severity: string; notification_suppressed: boolean }>(client,
    `SELECT id, opened_at, severity, notification_suppressed FROM monitoring_issues
     WHERE check_id = $1 AND status = 'open'
     ORDER BY opened_at DESC
     LIMIT 1`,
    [check.id]
  );
  const nowMs = observation.observedAt.getTime();
  const previousStatusSince = check.statusSince ?? observation.observedAt;
  const partialFailure = observation.details.partialFailure === true;
  const expiredCron = check.checkType === 'push' && check.pushCronExpression
    && Array.isArray(observation.details.failingLocations)
    && observation.details.failingLocations.some(location => recordValue(location).errorCode === 'cron_ping_missed');
  const failingLongEnough = failure && !partialFailure
    && (expiredCron || (check.currentStatus === observation.status
      ? nowMs - previousStatusSince.getTime() >= check.confirmationSeconds * 1000
      : check.confirmationSeconds <= 0));
  const recoveredLongEnough = !failure
    && activeIssue.rows[0]
    && (check.currentStatus === 'up'
      ? nowMs - previousStatusSince.getTime() >= check.recoverySeconds * 1000
      : check.recoverySeconds <= 0);
  const nextRunAt = observation.details.pushScanBacklog === true
    ? observation.observedAt
    : new Date(observation.observedAt.getTime() + evaluationIntervalSeconds(check) * 1000);
  const statusSince = check.currentStatus === observation.status && check.statusSince
    ? check.statusSince
    : observation.observedAt;
  const evaluatedThrough = typeof observation.details.pushEvaluatedThrough === 'string'
    ? new Date(observation.details.pushEvaluatedThrough)
    : null;
  const recoveredThrough = typeof observation.details.pushRecoveryThrough === 'string'
    ? new Date(observation.details.pushRecoveryThrough)
    : null;

  await monitoringQuery(client,
    `UPDATE monitoring_checks
     SET status_since = CASE WHEN current_status = $2 AND status_since IS NOT NULL THEN status_since ELSE $3 END,
         current_status = $2,
         last_run_at = CASE WHEN $9::boolean THEN $4 ELSE last_run_at END,
         next_run_at = CASE WHEN $9::boolean THEN $5 ELSE next_run_at END,
         last_response_time_ms = $6, last_error = $7,
         consecutive_failures = CASE WHEN $8::boolean THEN consecutive_failures + 1 ELSE 0 END,
         consecutive_successes = CASE WHEN $8::boolean THEN 0 ELSE consecutive_successes + 1 END,
         push_schedule_cursor = CASE WHEN $10::timestamptz IS NULL THEN push_schedule_cursor ELSE GREATEST(push_schedule_cursor, $10::timestamptz) END,
         push_recovered_through = CASE WHEN $11::timestamptz IS NULL THEN push_recovered_through ELSE GREATEST(push_recovered_through, $11::timestamptz) END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1`,
    [
      check.id,
      observation.status,
      statusSince,
      observation.observedAt,
      nextRunAt,
      observation.responseTimeMs,
      observation.error,
      failure,
      reschedule,
      evaluatedThrough,
      recoveredThrough,
    ]
  );

  if (recordDaily) {
    await monitoringQuery(client,
      `INSERT INTO monitoring_check_daily AS d
         (check_id, day, up_count, warning_count, down_count, unavailable_warning_count,
          response_time_sum, response_time_count, response_time_max)
       VALUES ($1, ($2::timestamptz AT TIME ZONE 'UTC')::date,
         ($3 = 'up')::int, ($3 = 'warning')::int, ($3 = 'down')::int,
         ($3 = 'warning' AND (COALESCE($4::jsonb->>'unavailableWarning' = 'true', false) OR COALESCE($4::jsonb->>'certificateError' = 'true', false)))::int,
         COALESCE($5, 0), ($5 IS NOT NULL)::int, $5)
       ON CONFLICT (check_id, day) DO UPDATE SET
         up_count = d.up_count + EXCLUDED.up_count,
         warning_count = d.warning_count + EXCLUDED.warning_count,
         down_count = d.down_count + EXCLUDED.down_count,
         unavailable_warning_count = d.unavailable_warning_count + EXCLUDED.unavailable_warning_count,
         response_time_sum = d.response_time_sum + EXCLUDED.response_time_sum,
         response_time_count = d.response_time_count + EXCLUDED.response_time_count,
         response_time_max = GREATEST(d.response_time_max, EXCLUDED.response_time_max)`,
      [check.id, observation.observedAt, observation.status, JSON.stringify(observation.details), observation.responseTimeMs],
    );
  }

  let issueChanged = false;
  if (failingLongEnough && activeIssue.rows.length === 0) {
    const notificationSuppressed = await isMonitoringCheckSilenced(check.id, check.targetId, client);
    const issue = await monitoringQuery<{ id: string }>(client,
      `INSERT INTO monitoring_issues (check_id, status, severity, summary, details_json, opened_at, notification_suppressed, updated_at)
       VALUES ($1, 'open', $2, $3, $4::jsonb, $5, $6, CURRENT_TIMESTAMP)
       ON CONFLICT (check_id) WHERE status = 'open' DO NOTHING
       RETURNING id`,
      [
        check.id,
        observation.status === 'warning' ? 'warning' : 'critical',
        `${check.name} is ${observation.status}`,
        JSON.stringify({
          error: observation.error,
          details: observation.details,
          observationId: observation.id,
        }),
        observation.observedAt,
        notificationSuppressed,
      ]
    );
    // A concurrent evaluation may already have opened the issue and queued its deliveries.
    if (issue.rows[0] && !notificationSuppressed) {
      await enqueueMonitoringIssueDeliveries({
        check,
        observation,
        issueId: Number(issue.rows[0].id),
        eventKind: 'failure',
        summary: `${check.name} is ${observation.status}`,
        client,
      });
      issueChanged = true;
    } else if (issue.rows[0]) issueChanged = true;
  } else if (failure && activeIssue.rows[0]) {
    const severity = observation.status === 'warning' ? 'warning' : 'critical';
    const escalated = failingLongEnough && severity === 'critical' && activeIssue.rows[0].severity !== 'critical';
    // An issue keeps its worst state until it closes: a full outage that starts
    // recovering at one location first stays recorded as down, not warning.
    const keptCritical = activeIssue.rows[0].severity === 'critical';
    await monitoringQuery(client,
      `UPDATE monitoring_issues
       SET severity = $2, summary = $3, updated_at = CURRENT_TIMESTAMP,
           details_json = details_json || $4::jsonb
       WHERE id = $1`,
      [
        activeIssue.rows[0].id,
        keptCritical ? 'critical' : severity,
        keptCritical ? `${check.name} is down` : `${check.name} is ${observation.status}`,
        JSON.stringify({
          error: observation.error,
          details: observation.details,
          latestObservationId: observation.id,
        }),
      ]
    );
    // A quorum warning may already have used this issue's failure notification; a real outage still has to page.
    if (escalated && !(await isMonitoringCheckSilenced(check.id, check.targetId, client))) {
      await enqueueMonitoringIssueDeliveries({
        check,
        observation,
        issueId: Number(activeIssue.rows[0].id),
        eventKind: 'failure',
        summary: `${check.name} is ${observation.status}`,
        dedupeSuffix: 'escalated',
        client,
      });
    }
    issueChanged = true;
  }

  if (recoveredLongEnough) {
    const recovered = await monitoringQuery<{ id: string }>(client,
      `UPDATE monitoring_issues
       SET status = 'closed', closed_at = $2, updated_at = CURRENT_TIMESTAMP,
           details_json = details_json || $3::jsonb
       WHERE id = $1
       RETURNING id`,
      [
        activeIssue.rows[0].id,
        observation.observedAt,
        JSON.stringify({ recoveryObservationId: observation.id }),
      ]
    );
    if (recovered.rows[0] && !activeIssue.rows[0].notification_suppressed) {
      await enqueueMonitoringIssueDeliveries({
        check,
        observation,
        issueId: Number(recovered.rows[0].id),
        eventKind: 'recovery',
        summary: `${check.name} recovered`,
        client,
      });
      issueChanged = true;
    } else if (recovered.rows[0]) issueChanged = true;
  }
  return issueChanged;
}

async function syncStatusPageReportsAfterIssueChange(): Promise<void> {
  try {
    await syncAutomaticStatusPageReports();
  } catch (error) {
    logger.error('Failed to sync automatic status page reports after monitoring issue change', {
      error: (error as Error).message,
    });
  }
}

async function enqueueMonitoringIssueDeliveries(input: {
  check: MonitoringCheck;
  observation: MonitoringObservation;
  issueId: number;
  eventKind: 'failure' | 'recovery';
  summary: string;
  dedupeSuffix?: string;
  client?: PoolClient;
}): Promise<void> {
  if (input.eventKind === 'failure' && await isMonitoringCheckSilenced(input.check.id, input.check.targetId, input.client)) return;
  const setting = await monitoringQuery<{ value: string }>(input.client,
    `SELECT value FROM admin_config WHERE key = 'alertsEnabled'`
  );
  if (setting.rows[0]?.value !== 'true') return;
  const webhooks = await monitoringQuery<MonitoringDeliveryWebhookRow>(input.client,
    `SELECT id, name, adapter, subscriptions_json, notify_recovery
     FROM alert_webhooks
     WHERE enabled = true
       AND encrypted_url IS NOT NULL
       AND (paused_at IS NULL OR (paused_until IS NOT NULL AND paused_until <= CURRENT_TIMESTAMP))
     ORDER BY id`
  );
  const subscribedWebhooks = webhooks.rows.filter((webhook) => {
    if (input.eventKind === 'recovery' && !webhook.notify_recovery) return false;
    return hasMonitoringIssueSubscription(webhook.subscriptions_json);
  });
  await Promise.all(subscribedWebhooks
    .map((webhook) => ({ webhook, payload: buildMonitoringPayload(webhook, input) }))
    .filter((item): item is { webhook: MonitoringDeliveryWebhookRow; payload: JsonRecord } => item.payload !== null)
    .map(({ webhook, payload }) => createAlertDelivery({
    dedupeKey: `monitoring:${input.issueId}:${input.eventKind}${input.dedupeSuffix ? `:${input.dedupeSuffix}` : ''}:${webhook.id}`,
    webhookId: webhook.id,
    webhookName: webhook.name,
    fleetServiceId: null,
    monitoringIssueId: input.issueId,
    serviceId: `monitoring-check-${input.check.id}`,
    serviceName: input.check.name,
    serviceType: 'monitoring',
    alertType: 'monitoring_issue',
    eventKind: input.eventKind,
    adapter: webhook.adapter,
    payload,
    client: input.client,
  })));
  await enqueueMonitoringIssueAdminDeliveries(input);
}

export async function processExpiredMonitoringSilences(): Promise<number> {
  const client = await getClient();
  let issueCount = 0;
  try {
    await client.query('BEGIN');
    const expired = await client.query<{ id: number }>(
      `SELECT id FROM monitoring_silences
       WHERE processed_at IS NULL AND ends_at <= CURRENT_TIMESTAMP
       ORDER BY ends_at, id
       LIMIT 1000
       FOR UPDATE SKIP LOCKED`,
    );
    if (!expired.rows.length) {
      await client.query('COMMIT');
      return 0;
    }
    const silenceIds = expired.rows.map(row => row.id);
    const issues = await client.query<{
      silence_id: number;
      issue_id: number;
      check_id: number;
      details_json: unknown;
      opened_at: Date;
      severity: 'warning' | 'critical';
      summary: string;
    }>(
      `SELECT DISTINCT ON (i.id)
         s.id AS silence_id, i.id AS issue_id, i.check_id, i.details_json, i.opened_at, i.severity, i.summary
       FROM monitoring_silences s
       JOIN monitoring_checks c ON (s.scope_type = 'check' AND c.id = s.check_id)
          OR (s.scope_type = 'target' AND c.target_id = s.target_id)
       JOIN monitoring_issues i ON i.check_id = c.id AND i.status = 'open'
       WHERE s.id = ANY($1::int[])
         AND NOT EXISTS (
           SELECT 1 FROM monitoring_silences active
           WHERE active.starts_at <= CURRENT_TIMESTAMP AND active.ends_at > CURRENT_TIMESTAMP
             AND ((active.scope_type = 'check' AND active.check_id = c.id)
               OR (active.scope_type = 'target' AND active.target_id = c.target_id))
         )
       ORDER BY i.id, s.ends_at DESC, s.id DESC`,
      [silenceIds],
    );
    for (const issue of issues.rows) {
      const check = await getMonitoringCheck(issue.check_id, client);
      if (!check) continue;
      const stored = recordValue(issue.details_json);
      const status = issue.severity === 'warning' ? 'warning' : 'down';
      const details = recordValue(stored.details);
      const observation: MonitoringObservation = {
        id: typeof stored.observationId === 'number' ? stored.observationId : 0,
        checkId: issue.check_id,
        locationId: null,
        status,
        errorCode: null,
        responseTimeMs: null,
        error: typeof stored.error === 'string' ? stored.error : null,
        details,
        observedAt: issue.opened_at,
      };
      await enqueueMonitoringIssueDeliveries({
        check,
        observation,
        issueId: issue.issue_id,
        eventKind: 'failure',
        summary: `${issue.summary} (maintenance ended)`,
        dedupeSuffix: `silence-ended:${issue.silence_id}`,
        client,
      });
      await client.query(
        'UPDATE monitoring_issues SET notification_suppressed = false WHERE id = $1 AND status = $2',
        [issue.issue_id, 'open'],
      );
      issueCount += 1;
    }
    await client.query(
      'UPDATE monitoring_silences SET processed_at = CURRENT_TIMESTAMP WHERE id = ANY($1::int[])',
      [silenceIds],
    );
    await client.query('COMMIT');
    return issueCount;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function enqueueMonitoringIssueAdminDeliveries(input: {
  check: MonitoringCheck;
  observation: MonitoringObservation;
  issueId: number;
  eventKind: 'failure' | 'recovery';
  summary: string;
  client?: PoolClient;
}): Promise<void> {
  const admins = await listAdminEmailSubscriptions(input.client);
  const subscribed = admins.filter((admin) => !admin.disabled && (
    input.eventKind === 'failure' ? admin.monitoringIssueOpened : admin.monitoringIssueRecovered
  ));
  const issue: MonitoringIssue = {
    id: input.issueId,
    checkId: input.check.id,
    checkName: input.check.name,
    targetName: input.check.targetName,
    status: input.eventKind === 'recovery' ? 'closed' : 'open',
    severity: input.observation.status === 'warning' ? 'warning' : 'critical',
    summary: input.summary,
    details: {
      error: input.observation.error,
      details: input.observation.details,
      observationId: input.observation.id,
    },
    openedAt: input.observation.observedAt,
    closedAt: input.eventKind === 'recovery' ? input.observation.observedAt : null,
    updatedAt: input.observation.observedAt,
    deliveries: [],
  };
  await Promise.all(subscribed.map((admin) => enqueueMonitoringIssueAdminEmail({
    email: admin.adminEmail,
    issue,
    event: input.eventKind === 'recovery' ? 'recovered' : 'opened',
    client: input.client,
  })));
}

function hasMonitoringIssueSubscription(value: unknown): boolean {
  return Array.isArray(value) && value.some((item) => (
    item
    && typeof item === 'object'
    && (item as { alertType?: unknown }).alertType === 'monitoring_issue'
    && (item as { enabled?: unknown }).enabled === true
  ));
}

function buildMonitoringPayload(
  webhook: Pick<MonitoringDeliveryWebhookRow, 'id' | 'name' | 'adapter'>,
  input: {
    check: MonitoringCheck;
    observation: MonitoringObservation;
    issueId: number;
    eventKind: 'failure' | 'recovery';
    summary: string;
  }
): JsonRecord | null {
  const endpoint = formatMonitoringEndpoint(input.check);
  const responseTime = input.observation.responseTimeMs === null ? 'n/a' : `${input.observation.responseTimeMs} ms`;
  const status = input.eventKind === 'recovery' ? 'recovered' : input.observation.status;
  const failingLocations = Array.isArray(input.observation.details.failingLocations)
    ? input.observation.details.failingLocations.filter((location): location is Record<string, unknown> =>
      location !== null && typeof location === 'object' && !Array.isArray(location))
    : [];
  const locationSummary = failingLocations.map(location =>
    `${String(location.name ?? 'Unknown location')} (${String(location.status ?? 'unknown')}${location.errorCode ? `: ${String(location.errorCode)}` : ''})`,
  ).join('\n') || 'No failing location detail';
  const detail = {
    version: 1,
    eventKind: input.eventKind,
    alertType: 'monitoring_issue',
    summary: input.summary,
    issue: {
      id: input.issueId,
      status: input.eventKind === 'recovery' ? 'closed' : 'open',
    },
    service: {
      id: `monitoring-check-${input.check.id}`,
      name: input.check.name,
      type: 'monitoring',
    },
    monitoring: {
      checkId: input.check.id,
      targetId: input.check.targetId,
      targetName: input.check.targetName,
      targetEnvironment: input.check.targetEnvironment,
      checkType: input.check.checkType,
      endpoint: input.check.endpoint,
      endpointDisplay: endpoint,
      port: input.check.port,
      status: input.observation.status,
      responseTimeMs: input.observation.responseTimeMs,
      error: input.observation.error,
      observedAt: input.observation.observedAt.toISOString(),
      details: input.observation.details,
    },
  };
  if (webhook.adapter === 'sentry') {
    return buildSentryAlertPayload({
      alertKey: `monitoring:check:${input.check.id}`,
      alertType: 'monitoring_issue',
      eventKind: input.eventKind,
      title: `${input.check.name} is down`,
      message: input.summary,
      severity: input.observation.status === 'warning' ? 'warning' : 'critical',
      environment: input.check.targetEnvironment,
      tags: { target: input.check.targetName, check_type: input.check.checkType, endpoint },
      context: {
        issueId: input.issueId,
        endpoint,
        status: input.observation.status,
        error: input.observation.error,
        failingLocations: locationSummary,
        responseTimeMs: input.observation.responseTimeMs,
        observedAt: input.observation.observedAt.toISOString(),
      },
      linkPath: '/monitoring',
      occurredAt: input.observation.observedAt,
    });
  }
  if (webhook.adapter === 'slack') {
    const title = `Monitoring ${status}: ${input.check.targetEnvironment} / ${input.check.targetName}`;
    const result = input.eventKind === 'recovery' ? 'up' : input.observation.status;
    const error = input.observation.error ?? (input.eventKind === 'recovery' ? 'OK' : 'No error detail recorded');
    const outcome = monitoringOutcome(input.check.name, input.eventKind, input.observation.status);
    const fields = [
      slackField('Endpoint', endpoint),
      slackField('Result', result),
      ...(input.eventKind === 'recovery' ? [] : [slackField('Cause', error)]),
      ...(input.eventKind === 'recovery' ? [] : [slackField('Failing locations', locationSummary)]),
      slackField('Response', responseTime),
      slackField('Observed', formatObservedAt(input.observation.observedAt)),
    ];
    return {
      text: `${title} - ${outcome} - ${endpoint}: ${error}`,
      blocks: [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: truncateSlackText(title, 150),
          },
        },
        {
          type: 'section',
          text: {
            type: 'mrkdwn',
            text: `*${escapeSlackMrkdwn(outcome)}*`,
          },
        },
        {
          type: 'section',
          fields,
        },
      ],
      robin_alert: detail,
    };
  }
  return detail;
}

function formatMonitoringEndpoint(check: MonitoringCheck): string {
  if (check.port === null) return check.endpoint;
  return `${check.endpoint}:${check.port}`;
}

function monitoringOutcome(
  checkName: string,
  eventKind: 'failure' | 'recovery',
  status: MonitoringObservation['status'],
): string {
  if (eventKind === 'recovery') return `${checkName} recovered`;
  if (status === 'warning') return `${checkName} is warning`;
  return `${checkName} failed`;
}

function formatObservedAt(value: Date): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const day = String(value.getUTCDate()).padStart(2, '0');
  const month = months[value.getUTCMonth()];
  const year = value.getUTCFullYear();
  const hour = String(value.getUTCHours()).padStart(2, '0');
  const minute = String(value.getUTCMinutes()).padStart(2, '0');
  return `${day} ${month} ${year}, ${hour}:${minute} UTC`;
}

function slackField(label: string, value: string): { type: 'mrkdwn'; text: string } {
  return {
    type: 'mrkdwn',
    text: `*${label}*\n${escapeSlackMrkdwn(value)}`,
  };
}

function escapeSlackMrkdwn(value: string): string {
  return truncateSlackText(value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'), 2000);
}

function truncateSlackText(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, Math.max(0, maxLength - 3))}...`;
}

export async function listMonitoringIssues(status?: 'open' | 'closed', limit = 50): Promise<MonitoringIssue[]> {
  const result = await query<IssueRow>(
    `SELECT ${ISSUE_COLUMNS}
     FROM monitoring_issues i
     JOIN monitoring_checks c ON c.id = i.check_id
     JOIN monitoring_targets t ON t.id = c.target_id
     WHERE ($1::text IS NULL OR i.status = $1)
     ORDER BY i.opened_at DESC, i.id DESC
     LIMIT $2`,
    [status ?? null, Math.max(1, Math.min(limit, 200))]
  );
  return attachIssueDeliveries(result.rows.map(mapIssue));
}

async function attachIssueDeliveries(issues: MonitoringIssue[]): Promise<MonitoringIssue[]> {
  if (issues.length === 0) return issues;
  const issueIds = issues.map((issue) => issue.id);
  const result = await query<IssueDeliveryRow>(
    `SELECT id, monitoring_issue_id, webhook_name, event_kind, status, attempts,
            response_status, error, created_at, completed_at
     FROM alert_deliveries
     WHERE monitoring_issue_id = ANY($1::bigint[])
     ORDER BY created_at DESC, id DESC`,
    [issueIds]
  );
  const byIssueId = new Map<number, MonitoringIssueDelivery[]>();
  for (const row of result.rows) {
    const entries = byIssueId.get(row.monitoring_issue_id) ?? [];
    entries.push(mapIssueDelivery(row));
    byIssueId.set(row.monitoring_issue_id, entries);
  }
  return issues.map((issue) => ({
    ...issue,
    deliveries: byIssueId.get(issue.id) ?? [],
  }));
}

/**
 * Deletes a closed issue, for example one caused by a test. Open issues are
 * refused, so a live failure cannot be hidden. Its status page incident links
 * go with it; past alert deliveries keep their record without the issue.
 */
export async function deleteClosedMonitoringIssue(id: number): Promise<'open' | boolean> {
  const result = await query<{ status: string }>(`SELECT status FROM monitoring_issues WHERE id = $1`, [id]);
  if (!result.rows[0]) return false;
  if (result.rows[0].status === 'open') return 'open';
  const deleted = await query(`DELETE FROM monitoring_issues WHERE id = $1 AND status = 'closed'`, [id]);
  return (deleted.rowCount ?? 0) > 0;
}

export async function closeStaleMonitoringIssue(id: number): Promise<MonitoringIssue | 'active' | null> {
  const active = await query<{ id: number }>(
    `SELECT i.id
     FROM monitoring_issues i
     JOIN monitoring_checks c ON c.id = i.check_id
     WHERE i.id = $1
       AND i.status = 'open'
       AND c.enabled = true
       AND c.paused_at IS NULL
       AND c.current_status IN ('warning', 'down')
     LIMIT 1`,
    [id]
  );
  if (active.rows[0]) return 'active';
  const result = await query<IssueRow>(
    `UPDATE monitoring_issues i
     SET status = 'closed', closed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP,
         details_json = details_json || $2::jsonb
     FROM monitoring_checks c
     JOIN monitoring_targets t ON t.id = c.target_id
     WHERE i.id = $1
       AND i.check_id = c.id
       AND i.status = 'open'
     RETURNING ${ISSUE_COLUMNS}`,
    [id, JSON.stringify({ manuallyClosedAsStale: true })]
  );
  if (!result.rows[0]) return null;
  const [issue] = await attachIssueDeliveries([mapIssue(result.rows[0])]);
  return issue;
}

const PRUNE_BATCH_SIZE = 10_000;

/**
 * Delete raw observations older than `observationDays` in batches, so a large
 * backlog never holds one long lock, and daily rollups older than
 * `historyDays`. Returns the number of rows removed from each table.
 */
export async function pruneMonitoringHistory(observationDays: number, historyDays: number): Promise<{ observations: number; days: number }> {
  let observations = 0;
  for (;;) {
    const result = await query(
      `DELETE FROM monitoring_observations
       WHERE id IN (
         SELECT id FROM monitoring_observations
         WHERE observed_at < CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
         ORDER BY observed_at
         LIMIT $2
       )`,
      [observationDays, PRUNE_BATCH_SIZE]
    );
    observations += result.rowCount ?? 0;
    if ((result.rowCount ?? 0) < PRUNE_BATCH_SIZE) break;
  }
  for (;;) {
    const result = await query(
      `DELETE FROM monitoring_push_checkins
       WHERE received_at < CURRENT_TIMESTAMP - INTERVAL '2 days'
         AND (check_id, scheduled_at) IN (
         SELECT p.check_id, p.scheduled_at
         FROM monitoring_push_checkins p JOIN monitoring_checks c ON c.id = p.check_id
         WHERE p.received_at < CURRENT_TIMESTAMP - INTERVAL '2 days'
           AND (c.push_cron_expression IS NULL OR p.received_at < c.push_schedule_started_at OR (
             p.scheduled_at < GREATEST(c.push_schedule_cursor, c.push_recovered_through)
             AND p.scheduled_at < (
               SELECT MAX(newer.scheduled_at) FROM monitoring_push_checkins newer
               WHERE newer.check_id = p.check_id
                 AND newer.received_at >= c.push_schedule_started_at
                 AND newer.scheduled_at <= CURRENT_TIMESTAMP - (c.confirmation_seconds * INTERVAL '1 second')
             )))
         ORDER BY p.received_at LIMIT $1
       )`,
      [PRUNE_BATCH_SIZE],
    );
    if ((result.rowCount ?? 0) < PRUNE_BATCH_SIZE) break;
  }
  const days = await query(
    `DELETE FROM monitoring_check_daily WHERE day < CURRENT_DATE - $1::int`,
    [historyDays]
  );
  const locationDays = await query(
    `DELETE FROM monitoring_location_daily WHERE day < CURRENT_DATE - $1::int`,
    [historyDays]
  );
  return { observations, days: (days.rowCount ?? 0) + (locationDays.rowCount ?? 0) };
}

interface CheckDayRow {
  day: string;
  up_count: number;
  warning_count: number;
  down_count: number;
  unavailable_warning_count: number;
  response_time_sum: string;
  response_time_count: number;
  response_time_max: number | null;
}

/** Daily availability for one check, oldest first, for the last `days` UTC days. */
export async function getMonitoringCheckHistory(checkId: number, days: number): Promise<MonitoringCheckDay[]> {
  const result = await query<CheckDayRow>(
    `SELECT day::text AS day, up_count, warning_count, down_count, unavailable_warning_count, response_time_sum, response_time_count, response_time_max
     FROM monitoring_check_daily
     WHERE check_id = $1 AND day > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - $2::int
     ORDER BY day`,
    [checkId, days]
  );
  return result.rows.map((row) => {
    const total = row.up_count + row.warning_count + row.down_count;
    return {
      day: row.day,
      up: row.up_count,
      warning: row.warning_count,
      down: row.down_count,
      availability: total > 0 ? (row.up_count + row.warning_count - row.unavailable_warning_count) / total : null,
      averageResponseTimeMs: row.response_time_count > 0 ? Math.round(Number(row.response_time_sum) / row.response_time_count) : null,
      maxResponseTimeMs: row.response_time_max,
    };
  });
}

export async function getMonitoringCheckLocationHistory(checkId: number, days: number): Promise<Array<MonitoringCheckDay & {
  locationId: number;
  locationName: string;
  region: string | null;
}>> {
  const result = await query<{
    location_id: number; location_name: string; region: string | null; day: string;
    up_count: number; warning_count: number; down_count: number; unavailable_warning_count: number;
    response_time_sum: string; response_time_count: number; response_time_max: number | null;
  }>(
    `SELECT d.location_id, l.name AS location_name, l.region, d.day::text AS day,
            d.up_count, d.warning_count, d.down_count, d.unavailable_warning_count, d.response_time_sum,
            d.response_time_count, d.response_time_max
     FROM monitoring_location_daily d
     JOIN monitoring_locations l ON l.id = d.location_id
     WHERE d.check_id = $1 AND d.day > (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date - $2::int
     ORDER BY l.name, d.location_id, d.day`,
    [checkId, days],
  );
  return result.rows.map(row => {
    const total = row.up_count + row.warning_count + row.down_count;
    return {
      locationId: row.location_id,
      locationName: row.location_name,
      region: row.region,
      day: row.day,
      up: row.up_count,
      warning: row.warning_count,
      down: row.down_count,
      availability: total ? (row.up_count + row.warning_count - row.unavailable_warning_count) / total : null,
      averageResponseTimeMs: row.response_time_count ? Math.round(Number(row.response_time_sum) / row.response_time_count) : null,
      maxResponseTimeMs: row.response_time_max,
    };
  });
}

export interface MonitoringIssueSpan {
  id: number;
  checkName: string;
  severity: 'warning' | 'critical';
  summary: string;
  openedAt: string;
  closedAt: string | null;
}

/** Issues open at any time within [start, end], oldest first, for chart annotations. */
export async function listMonitoringIssueSpans(start: Date, end: Date, limit = 200): Promise<MonitoringIssueSpan[]> {
  const result = await query<{ id: string; check_name: string; severity: 'warning' | 'critical'; summary: string; opened_at: Date; closed_at: Date | null }>(
    `SELECT i.id, c.name AS check_name, i.severity, i.summary, i.opened_at, i.closed_at
     FROM monitoring_issues i JOIN monitoring_checks c ON c.id = i.check_id
     WHERE i.opened_at <= $2 AND (i.closed_at IS NULL OR i.closed_at >= $1)
     ORDER BY i.opened_at
     LIMIT $3`,
    [start, end, Math.max(1, Math.min(limit, 500))]
  );
  return result.rows.map((row) => ({
    id: Number(row.id),
    checkName: row.check_name,
    severity: row.severity,
    summary: row.summary,
    openedAt: row.opened_at.toISOString(),
    closedAt: row.closed_at?.toISOString() ?? null,
  }));
}

export async function listRecentMonitoringObservations(limit = 50): Promise<MonitoringObservation[]> {
  const result = await query<ObservationRow>(
    `SELECT id, check_id, location_id, status, error_code, response_time_ms, error, details_json, observed_at
     FROM monitoring_observations
     ORDER BY observed_at DESC, id DESC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 200))]
  );
  return result.rows.map(mapObservation);
}

export async function getMonitoringSummary(): Promise<MonitoringSummary> {
  const [targets, checks, openIssues, recentIssues, recentObservations, weeklyCounts] = await Promise.all([
    listMonitoringTargets(),
    listMonitoringChecks(),
    listMonitoringIssues('open', 100),
    listMonitoringIssues(undefined, 200),
    listRecentMonitoringObservations(25),
    query<{ week_start: Date; count: string }>(
      `SELECT DATE_TRUNC('week', opened_at)::date AS week_start, COUNT(*) AS count
       FROM monitoring_issues
       WHERE opened_at >= CURRENT_DATE - INTERVAL '12 weeks'
       GROUP BY 1
       ORDER BY 1 DESC`
    ),
  ]);
  return {
    targets,
    checks,
    openIssues,
    recentIssues,
    recentObservations,
    weeklyIssueCounts: weeklyCounts.rows.map((row) => ({
      weekStart: row.week_start.toISOString().slice(0, 10),
      count: Number(row.count),
    })),
  };
}
