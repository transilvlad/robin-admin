import type { PoolClient } from 'pg';
import { getClient, query } from '../connection.js';
import type {
  TelemetryAlertIssue,
  TelemetryAlertIssueEvent,
  TelemetryAlertIssueEventType,
  TelemetryAlertIssueResolution,
  TelemetryAlertIssueStatus,
} from '../../types/telemetry-alerts.js';
import type { TelemetryAlertRule } from '../../types/telemetry-alerts.js';

interface IssueRow {
  id: string;
  rule_id: number;
  rule_name: string;
  query: string;
  comparator: TelemetryAlertIssue['comparator'];
  threshold: number;
  for_seconds: number;
  severity: TelemetryAlertIssue['severity'];
  series_key: string;
  labels_json: Record<string, string>;
  last_value: number | null;
  status: TelemetryAlertIssueStatus;
  opened_at: Date;
  last_seen_at: Date;
  dismissed_at: Date | null;
  dismissed_by: string | null;
  dismissed_until: Date | null;
  dismissal_reason: string | null;
  revision: number;
  resolved_at: Date | null;
  resolution_reason: TelemetryAlertIssueResolution | null;
}

interface EventRow {
  id: number;
  issue_id: string;
  event_type: TelemetryAlertIssueEventType;
  actor_name: string | null;
  reason: string | null;
  expires_at: Date | null;
  occurred_at: Date;
}

const ISSUE_COLUMNS = `i.id, i.rule_id, i.rule_name, i.query, i.comparator, i.threshold, i.for_seconds,
  i.severity, i.series_key, i.labels_json, i.last_value, i.status, i.opened_at, i.last_seen_at,
  i.dismissed_at, a.name AS dismissed_by, i.dismissed_until, i.dismissal_reason, i.revision,
  i.resolved_at, i.resolution_reason`;

function mapIssue(row: IssueRow, events: TelemetryAlertIssueEvent[] = []): TelemetryAlertIssue {
  return {
    id: row.id,
    ruleId: row.rule_id,
    ruleName: row.rule_name,
    query: row.query,
    comparator: row.comparator,
    threshold: Number(row.threshold),
    forSeconds: row.for_seconds,
    severity: row.severity,
    seriesKey: row.series_key,
    labels: row.labels_json,
    lastValue: row.last_value === null ? null : Number(row.last_value),
    status: row.status,
    openedAt: row.opened_at.toISOString(),
    lastSeenAt: row.last_seen_at.toISOString(),
    dismissedAt: row.dismissed_at?.toISOString() ?? null,
    dismissedBy: row.dismissed_by,
    dismissedUntil: row.dismissed_until?.toISOString() ?? null,
    dismissalReason: row.dismissal_reason,
    revision: row.revision,
    resolvedAt: row.resolved_at?.toISOString() ?? null,
    resolutionReason: row.resolution_reason,
    events,
  };
}

function mapEvent(row: EventRow): TelemetryAlertIssueEvent {
  return {
    id: row.id,
    eventType: row.event_type,
    actorName: row.actor_name,
    reason: row.reason,
    expiresAt: row.expires_at?.toISOString() ?? null,
    occurredAt: row.occurred_at.toISOString(),
  };
}

async function loadEvents(issueIds: string[], client?: PoolClient): Promise<Map<string, TelemetryAlertIssueEvent[]>> {
  if (issueIds.length === 0) return new Map();
  const text = `SELECT e.id, e.issue_id, e.event_type, COALESCE(e.actor_name, a.name) AS actor_name,
      e.reason, e.expires_at, e.occurred_at
    FROM telemetry_alert_issue_events e
    LEFT JOIN admins a ON a.id = e.actor_admin_id
    WHERE e.issue_id = ANY($1::uuid[])
    ORDER BY e.occurred_at, e.id`;
  const result = client
    ? await client.query<EventRow>(text, [issueIds])
    : await query<EventRow>(text, [issueIds]);
  const events = new Map<string, TelemetryAlertIssueEvent[]>();
  for (const row of result.rows) {
    const current = events.get(row.issue_id) ?? [];
    current.push(mapEvent(row));
    events.set(row.issue_id, current);
  }
  return events;
}

export async function listTelemetryAlertIssues(input: {
  status?: TelemetryAlertIssueStatus;
  limit?: number;
  offset?: number;
} = {}): Promise<{ issues: TelemetryAlertIssue[]; total: number }> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 200));
  const offset = Math.max(0, input.offset ?? 0);
  const [rows, count] = await Promise.all([
    query<IssueRow>(
      `SELECT ${ISSUE_COLUMNS}
       FROM telemetry_alert_issues i
       LEFT JOIN admins a ON a.id = i.dismissed_by
       WHERE ($1::text IS NULL OR i.status = $1)
       ORDER BY CASE i.status WHEN 'active' THEN 0 WHEN 'dismissed' THEN 1 ELSE 2 END,
         i.opened_at DESC, i.id DESC
       LIMIT $2 OFFSET $3`,
      [input.status ?? null, limit, offset],
    ),
    query<{ total: string }>(
      `SELECT COUNT(*) AS total FROM telemetry_alert_issues WHERE ($1::text IS NULL OR status = $1)`,
      [input.status ?? null],
    ),
  ]);
  const events = await loadEvents(rows.rows.map((row) => row.id));
  return {
    issues: rows.rows.map((row) => mapIssue(row, events.get(row.id) ?? [])),
    total: Number(count.rows[0]?.total ?? 0),
  };
}

export async function getTelemetryAlertIssueById(id: string): Promise<TelemetryAlertIssue | null> {
  const client = await getClient();
  try {
    return await getTelemetryAlertIssue(client, id);
  } finally {
    client.release();
  }
}

