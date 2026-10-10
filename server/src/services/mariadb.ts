import mysql from 'mysql2/promise';
import type { Pool, PoolOptions, RowDataPacket } from 'mysql2/promise';
import {
  MARIADB_CONFIG_STORE_TABLE,
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

// MariaDB (and MySQL 8, best effort) through one mysql2 pool per DSN, the same
// shape as postgres.ts: metrics, managed dynamic variables, and safe ops.
const CONNECT_TIMEOUT_MS = 8000;
// Seconds. Every pooled session gets it, so no admin query can pile up behind
// a busy server.
const STATEMENT_TIMEOUT_SECS = 8;
// Summing information_schema.TABLES opens table metadata, so collect on a slow cadence.
const SIZE_INTERVAL_MS = 10 * 60 * 1000;

const DEFAULT_SCOPE_ID = 'default';
const DEFAULT_SCOPE_NAME = 'Default (base)';
const MANAGED_JSON_FILE = 'managed.json';
const RENDERED_PREVIEW_FILE = 'rendered.sql';

const SYSTEM_SCHEMAS = ['mysql', 'information_schema', 'performance_schema', 'sys'];
const SYSTEM_SCHEMAS_SQL = SYSTEM_SCHEMAS.map((name) => `'${name}'`).join(', ');

export type MariadbFlavor = 'mariadb' | 'mysql';

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/** mysql2 options from a mysql:// or mariadb:// DSN (?socket=, ?ssl=true|skip-verify). */
export function parseMariadbDsn(dsn: string): PoolOptions {
  const url = new URL(dsn.trim().replace(/^mariadb:/i, 'mysql:'));
  const params = url.searchParams;
  const ssl = params.get('ssl')?.toLowerCase();
  const options: PoolOptions = {
    user: decodeURIComponent(url.username) || undefined,
    password: url.password ? decodeURIComponent(url.password) : undefined,
    database: decodeURIComponent(url.pathname.replace(/^\//, '')) || undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
    supportBigNumbers: true,
    bigNumberStrings: true,
    dateStrings: true,
  };
  const socket = params.get('socket');
  if (socket) {
    options.socketPath = socket;
  } else {
    options.host = url.hostname.replace(/^\[|\]$/g, '') || 'localhost';
    options.port = url.port ? Number.parseInt(url.port, 10) : 3306;
  }
  if (ssl && !['true', 'required', 'skip-verify', 'false'].includes(ssl)) throw new Error('Unsupported MariaDB TLS mode');
  if ([...params.keys()].some(key => !['socket', 'ssl'].includes(key))) throw new Error('MariaDB connection string contains unsupported options');
  if (url.protocol !== 'mysql:' || url.hash) throw new Error('Invalid MariaDB connection string');
  if (ssl === 'true' || ssl === 'required') options.ssl = { verifyIdentity: true };
  else if (ssl === 'skip-verify') options.ssl = { rejectUnauthorized: false };
  return options;
}

const poolCache = new Map<string, Pool>();

function getPoolForDsn(dsn: string): Pool {
  let pool = poolCache.get(dsn);
  if (!pool) {
    pool = mysql.createPool({
      ...parseMariadbDsn(dsn),
      connectionLimit: 4,
      maxIdle: 1,
      idleTimeout: 30000,
      queueLimit: 50,
      enableKeepAlive: true,
    });
    // Each new session is capped before it serves a query (commands run in order
    // on a connection). MySQL names the cap differently and applies it to SELECTs.
    pool.pool.on('connection', (connection) => {
      connection.query(`SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_SECS}`, (error: Error | null) => {
        if (error) connection.query(`SET SESSION max_execution_time = ${STATEMENT_TIMEOUT_SECS * 1000}`, () => undefined);
      });
    });
    poolCache.set(dsn, pool);
  }
  return pool;
}

/** Close and forget every cached MariaDB admin pool (graceful server shutdown). */
export async function closeMariadbPools(): Promise<void> {
  const pools = Array.from(poolCache.values());
  poolCache.clear();
  flavorCache.clear();
  await Promise.all(pools.map(async (pool) => {
    try {
      await pool.end();
    } catch (error) {
      logger.warn('MariaDB admin pool close failed', { error: (error as Error).message });
    }
  }));
}

/** The fleet row's `metricsUrl`, else the `MARIADB_ADMIN_DSN` fallback. */
export function resolveMariadbDsn(service: { metricsUrl: string | null }): string | null {
  return resolveServiceDsn(service, 'MARIADB_ADMIN_DSN');
}

export function isMariadbUrl(value: string | null | undefined): value is string {
  return isDsnFor('mariadb', value);
}

async function resolveConnectedDsn(serviceId: string): Promise<string> {
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== 'mariadb') {
    throw new Error('MariaDB service not found');
  }
  const dsn = resolveMariadbDsn(service);
  if (!isMariadbUrl(dsn)) {
    throw new Error('No MariaDB admin DSN configured for this service');
  }
  return dsn;
}

async function getConnectedPool(serviceId: string): Promise<Pool> {
  return getPoolForDsn(await resolveConnectedDsn(serviceId));
}

async function rows(pool: Pool, sql: string, params: unknown[] = []): Promise<RowDataPacket[]> {
  const [result] = await pool.query<RowDataPacket[]>({ sql, timeout: STATEMENT_TIMEOUT_SECS * 1000 }, params);
  return result;
}

const flavorCache = new Map<Pool, MariadbFlavor>();

export function flavorOfVersion(version: string): MariadbFlavor {
  return /mariadb/i.test(version) ? 'mariadb' : 'mysql';
}

async function flavorOf(pool: Pool): Promise<MariadbFlavor> {
  const cached = flavorCache.get(pool);
  if (cached) return cached;
  const [row] = await rows(pool, 'SELECT VERSION() AS version');
  const flavor = flavorOfVersion(String(row?.version ?? ''));
  flavorCache.set(pool, flavor);
  return flavor;
}

/** A dedicated bounded session for longer ANALYZE TABLE work. */
async function runAnalyze(serviceId: string, sql: string): Promise<RowDataPacket[]> {
  const connection = await mysql.createConnection(parseMariadbDsn(await resolveConnectedDsn(serviceId)));
  try {
    await connection.query({ sql: 'SET SESSION lock_wait_timeout = 60', timeout: 8000 });
    const [result] = await connection.query<RowDataPacket[]>({ sql, timeout: 60000 });
    return result;
  } finally {
    connection.destroy();
  }
}

// ---------------------------------------------------------------------------
// Snapshot: one sectioned batch, shared by direct mode and the agent
// ---------------------------------------------------------------------------

// Dynamic variables robin-admin can manage, plus the read-only facts the
// snapshot and Config page show. One SHOW reads them all.
interface ManagedVariable {
  key: string;
  name: string;
  kind: 'int' | 'float' | 'bool' | 'enum';
  min?: number;
  max?: number;
  values?: readonly string[];
  /** Only this server flavor has the variable. */
  flavor?: MariadbFlavor;
}

const UINT32_MAX = 4294967295;

export const MARIADB_MANAGED_VARIABLES: readonly ManagedVariable[] = [
  { key: 'maxConnections', name: 'max_connections', kind: 'int', min: 10, max: 100000 },
  { key: 'waitTimeout', name: 'wait_timeout', kind: 'int', min: 1, max: 31536000 },
  { key: 'interactiveTimeout', name: 'interactive_timeout', kind: 'int', min: 1, max: 31536000 },
  { key: 'maxStatementTime', name: 'max_statement_time', kind: 'float', min: 0, max: 31536000, flavor: 'mariadb' },
  { key: 'maxExecutionTime', name: 'max_execution_time', kind: 'int', min: 0, max: UINT32_MAX, flavor: 'mysql' },
  { key: 'innodbLockWaitTimeout', name: 'innodb_lock_wait_timeout', kind: 'int', min: 1, max: 1073741824 },
  { key: 'lockWaitTimeout', name: 'lock_wait_timeout', kind: 'int', min: 1, max: 31536000 },
  { key: 'slowQueryLog', name: 'slow_query_log', kind: 'bool' },
  { key: 'longQueryTime', name: 'long_query_time', kind: 'float', min: 0, max: 31536000 },
  { key: 'logQueriesNotUsingIndexes', name: 'log_queries_not_using_indexes', kind: 'bool' },
  { key: 'innodbPrintAllDeadlocks', name: 'innodb_print_all_deadlocks', kind: 'bool' },
  { key: 'innodbIoCapacity', name: 'innodb_io_capacity', kind: 'int', min: 100, max: UINT32_MAX },
  { key: 'innodbIoCapacityMax', name: 'innodb_io_capacity_max', kind: 'int', min: 100, max: UINT32_MAX },
  { key: 'innodbFlushLogAtTrxCommit', name: 'innodb_flush_log_at_trx_commit', kind: 'enum', values: ['0', '1', '2'] },
  { key: 'syncBinlog', name: 'sync_binlog', kind: 'int', min: 0, max: UINT32_MAX },
  { key: 'tmpTableSize', name: 'tmp_table_size', kind: 'int', min: 1024, max: Number.MAX_SAFE_INTEGER },
  { key: 'maxHeapTableSize', name: 'max_heap_table_size', kind: 'int', min: 16384, max: Number.MAX_SAFE_INTEGER },
  { key: 'tableOpenCache', name: 'table_open_cache', kind: 'int', min: 1, max: 1048576 },
  { key: 'threadCacheSize', name: 'thread_cache_size', kind: 'int', min: 0, max: 16384 },
];

// Managed outside Admin; restart requirements depend on the server version.
export const MARIADB_SERVER_SETTINGS = [
  'innodb_buffer_pool_size',
  'innodb_log_file_size',
  'innodb_buffer_pool_instances',
  'innodb_read_io_threads',
  'innodb_write_io_threads',
  'performance_schema',
] as const;

const SNAPSHOT_VARIABLES = [
  'version',
  'version_comment',
  ...MARIADB_MANAGED_VARIABLES.map((variable) => variable.name),
  ...MARIADB_SERVER_SETTINGS,
];

const SNAPSHOT_SECTIONS: ReadonlyArray<readonly [string, string]> = [
  ['status', 'SHOW GLOBAL STATUS'],
  ['variables', `SHOW GLOBAL VARIABLES WHERE Variable_name IN (${SNAPSHOT_VARIABLES.map((name) => `'${name}'`).join(', ')})`],
  ['trx', [
    "SELECT 'trx_active' AS k, COUNT(*) AS v FROM information_schema.INNODB_TRX",
    "SELECT 'oldest_trx_age_secs', COALESCE(MAX(TIMESTAMPDIFF(SECOND, trx_started, NOW())), 0) FROM information_schema.INNODB_TRX",
    "SELECT 'trx_lock_waits', COUNT(*) FROM information_schema.INNODB_TRX WHERE trx_state = 'LOCK WAIT'",
    `SELECT 'schema_count', COUNT(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN (${SYSTEM_SCHEMAS_SQL})`,
    "SELECT LOWER(m.NAME), m.COUNT FROM information_schema.INNODB_METRICS m WHERE m.NAME IN ('lock_deadlocks', 'trx_rseg_history_len')",
  ].join(' UNION ALL ')],
  ['replica', 'SHOW REPLICA STATUS'],
];

const SIZE_SECTION = [
  'size',
  `SELECT 'database_size_bytes' AS k, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS v FROM information_schema.TABLES WHERE TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS_SQL})`,
] as const;

/**
 * The statistics batch behind Raw, for `mariadb -B --force -e`. Each section is
 * introduced by a marker row; the agent runs the same text (mariadbSnapshotSQL
 * in agent/main.go) — keep the two in step. The size section is appended only
 * when it is due. The session cap is MariaDB syntax; MySQL treats it as a comment.
 */
export function buildMariadbSnapshotSql(includeSize: boolean): string {
  const sections = includeSize ? [...SNAPSHOT_SECTIONS, SIZE_SECTION] : SNAPSHOT_SECTIONS;
  return [
    `/*M!100100 SET SESSION max_statement_time = ${STATEMENT_TIMEOUT_SECS * 2} */`,
    ...sections.map(([name, sql]) => `SELECT '##${name}';\n${sql}`),
  ].join(';\n') + ';';
}

// The client's batch (-B) escaping, so direct mode reads exactly like the agent.
function batchCell(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  return String(value).replace(/\\/g, '\\\\').replace(/\t/g, '\\t').replace(/\n/g, '\\n');
}

function serializeSection(name: string, result: RowDataPacket[]): string {
  const lines = [`##${name}`];
  if (result.length > 0) {
    const columns = Object.keys(result[0]);
    lines.push(columns.join('\t'));
    for (const row of result) lines.push(columns.map((column) => batchCell(row[column])).join('\t'));
  }
  return lines.join('\n');
}

interface ParsedSections {
  kv: Record<string, Record<string, string>>;
  replica: Array<Record<string, string>>;
}

const KV_HEADERS = new Set(['Variable_name\tValue', 'k\tv']);

/** Split the batch output into its sections. Pure — no I/O. */
export function parseMariadbSections(raw: string): ParsedSections {
  const parsed: ParsedSections = { kv: {}, replica: [] };
  let section: string | null = null;
  let replicaHeader: string[] | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const marker = /^##(\w+)$/.exec(line.trim());
    if (marker) {
      section = marker[1];
      replicaHeader = null;
      continue;
    }
    if (!section) continue;
    if (section === 'replica') {
      const cells = line.split('\t');
      if (!replicaHeader) replicaHeader = cells;
      else parsed.replica.push(Object.fromEntries(replicaHeader.map((column, index) => [column, cells[index] ?? ''])));
      continue;
    }
    if (KV_HEADERS.has(line)) continue;
    const tab = line.indexOf('\t');
    if (tab <= 0) continue;
    (parsed.kv[section] ??= {})[line.slice(0, tab).toLowerCase()] = line.slice(tab + 1);
  }
  return parsed;
}

export interface MariadbLiveMetrics {
  serviceId: string;
  serviceType: 'mariadb';
  timestamp: Date;
  reachable: boolean;
  version: string;
  uptimeSecs: number;
  threadsConnected: number;
  threadsRunning: number;
  threadsCached: number;
  maxConnections: number;
  maxUsedConnections: number;
  connectionSaturationPct: number;
  abortedConnects: number;
  abortedClients: number;
  questions: number;
  comSelect: number;
  comInsert: number;
  comUpdate: number;
  comDelete: number;
  comCommit: number;
  comRollback: number;
  slowQueries: number;
  bytesReceived: number;
  bytesSent: number;
  bufferPoolReadRequests: number;
  bufferPoolReads: number;
  bufferPoolHitRatio: number;
  bufferPoolPagesTotal: number;
  bufferPoolPagesFree: number;
  bufferPoolPagesDirty: number;
  rowLockWaits: number;
  rowLockTimeMs: number;
  deadlocks: number;
  historyListLength: number;
  trxActive: number;
  oldestTrxAgeSecs: number;
  trxLockWaits: number;
  createdTmpDiskTables: number;
  createdTmpTables: number;
  openedTables: number;
  schemaCount: number;
  /** Collected every SIZE_INTERVAL_MS; null in a snapshot that skipped it. */
  databaseSizeBytes: number | null;
  isReplica: boolean;
  replicaIoRunning: boolean;
  replicaSqlRunning: boolean;
  /** Worst replication channel; null when not a replica or a channel is broken. */
  secondsBehindSource: number | null;
  rawStats: string;
  /** The variables section (lower-cased names), for drift checks. Not stored. */
  variables: Record<string, string>;
}

/** Numeric history columns, as camelCase keys: each maps to its snake_case column. */
export const MARIADB_NUMERIC_FIELDS = [
  'uptimeSecs', 'threadsConnected', 'threadsRunning', 'threadsCached', 'maxConnections', 'maxUsedConnections',
  'connectionSaturationPct', 'abortedConnects', 'abortedClients', 'questions', 'comSelect', 'comInsert',
  'comUpdate', 'comDelete', 'comCommit', 'comRollback', 'slowQueries', 'bytesReceived', 'bytesSent',
  'bufferPoolReadRequests', 'bufferPoolReads', 'bufferPoolHitRatio', 'bufferPoolPagesTotal', 'bufferPoolPagesFree',
  'bufferPoolPagesDirty', 'rowLockWaits', 'rowLockTimeMs', 'deadlocks', 'historyListLength', 'trxActive',
  'oldestTrxAgeSecs', 'trxLockWaits', 'createdTmpDiskTables', 'createdTmpTables', 'openedTables', 'schemaCount',
] as const satisfies ReadonlyArray<keyof MariadbLiveMetrics>;

export function emptyMariadbMetrics(serviceId: string): MariadbLiveMetrics {
  const metrics = {
    serviceId,
    serviceType: 'mariadb',
    timestamp: new Date(),
    reachable: false,
    version: '',
    databaseSizeBytes: null,
    isReplica: false,
    replicaIoRunning: false,
    replicaSqlRunning: false,
    secondsBehindSource: null,
    rawStats: '',
    variables: {},
  } as Partial<MariadbLiveMetrics>;
  for (const field of MARIADB_NUMERIC_FIELDS) (metrics as Record<string, unknown>)[field] = 0;
  return metrics as MariadbLiveMetrics;
}

function toNumber(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}

/** `x / y`, guarding against a zero/invalid denominator. Pure — no I/O. */
export function safeRatio(numerator: number, denominator: number): number {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator <= 0) return 0;
  return numerator / denominator;
}

