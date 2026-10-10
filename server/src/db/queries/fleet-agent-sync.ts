import { query } from '../connection.js';
import { quotePostgresIdentifier } from '../postgres-identifier.js';
import { getRobinConfigTableName } from './robin-config-meta.js';

export interface ManagedConfigStoreEntry<T = unknown> {
  ownerId: string;
  fileName: string;
  payloadJson: T;
  updatedEpoch: number;
  sha256: string;
}

export type FleetServiceApplyStatus = 'unknown' | 'pending' | 'succeeded' | 'failed';

export interface FleetServiceSyncStatus {
  serviceId: string;
  manifestSha256: string | null;
  manifestEtag: string | null;
  manifestFileCount: number | null;
  lastSeenAt: Date | null;
  lastManifestPulledAt: Date | null;
  lastFilePulledAt: Date | null;
  lastApplyStartedAt: Date | null;
  lastApplyFinishedAt: Date | null;
  lastApplyStatus: FleetServiceApplyStatus;
  lastApplyError: string | null;
  lastAppliedSha256: string | null;
  lastAppliedFileCount: number | null;
  agentVersion: string | null;
  syncRequestedAt: Date | null;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface FleetServiceSyncStatusUpdate {
  manifestSha256?: string | null;
  manifestEtag?: string | null;
  manifestFileCount?: number | null;
  lastSeenAt?: Date | null;
  lastManifestPulledAt?: Date | null;
  lastFilePulledAt?: Date | null;
  lastApplyStartedAt?: Date | null;
  lastApplyFinishedAt?: Date | null;
  lastApplyStatus?: FleetServiceApplyStatus;
  lastApplyError?: string | null;
  lastAppliedSha256?: string | null;
  lastAppliedFileCount?: number | null;
  agentVersion?: string | null;
  syncRequestedAt?: Date | null;
  metadataJson?: Record<string, unknown>;
}

interface RobinConfigStoreRow {
  server_id: string;
  file_name: string;
  payload_json: unknown;
  updated_epoch: number;
  sha256: string;
}

interface RspamdConfigStoreRow {
  service_id: string;
  file_name: string;
  payload_json: unknown;
  updated_epoch: number;
  sha256: string;
}

interface ClamavConfigStoreRow {
  service_id: string;
  file_name: string;
  payload_json: unknown;
  updated_epoch: number;
  sha256: string;
}

interface FleetServiceSyncStatusRow {
  service_id: string;
  manifest_sha256: string | null;
  manifest_etag: string | null;
  manifest_file_count: number | null;
  last_seen_at: Date | null;
  last_manifest_pulled_at: Date | null;
  last_file_pulled_at: Date | null;
  last_apply_started_at: Date | null;
  last_apply_finished_at: Date | null;
  last_apply_status: FleetServiceApplyStatus;
  last_apply_error: string | null;
  last_applied_sha256: string | null;
  last_applied_file_count: number | null;
  agent_version: string | null;
  sync_requested_at: Date | null;
  metadata_json: Record<string, unknown> | null;
  created_at: Date;
  updated_at: Date;
}

function mapStoreEntry<T>(
  ownerId: string,
  row: { file_name: string; payload_json: T; updated_epoch: number; sha256: string }
): ManagedConfigStoreEntry<T> {
  return {
    ownerId,
    fileName: row.file_name,
    payloadJson: row.payload_json,
    updatedEpoch: Number(row.updated_epoch),
    sha256: row.sha256,
  };
}

function mapSyncStatus(row: FleetServiceSyncStatusRow): FleetServiceSyncStatus {
  return {
    serviceId: row.service_id,
    manifestSha256: row.manifest_sha256,
    manifestEtag: row.manifest_etag,
    manifestFileCount: row.manifest_file_count,
    lastSeenAt: row.last_seen_at,
    lastManifestPulledAt: row.last_manifest_pulled_at,
    lastFilePulledAt: row.last_file_pulled_at,
    lastApplyStartedAt: row.last_apply_started_at,
    lastApplyFinishedAt: row.last_apply_finished_at,
    lastApplyStatus: row.last_apply_status ?? 'unknown',
    lastApplyError: row.last_apply_error,
    lastAppliedSha256: row.last_applied_sha256,
    lastAppliedFileCount: row.last_applied_file_count,
    agentVersion: row.agent_version,
    syncRequestedAt: row.sync_requested_at,
    metadataJson: row.metadata_json ?? {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function listRobinConfigStoreEntriesForService(
  serviceId: string
): Promise<ManagedConfigStoreEntry[]> {
  const tableName = quotePostgresIdentifier(await getRobinConfigTableName());
  const result = await query<RobinConfigStoreRow>(
    `SELECT server_id, file_name, payload_json, updated_epoch, sha256
     FROM ${tableName}
     WHERE server_id = 'default' OR server_id = $1
     ORDER BY file_name ASC, server_id ASC`,
    [serviceId]
  );

  return result.rows.map((row) => mapStoreEntry(row.server_id, row));
}

export async function listRspamdConfigStoreEntriesForService(
  serviceId: string
): Promise<ManagedConfigStoreEntry[]> {
  const result = await query<RspamdConfigStoreRow>(
    `SELECT service_id, file_name, payload_json, updated_epoch, sha256
     FROM rspamd_config_store
     WHERE service_id = 'default' OR service_id = $1
     ORDER BY file_name ASC, service_id ASC`,
    [serviceId]
  );

  return result.rows.map((row) => mapStoreEntry(row.service_id, row));
}

export async function listClamavConfigStoreEntriesForService(
  serviceId: string
): Promise<ManagedConfigStoreEntry[]> {
  const result = await query<ClamavConfigStoreRow>(
    `SELECT service_id, file_name, payload_json, updated_epoch, sha256
     FROM clamav_config_store
     WHERE service_id = 'default' OR service_id = $1
     ORDER BY file_name ASC, service_id ASC`,
    [serviceId]
  );

  return result.rows.map((row) => mapStoreEntry(row.service_id, row));
}

export async function listDovecotConfigStoreEntriesForService(
  serviceId: string
): Promise<ManagedConfigStoreEntry[]> {
  const result = await query<ClamavConfigStoreRow>(
    `SELECT service_id, file_name, payload_json, updated_epoch, sha256
     FROM dovecot_config_store
     WHERE service_id = 'default' OR service_id = $1
     ORDER BY file_name ASC, service_id ASC`,
    [serviceId]
  );

  return result.rows.map((row) => mapStoreEntry(row.service_id, row));
}

export async function listPostfixConfigStoreEntriesForService(
  serviceId: string
): Promise<ManagedConfigStoreEntry[]> {
  const result = await query<ClamavConfigStoreRow>(
    `SELECT service_id, file_name, payload_json, updated_epoch, sha256
     FROM postfix_config_store
     WHERE service_id = 'default' OR service_id = $1
     ORDER BY file_name ASC, service_id ASC`,
    [serviceId]
  );

  return result.rows.map((row) => mapStoreEntry(row.service_id, row));
}

// ── Append-only sync audit log ──────────────────────────────────────────────

export type FleetSyncLogEventType =
  | 'manifest_pulled'
  | 'apply_started'
  | 'apply_succeeded'
  | 'apply_failed'
  | 'registered'
  | 'sync_requested';

export interface FleetServiceSyncLogEntry {
  id: number;
  serviceId: string;
  eventType: FleetSyncLogEventType;
  applyStatus: FleetServiceApplyStatus | null;
  manifestSha256: string | null;
  appliedSha256: string | null;
  fileCount: number | null;
  agentVersion: string | null;
  message: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: Date;
}

interface FleetServiceSyncLogRow {
  id: string;
  service_id: string;
  event_type: FleetSyncLogEventType;
  apply_status: FleetServiceApplyStatus | null;
  manifest_sha256: string | null;
  applied_sha256: string | null;
  file_count: number | null;
  agent_version: string | null;
  message: string | null;
  metadata_json: Record<string, unknown> | null;
  created_at: Date;
}

function mapSyncLog(row: FleetServiceSyncLogRow): FleetServiceSyncLogEntry {
  return {
    id: Number(row.id),
    serviceId: row.service_id,
    eventType: row.event_type,
    applyStatus: row.apply_status,
    manifestSha256: row.manifest_sha256,
    appliedSha256: row.applied_sha256,
    fileCount: row.file_count,
    agentVersion: row.agent_version,
    message: row.message,
    metadataJson: row.metadata_json ?? {},
    createdAt: row.created_at,
  };
}

export async function appendFleetServiceSyncLog(input: {
  serviceId: string;
  eventType: FleetSyncLogEventType;
  applyStatus?: FleetServiceApplyStatus | null;
  manifestSha256?: string | null;
  appliedSha256?: string | null;
  fileCount?: number | null;
  agentVersion?: string | null;
  message?: string | null;
  metadataJson?: Record<string, unknown>;
}): Promise<void> {
  await query(
    `INSERT INTO fleet_service_sync_log
       (service_id, event_type, apply_status, manifest_sha256, applied_sha256,
        file_count, agent_version, message, metadata_json)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)`,
    [
      input.serviceId,
      input.eventType,
      input.applyStatus ?? null,
      input.manifestSha256 ?? null,
      input.appliedSha256 ?? null,
      input.fileCount ?? null,
      input.agentVersion ?? null,
      input.message ?? null,
      JSON.stringify(input.metadataJson ?? {}),
    ]
  );
}

export async function listFleetServiceSyncLog(
  serviceId: string,
  limit = 50
): Promise<FleetServiceSyncLogEntry[]> {
  const capped = Math.min(Math.max(1, Math.floor(limit)), 500);
  const result = await query<FleetServiceSyncLogRow>(
    `SELECT id, service_id, event_type, apply_status, manifest_sha256, applied_sha256,
            file_count, agent_version, message, metadata_json, created_at
     FROM fleet_service_sync_log
     WHERE service_id = $1
     ORDER BY created_at DESC, id DESC
     LIMIT $2`,
    [serviceId, capped]
  );
  return result.rows.map(mapSyncLog);
}

export async function getFleetServiceSyncStatus(serviceId: string): Promise<FleetServiceSyncStatus | null> {
  const result = await query<FleetServiceSyncStatusRow>(
    `SELECT service_id, manifest_sha256, manifest_etag, manifest_file_count,
            last_seen_at, last_manifest_pulled_at, last_file_pulled_at,
            last_apply_started_at, last_apply_finished_at, last_apply_status,
            last_apply_error, last_applied_sha256, last_applied_file_count,
            agent_version, sync_requested_at, metadata_json, created_at, updated_at
     FROM fleet_service_sync_status
     WHERE service_id = $1`,
    [serviceId]
  );

  return result.rows[0] ? mapSyncStatus(result.rows[0]) : null;
}

/** Force-sync: stamp sync_requested_at=now so the manifest hash changes and the
 *  agent re-pulls + re-applies (even when the config itself hasn't changed). */
export async function requestFleetServiceSync(serviceId: string): Promise<FleetServiceSyncStatus | null> {
  return upsertFleetServiceSyncStatus(serviceId, { syncRequestedAt: new Date() });
}

export async function upsertFleetServiceSyncStatus(
  serviceId: string,
  updates: FleetServiceSyncStatusUpdate
): Promise<FleetServiceSyncStatus | null> {
  const columns = ['service_id'];
  const placeholders = ['$1'];
  const values: unknown[] = [serviceId];
  const assignments: string[] = [];
  let paramIndex = 1;

  const fieldMap: Array<[keyof FleetServiceSyncStatusUpdate, string, boolean]> = [
    ['manifestSha256', 'manifest_sha256', false],
    ['manifestEtag', 'manifest_etag', false],
    ['manifestFileCount', 'manifest_file_count', false],
    ['lastSeenAt', 'last_seen_at', false],
    ['lastManifestPulledAt', 'last_manifest_pulled_at', false],
    ['lastFilePulledAt', 'last_file_pulled_at', false],
    ['lastApplyStartedAt', 'last_apply_started_at', false],
    ['lastApplyFinishedAt', 'last_apply_finished_at', false],
    ['lastApplyStatus', 'last_apply_status', false],
    ['lastApplyError', 'last_apply_error', false],
    ['lastAppliedSha256', 'last_applied_sha256', false],
    ['lastAppliedFileCount', 'last_applied_file_count', false],
    ['agentVersion', 'agent_version', false],
    ['syncRequestedAt', 'sync_requested_at', false],
    ['metadataJson', 'metadata_json', true],
  ];

  for (const [inputKey, columnName, isJson] of fieldMap) {
    // A key present with an undefined value was not reported: keep the stored
    // value. An explicit null still clears it.
    if (!(inputKey in updates) || updates[inputKey] === undefined) {
      continue;
    }

    paramIndex += 1;
    columns.push(columnName);
    placeholders.push(isJson ? `$${paramIndex}::jsonb` : `$${paramIndex}`);
    values.push(isJson ? JSON.stringify(updates[inputKey] ?? {}) : updates[inputKey]);
    assignments.push(`${columnName} = EXCLUDED.${columnName}`);
  }

  if (assignments.length === 0) {
    return getFleetServiceSyncStatus(serviceId);
  }

  assignments.push('updated_at = CURRENT_TIMESTAMP');

  const result = await query<FleetServiceSyncStatusRow>(
    `INSERT INTO fleet_service_sync_status (${columns.join(', ')})
     VALUES (${placeholders.join(', ')})
     ON CONFLICT (service_id)
     DO UPDATE SET ${assignments.join(', ')}
     RETURNING service_id, manifest_sha256, manifest_etag, manifest_file_count,
               last_seen_at, last_manifest_pulled_at, last_file_pulled_at,
               last_apply_started_at, last_apply_finished_at, last_apply_status,
               last_apply_error, last_applied_sha256, last_applied_file_count,
               agent_version, sync_requested_at, metadata_json, created_at, updated_at`,
    values
  );

  return result.rows[0] ? mapSyncStatus(result.rows[0]) : null;
}
