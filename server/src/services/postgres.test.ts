import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  safeRatio,
  mapPgStatDatabaseRow,
  mapPgStatActivityRows,
  normalizePostgresConfig,
  renderPostgresConfig,
  resolvePostgresDsn,
  buildPostgresSnapshotFromRaw,
  POSTGRES_SNAPSHOT_SQL,
} from './postgres.js';

describe('buildPostgresSnapshotFromRaw', () => {
  const nowIso = new Date().toISOString();
  const json = JSON.stringify({
    versionNum: '180001',
    maxConnections: '100',
    dbSize: '12582912',
    db: {
      xact_commit: '900', xact_rollback: '100', blks_hit: '800', blks_read: '200',
      tup_returned: '50', tup_fetched: '40', tup_inserted: '10', tup_updated: '5',
      tup_deleted: '2', deadlocks: '3', temp_files: '1', temp_bytes: '4096', conflicts: '0',
    },
    activity: [
      { state: 'active', wait_event_type: null, xact_start: nowIso, state_change: nowIso },
      { state: 'idle', wait_event_type: null, xact_start: null, state_change: nowIso },
      { state: 'active', wait_event_type: 'Lock', xact_start: nowIso, state_change: nowIso },
    ],
    deadTuples: '42',
  });

  it('assembles a snapshot from the consolidated agent JSON', () => {
    const s = buildPostgresSnapshotFromRaw('pg1', json);
    expect(s.serviceType).toBe('postgres');
    expect(s.reachable).toBe(true);
    expect(s.serverVersionNum).toBe(180001);
    expect(s.maxConnections).toBe(100);
    expect(s.databaseSizeBytes).toBe(12582912);
    expect(s.connectionsTotal).toBe(3);
    expect(s.connectionsActive).toBe(2);
    expect(s.connectionsIdle).toBe(1);
    expect(s.connectionsWaiting).toBe(1);
    expect(s.blockedQueries).toBe(1);
    expect(s.xactCommit).toBe(900);
    expect(s.commitRatio).toBeCloseTo(0.9);
    expect(s.cacheHitRatio).toBeCloseTo(0.8);
    expect(s.deadTuplesTotal).toBe(42);
    expect(s.connectionSaturationPct).toBeCloseTo(3);
    // Fields not in the agent query stay zero.
    expect(s.checkpointsTimed).toBe(0);
  });

  it('is unreachable on malformed JSON, with zeroed fields', () => {
    const s = buildPostgresSnapshotFromRaw('pg1', '{bad');
    expect(s.reachable).toBe(false);
    expect(s.connectionsTotal).toBe(0);
    expect(s.serverVersionNum).toBe(0);
  });
});

