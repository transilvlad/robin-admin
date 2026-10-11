import { beforeEach, describe, it, expect, vi } from 'vitest';

// `query`/`end` are defined on the PROTOTYPE (shared across every mocked pool
// instance), not as per-instance class fields — see redis.mode.test.ts for why.
const { PoolMock, poolInstances, ClientMock, clientInstances, getFleetServiceById, getEnabledFleetServices, getConfigStorePayload, upsertConfigStorePayload, deleteConfigStoreEntry } = vi.hoisted(() => {
  const instances: any[] = [];
  const clients: any[] = [];

  class PoolMockImpl {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      instances.push(this);
    }
  }

  const proto = PoolMockImpl.prototype as unknown as Record<string, unknown>;
  proto.query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  proto.end = vi.fn().mockResolvedValue(undefined);
  proto.on = vi.fn();

  // Dedicated Client used by runUnbounded() for VACUUM/ANALYZE — a short-lived
  // connection with statement_timeout: 0, outside the shared pool.
  class ClientMockImpl {
    opts: Record<string, unknown>;
    constructor(opts: Record<string, unknown>) {
      this.opts = opts;
      clients.push(this);
    }
  }
  const cproto = ClientMockImpl.prototype as unknown as Record<string, unknown>;
  cproto.connect = vi.fn().mockResolvedValue(undefined);
  cproto.query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  cproto.end = vi.fn().mockResolvedValue(undefined);

  return {
    PoolMock: PoolMockImpl,
    poolInstances: instances,
    ClientMock: ClientMockImpl,
    clientInstances: clients,
    getFleetServiceById: vi.fn(),
    getEnabledFleetServices: vi.fn(),
    getConfigStorePayload: vi.fn(),
    upsertConfigStorePayload: vi.fn(),
    deleteConfigStoreEntry: vi.fn(),
  };
});

vi.mock('pg', () => ({ default: { Pool: PoolMock, Client: ClientMock } }));

vi.mock('../db/queries/fleet-services.js', () => ({ getFleetServiceById, getEnabledFleetServices }));

vi.mock('../db/queries/config-store.js', () => ({
  POSTGRES_CONFIG_STORE_TABLE: 'postgres_config_store',
  getConfigStorePayload,
  upsertConfigStorePayload,
  deleteConfigStoreEntry,
}));

function resetPoolPrototypeDefaults() {
  PoolMock.prototype.query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  PoolMock.prototype.end = vi.fn().mockResolvedValue(undefined);
  PoolMock.prototype.on = vi.fn();
}

import {
  getPostgresConfigState,
  savePostgresManagedConfig,
  getPostgresConfigRendered,
  getPostgresRestartRequiredGucs,
  getPostgresLiveMetrics,
  getPostgresStatus,
  reloadPostgres,
  getPostgresActivity,
  cancelPostgresBackend,
  terminatePostgresBackend,
  getPostgresLocks,
  vacuumPostgres,
  analyzePostgres,
  getPostgresTableSizes,
  getPostgresStatStatements,
  resetPostgresStats,
  closePostgresPools,
} from './postgres.js';

function svc(overrides: Record<string, unknown> = {}) {
  return { id: 1, serviceId: 'pg1', serviceType: 'postgres', name: 'Postgres', metricsUrl: 'postgresql://pg-host/robin', ...overrides };
}

function instancesForConnString(connString: string) {
  return poolInstances.filter((i) => i.opts?.connectionString === connString);
}

function clientsForConnString(connString: string) {
  return clientInstances.filter((i) => i.opts?.connectionString === connString);
}

