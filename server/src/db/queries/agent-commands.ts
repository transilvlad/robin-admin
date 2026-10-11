import { randomUUID } from 'node:crypto';
import { getClient, query } from '../connection.js';
import { sanitizeServiceReports } from './fleet-agents.js';
import type { FleetServiceType } from './fleet-services.js';
import { logger } from '../../logger.js';

import { operationsPolicy } from '../../services/operations-settings.js';

export type AgentCommandStatus = 'queued' | 'sent' | 'acknowledged' | 'succeeded' | 'failed' | 'expired';

export interface AgentCommandRecord {
  id: string;
  agentId: string;
  serviceId: string;
  serviceType: FleetServiceType;
  action: string;
  args: Record<string, unknown>;
  status: AgentCommandStatus;
  resultOutput: string | null;
  resultError: string | null;
  sentAt: Date | null;
  acknowledgedAt: Date | null;
  completedAt: Date | null;
  expiresAt: Date;
  leaseExpiresAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface AgentCommandRow {
  id: string;
  agent_id: string;
  service_id: string;
  service_type: FleetServiceType;
  action: string;
  args_json: unknown;
  status: AgentCommandStatus;
  result_output: string | null;
  result_error: string | null;
  sent_at: Date | null;
  acknowledged_at: Date | null;
  completed_at: Date | null;
  expires_at: Date;
  lease_expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface CreateAgentCommandInput {
  agentId: string;
  serviceId: string;
  serviceType: FleetServiceType;
  action: string;
  args?: Record<string, unknown>;
}

const COMMAND_COLUMNS = `id, agent_id, service_id, service_type, action, args_json, status,
  result_output, result_error, sent_at, acknowledged_at, completed_at, expires_at,
  lease_expires_at, created_at, updated_at`;
const QUALIFIED_COMMAND_COLUMNS = `command.id, command.agent_id, command.service_id, command.service_type, command.action, command.args_json, command.status,
  command.result_output, command.result_error, command.sent_at, command.acknowledged_at, command.completed_at, command.expires_at,
  command.lease_expires_at, command.created_at, command.updated_at`;

type DiagnosticRow = Pick<AgentCommandRow, 'id' | 'agent_id' | 'service_id' | 'action' | 'status' | 'created_at' | 'sent_at' | 'acknowledged_at' | 'expires_at'>;
const DIAGNOSTIC_COLUMNS = 'id, agent_id, service_id, action, status, created_at, sent_at, acknowledged_at, expires_at';

export function logAgentCommandLifecycle(event: string, row: DiagnosticRow): void {
  logger.info('Agent command lifecycle', {
    event, commandId: row.id, agentId: row.agent_id, serviceId: row.service_id,
    action: row.action, status: row.status,
    elapsedMs: Math.max(0, Date.now() - row.created_at.getTime()),
    sentAt: row.sent_at?.toISOString() ?? null,
    acknowledgedAt: row.acknowledged_at?.toISOString() ?? null,
    expiresAt: row.expires_at.toISOString(),
  });
}

function mapAgentCommand(row: AgentCommandRow): AgentCommandRecord {
  const args = row.args_json && typeof row.args_json === 'object' && !Array.isArray(row.args_json)
    ? row.args_json as Record<string, unknown>
    : {};
  return {
    id: row.id,
    agentId: row.agent_id,
    serviceId: row.service_id,
    serviceType: row.service_type,
    action: row.action,
    args,
    status: row.status,
    resultOutput: row.result_output,
    resultError: row.result_error,
    sentAt: row.sent_at,
    acknowledgedAt: row.acknowledged_at,
    completedAt: row.completed_at,
    expiresAt: row.expires_at,
    leaseExpiresAt: row.lease_expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function createAgentCommand(input: CreateAgentCommandInput, timeoutMs: number): Promise<AgentCommandRecord> {
  const result = await query<AgentCommandRow>(
    `INSERT INTO fleet_agent_commands
       (id, agent_id, service_id, service_type, action, args_json, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6::jsonb, CURRENT_TIMESTAMP + (($7::double precision / 1000.0) * INTERVAL '1 second'))
     RETURNING ${COMMAND_COLUMNS}`,
    [
      randomUUID(),
      input.agentId,
      input.serviceId,
      input.serviceType,
      input.action,
      JSON.stringify(input.args ?? {}),
      Math.max(1, timeoutMs),
    ]
  );
  logAgentCommandLifecycle('queued', result.rows[0]);
  return mapAgentCommand(result.rows[0]);
}

export async function getAgentCommand(commandId: string): Promise<AgentCommandRecord | null> {
  const result = await query<AgentCommandRow>(
    `SELECT ${COMMAND_COLUMNS} FROM fleet_agent_commands WHERE id = $1`,
    [commandId]
  );
  return result.rows[0] ? mapAgentCommand(result.rows[0]) : null;
}

export async function agentRecentlyAdvertisedAction(agentId: string, action: string): Promise<boolean> {
  const result = await query<{ last_seen_at: Date | null; services_json: unknown }>(
    `SELECT last_seen_at, services_json FROM fleet_agents WHERE agent_id = $1`,
    [agentId]
  );
  const row = result.rows[0];
  if (!row?.last_seen_at || Date.now() - new Date(row.last_seen_at).getTime() > operationsPolicy().fleetAgentOnlineThresholdMs) {
    return false;
  }
  const reports = sanitizeServiceReports(row.services_json) ?? {};
  return Object.values(reports).some((report) => report.actions.includes(action));
}

export async function acknowledgeAgentCommands(agentId: string, commandIds: string[]): Promise<void> {
  if (commandIds.length === 0) return;
  const result = await query<DiagnosticRow>(
    `UPDATE fleet_agent_commands
       SET status = 'acknowledged',
           acknowledged_at = COALESCE(acknowledged_at, CURRENT_TIMESTAMP),
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE agent_id = $1
       AND id = ANY($2::uuid[])
       AND status IN ('queued', 'sent', 'acknowledged')
     RETURNING ${DIAGNOSTIC_COLUMNS}`,
    [agentId, commandIds]
  );
  for (const row of result.rows) logAgentCommandLifecycle('acknowledged', row);
}

export async function requeueUnackedSentCommands(agentId: string, ackedCommandIds: string[]): Promise<void> {
  const result = await query<DiagnosticRow>(
    `UPDATE fleet_agent_commands
       SET status = 'queued',
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE agent_id = $1
       AND status = 'sent'
       AND expires_at > CURRENT_TIMESTAMP
       AND (cardinality($2::uuid[]) = 0 OR NOT (id = ANY($2::uuid[])))
     RETURNING ${DIAGNOSTIC_COLUMNS}`,
    [agentId, ackedCommandIds]
  );
  for (const row of result.rows) logAgentCommandLifecycle('unacknowledged_requeued', row);
}

export async function requeueAgentCommandsForAgent(agentId: string, commandIds: string[]): Promise<void> {
  if (commandIds.length === 0) return;
  const result = await query<DiagnosticRow>(
    `UPDATE fleet_agent_commands
       SET status = 'queued',
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE agent_id = $1
       AND id = ANY($2::uuid[])
       AND status = 'sent'
       AND expires_at > CURRENT_TIMESTAMP
     RETURNING ${DIAGNOSTIC_COLUMNS}`,
    [agentId, commandIds]
  );
  for (const row of result.rows) logAgentCommandLifecycle('disconnected_requeued', row);
}

export async function expireDueAgentCommands(): Promise<void> {
  const result = await query<DiagnosticRow>(
    `UPDATE fleet_agent_commands
       SET status = 'expired',
           result_error = COALESCE(result_error, 'Command expired before completion'),
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE status IN ('queued', 'sent', 'acknowledged')
       AND expires_at <= CURRENT_TIMESTAMP
     RETURNING ${DIAGNOSTIC_COLUMNS}`
  );
  for (const row of result.rows) logAgentCommandLifecycle('expired', row);
}

export async function markAgentCommandExpired(commandId: string, error: string): Promise<AgentCommandRecord | null> {
  const result = await query<AgentCommandRow>(
    `UPDATE fleet_agent_commands
       SET status = 'expired',
           result_error = $2,
           completed_at = COALESCE(completed_at, CURRENT_TIMESTAMP),
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE id = $1
       AND status IN ('queued', 'sent', 'acknowledged')
       AND expires_at <= CURRENT_TIMESTAMP
     RETURNING ${COMMAND_COLUMNS}`,
    [commandId, error]
  );
  if (result.rows[0]) logAgentCommandLifecycle('expired', result.rows[0]);
  return result.rows[0] ? mapAgentCommand(result.rows[0]) : null;
}

export async function leaseQueuedAgentCommands(
  agentId: string,
  actions: string[],
  leaseMs: number,
  limit = 20,
): Promise<AgentCommandRecord[]> {
  if (actions.length === 0) return [];
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query<AgentCommandRow>(
      `WITH next_commands AS (
         SELECT id
         FROM fleet_agent_commands
         WHERE agent_id = $1
           AND status = 'queued'
           AND action = ANY($2::text[])
           AND expires_at > CURRENT_TIMESTAMP
         ORDER BY created_at ASC
         LIMIT $3
         FOR UPDATE SKIP LOCKED
       )
       UPDATE fleet_agent_commands command
          SET status = 'sent',
              sent_at = COALESCE(sent_at, CURRENT_TIMESTAMP),
              lease_expires_at = CURRENT_TIMESTAMP + (($4::double precision / 1000.0) * INTERVAL '1 second'),
              updated_at = CURRENT_TIMESTAMP
       FROM next_commands
       WHERE command.id = next_commands.id
       RETURNING ${QUALIFIED_COMMAND_COLUMNS}`,
      [agentId, actions, Math.max(1, limit), Math.max(1, leaseMs)]
    );
    await client.query('COMMIT');
    for (const row of result.rows) logAgentCommandLifecycle('leased', row);
    return result.rows.map(mapAgentCommand);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function completeAgentCommandResult(
  agentId: string,
  commandId: string,
  result: { ok: boolean; output?: string; error?: string },
): Promise<AgentCommandRecord | null> {
  const nextStatus: AgentCommandStatus = result.ok ? 'succeeded' : 'failed';
  const update = await query<AgentCommandRow>(
    `UPDATE fleet_agent_commands
       SET status = $3,
           result_output = $4,
           result_error = $5,
           completed_at = CURRENT_TIMESTAMP,
           lease_expires_at = NULL,
           updated_at = CURRENT_TIMESTAMP
     WHERE agent_id = $1
       AND id = $2
       AND status IN ('queued', 'sent', 'acknowledged')
       AND expires_at > CURRENT_TIMESTAMP
     RETURNING ${COMMAND_COLUMNS}`,
    [agentId, commandId, nextStatus, result.ok ? result.output ?? '' : null, result.ok ? null : result.error ?? null]
  );
  if (update.rows[0]) logAgentCommandLifecycle('result_recorded', update.rows[0]);
  else logger.info('Agent command result rejected', { commandId, agentId });
  return update.rows[0] ? mapAgentCommand(update.rows[0]) : null;
}
