/**
 * Latest log tail pushed by a co-located agent for a service it owns.
 *
 * Agent-mode services can't be reached by robin-admin (the agent dials out), so
 * the agent follows the service's journald unit / log file / container output
 * and ships new lines each cycle. We keep one capped rolling buffer per service
 * — a live "recent logs" tail, not a searchable archive — so it never grows
 * unbounded.
 */

import { query } from '../connection.js';

const MAX_STORED_LINES = 1000;

export interface AgentServiceLogs {
  source: string;
  lines: string[];
  capturedAt: Date;
}

interface AgentServiceLogsRow {
  source: string | null;
  lines_json: unknown;
  captured_at: Date;
}

/**
 * Replace the stored log buffer for a service. Lines are capped so a runaway
 * push can't bloat the row.
 */
export async function storeAgentServiceLogs(
  serviceId: string,
  source: string,
  lines: string[]
): Promise<void> {
  const capped = lines.slice(-MAX_STORED_LINES);
  await query(
    `INSERT INTO fleet_agent_service_logs (service_id, source, lines_json, captured_at, updated_at)
     VALUES ($1, $2, $3::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (service_id) DO UPDATE
       SET source = EXCLUDED.source,
           lines_json = EXCLUDED.lines_json,
           captured_at = EXCLUDED.captured_at,
           updated_at = CURRENT_TIMESTAMP`,
    [serviceId, source, JSON.stringify(capped)]
  );
}

/** The most recent log tail an agent pushed for this service, or null. */
export async function getAgentServiceLogs(serviceId: string): Promise<AgentServiceLogs | null> {
  const result = await query<AgentServiceLogsRow>(
    `SELECT source, lines_json, captured_at
     FROM fleet_agent_service_logs
     WHERE service_id = $1`,
    [serviceId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const lines = Array.isArray(row.lines_json)
    ? row.lines_json.filter((l): l is string => typeof l === 'string')
    : [];
  return { source: row.source ?? '', lines, capturedAt: row.captured_at };
}