// Routes every core-metrics query by a distinguishing substring so a single
// mock implementation can serve `collectPostgresLiveMetrics`'s Promise.all +
// its three best-effort follow-ups.
function coreMetricsQueryImpl(overrides: Record<string, unknown> = {}) {
  const defaults: Record<string, unknown> = {
    'server_version_num': { rows: [{ server_version_num: '150004' }] },
    'FROM pg_stat_database': { rows: [{
      xact_commit: '1000', xact_rollback: '10', blks_hit: '9000', blks_read: '1000',
      tup_returned: '5000', tup_fetched: '4000', tup_inserted: '100', tup_updated: '50',
      tup_deleted: '5', deadlocks: '0', temp_files: '0', temp_bytes: '0', conflicts: '0',
    }] },
    'FROM pg_stat_activity': { rows: [{ state: 'active', wait_event_type: null, xact_start: null, state_change: null }] },
    'max_connections': { rows: [{ setting: '100' }] },
    'pg_database_size': { rows: [{ size: '123456' }] },
    'pg_stat_bgwriter': { rows: [{ checkpoints_timed: '10', checkpoints_req: '2', buffers_checkpoint: '500' }] },
    'pg_stat_replication': { rows: [{ lag: '0' }] },
    'pg_stat_user_tables': { rows: [{ dead: '42' }] },
  };
  const merged = { ...defaults, ...overrides };
  return vi.fn().mockImplementation((sql: string) => {
    for (const [needle, result] of Object.entries(merged)) {
      if (sql.includes(needle)) {
        // Support both plain result stand-ins and lazily-constructed rejections
        // (a rejection built eagerly, before anyone awaits it, would trip
        // Node's unhandledRejection warning).
        return typeof result === 'function' ? (result as () => Promise<unknown>)() : Promise.resolve(result);
      }
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
}

describe('getPostgresLiveMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPoolPrototypeDefaults();
    delete process.env.POSTGRES_ADMIN_DSN;
  });

  it('returns an unreachable snapshot for the reserved default scope without resolving a service', async () => {
    const out = await getPostgresLiveMetrics('default');
    expect(out.reachable).toBe(false);
    expect(getFleetServiceById).not.toHaveBeenCalled();
  });

  it('throws when the resolved service is missing or the wrong type', async () => {
    getFleetServiceById.mockResolvedValue(null);
    await expect(getPostgresLiveMetrics('pg1')).rejects.toThrow(/not found/);
    getFleetServiceById.mockResolvedValue(svc({ serviceType: 'redis' }));
    await expect(getPostgresLiveMetrics('pg1')).rejects.toThrow(/not found/);
  });

  it('returns unreachable (without connecting) when no admin DSN resolves', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: null }));
    const out = await getPostgresLiveMetrics('pg1');
    expect(out.reachable).toBe(false);
    expect(poolInstances).toHaveLength(0);
  });

  it('collects + derives ratios from pg_stat_database/activity, and caches one pool per DSN', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://cache-host/robin' }));
    PoolMock.prototype.query = coreMetricsQueryImpl();

    const out1 = await getPostgresLiveMetrics('pg1');
    expect(out1.reachable).toBe(true);
    expect(out1.serverVersionNum).toBe(150004);
    expect(out1.xactCommit).toBe(1000);
    expect(out1.commitRatio).toBeCloseTo(1000 / 1010);
    expect(out1.cacheHitRatio).toBeCloseTo(9000 / 10000);
    expect(out1.maxConnections).toBe(100);
    expect(out1.connectionSaturationPct).toBeCloseTo(1);
    expect(out1.databaseSizeBytes).toBe(123456);
    expect(out1.checkpointsTimed).toBe(10);
    expect(out1.deadTuplesTotal).toBe(42);

    await getPostgresLiveMetrics('pg1');
    expect(instancesForConnString('postgresql://cache-host/robin')).toHaveLength(1);
  });

  it('marks unreachable when the core metrics query throws', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://broken-host/robin' }));
    PoolMock.prototype.query = vi.fn().mockRejectedValue(new Error('connection refused'));
    const out = await getPostgresLiveMetrics('pg1');
    expect(out.reachable).toBe(false);
  });

  it('degrades gracefully (stays reachable) when bgwriter/replication/dead-tuple views are unavailable', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://degraded-host/robin' }));
    PoolMock.prototype.query = coreMetricsQueryImpl({
      'pg_stat_bgwriter': () => Promise.reject(new Error('relation "pg_stat_bgwriter" does not exist')),
      'pg_stat_replication': () => Promise.reject(new Error('permission denied')),
      'pg_stat_user_tables': () => Promise.reject(new Error('permission denied')),
    });
    const out = await getPostgresLiveMetrics('pg1');
    expect(out.reachable).toBe(true);
    expect(out.checkpointsTimed).toBe(0);
    expect(out.replicationLagBytes).toBe(0);
    expect(out.deadTuplesTotal).toBe(0);
  });
});