/** Parse the sectioned batch output into a snapshot. Pure — no I/O. */
export function buildMariadbSnapshotFromRaw(serviceId: string, raw: string): MariadbLiveMetrics {
  const { kv, replica } = parseMariadbSections(raw);
  const status = kv.status ?? {};
  const variables = kv.variables ?? {};
  const trx = kv.trx ?? {};
  const s = (name: string) => toNumber(status[name]);
  const snapshot = emptyMariadbMetrics(serviceId);
  const readRequests = s('innodb_buffer_pool_read_requests');
  const reads = s('innodb_buffer_pool_reads');
  const maxConnections = toNumber(variables.max_connections);

  Object.assign(snapshot, {
    reachable: Object.keys(status).length > 0,
    version: variables.version ?? '',
    uptimeSecs: s('uptime'),
    threadsConnected: s('threads_connected'),
    threadsRunning: s('threads_running'),
    threadsCached: s('threads_cached'),
    maxConnections,
    maxUsedConnections: s('max_used_connections'),
    connectionSaturationPct: safeRatio(s('threads_connected'), maxConnections) * 100,
    abortedConnects: s('aborted_connects'),
    abortedClients: s('aborted_clients'),
    questions: s('questions'),
    comSelect: s('com_select'),
    comInsert: s('com_insert'),
    comUpdate: s('com_update'),
    comDelete: s('com_delete'),
    comCommit: s('com_commit'),
    comRollback: s('com_rollback'),
    slowQueries: s('slow_queries'),
    bytesReceived: s('bytes_received'),
    bytesSent: s('bytes_sent'),
    bufferPoolReadRequests: readRequests,
    bufferPoolReads: reads,
    // No reads yet means nothing missed the pool: report a full hit ratio.
    bufferPoolHitRatio: readRequests > 0 ? Math.max(0, 1 - reads / readRequests) : 1,
    bufferPoolPagesTotal: s('innodb_buffer_pool_pages_total'),
    bufferPoolPagesFree: s('innodb_buffer_pool_pages_free'),
    bufferPoolPagesDirty: s('innodb_buffer_pool_pages_dirty'),
    rowLockWaits: s('innodb_row_lock_waits'),
    rowLockTimeMs: s('innodb_row_lock_time'),
    // MariaDB reports these as status variables; MySQL through INNODB_METRICS.
    deadlocks: toNumber(status.innodb_deadlocks ?? trx.lock_deadlocks),
    historyListLength: toNumber(status.innodb_history_list_length ?? trx.trx_rseg_history_len),
    trxActive: toNumber(trx.trx_active),
    oldestTrxAgeSecs: toNumber(trx.oldest_trx_age_secs),
    trxLockWaits: toNumber(trx.trx_lock_waits),
    createdTmpDiskTables: s('created_tmp_disk_tables'),
    createdTmpTables: s('created_tmp_tables'),
    openedTables: s('opened_tables'),
    schemaCount: toNumber(trx.schema_count),
    databaseSizeBytes: kv.size?.database_size_bytes !== undefined ? toNumber(kv.size.database_size_bytes) : null,
    rawStats: raw.slice(0, 16000),
    variables,
  } satisfies Partial<MariadbLiveMetrics>);

  if (replica.length > 0) {
    const field = (row: Record<string, string>, ...names: string[]) => names.map((name) => row[name]).find((value) => value !== undefined);
    const lags = replica.map((row) => field(row, 'Seconds_Behind_Source', 'Seconds_Behind_Master'));
    snapshot.isReplica = true;
    snapshot.replicaIoRunning = replica.every((row) => field(row, 'Replica_IO_Running', 'Slave_IO_Running') === 'Yes');
    snapshot.replicaSqlRunning = replica.every((row) => field(row, 'Replica_SQL_Running', 'Slave_SQL_Running') === 'Yes');
    snapshot.secondsBehindSource = lags.some((lag) => lag === undefined || lag === 'NULL' || lag === '')
      ? null
      : Math.max(...lags.map(toNumber));
  }
  return snapshot;
}

