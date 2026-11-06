import type { PoolClient } from 'pg';
import { getClient, query } from '../connection.js';
import type {
  LogsAlertRule,
  LogsAlertRuleInput,
  LogsSavedSearch,
  LogsSavedSearchInput,
  LogsSearchFilters,
} from '../../types/logs.js';

interface SavedSearchRow {
  id: number;
  name: string;
  description: string | null;
  filters_json: LogsSearchFilters;
  created_by_name: string | null;
  created_at: Date;
  updated_at: Date;
}

interface LogsAlertRuleRow {
  id: number;
  name: string;
  description: string | null;
  query: string;
  window_seconds: number;
  comparator: LogsAlertRule['comparator'];
  threshold: number;
  for_seconds: number;
  enabled: boolean;
  status: LogsAlertRule['status'];
  last_value: number | null;
  pending_since: Date | null;
  firing_since: Date | null;
  generation: number;
  last_notified_at: Date | null;
  last_evaluated_at: Date | null;
  last_error: string | null;
  created_at: Date;
  updated_at: Date;
}

const SAVED_SEARCH_COLUMNS = `s.id, s.name, s.description, s.filters_json,
  a.name AS created_by_name, s.created_at, s.updated_at`;
const ALERT_RULE_COLUMNS = `id, name, description, query, window_seconds, comparator, threshold, for_seconds,
  enabled, status, last_value, pending_since, firing_since, generation, last_notified_at,
  last_evaluated_at, last_error, created_at, updated_at`;

export class LogsCapacityError extends Error {}