describe('config state + save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPoolPrototypeDefaults();
    delete process.env.POSTGRES_ADMIN_DSN;
    getConfigStorePayload.mockResolvedValue(null);
    upsertConfigStorePayload.mockResolvedValue(undefined);
  });

  it('returns default managed config when the store has no payload yet', async () => {
    getFleetServiceById.mockResolvedValue(svc());
    const state = await getPostgresConfigState('pg1');
    expect(state.managed.workMem).toBe('4MB');
    expect(state.serviceName).toBe('Postgres');
  });

  it('uses the reserved default scope name without a fleet lookup', async () => {
    const state = await getPostgresConfigState('default');
    expect(state.serviceName).toBe('Default (base)');
    expect(getFleetServiceById).not.toHaveBeenCalled();
  });

  it('persists managed.json + rendered preview, then applies ALTER SYSTEM SET + pg_reload_conf', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://apply-host/robin' }));
    const result = await savePostgresManagedConfig('pg1', { workMem: '32MB' });

    expect(result.applyError).toBeNull();
    expect(result.managed.workMem).toBe('32MB');
    expect(upsertConfigStorePayload).toHaveBeenCalledWith(
      'postgres_config_store', 'service_id', 'pg1', 'managed.json', expect.objectContaining({ workMem: '32MB' })
    );
    expect(upsertConfigStorePayload).toHaveBeenCalledWith(
      'postgres_config_store', 'service_id', 'pg1', 'rendered.sql', expect.objectContaining({ managedBy: 'robin-admin' })
    );
    const calls = instancesForConnString('postgresql://apply-host/robin')[0].query.mock.calls.map((c: unknown[]) => c[0]);
    expect(calls.some((sql: string) => sql.includes("ALTER SYSTEM SET work_mem = '32MB'"))).toBe(true);
    expect(calls.some((sql: string) => sql === 'SELECT pg_reload_conf()')).toBe(true);
  });

  it('still persists the store write when the live apply fails, surfacing applyError', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://apply-fail-host/robin' }));
    PoolMock.prototype.query = vi.fn().mockRejectedValue(new Error('permission denied for parameter'));

    const result = await savePostgresManagedConfig('pg1', { defaultStatisticsTarget: 250 });
    expect(result.applyError).toMatch(/permission denied/);
    expect(result.managed.defaultStatisticsTarget).toBe(250);
    expect(upsertConfigStorePayload).toHaveBeenCalledWith(
      'postgres_config_store', 'service_id', 'pg1', 'managed.json', expect.objectContaining({ defaultStatisticsTarget: 250 })
    );
  });

  it('applies a base save to every enabled instance', async () => {
    getEnabledFleetServices.mockResolvedValue([]);

    const result = await savePostgresManagedConfig('default', { workMem: '8MB' });

    expect(getEnabledFleetServices).toHaveBeenCalledWith('postgres');
    expect(result.applyError).toBeNull();
  });

  it('renders the current managed config on demand', async () => {
    getFleetServiceById.mockResolvedValue(svc());
    getConfigStorePayload.mockResolvedValue({ workMem: '64MB' });
    const rendered = await getPostgresConfigRendered('pg1');
    expect(rendered).toContain("ALTER SYSTEM SET work_mem = '64MB';");
  });

  it('surfaces restart-required GUCs with their pending_restart flag', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://restart-host/robin' }));
    PoolMock.prototype.query = vi.fn().mockResolvedValue({
      rows: [
        { name: 'shared_buffers', setting: '16384', unit: '8kB', pending_restart: false },
        { name: 'max_connections', setting: '100', unit: null, pending_restart: true },
      ],
    });
    const gucs = await getPostgresRestartRequiredGucs('pg1');
    expect(gucs).toHaveLength(2);
    expect(gucs.find((g) => g.name === 'max_connections')?.pendingRestart).toBe(true);
  });

  it('reports overall status combining config + reachability', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://status-host/robin' }));
    PoolMock.prototype.query = coreMetricsQueryImpl();
    const status = await getPostgresStatus('pg1');
    expect(status.reachable).toBe(true);
    expect(status.managed.workMem).toBe('4MB');
  });
});