// Database size is slow to read, so it is collected on a cadence and carried
// forward between collections (agent snapshots included).
const sizeCache = new Map<string, { bytes: number; at: number }>();

export function mariadbSizeDue(serviceId: string, now = Date.now()): boolean {
  return (sizeCache.get(serviceId)?.at ?? 0) <= now - SIZE_INTERVAL_MS;
}

/** Record a collected size, or fill a skipped one from the last known value. */
export function carryMariadbSize(snapshot: MariadbLiveMetrics, lastKnown?: number | null): MariadbLiveMetrics {
  if (snapshot.databaseSizeBytes !== null) {
    sizeCache.set(snapshot.serviceId, { bytes: snapshot.databaseSizeBytes, at: Date.now() });
    return snapshot;
  }
  const cached = sizeCache.get(snapshot.serviceId);
  if (cached) return { ...snapshot, databaseSizeBytes: cached.bytes };
  if (lastKnown !== undefined && lastKnown !== null) {
    // From history: known, but not freshly collected, so the next collection still runs.
    sizeCache.set(snapshot.serviceId, { bytes: lastKnown, at: 0 });
    return { ...snapshot, databaseSizeBytes: lastKnown };
  }
  return snapshot;
}

export function hasCachedMariadbSize(serviceId: string): boolean {
  return sizeCache.has(serviceId);
}