export async function getTelemetryAlertIssue(client: PoolClient, id: string, lock = false): Promise<TelemetryAlertIssue | null> {
  const result = await client.query<IssueRow>(
    `SELECT ${ISSUE_COLUMNS}
     FROM telemetry_alert_issues i
     LEFT JOIN admins a ON a.id = i.dismissed_by
     WHERE i.id = $1${lock ? ' FOR UPDATE OF i' : ''}`,
    [id],
  );
  const row = result.rows[0];
  if (!row) return null;
  const events = await loadEvents([id], client);
  return mapIssue(row, events.get(id) ?? []);
}

export async function createTelemetryAlertIssue(
  client: PoolClient,
  input: {
    id: string;
    ruleId: number;
    ruleName: string;
    query: string;
    comparator: TelemetryAlertIssue['comparator'];
    threshold: number;
    forSeconds: number;
    severity: TelemetryAlertIssue['severity'];
    seriesKey: string;
    labels: Record<string, string>;
    value: number | null;
    openedAt: Date;
  },
): Promise<void> {
  await client.query(
    `INSERT INTO telemetry_alert_issues
       (id, rule_id, rule_name, query, comparator, threshold, for_seconds, severity,
        series_key, labels_json, last_value, status, opened_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11, 'active', $12, $12)`,
    [input.id, input.ruleId, input.ruleName, input.query, input.comparator, input.threshold, input.forSeconds,
      input.severity, input.seriesKey, JSON.stringify(input.labels), input.value, input.openedAt],
  );
  await recordTelemetryAlertIssueEvent(client, input.id, 'firing', null, null, input.openedAt);
}

export async function updateTelemetryAlertIssueObservation(
  client: PoolClient,
  id: string,
  input: {
    rule: Pick<TelemetryAlertRule, 'name' | 'query' | 'comparator' | 'threshold' | 'forSeconds' | 'severity'>;
    labels: Record<string, string>;
    value: number | null;
    lastSeenAt: Date;
  },
): Promise<void> {
  await client.query(
    `UPDATE telemetry_alert_issues
     SET rule_name = $2, query = $3, comparator = $4, threshold = $5, for_seconds = $6,
         severity = $7, labels_json = $8::jsonb, last_value = $9, last_seen_at = $10
     WHERE id = $1 AND status IN ('active', 'dismissed')`,
    [id, input.rule.name, input.rule.query, input.rule.comparator, input.rule.threshold,
      input.rule.forSeconds, input.rule.severity, JSON.stringify(input.labels), input.value, input.lastSeenAt],
  );
}

export async function recordTelemetryAlertIssueEvent(
  client: PoolClient,
  issueId: string,
  event: TelemetryAlertIssueEventType,
  actorAdminId: number | null,
  reason: string | null,
  at = new Date(),
  actorName: string | null = null,
  expiresAt: Date | null = null,
): Promise<void> {
  await client.query(
    `INSERT INTO telemetry_alert_issue_events
       (issue_id, event_type, actor_admin_id, actor_name, reason, expires_at, occurred_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [issueId, event, actorAdminId, actorName, reason, expiresAt, at],
  );
}

export async function cancelTelemetryAlertIssueFailures(client: PoolClient, issueId: string, reason: string): Promise<number> {
  const result = await client.query(
    `UPDATE alert_deliveries
     SET status = 'cancelled', error = $2, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE telemetry_alert_issue_id = $1 AND event_kind = 'failure' AND status = 'pending'`,
    [issueId, reason],
  );
  return result.rowCount ?? 0;
}

export async function cancelTelemetryAlertIssueDismissals(client: PoolClient, issueId: string, reason: string): Promise<number> {
  const result = await client.query(
    `UPDATE alert_deliveries
     SET status = 'cancelled', error = $2, completed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE telemetry_alert_issue_id = $1 AND event_kind = 'dismissed' AND status = 'pending'`,
    [issueId, reason],
  );
  return result.rowCount ?? 0;
}

export async function resolveTelemetryAlertIssue(
  client: PoolClient,
  issueId: string,
  resolution: TelemetryAlertIssueResolution,
  at: Date,
): Promise<void> {
  const result = await client.query(
    `UPDATE telemetry_alert_issues
     SET status = 'resolved', resolved_at = $2, resolution_reason = $3, revision = revision + 1,
         resume_notification_pending = false
     WHERE id = $1 AND status IN ('active', 'dismissed')`,
    [issueId, at, resolution],
  );
  if ((result.rowCount ?? 0) > 0) {
    await recordTelemetryAlertIssueEvent(client, issueId, 'resolved', null, resolution, at);
    await cancelTelemetryAlertIssueFailures(client, issueId, 'Telemetry alert issue resolved');
  }
}

export async function updateTelemetryAlertIssueSeverity(
  client: PoolClient,
  issueId: string,
  severity: TelemetryAlertIssue['severity'],
  at: Date,
): Promise<boolean> {
  const result = await client.query(
    `UPDATE telemetry_alert_issues
     SET severity = $2, status = 'active', dismissed_at = NULL, dismissed_by = NULL,
         dismissed_until = NULL, dismissal_reason = NULL, revision = revision + 1,
         resume_notification_pending = true
     WHERE id = $1 AND status IN ('active', 'dismissed') AND severity = 'warning' AND $2 = 'critical'
     RETURNING id`,
    [issueId, severity],
  );
  if ((result.rowCount ?? 0) === 0) return false;
  await recordTelemetryAlertIssueEvent(client, issueId, 'severity_escalated', null, null, at);
  await cancelTelemetryAlertIssueFailures(client, issueId, 'Telemetry alert severity increased');
  await cancelTelemetryAlertIssueDismissals(client, issueId, 'Telemetry alert issue is active again');
  return true;
}
