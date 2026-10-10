import pg from 'pg';
import {
  POSTGRES_CONFIG_STORE_TABLE,
  deleteConfigStoreEntry,
  upsertConfigStorePayload,
} from '../db/queries/config-store.js';
import { getEnabledFleetServices, getFleetServiceById } from '../db/queries/fleet-services.js';
import {
  listConfigStoreOwners,
  readLayeredPayload,
  writeLayeredPayload,
} from './managed-config-file.js';
import { logger } from '../logger.js';
import { isDsnFor, resolveServiceDsn } from './service-dsn.js';

const { Pool } = pg;

// Direct-client mode uses a separate admin `pg.Pool` for the managed target,
// which may be a different database than robin-admin's own backend.
const CONNECT_TIMEOUT_MS = 8000;
const STATEMENT_TIMEOUT_MS = 8000;

// The reserved 'default' scope is the shared base config. It has no
// fleet_services row, so the service resolver/probes must tolerate it.
const DEFAULT_SCOPE_ID = 'default';
const DEFAULT_SCOPE_NAME = 'Default (base)';

const MANAGED_JSON_FILE = 'managed.json';
const RENDERED_PREVIEW_FILE = 'rendered.sql';

// One `pg.Pool` cached per resolved DSN, reused across poller ticks and route
// calls (never reconnect per call).
const poolCache = new Map<string, pg.Pool>();

function getPoolForDsn(dsn: string): pg.Pool {
  let pool = poolCache.get(dsn);
  if (!pool) {
    pool = new Pool({
      connectionString: dsn,
      max: 4,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
      statement_timeout: STATEMENT_TIMEOUT_MS,
      application_name: 'robin-admin-postgres-admin',
    });
    pool.on('error', (error: Error) => {
      logger.warn('Postgres admin pool error', { error: error.message });
    });
    poolCache.set(dsn, pool);
  }
  return pool;
}

/** Close and forget every cached Postgres admin pool (graceful server shutdown). */
export async function closePostgresPools(): Promise<void> {
  const pools = Array.from(poolCache.values());
  poolCache.clear();
  await Promise.all(
    pools.map(async (pool) => {
      try {
        await pool.end();
      } catch (error) {
        logger.warn('Postgres admin pool close failed', { error: (error as Error).message });
      }
    })
  );
}

async function getResolvedService(serviceId: string) {
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== 'postgres') {
    throw new Error('Postgres service not found');
  }
  return service;
}

/** The fleet row's `metricsUrl`, else the `POSTGRES_ADMIN_DSN` fallback. */
export function resolvePostgresDsn(service: { metricsUrl: string | null }): string | null {
  return resolveServiceDsn(service, 'POSTGRES_ADMIN_DSN');
}

export function isPostgresUrl(value: string | null | undefined): value is string {
  return isDsnFor('postgres', value);
}

async function resolveConnectedDsn(serviceId: string): Promise<string> {
  const service = await getResolvedService(serviceId);
  const dsn = resolvePostgresDsn(service);
  // A socket-style DSN (`postgresql://user@/db?host=/var/run/postgresql`) is
  // still a valid `postgresql://` URL, so the same prefix check covers it.
  if (!isPostgresUrl(dsn)) {
    throw new Error('No Postgres admin DSN configured for this service');
  }
  return dsn;
}

async function getConnectedPool(serviceId: string): Promise<pg.Pool> {
  return getPoolForDsn(await resolveConnectedDsn(serviceId));
}

/**
 * Run a statement on a dedicated, short-lived connection with NO statement
 * timeout. VACUUM/ANALYZE can legitimately run far longer than the pool's 8s
 * `statement_timeout` (which would cancel them mid-run), and a `SET` on a
 * pooled client would leak the cleared timeout to later metrics queries — so
 * these ops get their own connection outside the shared pool.
 */
async function runUnbounded(serviceId: string, sql: string): Promise<void> {
  const dsn = await resolveConnectedDsn(serviceId);
  const client = new pg.Client({
    connectionString: dsn,
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS,
    statement_timeout: 0,
    application_name: 'robin-admin-postgres-admin',
  });
  await client.connect();
  try {
    await client.query(sql);
  } finally {
    await client.end();
  }
}

// ---------------------------------------------------------------------------
// Managed config (reload-safe GUCs only — no shared_buffers/max_connections/
// wal_level, which require a restart and stay ansible-owned)
// ---------------------------------------------------------------------------

export interface PostgresManagedConfig {
  workMem: string;                          // e.g. "4MB"
  maintenanceWorkMem: string;               // e.g. "64MB"
  effectiveCacheSize: string;               // e.g. "4GB"
  logMinDurationStatement: number;          // ms; -1 disables
  statementTimeout: number;                 // ms; 0 disables
  idleInTransactionSessionTimeout: number;  // ms; 0 disables
  autovacuum: boolean;
  autovacuumVacuumScaleFactor: number;      // 0-1
  autovacuumAnalyzeScaleFactor: number;     // 0-1
  autovacuumNaptime: number;                // seconds
  checkpointTimeout: number;                // seconds
  maxWalSize: string;                       // e.g. "1GB"
  minWalSize: string;                       // e.g. "80MB"
  randomPageCost: number;
  defaultStatisticsTarget: number;          // 1-10000
  logConnections: boolean;
  logDisconnections: boolean;
  // Performance + logging (all reload-safe GUCs)
  effectiveIoConcurrency: number;           // 0-1000
  maxParallelWorkersPerGather: number;      // 0-1024
  checkpointCompletionTarget: number;       // 0-1
  walCompression: boolean;
  synchronousCommit: string;                // on|off|local|remote_write|remote_apply
  logLockWaits: boolean;
  logTempFiles: number;                     // kB; -1 disables
}