async function collectSections(pool: Pool, includeSize: boolean): Promise<string> {
  const sections = includeSize ? [...SNAPSHOT_SECTIONS, SIZE_SECTION] : SNAPSHOT_SECTIONS;
  const parts = await Promise.all(sections.map(async ([name, sql]) => {
    try {
      return serializeSection(name, await rows(pool, sql));
    } catch (error) {
      // A missing privilege or view costs that section only, as with the agent's --force.
      if (name === 'status') throw error;
      return `##${name}\n# ${(error as Error).message.replace(/\n/g, ' ')}`;
    }
  }));
  return parts.join('\n');
}

export async function getMariadbLiveMetrics(serviceId: string): Promise<MariadbLiveMetrics> {
  if (serviceId === DEFAULT_SCOPE_ID) return emptyMariadbMetrics(serviceId);
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== 'mariadb') {
    throw new Error('MariaDB service not found');
  }
  const dsn = resolveMariadbDsn(service);
  if (!isMariadbUrl(dsn)) {
    logger.warn('No usable MariaDB admin DSN for service', { serviceId });
    return emptyMariadbMetrics(serviceId);
  }
  try {
    const raw = await collectSections(getPoolForDsn(dsn), mariadbSizeDue(serviceId));
    return carryMariadbSize(buildMariadbSnapshotFromRaw(serviceId, raw));
  } catch (error) {
    logger.warn('MariaDB metrics query failed', { serviceId, error: (error as Error).message });
    const snapshot = emptyMariadbMetrics(serviceId);
    snapshot.rawStats = `# The statistics query failed: ${(error as Error).message}`;
    return snapshot;
  }
}

