import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  assertValidSchemaName,
  assertValidTableName,
  buildMariadbSnapshotFromRaw,
  buildMariadbSnapshotSql,
  carryMariadbSize,
  emptyMariadbMetrics,
  flavorOfVersion,
  isMariadbUrl,
  mariadbConfigDrift,
  normalizeMariadbConfig,
  parseMariadbDsn,
  parseMariadbSections,
  renderMariadbConfig,
  resolveMariadbDsn,
} from './mariadb.js';

// The shape `mariadb -B --force` prints for the snapshot batch: each marker
// SELECT prints its header and row, every result set its header line.
const RAW = [
  '##status', '##status',
  'Variable_name\tValue',
  'Uptime\t3600',
  'Threads_connected\t35',
  'Threads_running\t3',
  'Threads_cached\t5',
  'Max_used_connections\t60',
  'Aborted_connects\t2',
  'Questions\t100000',
  'Com_commit\t900',
  'Com_rollback\t10',
  'Slow_queries\t4',
  'Innodb_buffer_pool_read_requests\t10000',
  'Innodb_buffer_pool_reads\t100',
  'Innodb_row_lock_waits\t7',
  'Innodb_deadlocks\t1',
  'Innodb_history_list_length\t42',
  '##variables', '##variables',
  'Variable_name\tValue',
  'version\t10.11.9-MariaDB-ubu2204',
  'version_comment\tmariadb.org binary distribution',
  'max_connections\t350',
  'slow_query_log\tOFF',
  'long_query_time\t10.000000',
  'innodb_buffer_pool_size\t134217728',
  '##trx', '##trx',
  'k\tv',
  'trx_active\t2',
  'oldest_trx_age_secs\t900',
  'trx_lock_waits\t1',
  'schema_count\t21',
  'lock_deadlocks\t0',
  '##replica', '##replica',
  '##size', '##size',
  'k\tv',
  'database_size_bytes\t52428800',
].join('\n');

describe('MariaDB DSNs', () => {
  it('accepts mysql:// and mariadb:// only', () => {
    expect(isMariadbUrl('mysql://u:p@db:3306/app')).toBe(true);
    expect(isMariadbUrl('MariaDB://db')).toBe(true);
    expect(isMariadbUrl('postgresql://db')).toBe(false);
    expect(isMariadbUrl(null)).toBe(false);
  });

  it('prefers the service DSN and falls back to MARIADB_ADMIN_DSN', () => {
    process.env.MARIADB_ADMIN_DSN = 'mysql://env-host/db';
    try {
      expect(resolveMariadbDsn({ metricsUrl: 'mysql://own/db' })).toBe('mysql://own/db');
      expect(resolveMariadbDsn({ metricsUrl: null })).toBe('mysql://env-host/db');
    } finally {
      delete process.env.MARIADB_ADMIN_DSN;
    }
    expect(resolveMariadbDsn({ metricsUrl: '  ' })).toBeNull();
  });

  it('parses credentials, socket and TLS options', () => {
    expect(parseMariadbDsn('mariadb://robin%40x:p%3Ass@db.example:3307/app?ssl=true')).toMatchObject({
      user: 'robin@x', password: 'p:ss', host: 'db.example', port: 3307, database: 'app', ssl: { verifyIdentity: true },
    });
    const socket = parseMariadbDsn('mysql://monitor@localhost/?socket=/run/mysqld/mysqld.sock&ssl=skip-verify');
    expect(socket).toMatchObject({ socketPath: '/run/mysqld/mysqld.sock', ssl: { rejectUnauthorized: false } });
    expect(socket.host).toBeUndefined();
    expect(socket.database).toBeUndefined();
    expect(() => parseMariadbDsn('mysql://db/?ssl=typo')).toThrow(/TLS mode/);
    expect(() => parseMariadbDsn('mysql://db/?password=hidden')).toThrow(/unsupported options/);
  });

  it('tells MariaDB from MySQL by its version string', () => {
    expect(flavorOfVersion('10.11.9-MariaDB-ubu2204')).toBe('mariadb');
    expect(flavorOfVersion('8.4.2')).toBe('mysql');
  });
});