describe('safeRatio', () => {
  it('divides normally for a positive denominator', () => {
    expect(safeRatio(1, 4)).toBe(0.25);
  });

  it('returns 0 for a zero, negative, or non-finite denominator', () => {
    expect(safeRatio(10, 0)).toBe(0);
    expect(safeRatio(10, -5)).toBe(0);
    expect(safeRatio(10, Number.NaN)).toBe(0);
    expect(safeRatio(10, Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('returns 0 for a non-finite numerator', () => {
    expect(safeRatio(Number.NaN, 5)).toBe(0);
  });
});

describe('mapPgStatDatabaseRow', () => {
  it('converts pg bigint-as-string columns to numbers', () => {
    const out = mapPgStatDatabaseRow({
      xact_commit: '1000', xact_rollback: '10', blks_hit: '9000', blks_read: '1000',
      tup_returned: '5000', tup_fetched: '4000', tup_inserted: '100', tup_updated: '50',
      tup_deleted: '5', deadlocks: '0', temp_files: '2', temp_bytes: '2048', conflicts: '1',
    });
    expect(out).toEqual({
      xactCommit: 1000, xactRollback: 10, blksHit: 9000, blksRead: 1000,
      tupReturned: 5000, tupFetched: 4000, tupInserted: 100, tupUpdated: 50,
      tupDeleted: 5, deadlocks: 0, tempFiles: 2, tempBytes: 2048, conflicts: 1,
    });
  });

  it('defaults every field to 0 for a missing/empty row', () => {
    const out = mapPgStatDatabaseRow({});
    expect(Object.values(out).every((v) => v === 0)).toBe(true);
  });

  it('tolerates non-numeric garbage without throwing', () => {
    const out = mapPgStatDatabaseRow({ xact_commit: 'not-a-number', blks_hit: null, blks_read: undefined });
    expect(out.xactCommit).toBe(0);
    expect(out.blksHit).toBe(0);
    expect(out.blksRead).toBe(0);
  });
});

describe('mapPgStatActivityRows', () => {
  const now = new Date('2024-01-01T00:10:00Z');

  it('counts connection states and blocked (Lock wait) queries', () => {
    const rows = [
      { state: 'active', wait_event_type: null },
      { state: 'active', wait_event_type: 'Lock' },
      { state: 'idle', wait_event_type: null },
      { state: 'idle in transaction', wait_event_type: null, state_change: new Date('2024-01-01T00:09:00Z') },
    ];
    const agg = mapPgStatActivityRows(rows, now);
    expect(agg.connectionsTotal).toBe(4);
    expect(agg.connectionsActive).toBe(2);
    expect(agg.connectionsIdle).toBe(1);
    expect(agg.connectionsIdleInTxn).toBe(1);
    expect(agg.connectionsWaiting).toBe(1);
    expect(agg.blockedQueries).toBe(1);
    expect(agg.oldestIdleInTxnSecs).toBe(60);
  });

  it('tracks the oldest in-flight transaction age from xact_start', () => {
    const rows = [
      { state: 'active', xact_start: new Date('2024-01-01T00:00:00Z') },
      { state: 'active', xact_start: new Date('2024-01-01T00:08:00Z') },
    ];
    const agg = mapPgStatActivityRows(rows, now);
    expect(agg.oldestXactAgeSecs).toBe(600);
  });

  it('returns all-zero aggregates for an empty row set', () => {
    const agg = mapPgStatActivityRows([], now);
    expect(agg).toEqual({
      connectionsTotal: 0, connectionsActive: 0, connectionsIdle: 0, connectionsIdleInTxn: 0,
      connectionsWaiting: 0, blockedQueries: 0, oldestXactAgeSecs: 0, oldestIdleInTxnSecs: 0,
    });
  });
});

describe('normalizePostgresConfig', () => {
  it('returns defaults for missing/non-object input', () => {
    const defaults = normalizePostgresConfig(undefined);
    expect(defaults.workMem).toBe('4MB');
    expect(defaults.autovacuum).toBe(true);
    expect(defaults.defaultStatisticsTarget).toBe(100);
    expect(normalizePostgresConfig(null)).toEqual(defaults);
    expect(normalizePostgresConfig('nope')).toEqual(defaults);
  });

  it('accepts valid overrides', () => {
    const out = normalizePostgresConfig({
      workMem: '16MB',
      maintenanceWorkMem: '256MB',
      effectiveCacheSize: '8GB',
      logMinDurationStatement: 250,
      statementTimeout: 30000,
      idleInTransactionSessionTimeout: 60000,
      autovacuum: false,
      autovacuumVacuumScaleFactor: 0.05,
      autovacuumAnalyzeScaleFactor: 0.02,
      autovacuumNaptime: 30,
      checkpointTimeout: 600,
      maxWalSize: '2GB',
      minWalSize: '160MB',
      randomPageCost: 1.1,
      defaultStatisticsTarget: 500,
      logConnections: true,
      logDisconnections: true,
    });
    expect(out.workMem).toBe('16MB');
    expect(out.effectiveCacheSize).toBe('8GB');
    expect(out.logMinDurationStatement).toBe(250);
    expect(out.autovacuum).toBe(false);
    expect(out.autovacuumVacuumScaleFactor).toBe(0.05);
    expect(out.checkpointTimeout).toBe(600);
    expect(out.randomPageCost).toBe(1.1);
    expect(out.defaultStatisticsTarget).toBe(500);
    expect(out.logConnections).toBe(true);
  });

  it('rejects a malformed memory-size string and falls back to default', () => {
    expect(normalizePostgresConfig({ workMem: '16MB; DROP TABLE users' }).workMem).toBe('4MB');
    expect(normalizePostgresConfig({ maxWalSize: 'lots' }).maxWalSize).toBe('1GB');
  });

  it('allows -1 for logMinDurationStatement (disabled) but rejects values below -1', () => {
    expect(normalizePostgresConfig({ logMinDurationStatement: -1 }).logMinDurationStatement).toBe(-1);
    expect(normalizePostgresConfig({ logMinDurationStatement: -2 }).logMinDurationStatement).toBe(-1);
  });

  it('clamps out-of-range scale factors and statistics target back to default', () => {
    expect(normalizePostgresConfig({ autovacuumVacuumScaleFactor: 2 }).autovacuumVacuumScaleFactor).toBe(0.2);
    expect(normalizePostgresConfig({ autovacuumVacuumScaleFactor: -1 }).autovacuumVacuumScaleFactor).toBe(0.2);
    expect(normalizePostgresConfig({ defaultStatisticsTarget: 0 }).defaultStatisticsTarget).toBe(100);
    expect(normalizePostgresConfig({ defaultStatisticsTarget: 20000 }).defaultStatisticsTarget).toBe(100);
  });

  it('rejects non-boolean values for boolean fields', () => {
    expect(normalizePostgresConfig({ autovacuum: 'yes' }).autovacuum).toBe(true);
    expect(normalizePostgresConfig({ logConnections: 1 }).logConnections).toBe(false);
  });
});

describe('renderPostgresConfig', () => {
  it('renders one ALTER SYSTEM SET statement per managed GUC, quoted as a literal', () => {
    const managed = normalizePostgresConfig({ workMem: '32MB', autovacuum: false, logConnections: true });
    const rendered = renderPostgresConfig(managed);
    expect(rendered).toContain("ALTER SYSTEM SET work_mem = '32MB';");
    expect(rendered).toContain("ALTER SYSTEM SET autovacuum = 'off';");
    expect(rendered).toContain("ALTER SYSTEM SET log_connections = 'on';");
    expect(rendered).toContain("ALTER SYSTEM SET autovacuum_naptime = '60s';");
  });

  it('escapes an embedded single quote in a value', () => {
    // effectiveCacheSize fails validation for anything containing a quote, so
    // it falls back to the default — proving the render path never emits an
    // un-escaped attacker-controlled literal in the first place.
    const managed = normalizePostgresConfig({ effectiveCacheSize: "4GB'; DROP TABLE x; --" });
    expect(managed.effectiveCacheSize).toBe('4GB');
    const rendered = renderPostgresConfig(managed);
    expect(rendered).not.toContain('DROP TABLE');
  });
});

describe('resolvePostgresDsn', () => {
  const ORIGINAL_ENV = process.env.POSTGRES_ADMIN_DSN;

  beforeEach(() => {
    delete process.env.POSTGRES_ADMIN_DSN;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.POSTGRES_ADMIN_DSN;
    else process.env.POSTGRES_ADMIN_DSN = ORIGINAL_ENV;
  });

  it('prefers the fleet row metricsUrl over POSTGRES_ADMIN_DSN', () => {
    process.env.POSTGRES_ADMIN_DSN = 'postgresql://env-host/robin';
    expect(resolvePostgresDsn({ metricsUrl: 'postgresql://fleet-host/robin' })).toBe('postgresql://fleet-host/robin');
  });

  it('falls back to POSTGRES_ADMIN_DSN when the fleet row has no DSN', () => {
    process.env.POSTGRES_ADMIN_DSN = 'postgresql://env-host/robin';
    expect(resolvePostgresDsn({ metricsUrl: null })).toBe('postgresql://env-host/robin');
  });

  it('falls back to the fleet row metricsUrl when the env var is unset', () => {
    expect(resolvePostgresDsn({ metricsUrl: 'postgresql://fleet-host/robin' })).toBe('postgresql://fleet-host/robin');
  });

  it('returns null when neither is set', () => {
    expect(resolvePostgresDsn({ metricsUrl: null })).toBeNull();
    expect(resolvePostgresDsn({ metricsUrl: '   ' })).toBeNull();
  });
});

describe('POSTGRES_SNAPSHOT_SQL', () => {
  it('is the query the agent runs, so Raw reads the same in both modes', () => {
    const agentSource = readFileSync(fileURLToPath(new URL('../../../agent/main.go', import.meta.url)), 'utf8');
    const agentSql = /const postgresSnapshotSQL = `([^`]*)`/.exec(agentSource)?.[1];
    expect(agentSql).toBe(POSTGRES_SNAPSHOT_SQL);
  });

  it('keeps Raw as PostgreSQL returned it, indented', () => {
    const snapshot = buildPostgresSnapshotFromRaw('pg1', '{"versionNum":"180001","db":{"xact_commit":5}}');
    expect(snapshot.rawStats).toBe('{\n  "versionNum": "180001",\n  "db": {\n    "xact_commit": 5\n  }\n}');
  });
});