export async function getMariadbRawStats(serviceId: string): Promise<string> {
  return (await getMariadbLiveMetrics(serviceId)).rawStats;
}

// ---------------------------------------------------------------------------
// Managed config: dynamic variables, sparse (only what an operator set)
// ---------------------------------------------------------------------------

/** A value per managed variable; null leaves the server's own setting alone. */
export type MariadbManagedConfig = Record<string, number | boolean | string | null>;

function normalizeVariableValue(variable: ManagedVariable, value: unknown): number | boolean | string | null {
  if (value === null || value === undefined || value === '') return null;
  switch (variable.kind) {
    case 'bool': {
      if (typeof value === 'boolean') return value;
      const text = String(value).toUpperCase();
      if (text === 'ON' || text === '1' || text === 'TRUE') return true;
      if (text === 'OFF' || text === '0' || text === 'FALSE') return false;
      throw new Error(`${variable.name} must be ON or OFF`);
    }
    case 'enum': {
      const text = String(value);
      if (variable.values?.includes(text)) return text;
      throw new Error(`${variable.name} must be one of ${variable.values?.join(', ')}`);
    }
    case 'int':
    case 'float': {
      const n = typeof value === 'number' ? value : Number(String(value).trim());
      const valid = Number.isFinite(n) && (variable.kind === 'float' || Number.isInteger(n))
        && n >= (variable.min ?? 0) && n <= (variable.max ?? Number.MAX_SAFE_INTEGER);
      if (!valid) {
        throw new Error(`${variable.name} must be ${variable.kind === 'int' ? 'an integer' : 'a number'} from ${variable.min ?? 0} to ${variable.max}`);
      }
      return n;
    }
  }
}

/** Validate submitted settings before persisting or applying them. */
export function normalizeMariadbConfig(value: unknown): MariadbManagedConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('MariaDB configuration must be an object');
  const input = value as Record<string, unknown>;
  if (Object.keys(input).some(key => !MARIADB_MANAGED_VARIABLES.some(variable => variable.key === key))) throw new Error('MariaDB configuration contains unsupported settings');
  return Object.fromEntries(MARIADB_MANAGED_VARIABLES.map((variable) => [variable.key, normalizeVariableValue(variable, input[variable.key])]));
}

// A stored payload is trusted less than a request: an invalid value is dropped.
function readStoredConfig(value: unknown): MariadbManagedConfig {
  const input = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return Object.fromEntries(MARIADB_MANAGED_VARIABLES.map((variable) => {
    try {
      return [variable.key, normalizeVariableValue(variable, input[variable.key])];
    } catch {
      return [variable.key, null];
    }
  }));
}

function sqlValue(variable: ManagedVariable, value: number | boolean | string): string {
  if (variable.kind === 'bool') return value ? 'ON' : 'OFF';
  return String(value);
}

function managedPairs(managed: MariadbManagedConfig, flavor?: MariadbFlavor): Array<[ManagedVariable, string]> {
  return MARIADB_MANAGED_VARIABLES
    .filter((variable) => managed[variable.key] !== null && managed[variable.key] !== undefined)
    .filter((variable) => !flavor || !variable.flavor || variable.flavor === flavor)
    .map((variable) => [variable, sqlValue(variable, managed[variable.key] as number | boolean | string)]);
}

export function renderMariadbConfig(managed: MariadbManagedConfig): string {
  const pairs = managedPairs(managed);
  const lines = [
    '-- Managed by Robin Admin. Dynamic variables only, applied live with SET GLOBAL',
    '-- and re-applied from Admin after a restart reverts them.',
    ...(pairs.length === 0
      ? ['-- No variables are managed for this scope; the server keeps its own settings.']
      : pairs.map(([variable, value]) => `SET GLOBAL ${variable.name} = ${variable.kind === 'bool' ? `'${value}'` : value};`)),
  ];
  return `${lines.join('\n')}\n`;
}

export interface MariadbServerSetting {
  name: string;
  setting: string;
}

export interface MariadbConfigState {
  serviceId: string;
  serviceName: string;
  managed: MariadbManagedConfig;
  /** The running server's value per managed key (instance scopes, when reachable). */
  live: Record<string, string>;
  flavor: MariadbFlavor | null;
  serverSettings: MariadbServerSetting[];
}

async function resolveScopeName(serviceId: string): Promise<string> {
  if (serviceId === DEFAULT_SCOPE_ID) return DEFAULT_SCOPE_NAME;
  const service = await getFleetServiceById(serviceId);
  return service?.name ?? serviceId;
}

async function readServerVariables(serviceId: string): Promise<{ flavor: MariadbFlavor; variables: Record<string, string> }> {
  const pool = await getConnectedPool(serviceId);
  const result = await rows(pool, SNAPSHOT_SECTIONS[1][1]);
  const variables = Object.fromEntries(result.map((row) => [String(row.Variable_name).toLowerCase(), String(row.Value ?? '')]));
  return { flavor: flavorOfVersion(`${variables.version ?? ''} ${variables.version_comment ?? ''}`), variables };
}

export async function getMariadbConfigState(serviceId: string): Promise<MariadbConfigState> {
  const [serviceName, payload, server] = await Promise.all([
    resolveScopeName(serviceId),
    readLayeredPayload(MARIADB_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE),
    serviceId === DEFAULT_SCOPE_ID ? Promise.resolve(null) : readServerVariables(serviceId).catch(() => null),
  ]);
  const live: Record<string, string> = {};
  for (const variable of MARIADB_MANAGED_VARIABLES) {
    const value = server?.variables[variable.name];
    if (value !== undefined) live[variable.key] = value;
  }
  return {
    serviceId,
    serviceName,
    managed: readStoredConfig(payload),
    live,
    flavor: server?.flavor ?? null,
    serverSettings: MARIADB_SERVER_SETTINGS
      .filter((name) => server?.variables[name] !== undefined)
      .map((name) => ({ name, setting: server?.variables[name] ?? '' })),
  };
}

export async function listMariadbConfigScopes(): Promise<string[]> {
  return listConfigStoreOwners(MARIADB_CONFIG_STORE_TABLE, 'service_id');
}

