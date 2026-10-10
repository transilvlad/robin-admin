/**
 * Real-server checks for the MariaDB service module. Runs against every DSN in
 * MARIADB_IT_DSNS (comma-separated, e.g. a MariaDB 10.11 and a MySQL 8.4), as
 * a user with admin rights (root in CI). robin-admin's own store is mocked.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import mysql from 'mysql2/promise';

const DSNS = (process.env.MARIADB_IT_DSNS ?? '').split(',').map((dsn) => dsn.trim()).filter(Boolean);

const { services, store } = vi.hoisted(() => ({
  services: new Map<string, { serviceId: string; serviceType: 'mariadb'; name: string; metricsUrl: string; enabled: boolean }>(),
  store: new Map<string, unknown>(),
}));

vi.mock('../db/queries/fleet-services.js', () => ({
  getFleetServiceById: async (id: string) => services.get(id) ?? null,
  getEnabledFleetServices: async () => Array.from(services.values()),
}));

vi.mock('../db/queries/config-store.js', () => {
  const key = (table: string, owner: string, file: string) => `${table}|${owner}|${file}`;
  return {
    MARIADB_CONFIG_STORE_TABLE: 'mariadb_config_store',
    getConfigStorePayload: async (table: string, _col: string, owner: string, file: string) => store.get(key(table, owner, file)) ?? null,
    upsertConfigStorePayload: async (table: string, _col: string, owner: string, file: string, payload: unknown) => {
      store.set(key(table, owner, file), payload);
    },
    deleteConfigStoreEntry: async (table: string, _col: string, owner: string, file: string) => {
      store.delete(key(table, owner, file));
    },
    listConfigStoreOwners: async () => ['default'],
  };
});

const mariadb = await import('./mariadb.js');

// Without DSNs one placeholder suite is reported as skipped.
const TARGETS = (DSNS.length > 0 ? DSNS : ['unset']).map((dsn, index) => ({ dsn, serviceId: `it-${index}` }));

describe.skipIf(DSNS.length === 0).each(TARGETS)('MariaDB against $dsn', ({ dsn, serviceId }) => {
  let admin: mysql.Connection;
  let original: Record<string, string> = {};

  beforeAll(async () => {
    services.set(serviceId, { serviceId, serviceType: 'mariadb', name: 'IT', metricsUrl: dsn, enabled: true });
    admin = await mysql.createConnection(mariadb.parseMariadbDsn(dsn));
    await admin.query('CREATE DATABASE IF NOT EXISTS app');
    await admin.query('CREATE DATABASE IF NOT EXISTS `app-tenant-1`');
    await admin.query('CREATE TABLE IF NOT EXISTS app.queued_messages (id INT PRIMARY KEY, attempts INT NOT NULL DEFAULT 0) ENGINE=InnoDB');
    await admin.query('INSERT IGNORE INTO app.queued_messages (id) VALUES (1), (2)');
    await admin.query('CREATE TABLE IF NOT EXISTS `app-tenant-1`.`raw-2026-10-02` (id INT PRIMARY KEY, data BLOB) ENGINE=InnoDB');
    const [rows] = await admin.query<mysql.RowDataPacket[]>("SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections', 'slow_query_log')");
    original = Object.fromEntries(rows.map((row) => [row.Variable_name, row.Value]));
  });

  afterAll(async () => {
    await admin.query(`SET GLOBAL max_connections = ${original.max_connections}`);
    await admin.query(`SET GLOBAL slow_query_log = '${original.slow_query_log}'`);
    await admin.query("SELECT 1").catch(() => undefined);
    await admin.end();
    services.delete(serviceId);
    await mariadb.closeMariadbPools();
  });

  it('collects a reachable snapshot, size included on the first collection', async () => {
    const snapshot = await mariadb.getMariadbLiveMetrics(serviceId);
    expect(snapshot.reachable).toBe(true);
    expect(snapshot.version).not.toBe('');
    expect(snapshot.uptimeSecs).toBeGreaterThan(0);
    expect(snapshot.threadsConnected).toBeGreaterThan(0);
    expect(snapshot.maxConnections).toBeGreaterThan(0);
    expect(snapshot.schemaCount).toBeGreaterThanOrEqual(2);
    expect(snapshot.databaseSizeBytes).toBeGreaterThan(0);
    expect(snapshot.bufferPoolHitRatio).toBeGreaterThan(0);
    expect(snapshot.rawStats).toMatch(/^##status\nVariable_name\tValue\n/);
    expect(snapshot.rawStats).toContain('##trx\nk\tv\ntrx_active\t');
    // The next collection skips the slow size query but carries the value.
    const next = await mariadb.getMariadbLiveMetrics(serviceId);
    expect(next.rawStats).not.toContain('##size');
    expect(next.databaseSizeBytes).toBe(snapshot.databaseSizeBytes);
  });

  it('applies managed variables live, detects drift, and re-applies', async () => {
    const saved = await mariadb.saveMariadbManagedConfig(serviceId, { maxConnections: 222, slowQueryLog: true });
    expect(saved.applyError).toBeNull();
    expect(saved.live.maxConnections).toBe('222');
    expect(saved.live.slowQueryLog).toBe('ON');
    expect(saved.rendered).toContain('max_connections = 222');

    // A restart reverts SET GLOBAL; simulate it.
    await admin.query('SET GLOBAL max_connections = 151');
    const drifted = await mariadb.getMariadbLiveMetrics(serviceId);
    expect(mariadb.mariadbConfigDrift(saved.managed, drifted.variables)).toEqual(['max_connections']);

    await expect(mariadb.reapplyMariadbConfig(serviceId)).resolves.toBe('Managed variables applied');
    const after = await mariadb.getMariadbLiveMetrics(serviceId);
    expect(after.variables.max_connections).toBe('222');

    const reset = await mariadb.resetMariadbConfig(serviceId);
    expect(reset.managed.maxConnections).toBeNull();
  });

  it('shows a stuck transaction and its blocker, and kills the blocker', async () => {
    const holder = await mysql.createConnection(mariadb.parseMariadbDsn(dsn));
    const waiter = await mysql.createConnection(mariadb.parseMariadbDsn(dsn));
    try {
      const [[{ id: holderId }]] = await holder.query<mysql.RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
      await holder.query('BEGIN');
      await holder.query('UPDATE app.queued_messages SET attempts = attempts + 1 WHERE id = 1');
      await waiter.query('SET SESSION innodb_lock_wait_timeout = 30');
      await waiter.query('BEGIN');
      const blocked = waiter.query('UPDATE app.queued_messages SET attempts = attempts + 1 WHERE id = 1').catch((error: Error) => error);

      let waiting: Awaited<ReturnType<typeof mariadb.getMariadbTransactions>>[number] | undefined;
      for (let attempt = 0; attempt < 50 && !waiting; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        waiting = (await mariadb.getMariadbTransactions(serviceId)).find((row) => row.state === 'LOCK WAIT');
      }
      expect(waiting?.blockedByThreadIds).toEqual([Number(holderId)]);

      const snapshot = await mariadb.getMariadbLiveMetrics(serviceId);
      expect(snapshot.trxActive).toBeGreaterThanOrEqual(2);
      expect(snapshot.trxLockWaits).toBeGreaterThanOrEqual(1);

      const processes = await mariadb.getMariadbProcesslist(serviceId);
      expect(processes.some((row) => row.id === Number(holderId))).toBe(true);

      await mariadb.killMariadbConnection(serviceId, holderId, 'connection');
      // The holder's rollback releases the row: the waiter's update goes through.
      const outcome = await blocked;
      expect(outcome).not.toBeInstanceOf(Error);
      await waiter.query('ROLLBACK');
    } finally {
      await holder.end().catch(() => undefined);
      await waiter.end().catch(() => undefined);
    }
  });

  it('lists hyphenated schemas and tables, and analyzes one', async () => {
    const schemas = await mariadb.getMariadbSchemas(serviceId);
    expect(schemas.map((row) => row.schema)).toEqual(expect.arrayContaining(['app', 'app-tenant-1']));
    const tables = await mariadb.getMariadbTables(serviceId, { schema: 'app-tenant-1' });
    expect(tables.map((row) => row.table)).toContain('raw-2026-10-02');
    await expect(mariadb.analyzeMariadbTable(serviceId, 'app-tenant-1.raw-2026-10-02')).resolves.toMatch(/status: OK/i);
  });

  it('reports statement digests only when performance_schema is on', async () => {
    const [[{ enabled }]] = await admin.query<mysql.RowDataPacket[]>('SELECT @@performance_schema AS enabled');
    const result = await mariadb.getMariadbStatements(serviceId);
    expect(result.available).toBe(Number(enabled) === 1);
  });

  it('resets the status counters', async () => {
    await expect(mariadb.resetMariadbStats(serviceId)).resolves.toBe('Status counters reset');
  });

  it('kills a running query without ending its session', async () => {
    const sleeper = await mysql.createConnection(mariadb.parseMariadbDsn(dsn));
    try {
      const [[{ id }]] = await sleeper.query<mysql.RowDataPacket[]>('SELECT CONNECTION_ID() AS id');
      // Handle the interruption at once: the kill can reject this before it is awaited.
      const sleeping = sleeper.query('SELECT SLEEP(20)').catch(() => undefined);
      await new Promise((resolve) => setTimeout(resolve, 300));
      await mariadb.killMariadbConnection(serviceId, id, 'query');
      await sleeping;
      const [[{ alive }]] = await sleeper.query<mysql.RowDataPacket[]>('SELECT 1 AS alive');
      expect(Number(alive)).toBe(1);
    } finally {
      await sleeper.end().catch(() => undefined);
    }
  }, 30000);
});