describe('reloadPostgres', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPoolPrototypeDefaults();
    delete process.env.POSTGRES_ADMIN_DSN;
  });

  it('issues SELECT pg_reload_conf()', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://reload-host/robin' }));
    const out = await reloadPostgres('pg1');
    expect(out).toMatch(/reload/i);
    expect(instancesForConnString('postgresql://reload-host/robin')[0].query).toHaveBeenCalledWith('SELECT pg_reload_conf()');
  });

  it('throws when there is no admin DSN to reload', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: null }));
    await expect(reloadPostgres('pg1')).rejects.toThrow(/DSN/);
  });
});

describe('ops: activity / cancel / terminate / locks', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPoolPrototypeDefaults();
    delete process.env.POSTGRES_ADMIN_DSN;
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://ops-host/robin' }));
  });

  it('getPostgresActivity maps rows and computes query age', async () => {
    PoolMock.prototype.query = vi.fn().mockResolvedValue({
      rows: [{ pid: 123, usename: 'robin', state: 'active', wait_event_type: null, wait_event: null, query: 'SELECT 1', query_start: new Date(Date.now() - 5000) }],
    });
    const rows = await getPostgresActivity('pg1', 10);
    expect(rows).toHaveLength(1);
    expect(rows[0].pid).toBe(123);
    expect(rows[0].ageSecs).toBeGreaterThanOrEqual(4);
  });

  it('cancelPostgresBackend validates the pid before calling pg_cancel_backend', async () => {
    await expect(cancelPostgresBackend('pg1', -1)).rejects.toThrow(/Invalid Postgres backend pid/);
    await expect(cancelPostgresBackend('pg1', 0)).rejects.toThrow(/Invalid Postgres backend pid/);
    await expect(cancelPostgresBackend('pg1', 1.5)).rejects.toThrow(/Invalid Postgres backend pid/);

    PoolMock.prototype.query = vi.fn().mockResolvedValue({ rows: [{ pg_cancel_backend: true }] });
    const ok = await cancelPostgresBackend('pg1', 4242);
    expect(ok).toBe(true);
    expect(instancesForConnString('postgresql://ops-host/robin').at(-1)?.query)
      .toHaveBeenCalledWith('SELECT pg_cancel_backend($1) AS pg_cancel_backend', [4242]);
  });

  it('terminatePostgresBackend validates the pid before calling pg_terminate_backend', async () => {
    await expect(terminatePostgresBackend('pg1', Number.NaN)).rejects.toThrow(/Invalid Postgres backend pid/);
    PoolMock.prototype.query = vi.fn().mockResolvedValue({ rows: [{ pg_terminate_backend: true }] });
    const ok = await terminatePostgresBackend('pg1', 99);
    expect(ok).toBe(true);
  });

  it('getPostgresLocks returns blocking pids from the single joined query', async () => {
    // pg_blocking_pids(l.pid) is computed in the same statement as the lock scan
    // (no per-row round-trip), so the row already carries blocked_by.
    PoolMock.prototype.query = vi.fn().mockResolvedValue({
      rows: [{ pid: 1, relation: 'orders', mode: 'RowExclusiveLock', granted: false, blocked_by: [2, 3] }],
    });
    const locks = await getPostgresLocks('pg1');
    expect(locks).toEqual([{ pid: 1, relation: 'orders', mode: 'RowExclusiveLock', granted: false, blockedByPids: [2, 3] }]);
    // A single query, not 1 + N (one per lock row).
    expect(PoolMock.prototype.query).toHaveBeenCalledTimes(1);
  });
});