/** Effective config for one instance: the base with its own override on top. */
async function effectiveConfig(serviceId: string): Promise<MariadbManagedConfig> {
  return readStoredConfig(await readLayeredPayload(MARIADB_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE));
}

/**
 * SET GLOBAL every managed variable on one instance. Admin is the only config store.
 * Variables that depend on each other's current value (innodb_io_capacity vs
 * its max) can fail in one order, so failures get one more pass. Returns the
 * failures, or null.
 */
async function applyMariadbConfigLive(serviceId: string, managed: MariadbManagedConfig): Promise<string | null> {
  try {
    const pool = await getConnectedPool(serviceId);
    const flavor = await flavorOf(pool);
    let pending = managedPairs(managed, flavor);
    let failures: string[] = [];
    for (let pass = 0; pass < 2 && pending.length > 0; pass += 1) {
      const failed: Array<[ManagedVariable, string]> = [];
      failures = [];
      for (const [variable, value] of pending) {
        try {
          await pool.query({ sql: `SET GLOBAL ${variable.name} = ${variable.kind === 'bool' ? `'${value}'` : value}`, timeout: STATEMENT_TIMEOUT_SECS * 1000 });
        } catch (error) {
          failed.push([variable, value]);
          failures.push(`${variable.name}: ${(error as Error).message}`);
        }
      }
      pending = failed;
    }
    if (failures.length > 0) {
      logger.warn('MariaDB managed config live apply failed', { serviceId, failures });
      return failures.join('; ');
    }
    return null;
  } catch (error) {
    const message = (error as Error).message;
    logger.warn('MariaDB managed config live apply failed', { serviceId, error: message });
    return message;
  }
}

async function applyMariadbBaseToInstances(): Promise<string | null> {
  const failures: string[] = [];
  for (const service of await getEnabledFleetServices('mariadb')) {
    const error = await applyMariadbConfigLive(service.serviceId, await effectiveConfig(service.serviceId));
    if (error) failures.push(`${service.serviceId}: ${error}`);
  }
  return failures.length > 0 ? failures.join('; ') : null;
}

export interface MariadbConfigSaveResult extends MariadbConfigState {
  rendered: string;
  applyError: string | null;
}

export async function saveMariadbManagedConfig(serviceId: string, patch: Record<string, unknown>): Promise<MariadbConfigSaveResult> {
  const current = await getMariadbConfigState(serviceId);
  const changes = normalizeMariadbConfig({ ...current.managed, ...patch });
  const rendered = renderMariadbConfig(changes);

  // Stored before the live apply, so a failed apply never loses the intended state.
  await writeLayeredPayload(MARIADB_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE, changes);
  await upsertConfigStorePayload(MARIADB_CONFIG_STORE_TABLE, 'service_id', serviceId, RENDERED_PREVIEW_FILE, {
    content: rendered,
    managedBy: 'robin-admin',
  });

  const applyError = serviceId === DEFAULT_SCOPE_ID
    ? await applyMariadbBaseToInstances()
    : await applyMariadbConfigLive(serviceId, changes);
  return { ...(await getMariadbConfigState(serviceId)), rendered, applyError };
}

/**
 * Drop an instance's override so it inherits the base again. Variables the
 * override set keep their running value until the server restarts.
 */
export async function resetMariadbConfig(serviceId: string): Promise<MariadbConfigState & { applyError: string | null }> {
  if (serviceId === DEFAULT_SCOPE_ID) {
    throw new Error('The default base scope has no override to reset');
  }
  await deleteConfigStoreEntry(MARIADB_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE);
  await deleteConfigStoreEntry(MARIADB_CONFIG_STORE_TABLE, 'service_id', serviceId, RENDERED_PREVIEW_FILE);
  const state = await getMariadbConfigState(serviceId);
  return { ...state, applyError: await applyMariadbConfigLive(serviceId, state.managed) };
}

/** MariaDB has no config reload: re-apply the managed variables now. */
export async function reapplyMariadbConfig(serviceId: string): Promise<string> {
  const managed = await effectiveConfig(serviceId);
  if (managedPairs(managed).length === 0) return 'No managed variables to apply';
  const error = await applyMariadbConfigLive(serviceId, managed);
  if (error) throw new Error(error);
  return 'Managed variables applied';
}

function sameSetting(variable: ManagedVariable, live: string | undefined, wanted: string): boolean {
  if (live === undefined) return true; // the server doesn't have it (other flavor/version)
  if (variable.kind === 'bool') return ['ON', '1', 'TRUE'].includes(live.toUpperCase()) === (wanted === 'ON');
  if (variable.kind === 'enum') return live === wanted;
  return Math.abs(toNumber(live) - Number(wanted)) < 1e-6;
}

/** Managed variables whose running value differs from what is stored. Pure — no I/O. */
export function mariadbConfigDrift(managed: MariadbManagedConfig, variables: Record<string, string>): string[] {
  const flavor = flavorOfVersion(`${variables.version ?? ''} ${variables.version_comment ?? ''}`);
  return managedPairs(managed, flavor)
    .filter(([variable, value]) => !sameSetting(variable, variables[variable.name], value))
    .map(([variable]) => variable.name);
}

const DRIFT_RETRY_MS = 5 * 60 * 1000;
const lastDriftApply = new Map<string, number>();

/**
 * SET GLOBAL does not survive a restart (MariaDB has no SET PERSIST), so after
 * each snapshot compare the running variables with the stored config and
 * re-apply when they differ. A drift re-apply runs at most every few minutes
 * per instance, so a failing one (e.g. a missing privilege) or something else
 * setting the same variable is not fought on every poll. Saves are not limited.
 */
export async function enforceMariadbConfig(snapshot: MariadbLiveMetrics): Promise<void> {
  if (!snapshot.reachable || Object.keys(snapshot.variables).length === 0) return;
  if (Date.now() - (lastDriftApply.get(snapshot.serviceId) ?? 0) < DRIFT_RETRY_MS) return;
  try {
    const managed = await effectiveConfig(snapshot.serviceId);
    const drift = mariadbConfigDrift(managed, snapshot.variables);
    if (drift.length === 0) return;
    const service = await getFleetServiceById(snapshot.serviceId);
    if (!service || !isMariadbUrl(resolveMariadbDsn(service))) return;
    logger.info('Re-applying managed MariaDB variables', { serviceId: snapshot.serviceId, drift });
    lastDriftApply.set(snapshot.serviceId, Date.now());
    await applyMariadbConfigLive(snapshot.serviceId, managed);
  } catch (error) {
    logger.warn('MariaDB config drift check failed', { serviceId: snapshot.serviceId, error: (error as Error).message });
  }
}