async function createWithinLimit<T>(
  table: 'logs_saved_searches' | 'logs_alert_rules',
  limit: number,
  insert: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Serialize the count and insert across API requests and server instances.
    await client.query('SELECT pg_advisory_xact_lock($1)', [table === 'logs_saved_searches' ? 846_255_035 : 846_255_036]);
    const count = await client.query<{ count: string }>(`SELECT count(*) AS count FROM ${table}`);
    if (Number(count.rows[0].count) >= limit) {
      throw new LogsCapacityError(`At most ${limit} ${table === 'logs_saved_searches' ? 'shared Logs saved searches' : 'Logs alert rules'} are supported`);
    }
    const result = await insert(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

function mapSavedSearch(row: SavedSearchRow): LogsSavedSearch {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    filters: row.filters_json,
    createdBy: row.created_by_name,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapAlertRule(row: LogsAlertRuleRow): LogsAlertRule {
  return {
    id: row.id,
    name: row.name,
    description: row.description,
    query: row.query,
    windowSeconds: row.window_seconds,
    comparator: row.comparator,
    threshold: Number(row.threshold),
    forSeconds: row.for_seconds,
    enabled: row.enabled,
    status: row.status,
    lastValue: row.last_value === null ? null : Number(row.last_value),
    generation: row.generation,
    pendingSince: row.pending_since?.toISOString() ?? null,
    firingSince: row.firing_since?.toISOString() ?? null,
    lastEvaluatedAt: row.last_evaluated_at?.toISOString() ?? null,
    lastError: row.last_error,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

export async function listLogsSavedSearches(): Promise<LogsSavedSearch[]> {
  const result = await query<SavedSearchRow>(
    `SELECT ${SAVED_SEARCH_COLUMNS}
     FROM logs_saved_searches s
     LEFT JOIN admins a ON a.id = s.created_by
     ORDER BY s.name, s.id`,
  );
  return result.rows.map(mapSavedSearch);
}

export async function createLogsSavedSearch(input: LogsSavedSearchInput, adminId: number | null): Promise<LogsSavedSearch> {
  return createWithinLimit('logs_saved_searches', 100, async (client) => {
    const result = await client.query<SavedSearchRow>(
      `WITH inserted AS (
         INSERT INTO logs_saved_searches (name, description, filters_json, created_by)
         VALUES ($1, $2, $3::jsonb, $4)
         RETURNING id, name, description, filters_json, created_by, created_at, updated_at
       )
       SELECT i.id, i.name, i.description, i.filters_json, a.name AS created_by_name, i.created_at, i.updated_at
       FROM inserted i LEFT JOIN admins a ON a.id = i.created_by`,
      [input.name, input.description, JSON.stringify(input.filters), adminId],
    );
    return mapSavedSearch(result.rows[0]);
  });
}

export async function updateLogsSavedSearch(id: number, input: LogsSavedSearchInput): Promise<LogsSavedSearch | null> {
  const result = await query<SavedSearchRow>(
    `WITH updated AS (
       UPDATE logs_saved_searches
       SET name = $2, description = $3, filters_json = $4::jsonb, updated_at = CURRENT_TIMESTAMP
       WHERE id = $1
       RETURNING id, name, description, filters_json, created_by, created_at, updated_at
     )
     SELECT u.id, u.name, u.description, u.filters_json, a.name AS created_by_name, u.created_at, u.updated_at
     FROM updated u LEFT JOIN admins a ON a.id = u.created_by`,
    [id, input.name, input.description, JSON.stringify(input.filters)],
  );
  return result.rows[0] ? mapSavedSearch(result.rows[0]) : null;
}

export async function deleteLogsSavedSearch(id: number): Promise<boolean> {
  const result = await query('DELETE FROM logs_saved_searches WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listLogsAlertRules(): Promise<LogsAlertRule[]> {
  const result = await query<LogsAlertRuleRow>(
    `SELECT ${ALERT_RULE_COLUMNS} FROM logs_alert_rules ORDER BY name, id`,
  );
  return result.rows.map(mapAlertRule);
}

export async function listAllLogsAlertRules(client: PoolClient): Promise<LogsAlertRule[]> {
  const result = await client.query<LogsAlertRuleRow>(
    `SELECT ${ALERT_RULE_COLUMNS} FROM logs_alert_rules ORDER BY id`,
  );
  return result.rows.map(mapAlertRule);
}

export async function getLogsAlertRuleById(client: PoolClient, id: number): Promise<LogsAlertRule | null> {
  const result = await client.query<LogsAlertRuleRow>(
    `SELECT ${ALERT_RULE_COLUMNS} FROM logs_alert_rules WHERE id = $1 FOR UPDATE`,
    [id],
  );
  return result.rows[0] ? mapAlertRule(result.rows[0]) : null;
}

export async function createLogsAlertRule(input: LogsAlertRuleInput): Promise<LogsAlertRule> {
  return createWithinLimit('logs_alert_rules', 20, async (client) => {
    const result = await client.query<LogsAlertRuleRow>(
      `INSERT INTO logs_alert_rules (name, description, query, window_seconds, comparator, threshold, for_seconds, enabled)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING ${ALERT_RULE_COLUMNS}`,
      [input.name, input.description, input.query, input.windowSeconds, input.comparator, input.threshold, input.forSeconds, input.enabled],
    );
    return mapAlertRule(result.rows[0]);
  });
}

export async function updateLogsAlertRule(id: number, input: LogsAlertRuleInput): Promise<LogsAlertRule | null> {
  const result = await query<LogsAlertRuleRow>(
    `UPDATE logs_alert_rules
     SET name = $2, description = $3, query = $4, window_seconds = $5, comparator = $6,
         threshold = $7, for_seconds = $8, enabled = $9,
         pending_since = CASE WHEN status = 'pending'
           AND (query, window_seconds, comparator, threshold, for_seconds, enabled)
             IS DISTINCT FROM ($4::text, $5::integer, $6::varchar, $7::double precision, $8::integer, $9::boolean)
           THEN NULL ELSE pending_since END,
         last_error = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
     RETURNING ${ALERT_RULE_COLUMNS}`,
    [id, input.name, input.description, input.query, input.windowSeconds, input.comparator, input.threshold, input.forSeconds, input.enabled],
  );
  return result.rows[0] ? mapAlertRule(result.rows[0]) : null;
}

export async function deleteLogsAlertRule(client: PoolClient, id: number): Promise<LogsAlertRule | null> {
  const result = await client.query<LogsAlertRuleRow>(
    `DELETE FROM logs_alert_rules WHERE id = $1 RETURNING ${ALERT_RULE_COLUMNS}`,
    [id],
  );
  return result.rows[0] ? mapAlertRule(result.rows[0]) : null;
}

export async function recordLogsAlertEvaluation(
  client: PoolClient,
  input: {
    id: number;
    status: LogsAlertRule['status'];
    value: number | null;
    pendingSince: Date | null;
    firingSince: Date | null;
    generation?: number;
    notifiedAt?: Date | null;
    error: string | null;
    evaluatedAt: Date;
  },
): Promise<void> {
  await client.query(
    `UPDATE logs_alert_rules
     SET status = $2, last_value = $3, pending_since = $4, firing_since = $5,
         generation = COALESCE($6, generation),
         last_notified_at = CASE WHEN $7 THEN $8 ELSE last_notified_at END,
         last_evaluated_at = $9, last_error = $10
     WHERE id = $1`,
    [
      input.id,
      input.status,
      input.value,
      input.pendingSince,
      input.firingSince,
      input.generation ?? null,
      input.notifiedAt !== undefined,
      input.notifiedAt ?? null,
      input.evaluatedAt,
      input.error?.slice(0, 500) ?? null,
    ],
  );
}
