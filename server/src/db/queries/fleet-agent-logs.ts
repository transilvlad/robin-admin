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
import type { PoolClient } from 'pg';
import type { FleetLogStreamStatus } from '../../types/logs.js';

const MAX_STORED_LINES = 1000;

export interface AgentServiceLogs {
  source: string;
  lines: string[];
  capturedAt: Date;
  counters?: Record<string, number | string> | null;
  lagCycles?: number;
}

interface AgentServiceLogsRow {
  source: string | null;
  lines_json: unknown;
  captured_at: Date;
  pipeline_counters: unknown;
  lag_cycles: number;
}

/**
 * Replace the stored log buffer for a service. Lines are capped so a runaway
 * push can't bloat the row.
 */
export async function storeAgentServiceLogs(
  serviceId: string,
  source: string,
  lines: string[],
  counters?: Record<string, number | string>,
  client?: PoolClient,
): Promise<void> {
  const capped = lines.slice(-MAX_STORED_LINES);
  const execute = client ? client.query.bind(client) : query;
  await execute(
    `INSERT INTO fleet_agent_service_logs
       (service_id, source, lines_json, pipeline_counters, lag_cycles, captured_at, updated_at)
     VALUES (
       $1, $2, $3::jsonb,
       CASE WHEN $4::jsonb IS NULL THEN NULL ELSE jsonb_set($4::jsonb, '{lagCycles}', '0'::jsonb) END,
       CASE WHEN $4::jsonb IS NULL THEN 0
         WHEN COALESCE(($4::jsonb ->> 'readLagMs')::bigint, 0) > 90000 THEN 1 ELSE 0 END,
       CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )
     ON CONFLICT (service_id) DO UPDATE
       SET source = EXCLUDED.source,
           lines_json = EXCLUDED.lines_json,
           pipeline_counters = CASE WHEN $4::jsonb IS NULL THEN fleet_agent_service_logs.pipeline_counters
             ELSE jsonb_set($4::jsonb, '{lagCycles}', to_jsonb(
               CASE WHEN COALESCE($4::jsonb ->> 'updatedAt', '') = COALESCE(fleet_agent_service_logs.pipeline_counters ->> 'updatedAt', '')
                 THEN fleet_agent_service_logs.lag_cycles
                 WHEN COALESCE(($4::jsonb ->> 'readLagMs')::bigint, 0) > 90000
                   THEN fleet_agent_service_logs.lag_cycles + 1 ELSE 0 END
             )) END,
           lag_cycles = CASE WHEN $4::jsonb IS NULL THEN fleet_agent_service_logs.lag_cycles
             WHEN COALESCE($4::jsonb ->> 'updatedAt', '') = COALESCE(fleet_agent_service_logs.pipeline_counters ->> 'updatedAt', '')
               THEN fleet_agent_service_logs.lag_cycles
             WHEN COALESCE(($4::jsonb ->> 'readLagMs')::bigint, 0) > 90000
               THEN fleet_agent_service_logs.lag_cycles + 1 ELSE 0 END,
           captured_at = EXCLUDED.captured_at,
           updated_at = CURRENT_TIMESTAMP`,
    [serviceId, source, JSON.stringify(capped), counters ? JSON.stringify(counters) : null]
  );
}

/** The most recent log tail an agent pushed for this service, or null. */
export async function getAgentServiceLogs(serviceId: string, client?: PoolClient): Promise<AgentServiceLogs | null> {
  const execute = client ? client.query.bind(client) : query;
  const result = await execute<AgentServiceLogsRow>(
    `SELECT source, lines_json, captured_at, pipeline_counters, lag_cycles
     FROM fleet_agent_service_logs
     WHERE service_id = $1`,
    [serviceId]
  );
  const row = result.rows[0];
  if (!row) return null;
  const lines = Array.isArray(row.lines_json)
    ? row.lines_json.filter((l): l is string => typeof l === 'string')
    : [];
  const counters = row.pipeline_counters && typeof row.pipeline_counters === 'object'
    && !Array.isArray(row.pipeline_counters)
    ? row.pipeline_counters as Record<string, number | string>
    : null;
  return { source: row.source ?? '', lines, capturedAt: row.captured_at, counters, lagCycles: Number(row.lag_cycles) || 0 };
}

export async function listFleetLogStreamStatuses(limit: number): Promise<{ streams: FleetLogStreamStatus[]; truncated: boolean }> {
  const boundedLimit = Math.max(1, Math.min(1000, Math.trunc(limit) || 200));
  const result = await query<{
    service_id: string;
    service_type: string;
    source: string | null;
    captured_at: Date | null;
    pipeline_counters: unknown;
    lag_cycles: number | null;
  }>(
    `SELECT f.service_id, f.service_type, l.source, l.captured_at, l.pipeline_counters, l.lag_cycles
     FROM fleet_services f
     LEFT JOIN fleet_agent_service_logs l ON l.service_id = f.service_id
     WHERE f.enabled AND (f.log_agent_id IS NOT NULL OR (f.collection_mode = 'agent' AND f.agent_id IS NOT NULL))
     ORDER BY f.service_type, f.service_id
     LIMIT $1`,
    [boundedLimit + 1],
  );
  const streams = result.rows.slice(0, boundedLimit).map((row): FleetLogStreamStatus => ({
    serviceId: row.service_id,
    serviceType: row.service_type,
    source: row.source,
    capturedAt: row.captured_at?.toISOString() ?? null,
    counters: row.pipeline_counters && typeof row.pipeline_counters === 'object' && !Array.isArray(row.pipeline_counters)
      ? row.pipeline_counters as Record<string, number | string> : null,
    lagCycles: Number(row.lag_cycles) || 0,
  }));
  return { streams, truncated: result.rows.length > boundedLimit };
}