export async function getMariadbStatus(serviceId: string) {
  const [config, metrics] = await Promise.all([
    getMariadbConfigState(serviceId),
    getMariadbLiveMetrics(serviceId).catch(() => null),
  ]);
  return {
    serviceId,
    serviceName: config.serviceName,
    reachable: metrics?.reachable ?? false,
    managed: config.managed,
    metrics,
  };
}

// ---------------------------------------------------------------------------
// Ops (observability + safe actions — no DROP/TRUNCATE/OPTIMIZE/arbitrary SQL)
// ---------------------------------------------------------------------------

function normalizeLimit(value: unknown, fallback: number, max: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 1 && n <= max ? n : fallback;
}

function assertValidThreadId(id: unknown): number {
  const n = typeof id === 'number' ? id : Number.parseInt(String(id ?? ''), 10);
  if (!Number.isSafeInteger(n) || n <= 0 || String(n) !== String(id).trim()) {
    throw new Error('Invalid MariaDB connection id');
  }
  return n;
}

// Allow hyphenated names; every validated name is backtick-quoted.
const IDENTIFIER_RE = /^[A-Za-z0-9_$-]{1,64}$/;

export function assertValidSchemaName(name: unknown): string {
  if (typeof name !== 'string' || !IDENTIFIER_RE.test(name.trim())) {
    throw new Error('Invalid schema name');
  }
  return name.trim();
}

/** `schema.table`; the schema is required (there is no default database). */
export function assertValidTableName(table: unknown): { schema: string; table: string } {
  if (typeof table !== 'string') throw new Error('Invalid table name');
  const parts = table.trim().split('.');
  if (parts.length !== 2 || parts.some((part) => !IDENTIFIER_RE.test(part))) {
    throw new Error('Invalid table name (use schema.table)');
  }
  return { schema: parts[0], table: parts[1] };
}

function quoteIdentifier(name: string): string {
  return `\`${name.replace(/`/g, '``')}\``;
}

export interface MariadbProcessRow {
  id: number;
  user: string | null;
  host: string | null;
  db: string | null;
  command: string | null;
  timeSecs: number;
  state: string | null;
  info: string | null;
}

export async function getMariadbProcesslist(serviceId: string, limit?: number): Promise<MariadbProcessRow[]> {
  const pool = await getConnectedPool(serviceId);
  const result = await rows(pool,
    `SELECT ID, USER, HOST, DB, COMMAND, TIME, STATE, LEFT(INFO, 2000) AS INFO
     FROM information_schema.PROCESSLIST
     WHERE ID <> CONNECTION_ID() AND COMMAND NOT IN ('Daemon', 'Binlog Dump')
     ORDER BY TIME DESC
     LIMIT ?`,
    [normalizeLimit(limit, 100, 1000)]);
  return result.map((row) => ({
    id: toNumber(row.ID),
    user: row.USER ?? null,
    host: row.HOST ?? null,
    db: row.DB ?? null,
    command: row.COMMAND ?? null,
    timeSecs: toNumber(row.TIME),
    state: row.STATE || null,
    info: row.INFO ?? null,
  }));
}

/** KILL QUERY (stop the statement) or KILL CONNECTION (end the session). */
export async function killMariadbConnection(serviceId: string, id: unknown, scope: 'query' | 'connection'): Promise<void> {
  const threadId = assertValidThreadId(id);
  const pool = await getConnectedPool(serviceId);
  await pool.query({ sql: `KILL ${scope === 'query' ? 'QUERY' : 'CONNECTION'} ${threadId}`, timeout: STATEMENT_TIMEOUT_SECS * 1000 });
}

export interface MariadbTransactionRow {
  trxId: string;
  state: string;
  startedAt: string;
  ageSecs: number;
  threadId: number;
  user: string | null;
  host: string | null;
  db: string | null;
  command: string | null;
  query: string | null;
  rowsLocked: number;
  tablesLocked: number;
  /** Connection ids holding the locks this transaction waits for. */
  blockedByThreadIds: number[];
}

export async function getMariadbTransactions(serviceId: string): Promise<MariadbTransactionRow[]> {
  const pool = await getConnectedPool(serviceId);
  const flavor = await flavorOf(pool);
  const [trxRows, waitRows] = await Promise.all([
    rows(pool,
      `SELECT t.trx_id, t.trx_state, t.trx_started, TIMESTAMPDIFF(SECOND, t.trx_started, NOW()) AS age_secs,
              t.trx_mysql_thread_id, LEFT(t.trx_query, 2000) AS trx_query, t.trx_rows_locked, t.trx_tables_locked,
              p.USER, p.HOST, p.DB, p.COMMAND
       FROM information_schema.INNODB_TRX t
       LEFT JOIN information_schema.PROCESSLIST p ON p.ID = t.trx_mysql_thread_id
       ORDER BY t.trx_started ASC
       LIMIT 200`),
    rows(pool, flavor === 'mariadb'
      ? 'SELECT requesting_trx_id, blocking_trx_id FROM information_schema.INNODB_LOCK_WAITS'
      : 'SELECT REQUESTING_ENGINE_TRANSACTION_ID AS requesting_trx_id, BLOCKING_ENGINE_TRANSACTION_ID AS blocking_trx_id FROM performance_schema.data_lock_waits'
    ).catch(() => [] as RowDataPacket[]),
  ]);
  const threadOf = new Map(trxRows.map((row) => [String(row.trx_id), toNumber(row.trx_mysql_thread_id)]));
  const blockers = new Map<string, Set<number>>();
  for (const wait of waitRows) {
    const blocker = threadOf.get(String(wait.blocking_trx_id));
    if (blocker === undefined) continue;
    const set = blockers.get(String(wait.requesting_trx_id)) ?? new Set<number>();
    set.add(blocker);
    blockers.set(String(wait.requesting_trx_id), set);
  }
  return trxRows.map((row) => ({
    trxId: String(row.trx_id),
    state: String(row.trx_state ?? ''),
    startedAt: String(row.trx_started ?? ''),
    ageSecs: toNumber(row.age_secs),
    threadId: toNumber(row.trx_mysql_thread_id),
    user: row.USER ?? null,
    host: row.HOST ?? null,
    db: row.DB ?? null,
    command: row.COMMAND ?? null,
    query: row.trx_query ?? null,
    rowsLocked: toNumber(row.trx_rows_locked),
    tablesLocked: toNumber(row.trx_tables_locked),
    blockedByThreadIds: Array.from(blockers.get(String(row.trx_id)) ?? []),
  }));
}

