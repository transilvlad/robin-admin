import type { PoolClient } from 'pg';
import { query } from '../connection.js';
import type {
  TelemetryAlertRule,
  TelemetryAlertRuleInput,
  TelemetryAlertRuleWithStates,
  TelemetryAlertSeriesState,
} from '../../types/telemetry-alerts.js';

interface RuleRow {
  id: number;
  name: string;
  description: string | null;
  query: string;
  comparator: TelemetryAlertRule['comparator'];
  threshold: number;
  for_seconds: number;
  severity: TelemetryAlertRule['severity'];
  enabled: boolean;
  last_evaluated_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface StateRow {
  rule_id: number;
  series_key: string;
  labels_json: Record<string, string>;
  status: 'pending' | 'firing';
  pending_since: Date;
  firing_since: Date | null;
  last_value: number | null;
  last_seen_at: Date;
}

const RULE_COLUMNS = `id, name, description, query, comparator, threshold, for_seconds, severity, enabled,
  last_evaluated_at, last_error, created_at, updated_at`;

function mapRule(row: RuleRow): TelemetryAlertRule {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    query: row.query,
    comparator: row.comparator,
    threshold: Number(row.threshold),
    forSeconds: row.for_seconds,
    severity: row.severity,
    enabled: row.enabled,
    lastEvaluatedAt: row.last_evaluated_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export function mapState(row: StateRow): TelemetryAlertSeriesState {
  return {
    ruleId: row.rule_id,
    seriesKey: row.series_key,
    labels: row.labels_json,
    status: row.status,
    pendingSince: row.pending_since.toISOString(),
    firingSince: row.firing_since?.toISOString() ?? null,
    lastValue: row.last_value === null ? null : Number(row.last_value),
    lastSeenAt: row.last_seen_at.toISOString(),
  };
}

export async function listTelemetryAlertRules(): Promise<TelemetryAlertRuleWithStates[]> {
  const [rules, states] = await Promise.all([
    query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM telemetry_alert_rules ORDER BY name, id`),
    query<StateRow>(`SELECT rule_id, series_key, labels_json, status, pending_since, firing_since, last_value, last_seen_at
                     FROM telemetry_alert_states ORDER BY status DESC, pending_since`),
  ]);
  return rules.rows.map((row) => ({
    ...mapRule(row),
    states: states.rows.filter((state) => state.rule_id === row.id).map(mapState),
  }));
}

export async function listEnabledTelemetryAlertRules(client: PoolClient): Promise<TelemetryAlertRule[]> {
  const result = await client.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM telemetry_alert_rules WHERE enabled ORDER BY id`);
  return result.rows.map(mapRule);
}

export async function createTelemetryAlertRule(input: TelemetryAlertRuleInput): Promise<TelemetryAlertRule> {
  const result = await query<RuleRow>(
    `INSERT INTO telemetry_alert_rules (name, description, query, comparator, threshold, for_seconds, severity, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${RULE_COLUMNS}`,
    [input.name, input.description, input.query, input.comparator, input.threshold, input.forSeconds, input.severity, input.enabled],
  );
  return mapRule(result.rows[0]);
}

/**
 * Series state survives an edit: the next evaluation recovers firing series
 * that no longer match or are no longer returned, through the normal delivery
 * path. A disabled rule's state is cleared, with recoveries, by the evaluator.
 */
export async function updateTelemetryAlertRule(id: number, input: TelemetryAlertRuleInput): Promise<TelemetryAlertRule | null> {
  const result = await query<RuleRow>(
    `UPDATE telemetry_alert_rules
     SET name = $2, description = $3, query = $4, comparator = $5, threshold = $6, for_seconds = $7,
         severity = $8, enabled = $9, last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${RULE_COLUMNS}`,
    [id, input.name, input.description, input.query, input.comparator, input.threshold, input.forSeconds, input.severity, input.enabled],
  );
  if (!result.rows[0]) return null;
  return mapRule(result.rows[0]);
}

export async function listTelemetryAlertRulesByIds(client: PoolClient, ids: number[]): Promise<TelemetryAlertRule[]> {
  if (ids.length === 0) return [];
  const result = await client.query<RuleRow>(`SELECT ${RULE_COLUMNS} FROM telemetry_alert_rules WHERE id = ANY($1::int[]) ORDER BY id`, [ids]);
  return result.rows.map(mapRule);
}

/** Its series states go with the rule (ON DELETE CASCADE). */
export async function deleteTelemetryAlertRule(client: PoolClient, id: number): Promise<boolean> {
  const result = await client.query('DELETE FROM telemetry_alert_rules WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function loadTelemetryAlertStates(client: PoolClient, ruleId: number): Promise<StateRow[]> {
  const result = await client.query<StateRow>(
    `SELECT rule_id, series_key, labels_json, status, pending_since, firing_since, last_value, last_seen_at
     FROM telemetry_alert_states WHERE rule_id = $1`,
    [ruleId],
  );
  return result.rows;
}

export async function saveTelemetryAlertState(client: PoolClient, state: StateRow): Promise<void> {
  await client.query(
    `INSERT INTO telemetry_alert_states
       (rule_id, series_key, labels_json, status, pending_since, firing_since, last_value, last_seen_at)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7, $8)
     ON CONFLICT (rule_id, series_key) DO UPDATE
       SET labels_json = EXCLUDED.labels_json, status = EXCLUDED.status, pending_since = EXCLUDED.pending_since,
           firing_since = EXCLUDED.firing_since, last_value = EXCLUDED.last_value,
           last_seen_at = EXCLUDED.last_seen_at, updated_at = CURRENT_TIMESTAMP`,
    [state.rule_id, state.series_key, JSON.stringify(state.labels_json), state.status, state.pending_since,
      state.firing_since, state.last_value, state.last_seen_at],
  );
}

export async function deleteTelemetryAlertState(client: PoolClient, ruleId: number, seriesKey: string): Promise<void> {
  await client.query('DELETE FROM telemetry_alert_states WHERE rule_id = $1 AND series_key = $2', [ruleId, seriesKey]);
}

export async function recordTelemetryAlertRuleEvaluation(
  client: PoolClient,
  ruleId: number,
  error: string | null,
  at: Date,
): Promise<void> {
  await client.query(
    'UPDATE telemetry_alert_rules SET last_evaluated_at = $2, last_error = $3 WHERE id = $1',
    [ruleId, at, error === null ? null : error.slice(0, 500)],
  );
}

/**
 * Disabled rules track nothing. Returns the cleared states so the caller can
 * recover the ones that were firing.
 */
export async function clearDisabledTelemetryAlertStates(client: PoolClient): Promise<StateRow[]> {
  const result = await client.query<StateRow>(
    `DELETE FROM telemetry_alert_states s USING telemetry_alert_rules r
     WHERE r.id = s.rule_id AND NOT r.enabled
     RETURNING s.rule_id, s.series_key, s.labels_json, s.status, s.pending_since, s.firing_since, s.last_value, s.last_seen_at`,
  );
  return result.rows;
}