describe('ops: vacuum / analyze / table sizes / stat statements / reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetPoolPrototypeDefaults();
    delete process.env.POSTGRES_ADMIN_DSN;
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://vac-host/robin' }));
  });

  it('vacuumPostgres validates the table identifier and never emits a bare/unquoted user string', async () => {
    await expect(vacuumPostgres('pg1', { table: 'orders; DROP TABLE users; --' })).rejects.toThrow(/Invalid table name/);
    await expect(vacuumPostgres('pg1', { table: 'orders"; DROP TABLE users' })).rejects.toThrow(/Invalid table name/);

    await vacuumPostgres('pg1', { table: 'public.orders', analyze: true });
    const call = clientsForConnString('postgresql://vac-host/robin').at(-1)?.query.mock.calls.at(-1)?.[0];
    expect(call).toBe('VACUUM ANALYZE "public"."orders"');
  });

  it('vacuumPostgres without a table vacuums the whole database', async () => {
    await vacuumPostgres('pg1', {});
    const call = clientsForConnString('postgresql://vac-host/robin').at(-1)?.query.mock.calls.at(-1)?.[0];
    expect(call).toBe('VACUUM');
    // Long-running ops run on a dedicated connection with no statement timeout.
    expect(clientsForConnString('postgresql://vac-host/robin').at(-1)?.opts.statement_timeout).toBe(0);
  });

  it('analyzePostgres validates the table identifier the same way', async () => {
    await expect(analyzePostgres('pg1', { table: 'bad name' })).rejects.toThrow(/Invalid table name/);
    await analyzePostgres('pg1', { table: 'orders' });
    const call = clientsForConnString('postgresql://vac-host/robin').at(-1)?.query.mock.calls.at(-1)?.[0];
    expect(call).toBe('ANALYZE "orders"');
  });

  it('getPostgresTableSizes maps schema/table/bytes', async () => {
    PoolMock.prototype.query = vi.fn().mockResolvedValue({ rows: [{ schema: 'public', table: 'orders', total_bytes: '204800' }] });
    const sizes = await getPostgresTableSizes('pg1', 5);
    expect(sizes).toEqual([{ schema: 'public', table: 'orders', totalBytes: 204800 }]);
  });

  it('getPostgresStatStatements returns capability-unavailable (not a throw) when the extension is absent', async () => {
    PoolMock.prototype.query = vi.fn().mockResolvedValue({ rows: [], rowCount: 0 });
    const result = await getPostgresStatStatements('pg1');
    expect(result).toEqual({ available: false, rows: [] });
  });

  it('getPostgresStatStatements returns capability-unavailable when the extension check itself throws', async () => {
    PoolMock.prototype.query = vi.fn().mockRejectedValue(new Error('permission denied for view pg_extension'));
    const result = await getPostgresStatStatements('pg1');
    expect(result).toEqual({ available: false, rows: [] });
  });

  it('getPostgresStatStatements parses rows when the extension is present', async () => {
    PoolMock.prototype.query = vi.fn().mockImplementation((sql: string) => {
      if (sql.includes('pg_extension')) return Promise.resolve({ rows: [{ '?column?': 1 }], rowCount: 1 });
      if (sql.includes('pg_stat_statements')) {
        return Promise.resolve({ rows: [{ query: 'SELECT * FROM orders', calls: '10', total_exec_time: '500.5', mean_exec_time: '50.05' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    const result = await getPostgresStatStatements('pg1', 5);
    expect(result.available).toBe(true);
    expect(result.rows).toEqual([{ query: 'SELECT * FROM orders', calls: 10, totalExecMs: 500.5, meanExecMs: 50.05 }]);
  });

  it('resetPostgresStats calls pg_stat_reset()', async () => {
    await resetPostgresStats('pg1');
    expect(instancesForConnString('postgresql://vac-host/robin').at(-1)?.query).toHaveBeenCalledWith('SELECT pg_stat_reset()');
  });

  it('never exposes a DROP/TRUNCATE-style export', async () => {
    const pgModule = await import('./postgres.js');
    const exportNames = Object.keys(pgModule);
    expect(exportNames.some((n) => /drop|truncate/i.test(n))).toBe(false);
  });
});

describe('closePostgresPools', () => {
  it('ends every cached pool and clears the cache', async () => {
    vi.clearAllMocks();
    resetPoolPrototypeDefaults();
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'postgresql://close-host/robin' }));
    PoolMock.prototype.query = coreMetricsQueryImpl();
    await getPostgresLiveMetrics('pg1');
    const created = instancesForConnString('postgresql://close-host/robin');
    expect(created.length).toBeGreaterThan(0);

    await closePostgresPools();
    for (const instance of created) {
      expect(instance.end).toHaveBeenCalled();
    }

    // A subsequent call must construct a fresh pool (the cache was cleared).
    await getPostgresLiveMetrics('pg1');
    expect(instancesForConnString('postgresql://close-host/robin').length).toBe(created.length + 1);
  });
});