export interface MariadbSchemaRow {
  schema: string;
  tables: number;
  totalBytes: number;
  freeBytes: number;
}

export interface MariadbTableRow {
  schema: string;
  table: string;
  engine: string | null;
  rows: number;
  totalBytes: number;
  freeBytes: number;
}

export async function getMariadbSchemas(serviceId: string, limit?: number): Promise<MariadbSchemaRow[]> {
  const pool = await getConnectedPool(serviceId);
  const result = await rows(pool,
    `SELECT TABLE_SCHEMA AS schema_name, COUNT(*) AS tables, COALESCE(SUM(DATA_LENGTH + INDEX_LENGTH), 0) AS total_bytes,
            COALESCE(SUM(DATA_FREE), 0) AS free_bytes
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS_SQL})
     GROUP BY TABLE_SCHEMA
     ORDER BY total_bytes DESC
     LIMIT ?`,
    [normalizeLimit(limit, 200, 5000)]);
  return result.map((row) => ({
    schema: String(row.schema_name),
    tables: toNumber(row.tables),
    totalBytes: toNumber(row.total_bytes),
    freeBytes: toNumber(row.free_bytes),
  }));
}

export async function getMariadbTables(serviceId: string, options: { schema?: string; limit?: number } = {}): Promise<MariadbTableRow[]> {
  const pool = await getConnectedPool(serviceId);
  const schema = options.schema ? assertValidSchemaName(options.schema) : null;
  const result = await rows(pool,
    `SELECT TABLE_SCHEMA AS schema_name, TABLE_NAME AS table_name, ENGINE AS engine, TABLE_ROWS AS table_rows,
            DATA_LENGTH + INDEX_LENGTH AS total_bytes, DATA_FREE AS free_bytes
     FROM information_schema.TABLES
     WHERE TABLE_TYPE = 'BASE TABLE' AND ${schema ? 'TABLE_SCHEMA = ?' : `TABLE_SCHEMA NOT IN (${SYSTEM_SCHEMAS_SQL})`}
     ORDER BY total_bytes DESC
     LIMIT ?`,
    [...(schema ? [schema] : []), normalizeLimit(options.limit, 25, 500)]);
  return result.map((row) => ({
    schema: String(row.schema_name),
    table: String(row.table_name),
    engine: row.engine ?? null,
    rows: toNumber(row.table_rows),
    totalBytes: toNumber(row.total_bytes),
    freeBytes: toNumber(row.free_bytes),
  }));
}

/** ANALYZE TABLE refreshes index statistics; it reads, never rebuilds. */
export async function analyzeMariadbTable(serviceId: string, table: unknown): Promise<string> {
  const target = assertValidTableName(table);
  const quoted = `${quoteIdentifier(target.schema)}.${quoteIdentifier(target.table)}`;
  const result = await runAnalyze(serviceId, `ANALYZE TABLE ${quoted}`);
  const messages = result.map((row) => `${row.Msg_type ?? ''}: ${row.Msg_text ?? ''}`.trim()).filter(Boolean);
  return `ANALYZE TABLE ${quoted}: ${messages.join('; ') || 'done'}`;
}

export interface MariadbStatementRow {
  schema: string | null;
  digest: string;
  calls: number;
  totalMs: number;
  meanMs: number;
  rowsExamined: number;
}

export interface MariadbStatementsResult {
  available: boolean;
  rows: MariadbStatementRow[];
}

const PICOSECONDS_PER_MS = 1e9;

export async function getMariadbStatements(serviceId: string, limit?: number): Promise<MariadbStatementsResult> {
  const pool = await getConnectedPool(serviceId);
  try {
    const [enabled] = await rows(pool, 'SELECT @@performance_schema AS enabled');
    if (toNumber(enabled?.enabled) !== 1) return { available: false, rows: [] };
    const result = await rows(pool,
      `SELECT SCHEMA_NAME, LEFT(DIGEST_TEXT, 2000) AS digest, COUNT_STAR, SUM_TIMER_WAIT, AVG_TIMER_WAIT, SUM_ROWS_EXAMINED
       FROM performance_schema.events_statements_summary_by_digest
       WHERE DIGEST_TEXT IS NOT NULL
       ORDER BY SUM_TIMER_WAIT DESC
       LIMIT ?`,
      [normalizeLimit(limit, 20, 200)]);
    return {
      available: true,
      rows: result.map((row) => ({
        schema: row.SCHEMA_NAME ?? null,
        digest: String(row.digest ?? ''),
        calls: toNumber(row.COUNT_STAR),
        totalMs: toNumber(row.SUM_TIMER_WAIT) / PICOSECONDS_PER_MS,
        meanMs: toNumber(row.AVG_TIMER_WAIT) / PICOSECONDS_PER_MS,
        rowsExamined: toNumber(row.SUM_ROWS_EXAMINED),
      })),
    };
  } catch (error) {
    logger.warn('MariaDB statement digests unavailable', { serviceId, error: (error as Error).message });
    return { available: false, rows: [] };
  }
}

/** FLUSH STATUS: zero the status counters (24h deltas restart from the reset). */
export async function resetMariadbStats(serviceId: string): Promise<string> {
  const pool = await getConnectedPool(serviceId);
  await pool.query({ sql: 'FLUSH STATUS', timeout: STATEMENT_TIMEOUT_SECS * 1000 });
  return 'Status counters reset';
}