const DEFAULT_POSTGRES_CONFIG: PostgresManagedConfig = {
  workMem: '4MB',
  maintenanceWorkMem: '64MB',
  effectiveCacheSize: '4GB',
  logMinDurationStatement: -1,
  statementTimeout: 0,
  idleInTransactionSessionTimeout: 0,
  autovacuum: true,
  autovacuumVacuumScaleFactor: 0.2,
  autovacuumAnalyzeScaleFactor: 0.1,
  autovacuumNaptime: 60,
  checkpointTimeout: 300,
  maxWalSize: '1GB',
  minWalSize: '80MB',
  randomPageCost: 4,
  defaultStatisticsTarget: 100,
  logConnections: false,
  logDisconnections: false,
  effectiveIoConcurrency: 1,
  maxParallelWorkersPerGather: 2,
  checkpointCompletionTarget: 0.9,
  walCompression: false,
  synchronousCommit: 'on',
  logLockWaits: false,
  logTempFiles: -1,
};

const SYNCHRONOUS_COMMIT_MODES = new Set(['on', 'off', 'local', 'remote_write', 'remote_apply']);
function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

function normalizeInteger(value: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : fallback;
}

function normalizeSignedInteger(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= min && n <= max ? Math.trunc(n) : fallback;
}

function normalizeFloatRange(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

// Postgres memory-size GUCs: an integer optionally followed by a unit
// (kB/MB/GB/TB, case-insensitive per postgresql.conf syntax).
const PG_MEMORY_SIZE_RE = /^\d+(?:\s?(?:kB|MB|GB|TB|B))?$/i;

function normalizeMemorySize(value: unknown, fallback: string): string {
  if (typeof value === 'string' && PG_MEMORY_SIZE_RE.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

export function normalizePostgresConfig(value: unknown): PostgresManagedConfig {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_POSTGRES_CONFIG };
  }
  const s = value as Record<string, unknown>;
  return {
    workMem: normalizeMemorySize(s.workMem, DEFAULT_POSTGRES_CONFIG.workMem),
    maintenanceWorkMem: normalizeMemorySize(s.maintenanceWorkMem, DEFAULT_POSTGRES_CONFIG.maintenanceWorkMem),
    effectiveCacheSize: normalizeMemorySize(s.effectiveCacheSize, DEFAULT_POSTGRES_CONFIG.effectiveCacheSize),
    logMinDurationStatement: normalizeSignedInteger(s.logMinDurationStatement, DEFAULT_POSTGRES_CONFIG.logMinDurationStatement, -1, 24 * 60 * 60 * 1000),
    statementTimeout: normalizeInteger(s.statementTimeout, DEFAULT_POSTGRES_CONFIG.statementTimeout, 0, 24 * 60 * 60 * 1000),
    idleInTransactionSessionTimeout: normalizeInteger(s.idleInTransactionSessionTimeout, DEFAULT_POSTGRES_CONFIG.idleInTransactionSessionTimeout, 0, 24 * 60 * 60 * 1000),
    autovacuum: normalizeBoolean(s.autovacuum, DEFAULT_POSTGRES_CONFIG.autovacuum),
    autovacuumVacuumScaleFactor: normalizeFloatRange(s.autovacuumVacuumScaleFactor, DEFAULT_POSTGRES_CONFIG.autovacuumVacuumScaleFactor, 0, 1),
    autovacuumAnalyzeScaleFactor: normalizeFloatRange(s.autovacuumAnalyzeScaleFactor, DEFAULT_POSTGRES_CONFIG.autovacuumAnalyzeScaleFactor, 0, 1),
    autovacuumNaptime: normalizeInteger(s.autovacuumNaptime, DEFAULT_POSTGRES_CONFIG.autovacuumNaptime, 1, 86400),
    checkpointTimeout: normalizeInteger(s.checkpointTimeout, DEFAULT_POSTGRES_CONFIG.checkpointTimeout, 30, 86400),
    maxWalSize: normalizeMemorySize(s.maxWalSize, DEFAULT_POSTGRES_CONFIG.maxWalSize),
    minWalSize: normalizeMemorySize(s.minWalSize, DEFAULT_POSTGRES_CONFIG.minWalSize),
    randomPageCost: normalizeFloatRange(s.randomPageCost, DEFAULT_POSTGRES_CONFIG.randomPageCost, 0, 100),
    defaultStatisticsTarget: normalizeInteger(s.defaultStatisticsTarget, DEFAULT_POSTGRES_CONFIG.defaultStatisticsTarget, 1, 10000),
    logConnections: normalizeBoolean(s.logConnections, DEFAULT_POSTGRES_CONFIG.logConnections),
    logDisconnections: normalizeBoolean(s.logDisconnections, DEFAULT_POSTGRES_CONFIG.logDisconnections),
    effectiveIoConcurrency: normalizeInteger(s.effectiveIoConcurrency, DEFAULT_POSTGRES_CONFIG.effectiveIoConcurrency, 0, 1000),
    maxParallelWorkersPerGather: normalizeInteger(s.maxParallelWorkersPerGather, DEFAULT_POSTGRES_CONFIG.maxParallelWorkersPerGather, 0, 1024),
    checkpointCompletionTarget: normalizeFloatRange(s.checkpointCompletionTarget, DEFAULT_POSTGRES_CONFIG.checkpointCompletionTarget, 0, 1),
    walCompression: normalizeBoolean(s.walCompression, DEFAULT_POSTGRES_CONFIG.walCompression),
    synchronousCommit: normalizeEnum(s.synchronousCommit, SYNCHRONOUS_COMMIT_MODES, DEFAULT_POSTGRES_CONFIG.synchronousCommit),
    logLockWaits: normalizeBoolean(s.logLockWaits, DEFAULT_POSTGRES_CONFIG.logLockWaits),
    logTempFiles: normalizeSignedInteger(s.logTempFiles, DEFAULT_POSTGRES_CONFIG.logTempFiles, -1, 2147483647),
  };
}

export interface PostgresConfigState {
  serviceId: string;
  serviceName: string;
  managed: PostgresManagedConfig;
  restartRequired: PostgresRestartRequiredGuc[];
}

// Display name for a scope: base, a registered instance's name, or (freeform
// Save-As, no fleet row yet) the scope id itself.
async function resolveScopeName(serviceId: string): Promise<string> {
  if (serviceId === DEFAULT_SCOPE_ID) return DEFAULT_SCOPE_NAME;
  const service = await getFleetServiceById(serviceId);
  return service?.name ?? serviceId;
}

export async function getPostgresConfigState(serviceId: string): Promise<PostgresConfigState> {
  const [serviceName, payload] = await Promise.all([
    resolveScopeName(serviceId),
    readLayeredPayload(POSTGRES_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE),
  ]);
  const restartRequired = serviceId === DEFAULT_SCOPE_ID
    ? []
    : await getPostgresRestartRequiredGucs(serviceId).catch(() => []);
  return {
    serviceId,
    serviceName,
    managed: normalizePostgresConfig(payload),
    restartRequired,
  };
}

/** All config scopes: the 'default' base plus every per-instance override owner. */
export async function listPostgresConfigScopes(): Promise<string[]> {
  return listConfigStoreOwners(POSTGRES_CONFIG_STORE_TABLE, 'service_id');
}

/** Drop an instance's whole override so it inherits the base again. */
export async function resetPostgresConfig(serviceId: string): Promise<PostgresConfigState & { applyError: string | null }> {
  if (serviceId === DEFAULT_SCOPE_ID) {
    throw new Error('The default base scope has no override to reset');
  }
  await deleteConfigStoreEntry(POSTGRES_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE);
  await deleteConfigStoreEntry(POSTGRES_CONFIG_STORE_TABLE, 'service_id', serviceId, RENDERED_PREVIEW_FILE);
  const state = await getPostgresConfigState(serviceId);
  return { ...state, applyError: await applyPostgresConfigLive(serviceId, state.managed) };
}

// Every managed GUC value is emitted as a quoted string literal — `ALTER
// SYSTEM SET x = '...'` accepts a quoted literal regardless of the GUC's
// underlying type, so this sidesteps any per-type quoting logic.
function quotePgLiteral(raw: string): string {
  return `'${raw.replace(/'/g, "''")}'`;
}

function postgresGucPairs(managed: PostgresManagedConfig): Array<[string, string]> {
  const onOff = (b: boolean) => (b ? 'on' : 'off');
  return [
    ['work_mem', managed.workMem],
    ['maintenance_work_mem', managed.maintenanceWorkMem],
    ['effective_cache_size', managed.effectiveCacheSize],
    ['log_min_duration_statement', String(managed.logMinDurationStatement)],
    ['statement_timeout', String(managed.statementTimeout)],
    ['idle_in_transaction_session_timeout', String(managed.idleInTransactionSessionTimeout)],
    ['autovacuum', onOff(managed.autovacuum)],
    ['autovacuum_vacuum_scale_factor', String(managed.autovacuumVacuumScaleFactor)],
    ['autovacuum_analyze_scale_factor', String(managed.autovacuumAnalyzeScaleFactor)],
    ['autovacuum_naptime', `${managed.autovacuumNaptime}s`],
    ['checkpoint_timeout', `${managed.checkpointTimeout}s`],
    ['max_wal_size', managed.maxWalSize],
    ['min_wal_size', managed.minWalSize],
    ['random_page_cost', String(managed.randomPageCost)],
    ['default_statistics_target', String(managed.defaultStatisticsTarget)],
    ['log_connections', onOff(managed.logConnections)],
    ['log_disconnections', onOff(managed.logDisconnections)],
    ['effective_io_concurrency', String(managed.effectiveIoConcurrency)],
    ['max_parallel_workers_per_gather', String(managed.maxParallelWorkersPerGather)],
    ['checkpoint_completion_target', String(managed.checkpointCompletionTarget)],
    ['wal_compression', onOff(managed.walCompression)],
    ['synchronous_commit', managed.synchronousCommit],
    ['log_lock_waits', onOff(managed.logLockWaits)],
    ['log_temp_files', String(managed.logTempFiles)],
  ];
}

export function renderPostgresConfig(managed: PostgresManagedConfig): string {
  const lines = [
    '-- Managed by Robin Admin — do not edit by hand. Reload-safe GUCs only.',
    ...postgresGucPairs(managed).map(([name, value]) => `ALTER SYSTEM SET ${name} = ${quotePgLiteral(value)};`),
  ];
  return `${lines.join('\n')}\n`;
}

export interface PostgresConfigSaveResult extends PostgresConfigState {
  rendered: string;
  /** Set when the live ALTER SYSTEM/reload apply failed; the persisted store
   *  write above still succeeded, so the managed form + preview are not lost. */
  applyError: string | null;
}

export async function savePostgresManagedConfig(
  serviceId: string,
  patch: Partial<PostgresManagedConfig>
): Promise<PostgresConfigSaveResult> {
  const current = await getPostgresConfigState(serviceId);
  const merged = normalizePostgresConfig({ ...current.managed, ...patch });
  const rendered = renderPostgresConfig(merged);

  // Persist the managed form + rendered preview BEFORE attempting the live
  // apply, so a failed apply never loses the operator's intended state. The
  // base scope stores the full object; an instance stores only its delta.
  await writeLayeredPayload(POSTGRES_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE, merged as unknown as Record<string, unknown>);
  await upsertConfigStorePayload(POSTGRES_CONFIG_STORE_TABLE, 'service_id', serviceId, RENDERED_PREVIEW_FILE, {
    content: rendered,
    managedBy: 'robin-admin',
  });

  const applyError = serviceId === DEFAULT_SCOPE_ID
    ? await applyPostgresBaseToInstances()
    : await applyPostgresConfigLive(serviceId, merged);

  return {
    serviceId,
    serviceName: current.serviceName,
    managed: merged,
    restartRequired: current.restartRequired,
    rendered,
    applyError,
  };
}

/** ALTER SYSTEM + reload the managed GUCs on one instance; returns the failure, if any. */
async function applyPostgresConfigLive(serviceId: string, managed: PostgresManagedConfig): Promise<string | null> {
  try {
    const pool = await getConnectedPool(serviceId);
    for (const [name, value] of postgresGucPairs(managed)) {
      await pool.query(`ALTER SYSTEM SET ${name} = ${quotePgLiteral(value)}`);
    }
    await pool.query('SELECT pg_reload_conf()');
    return null;
  } catch (error) {
    const message = (error as Error).message;
    logger.warn('Postgres managed config live apply failed', { serviceId, error: message });
    return message;
  }
}

/** A base save reaches every enabled instance, each with its own override layered on top. */
async function applyPostgresBaseToInstances(): Promise<string | null> {
  const failures: string[] = [];
  for (const service of await getEnabledFleetServices('postgres')) {
    const { managed } = await getPostgresConfigState(service.serviceId);
    const error = await applyPostgresConfigLive(service.serviceId, managed);
    if (error) failures.push(`${service.serviceId}: ${error}`);
  }
  return failures.length > 0 ? failures.join('; ') : null;
}

export async function getPostgresConfigRendered(serviceId: string): Promise<string> {
  const current = await getPostgresConfigState(serviceId);
  return renderPostgresConfig(current.managed);
}

// Restart-required GUCs are informational only (never written by this
// module) — surfaced so the Config page can flag "pending restart".
const RESTART_REQUIRED_GUCS = ['shared_buffers', 'max_connections', 'wal_level'] as const;

export interface PostgresRestartRequiredGuc {
  name: string;
  setting: string;
  unit: string | null;
  pendingRestart: boolean;
}

export async function getPostgresRestartRequiredGucs(serviceId: string): Promise<PostgresRestartRequiredGuc[]> {
  const pool = await getConnectedPool(serviceId);
  const result = await pool.query<{ name: string; setting: string; unit: string | null; pending_restart: boolean }>(
    `SELECT name, setting, unit, pending_restart FROM pg_settings WHERE name = ANY($1::text[])`,
    [RESTART_REQUIRED_GUCS as unknown as string[]]
  );
  return result.rows.map((row) => ({
    name: row.name,
    setting: row.setting,
    unit: row.unit,
    pendingRestart: row.pending_restart,
  }));
}

// ---------------------------------------------------------------------------
// Live metrics
// ---------------------------------------------------------------------------

export interface PostgresLiveMetrics {
  serviceId: string;
  serviceType: 'postgres';
  timestamp: Date;
  reachable: boolean;
  serverVersionNum: number;
  connectionsTotal: number;
  connectionsActive: number;
  connectionsIdle: number;
  connectionsIdleInTxn: number;
  connectionsWaiting: number;
  maxConnections: number;
  connectionSaturationPct: number;
  xactCommit: number;
  xactRollback: number;
  commitRatio: number;
  blksHit: number;
  blksRead: number;
  cacheHitRatio: number;
  tupReturned: number;
  tupFetched: number;
  tupInserted: number;
  tupUpdated: number;
  tupDeleted: number;
  deadlocks: number;
  tempFiles: number;
  tempBytes: number;
  conflicts: number;
  databaseSizeBytes: number;
  oldestXactAgeSecs: number;
  oldestIdleInTxnSecs: number;
  blockedQueries: number;
  checkpointsTimed: number;
  checkpointsReq: number;
  buffersCheckpoint: number;
  replicationLagBytes: number;
  deadTuplesTotal: number;
  rawStats: string;
}

/** `x / y`, guarding against a zero/invalid denominator. Pure — no I/O. */
export function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') return Number.isFinite(value) ? value : 0;
  if (typeof value === 'string') {
    const n = Number.parseFloat(value);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

export interface PgStatDatabaseAggregate {
  xactCommit: number;
  xactRollback: number;
  blksHit: number;
  blksRead: number;
  tupReturned: number;
  tupFetched: number;
  tupInserted: number;
  tupUpdated: number;
  tupDeleted: number;
  deadlocks: number;
  tempFiles: number;
  tempBytes: number;
  conflicts: number;
}

/** Map an aggregated `SUM(...) FROM pg_stat_database` row (bigints arrive as strings). Pure — no I/O. */
export function mapPgStatDatabaseRow(row: Record<string, unknown>): PgStatDatabaseAggregate {
  return {
    xactCommit: toNumber(row.xact_commit),
    xactRollback: toNumber(row.xact_rollback),
    blksHit: toNumber(row.blks_hit),
    blksRead: toNumber(row.blks_read),
    tupReturned: toNumber(row.tup_returned),
    tupFetched: toNumber(row.tup_fetched),
    tupInserted: toNumber(row.tup_inserted),
    tupUpdated: toNumber(row.tup_updated),
    tupDeleted: toNumber(row.tup_deleted),
    deadlocks: toNumber(row.deadlocks),
    tempFiles: toNumber(row.temp_files),
    tempBytes: toNumber(row.temp_bytes),
    conflicts: toNumber(row.conflicts),
  };
}

export interface PgActivityRowInput {
  state: string | null;
  wait_event_type?: string | null;
  xact_start?: Date | string | null;
  state_change?: Date | string | null;
}

export interface PgActivityAggregate {
  connectionsTotal: number;
  connectionsActive: number;
  connectionsIdle: number;
  connectionsIdleInTxn: number;
  connectionsWaiting: number;
  blockedQueries: number;
  oldestXactAgeSecs: number;
  oldestIdleInTxnSecs: number;
}

function ageSecs(value: Date | string | null | undefined, nowMs: number): number {
  if (!value) return 0;
  const t = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((nowMs - t) / 1000));
}

/** Aggregate `pg_stat_activity` rows (already excluding the admin connection itself). Pure — no I/O. */
export function mapPgStatActivityRows(rows: PgActivityRowInput[], now: Date = new Date()): PgActivityAggregate {
  const nowMs = now.getTime();
  const agg: PgActivityAggregate = {
    connectionsTotal: rows.length,
    connectionsActive: 0,
    connectionsIdle: 0,
    connectionsIdleInTxn: 0,
    connectionsWaiting: 0,
    blockedQueries: 0,
    oldestXactAgeSecs: 0,
    oldestIdleInTxnSecs: 0,
  };
  for (const row of rows) {
    const state = (row.state ?? '').toLowerCase();
    if (state === 'active') agg.connectionsActive += 1;
    else if (state === 'idle') agg.connectionsIdle += 1;
    else if (state.startsWith('idle in transaction')) {
      agg.connectionsIdleInTxn += 1;
      agg.oldestIdleInTxnSecs = Math.max(agg.oldestIdleInTxnSecs, ageSecs(row.state_change, nowMs));
    }
    if (row.wait_event_type === 'Lock') {
      agg.connectionsWaiting += 1;
      agg.blockedQueries += 1;
    }
    if (row.xact_start) {
      agg.oldestXactAgeSecs = Math.max(agg.oldestXactAgeSecs, ageSecs(row.xact_start, nowMs));
    }
  }
  return agg;
}

/**
 * Assemble a live snapshot from the consolidated JSON a co-located agent shipped
 * (agent mode). robin-admin has no pg client on that host, so the agent runs one
 * `psql -tAc` query producing a single JSON object (server_version_num,
 * max_connections, db size, pg_stat_database sums, pg_stat_activity rows, dead
 * tuples, replication lag) and forwards it. Reuses the same pure mappers as the
 * direct pool path. Fields not in the consolidated query (checkpointer counters)
 * are left at zero for agent mode. Reachable when the JSON parsed.
 */
/**
 * The statistics query behind Raw: one JSON object from PostgreSQL's own views.
 * The agent runs the same query through psql (postgresSnapshotSQL in
 * agent/main.go); keep the two in step.
 */
export const POSTGRES_SNAPSHOT_SQL = `SELECT json_build_object('versionNum',current_setting('server_version_num'),'maxConnections',current_setting('max_connections'),'dbSize',pg_database_size(current_database()),'db',(SELECT row_to_json(t) FROM (SELECT SUM(xact_commit) xact_commit,SUM(xact_rollback) xact_rollback,SUM(blks_hit) blks_hit,SUM(blks_read) blks_read,SUM(tup_returned) tup_returned,SUM(tup_fetched) tup_fetched,SUM(tup_inserted) tup_inserted,SUM(tup_updated) tup_updated,SUM(tup_deleted) tup_deleted,SUM(deadlocks) deadlocks,SUM(temp_files) temp_files,SUM(temp_bytes) temp_bytes,SUM(conflicts) conflicts FROM pg_stat_database WHERE datname IS NOT NULL) t),'activity',(SELECT COALESCE(json_agg(json_build_object('state',state,'wait_event_type',wait_event_type,'xact_start',xact_start,'state_change',state_change)),'[]'::json) FROM pg_stat_activity WHERE pid <> pg_backend_pid()),'deadTuples',(SELECT COALESCE(SUM(n_dead_tup),0) FROM pg_stat_user_tables))`;

/** PostgreSQL's answer as indented JSON, so Raw reads the same in either mode. */
function formatRawSnapshot(json: string): string {
  try {
    return JSON.stringify(JSON.parse(json), null, 2).slice(0, 8000);
  } catch {
    return json.slice(0, 8000);
  }
}

export function buildPostgresSnapshotFromRaw(serviceId: string, json: string): PostgresLiveMetrics {
  let parsed: Record<string, unknown> = {};
  let ok = false;
  try {
    const p = JSON.parse(json);
    if (p && typeof p === 'object' && !Array.isArray(p)) {
      parsed = p as Record<string, unknown>;
      ok = true;
    }
  } catch {
    ok = false;
  }
  const dbAgg = mapPgStatDatabaseRow((parsed.db as Record<string, unknown>) ?? {});
  const activity = mapPgStatActivityRows(Array.isArray(parsed.activity) ? (parsed.activity as PgActivityRowInput[]) : []);
  const maxConnections = toNumber(parsed.maxConnections);
  return {
    serviceId,
    serviceType: 'postgres',
    timestamp: new Date(),
    reachable: ok,
    serverVersionNum: toNumber(parsed.versionNum),
    connectionsTotal: activity.connectionsTotal,
    connectionsActive: activity.connectionsActive,
    connectionsIdle: activity.connectionsIdle,
    connectionsIdleInTxn: activity.connectionsIdleInTxn,
    connectionsWaiting: activity.connectionsWaiting,
    maxConnections,
    connectionSaturationPct: safeRatio(activity.connectionsTotal, maxConnections) * 100,
    xactCommit: dbAgg.xactCommit,
    xactRollback: dbAgg.xactRollback,
    commitRatio: safeRatio(dbAgg.xactCommit, dbAgg.xactCommit + dbAgg.xactRollback),
    blksHit: dbAgg.blksHit,
    blksRead: dbAgg.blksRead,
    cacheHitRatio: safeRatio(dbAgg.blksHit, dbAgg.blksHit + dbAgg.blksRead),
    tupReturned: dbAgg.tupReturned,
    tupFetched: dbAgg.tupFetched,
    tupInserted: dbAgg.tupInserted,
    tupUpdated: dbAgg.tupUpdated,
    tupDeleted: dbAgg.tupDeleted,
    deadlocks: dbAgg.deadlocks,
    tempFiles: dbAgg.tempFiles,
    tempBytes: dbAgg.tempBytes,
    conflicts: dbAgg.conflicts,
    databaseSizeBytes: toNumber(parsed.dbSize),
    oldestXactAgeSecs: activity.oldestXactAgeSecs,
    oldestIdleInTxnSecs: activity.oldestIdleInTxnSecs,
    blockedQueries: activity.blockedQueries,
    checkpointsTimed: 0,
    checkpointsReq: 0,
    buffersCheckpoint: 0,
    replicationLagBytes: toNumber(parsed.replicationLag),
    deadTuplesTotal: toNumber(parsed.deadTuples),
    rawStats: formatRawSnapshot(json),
  };
}

async function collectPostgresLiveMetrics(base: PostgresLiveMetrics, pool: pg.Pool): Promise<PostgresLiveMetrics> {
  try {
    const [versionRes, dbRes, activityRes, maxConnRes, sizeRes] = await Promise.all([
      pool.query<{ server_version_num: string }>('SHOW server_version_num'),
      pool.query('SELECT SUM(xact_commit) AS xact_commit, SUM(xact_rollback) AS xact_rollback, ' +
        'SUM(blks_hit) AS blks_hit, SUM(blks_read) AS blks_read, SUM(tup_returned) AS tup_returned, ' +
        'SUM(tup_fetched) AS tup_fetched, SUM(tup_inserted) AS tup_inserted, SUM(tup_updated) AS tup_updated, ' +
        'SUM(tup_deleted) AS tup_deleted, SUM(deadlocks) AS deadlocks, SUM(temp_files) AS temp_files, ' +
        'SUM(temp_bytes) AS temp_bytes, SUM(conflicts) AS conflicts FROM pg_stat_database WHERE datname IS NOT NULL'),
      pool.query<PgActivityRowInput>(
        'SELECT state, wait_event_type, xact_start, state_change FROM pg_stat_activity WHERE pid <> pg_backend_pid()'
      ),
      pool.query<{ setting: string }>("SELECT setting FROM pg_settings WHERE name = 'max_connections'"),
      pool.query<{ size: string }>('SELECT pg_database_size(current_database()) AS size'),
    ]);

    base.serverVersionNum = Number.parseInt(versionRes.rows[0]?.server_version_num ?? '0', 10) || 0;
    const dbAgg = mapPgStatDatabaseRow(dbRes.rows[0] ?? {});
    Object.assign(base, dbAgg);
    base.commitRatio = safeRatio(dbAgg.xactCommit, dbAgg.xactCommit + dbAgg.xactRollback);
    base.cacheHitRatio = safeRatio(dbAgg.blksHit, dbAgg.blksHit + dbAgg.blksRead);

    const activityAgg = mapPgStatActivityRows(activityRes.rows);
    Object.assign(base, activityAgg);
    base.maxConnections = Number.parseInt(maxConnRes.rows[0]?.setting ?? '0', 10) || 0;
    base.connectionSaturationPct = safeRatio(base.connectionsTotal, base.maxConnections) * 100;
    base.databaseSizeBytes = toNumber(sizeRes.rows[0]?.size);
    base.reachable = true;
  } catch (error) {
    logger.warn('Postgres core metrics query failed', { serviceId: base.serviceId, error: (error as Error).message });
    return base;
  }

  // Each of these is best-effort: absent on some builds/permissions, or the
  // instance may be a standalone primary with no replicas — never let one
  // missing view fail the whole metrics call.
  try {
    // Checkpoint counters moved from pg_stat_bgwriter to pg_stat_checkpointer in
    // PG17 (with renamed columns). Query the right view for the server version so
    // the metric populates and we don't spam the Postgres log with a failing query.
    const checkpointRes = base.serverVersionNum >= 170000
      ? await pool.query<{ checkpoints_timed: string; checkpoints_req: string; buffers_checkpoint: string }>(
        'SELECT num_timed AS checkpoints_timed, num_requested AS checkpoints_req, buffers_written AS buffers_checkpoint FROM pg_stat_checkpointer'
      )
      : await pool.query<{ checkpoints_timed: string; checkpoints_req: string; buffers_checkpoint: string }>(
        'SELECT checkpoints_timed, checkpoints_req, buffers_checkpoint FROM pg_stat_bgwriter'
      );
    base.checkpointsTimed = toNumber(checkpointRes.rows[0]?.checkpoints_timed);
    base.checkpointsReq = toNumber(checkpointRes.rows[0]?.checkpoints_req);
    base.buffersCheckpoint = toNumber(checkpointRes.rows[0]?.buffers_checkpoint);
  } catch {
    // Neither view available / permitted — leave at 0.
  }

  try {
    const replRes = await pool.query<{ lag: string }>(
      "SELECT COALESCE(SUM(pg_wal_lsn_diff(pg_current_wal_lsn(), replay_lsn)), 0) AS lag FROM pg_stat_replication"
    );
    base.replicationLagBytes = toNumber(replRes.rows[0]?.lag);
  } catch {
    // no replicas, or caller lacks replication view privileges — leave at 0
  }

  try {
    const deadRes = await pool.query<{ dead: string }>('SELECT COALESCE(SUM(n_dead_tup), 0) AS dead FROM pg_stat_user_tables');
    base.deadTuplesTotal = toNumber(deadRes.rows[0]?.dead);
  } catch {
    // leave at 0
  }

  try {
    const raw = await pool.query<{ snapshot: unknown }>(`SELECT (${POSTGRES_SNAPSHOT_SQL}) AS snapshot`);
    base.rawStats = formatRawSnapshot(JSON.stringify(raw.rows[0]?.snapshot ?? null));
  } catch (error) {
    base.rawStats = `# The statistics query failed: ${(error as Error).message}`;
  }
  return base;
}

export async function getPostgresLiveMetrics(serviceId: string): Promise<PostgresLiveMetrics> {
  const base: PostgresLiveMetrics = {
    serviceId,
    serviceType: 'postgres',
    timestamp: new Date(),
    reachable: false,
    serverVersionNum: 0,
    connectionsTotal: 0,
    connectionsActive: 0,
    connectionsIdle: 0,
    connectionsIdleInTxn: 0,
    connectionsWaiting: 0,
    maxConnections: 0,
    connectionSaturationPct: 0,
    xactCommit: 0,
    xactRollback: 0,
    commitRatio: 0,
    blksHit: 0,
    blksRead: 0,
    cacheHitRatio: 0,
    tupReturned: 0,
    tupFetched: 0,
    tupInserted: 0,
    tupUpdated: 0,
    tupDeleted: 0,
    deadlocks: 0,
    tempFiles: 0,
    tempBytes: 0,
    conflicts: 0,
    databaseSizeBytes: 0,
    oldestXactAgeSecs: 0,
    oldestIdleInTxnSecs: 0,
    blockedQueries: 0,
    checkpointsTimed: 0,
    checkpointsReq: 0,
    buffersCheckpoint: 0,
    replicationLagBytes: 0,
    deadTuplesTotal: 0,
    rawStats: '',
  };

  // The 'default' base layer has no running server to probe.
  if (serviceId === DEFAULT_SCOPE_ID) {
    return base;
  }

  const service = await getResolvedService(serviceId);
  const dsn = resolvePostgresDsn(service);
  if (!isPostgresUrl(dsn)) {
    logger.warn('No usable Postgres admin DSN for service', { serviceId });
    return base;
  }
  const pool = getPoolForDsn(dsn);
  return collectPostgresLiveMetrics(base, pool);
}

export async function getPostgresRawStats(serviceId: string): Promise<string> {
  const metrics = await getPostgresLiveMetrics(serviceId);
  return metrics.rawStats;
}

export async function getPostgresStatus(serviceId: string) {
  const [config, metrics] = await Promise.all([
    getPostgresConfigState(serviceId),
    getPostgresLiveMetrics(serviceId).catch(() => null),
  ]);
  return {
    serviceId,
    serviceName: config.serviceName,
    reachable: metrics?.reachable ?? false,
    managed: config.managed,
    metrics,
  };
}

export async function reloadPostgres(serviceId: string): Promise<string> {
  const pool = await getConnectedPool(serviceId);
  await pool.query('SELECT pg_reload_conf()');
  return 'Configuration reload signal sent';
}

// ---------------------------------------------------------------------------
// Ops (observability + safe operational actions — no DROP/TRUNCATE/arbitrary SQL)
// ---------------------------------------------------------------------------

function assertValidPid(pid: unknown): number {
  const n = typeof pid === 'number' ? pid : Number.parseInt(String(pid ?? ''), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Invalid Postgres backend pid');
  }
  return n;
}

// A bare or schema-qualified SQL identifier, e.g. `orders` or `public.orders`.
// Rejects anything else (quoting/casing tricks, statement terminators, etc.)
// before it's ever concatenated into a VACUUM/ANALYZE/size-lookup statement.
const IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

function assertValidTableName(table: unknown): string {
  if (typeof table !== 'string') {
    throw new Error('Invalid table name');
  }
  const parts = table.trim().split('.');
  if (parts.length > 2 || parts.some((p) => !IDENTIFIER_RE.test(p))) {
    throw new Error('Invalid table name');
  }
  return table.trim();
}

function quoteIdentifier(table: string): string {
  return table
    .split('.')
    .map((part) => `"${part.replace(/"/g, '""')}"`)
    .join('.');
}

export interface PostgresActivityRow {
  pid: number;
  usename: string | null;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  query: string | null;
  ageSecs: number;
}

export async function getPostgresActivity(serviceId: string, limit = 25): Promise<PostgresActivityRow[]> {
  const pool = await getConnectedPool(serviceId);
  const safeLimit = normalizeInteger(limit, 25, 1, 500);
  const result = await pool.query<{
    pid: number; usename: string | null; state: string | null;
    wait_event_type: string | null; wait_event: string | null; query: string | null; query_start: Date | null;
  }>(
    `SELECT pid, usename, state, wait_event_type, wait_event, query, query_start
     FROM pg_stat_activity
     WHERE pid <> pg_backend_pid() AND state IS NOT NULL
     ORDER BY COALESCE(query_start, backend_start) ASC
     LIMIT $1`,
    [safeLimit]
  );
  const now = Date.now();
  return result.rows.map((row) => ({
    pid: row.pid,
    usename: row.usename,
    state: row.state,
    waitEventType: row.wait_event_type,
    waitEvent: row.wait_event,
    query: row.query,
    ageSecs: ageSecs(row.query_start, now),
  }));
}

export async function cancelPostgresBackend(serviceId: string, pid: number): Promise<boolean> {
  const safePid = assertValidPid(pid);
  const pool = await getConnectedPool(serviceId);
  const result = await pool.query<{ pg_cancel_backend: boolean }>('SELECT pg_cancel_backend($1) AS pg_cancel_backend', [safePid]);
  return result.rows[0]?.pg_cancel_backend ?? false;
}

export async function terminatePostgresBackend(serviceId: string, pid: number): Promise<boolean> {
  const safePid = assertValidPid(pid);
  const pool = await getConnectedPool(serviceId);
  const result = await pool.query<{ pg_terminate_backend: boolean }>('SELECT pg_terminate_backend($1) AS pg_terminate_backend', [safePid]);
  return result.rows[0]?.pg_terminate_backend ?? false;
}

export interface PostgresLockRow {
  pid: number;
  relation: string | null;
  mode: string | null;
  granted: boolean;
  blockedByPids: number[];
}

export async function getPostgresLocks(serviceId: string): Promise<PostgresLockRow[]> {
  const pool = await getConnectedPool(serviceId);
  // `pg_blocking_pids(l.pid)` is computed in the same statement to avoid an
  // extra round-trip per lock row.
  const result = await pool.query<{ pid: number; relation: string | null; mode: string | null; granted: boolean; blocked_by: number[] | null }>(
    `SELECT l.pid, c.relname AS relation, l.mode, l.granted, pg_blocking_pids(l.pid) AS blocked_by
     FROM pg_locks l
     LEFT JOIN pg_class c ON c.oid = l.relation
     WHERE l.pid <> pg_backend_pid()
     ORDER BY l.granted ASC, l.pid ASC
     LIMIT 200`
  );
  return result.rows.map((row) => ({
    pid: row.pid,
    relation: row.relation,
    mode: row.mode,
    granted: row.granted,
    blockedByPids: row.blocked_by ?? [],
  }));
}

export async function vacuumPostgres(serviceId: string, options: { table?: string; analyze?: boolean } = {}): Promise<string> {
  const target = options.table ? quoteIdentifier(assertValidTableName(options.table)) : '';
  const sql = `VACUUM ${options.analyze ? 'ANALYZE ' : ''}${target}`.trim();
  await runUnbounded(serviceId, sql);
  return target ? `VACUUM${options.analyze ? ' ANALYZE' : ''} completed for ${target}` : `VACUUM${options.analyze ? ' ANALYZE' : ''} completed`;
}

export async function analyzePostgres(serviceId: string, options: { table?: string } = {}): Promise<string> {
  const target = options.table ? quoteIdentifier(assertValidTableName(options.table)) : '';
  const sql = `ANALYZE ${target}`.trim();
  await runUnbounded(serviceId, sql);
  return target ? `ANALYZE completed for ${target}` : 'ANALYZE completed';
}

export interface PostgresTableSize {
  schema: string;
  table: string;
  totalBytes: number;
}

export async function getPostgresTableSizes(serviceId: string, limit = 20): Promise<PostgresTableSize[]> {
  const pool = await getConnectedPool(serviceId);
  const safeLimit = normalizeInteger(limit, 20, 1, 200);
  const result = await pool.query<{ schema: string; table: string; total_bytes: string }>(
    `SELECT n.nspname AS schema, c.relname AS table, pg_total_relation_size(c.oid) AS total_bytes
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'p') AND n.nspname NOT IN ('pg_catalog', 'information_schema')
     ORDER BY pg_total_relation_size(c.oid) DESC
     LIMIT $1`,
    [safeLimit]
  );
  return result.rows.map((row) => ({ schema: row.schema, table: row.table, totalBytes: toNumber(row.total_bytes) }));
}

export interface PostgresStatStatementRow {
  query: string;
  calls: number;
  totalExecMs: number;
  meanExecMs: number;
}

export interface PostgresStatStatementsResult {
  available: boolean;
  rows: PostgresStatStatementRow[];
}

export async function getPostgresStatStatements(serviceId: string, limit = 20): Promise<PostgresStatStatementsResult> {
  const pool = await getConnectedPool(serviceId);
  const safeLimit = normalizeInteger(limit, 20, 1, 200);
  try {
    const extRes = await pool.query('SELECT 1 FROM pg_extension WHERE extname = $1', ['pg_stat_statements']);
    if (extRes.rowCount === 0) {
      return { available: false, rows: [] };
    }
    // Column names changed across versions (total_time/mean_time pre-PG13 vs
    // total_exec_time/mean_exec_time PG13+); try the modern names first.
    const statRes = await pool.query<{ query: string; calls: string; total_exec_time: string; mean_exec_time: string }>(
      `SELECT query, calls, total_exec_time, mean_exec_time
       FROM pg_stat_statements
       ORDER BY total_exec_time DESC
       LIMIT $1`,
      [safeLimit]
    );
    return {
      available: true,
      rows: statRes.rows.map((row) => ({
        query: row.query,
        calls: toNumber(row.calls),
        totalExecMs: toNumber(row.total_exec_time),
        meanExecMs: toNumber(row.mean_exec_time),
      })),
    };
  } catch (error) {
    logger.warn('pg_stat_statements unavailable', { serviceId, error: (error as Error).message });
    return { available: false, rows: [] };
  }
}

export async function resetPostgresStats(serviceId: string): Promise<string> {
  const pool = await getConnectedPool(serviceId);
  await pool.query('SELECT pg_stat_reset()');
  return 'Statistics reset';
}