describe('MariaDB snapshot', () => {
  it('marks each section and adds the size section only when due', () => {
    const withSize = buildMariadbSnapshotSql(true);
    expect(withSize).toContain("SELECT '##status';\nSHOW GLOBAL STATUS;");
    expect(withSize).toContain("SELECT '##size';");
    expect(buildMariadbSnapshotSql(false)).not.toContain('##size');
    expect(withSize.startsWith('/*M!100100 SET SESSION max_statement_time')).toBe(true);
  });

  it('matches the batch the agent runs, byte for byte', () => {
    const agentSource = readFileSync(fileURLToPath(new URL('../../../agent/mariadb.go', import.meta.url)), 'utf8');
    const goConst = (name: string) => new RegExp(`const ${name} = \`([^\`]*)\``).exec(agentSource)?.[1];
    expect(goConst('mariadbSnapshotSQL')).toBe(buildMariadbSnapshotSql(false));
    expect(`${goConst('mariadbSnapshotSQL')}${goConst('mariadbSizeSQL')}`).toBe(buildMariadbSnapshotSql(true));
  });

  it('splits sections, skipping marker repeats and header lines', () => {
    const parsed = parseMariadbSections(RAW);
    expect(parsed.kv.status.threads_connected).toBe('35');
    expect(parsed.kv.status.variable_name).toBeUndefined();
    expect(parsed.kv.trx.k).toBeUndefined();
    expect(parsed.kv.size.database_size_bytes).toBe('52428800');
    expect(parsed.replica).toEqual([]);
  });

  it('maps the batch into a snapshot', () => {
    const snapshot = buildMariadbSnapshotFromRaw('app-db', RAW);
    expect(snapshot).toMatchObject({
      serviceId: 'app-db',
      serviceType: 'mariadb',
      reachable: true,
      version: '10.11.9-MariaDB-ubu2204',
      uptimeSecs: 3600,
      threadsConnected: 35,
      maxConnections: 350,
      connectionSaturationPct: 10,
      questions: 100000,
      bufferPoolHitRatio: 0.99,
      deadlocks: 1,
      historyListLength: 42,
      trxActive: 2,
      oldestTrxAgeSecs: 900,
      trxLockWaits: 1,
      schemaCount: 21,
      databaseSizeBytes: 52428800,
      isReplica: false,
      secondsBehindSource: null,
    });
    expect(snapshot.variables.max_connections).toBe('350');
  });

  it('reads replication from either column naming, worst channel wins', () => {
    const replica = [
      '##status', 'Variable_name\tValue', 'Uptime\t1',
      '##replica',
      'Connection_name\tSlave_IO_Running\tSlave_SQL_Running\tSeconds_Behind_Master',
      'a\tYes\tYes\t3',
      'b\tYes\tYes\t40',
    ].join('\n');
    expect(buildMariadbSnapshotFromRaw('r', replica)).toMatchObject({
      isReplica: true, replicaIoRunning: true, replicaSqlRunning: true, secondsBehindSource: 40,
    });
    const stopped = [
      '##status', 'Variable_name\tValue', 'Uptime\t1',
      '##replica', 'Replica_IO_Running\tReplica_SQL_Running\tSeconds_Behind_Source', 'Yes\tNo\tNULL',
    ].join('\n');
    expect(buildMariadbSnapshotFromRaw('r', stopped)).toMatchObject({
      isReplica: true, replicaSqlRunning: false, secondsBehindSource: null,
    });
  });

  it('is unreachable without a status section, and MySQL counters come from INNODB_METRICS', () => {
    expect(buildMariadbSnapshotFromRaw('x', '# The statistics query failed').reachable).toBe(false);
    const mysql = ['##status', 'Variable_name\tValue', 'Uptime\t5', '##trx', 'k\tv', 'lock_deadlocks\t3', 'trx_rseg_history_len\t9'].join('\n');
    expect(buildMariadbSnapshotFromRaw('x', mysql)).toMatchObject({ deadlocks: 3, historyListLength: 9, bufferPoolHitRatio: 1 });
  });

  it('carries the last known size into a snapshot that skipped it', () => {
    const fresh = buildMariadbSnapshotFromRaw('carry-1', RAW);
    expect(carryMariadbSize(fresh).databaseSizeBytes).toBe(52428800);
    const skipped = emptyMariadbMetrics('carry-1');
    expect(carryMariadbSize(skipped).databaseSizeBytes).toBe(52428800);
    expect(carryMariadbSize(emptyMariadbMetrics('carry-2'), 77).databaseSizeBytes).toBe(77);
    expect(carryMariadbSize(emptyMariadbMetrics('carry-3')).databaseSizeBytes).toBeNull();
  });
});

describe('MariaDB managed config', () => {
  it('keeps only what was set, and validates it', () => {
    const managed = normalizeMariadbConfig({ maxConnections: '350', slowQueryLog: 'ON', longQueryTime: 2.5, waitTimeout: '' });
    expect(managed.maxConnections).toBe(350);
    expect(managed.slowQueryLog).toBe(true);
    expect(managed.longQueryTime).toBe(2.5);
    expect(managed.waitTimeout).toBeNull();
    expect(() => normalizeMariadbConfig({ bogus: 1 })).toThrow(/unsupported settings/);
    expect(() => normalizeMariadbConfig([])).toThrow(/object/);
    expect(() => normalizeMariadbConfig({ maxConnections: 5 })).toThrow(/max_connections/);
    expect(() => normalizeMariadbConfig({ maxConnections: 10.5 })).toThrow(/integer/);
    expect(() => normalizeMariadbConfig({ innodbFlushLogAtTrxCommit: '3' })).toThrow(/one of/);
    expect(() => normalizeMariadbConfig({ slowQueryLog: 'maybe' })).toThrow(/ON or OFF/);
  });

  it('renders only the managed variables', () => {
    expect(renderMariadbConfig(normalizeMariadbConfig({}))).toContain('No variables are managed');
    const rendered = renderMariadbConfig(normalizeMariadbConfig({ maxConnections: 350, slowQueryLog: false }));
    expect(rendered).toContain('SET GLOBAL max_connections = 350;');
    expect(rendered).toContain("SET GLOBAL slow_query_log = 'OFF';");
    expect(rendered).not.toContain('wait_timeout');
  });

  it('detects drift per flavor, normalizing booleans and numbers', () => {
    const managed = normalizeMariadbConfig({ maxConnections: 350, slowQueryLog: true, longQueryTime: 10, maxExecutionTime: 5000 });
    const variables = { version: '10.11.9-MariaDB', max_connections: '350', slow_query_log: 'ON', long_query_time: '10.000000' };
    // max_execution_time is MySQL-only: not drift on MariaDB.
    expect(mariadbConfigDrift(managed, variables)).toEqual([]);
    expect(mariadbConfigDrift(managed, { ...variables, max_connections: '151', slow_query_log: 'OFF' })).toEqual(['max_connections', 'slow_query_log']);
    expect(mariadbConfigDrift(managed, { version: '8.4.2', max_connections: '350', slow_query_log: '1', long_query_time: '10', max_execution_time: '0' }))
      .toEqual(['max_execution_time']);
  });
});

describe('MariaDB identifiers', () => {
  it('allows hyphenated names and requires schema.table', () => {
    expect(assertValidTableName('app-tenant-12.raw-2026-10-02')).toEqual({ schema: 'app-tenant-12', table: 'raw-2026-10-02' });
    expect(assertValidSchemaName('app-tenant-3')).toBe('app-tenant-3');
    expect(() => assertValidTableName('orders')).toThrow(/schema\.table/);
    expect(() => assertValidTableName('a.b; DROP TABLE x')).toThrow();
    expect(() => assertValidTableName('a.`b`')).toThrow();
    expect(() => assertValidSchemaName("x' OR 1")).toThrow();
  });
});
