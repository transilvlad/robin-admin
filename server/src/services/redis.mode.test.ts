import { beforeEach, describe, it, expect, vi } from 'vitest';

// `info`/`config`/etc. are defined on the PROTOTYPE (shared across every
// mocked client instance), not as per-instance class fields — this lets a
// test reassign e.g. `RedisMock.prototype.info` right before invoking the
// function under test, even though the instance itself is constructed deep
// inside the module under test (so the test never gets a handle on it before
// construction).
const { RedisMock, redisInstances, getFleetServiceById, getEnabledFleetServices, getConfigStorePayload, upsertConfigStorePayload, deleteConfigStoreEntry } = vi.hoisted(() => {
  const instances: any[] = [];

  class RedisMockImpl {
    dsn: string;
    opts: unknown;
    constructor(dsn: string, opts: unknown) {
      this.dsn = dsn;
      this.opts = opts;
      instances.push(this);
    }
  }

  const proto = RedisMockImpl.prototype as unknown as Record<string, unknown>;
  proto.info = vi.fn().mockResolvedValue('');
  proto.dbsize = vi.fn().mockResolvedValue(0);
  proto.config = vi.fn().mockResolvedValue('OK');
  proto.quit = vi.fn().mockResolvedValue('OK');
  proto.disconnect = vi.fn();
  proto.on = vi.fn();
  proto.slowlog = vi.fn().mockResolvedValue([]);
  proto.client = vi.fn().mockResolvedValue('');
  proto.bgsave = vi.fn().mockResolvedValue('Background saving started');
  proto.bgrewriteaof = vi.fn().mockResolvedValue('Background append only file rewriting started');
  proto.latency = vi.fn().mockResolvedValue([]);

  return {
    RedisMock: RedisMockImpl,
    redisInstances: instances,
    getFleetServiceById: vi.fn(),
    getEnabledFleetServices: vi.fn(),
    getConfigStorePayload: vi.fn(),
    upsertConfigStorePayload: vi.fn(),
    deleteConfigStoreEntry: vi.fn(),
  };
});

vi.mock('ioredis', () => ({ default: RedisMock }));

vi.mock('../db/queries/fleet-services.js', () => ({ getFleetServiceById, getEnabledFleetServices }));

vi.mock('../db/queries/config-store.js', () => ({
  REDIS_CONFIG_STORE_TABLE: 'redis_config_store',
  getConfigStorePayload,
  upsertConfigStorePayload,
  deleteConfigStoreEntry,
}));

// Every test that customizes a prototype mock (e.g. to simulate a failure)
// mutates it in place; call this after `vi.clearAllMocks()` in each
// `beforeEach` so no test leaks a custom implementation into the next one.
function resetRedisPrototypeDefaults() {
  RedisMock.prototype.info = vi.fn().mockResolvedValue('');
  RedisMock.prototype.dbsize = vi.fn().mockResolvedValue(0);
  RedisMock.prototype.config = vi.fn().mockResolvedValue('OK');
  RedisMock.prototype.quit = vi.fn().mockResolvedValue('OK');
  RedisMock.prototype.disconnect = vi.fn();
  RedisMock.prototype.on = vi.fn();
  RedisMock.prototype.slowlog = vi.fn().mockResolvedValue([]);
  RedisMock.prototype.client = vi.fn().mockResolvedValue('');
  RedisMock.prototype.bgsave = vi.fn().mockResolvedValue('Background saving started');
  RedisMock.prototype.bgrewriteaof = vi.fn().mockResolvedValue('Background append only file rewriting started');
  RedisMock.prototype.latency = vi.fn().mockResolvedValue([]);
}

import {
  getRedisLiveMetrics,
  getRedisConfigState,
  saveRedisManagedConfig,
  resetRedisConfig,
  getRedisConfigRendered,
  getRedisStatus,
  reloadRedis,
  getRedisSlowlog,
  resetRedisSlowlog,
  getRedisClients,
  killRedisClient,
  redisBgsave,
  redisBgrewriteaof,
  redisResetStats,
  getRedisLatency,
  closeRedisClients,
} from './redis.js';

function svc(overrides: Record<string, unknown> = {}) {
  return { id: 1, serviceId: 'rc1', serviceType: 'redis', name: 'Redis', metricsUrl: 'redis://redis-rc1:6379', ...overrides };
}

function instancesForDsn(dsn: string) {
  return redisInstances.filter((i) => i.dsn === dsn);
}

describe('getRedisLiveMetrics', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedisPrototypeDefaults();
    delete process.env.REDIS_ADMIN_DSN;
  });

  it('returns an unreachable snapshot for the reserved default scope without resolving a service', async () => {
    const out = await getRedisLiveMetrics('default');
    expect(out.reachable).toBe(false);
    expect(getFleetServiceById).not.toHaveBeenCalled();
  });

  it('throws when the resolved service is missing or the wrong type', async () => {
    getFleetServiceById.mockResolvedValue(null);
    await expect(getRedisLiveMetrics('rc1')).rejects.toThrow(/not found/);
    getFleetServiceById.mockResolvedValue(svc({ serviceType: 'postgres' }));
    await expect(getRedisLiveMetrics('rc1')).rejects.toThrow(/not found/);
  });

  it('returns unreachable (without connecting) when no admin DSN resolves', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: null }));
    const out = await getRedisLiveMetrics('rc1');
    expect(out.reachable).toBe(false);
    expect(redisInstances).toHaveLength(0);
  });

  it('parses INFO, marks reachable, and caches one client per DSN', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://cache-dsn:6379' }));
    const info = ['role:master', 'connected_clients:2', 'used_memory:100'].join('\n');
    // First call constructs the client; subsequent calls reuse it.
    RedisMock.prototype.info = vi.fn().mockResolvedValue(info);

    const out1 = await getRedisLiveMetrics('rc1');
    expect(out1.reachable).toBe(true);
    expect(out1.role).toBe('master');
    expect(out1.connectedClients).toBe(2);

    await getRedisLiveMetrics('rc1');
    expect(instancesForDsn('redis://cache-dsn:6379')).toHaveLength(1);
  });

  it('marks unreachable when INFO throws', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://broken-dsn:6379' }));
    RedisMock.prototype.info = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'));
    const out = await getRedisLiveMetrics('rc1');
    expect(out.reachable).toBe(false);
  });

  it('falls back to DBSIZE when the Keyspace section has no db lines', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://dbsize-dsn:6379' }));
    RedisMock.prototype.info = vi.fn().mockResolvedValue('role:master\n');
    RedisMock.prototype.dbsize = vi.fn().mockResolvedValue(42);
    const out = await getRedisLiveMetrics('rc1');
    expect(out.dbKeys).toBe(42);
  });
});

describe('config state + save', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedisPrototypeDefaults();
    delete process.env.REDIS_ADMIN_DSN;
    getConfigStorePayload.mockResolvedValue(null);
    upsertConfigStorePayload.mockResolvedValue(undefined);
  });

  it('returns default managed config when the store has no payload yet', async () => {
    getFleetServiceById.mockResolvedValue(svc());
    const state = await getRedisConfigState('rc1');
    expect(state.managed.maxmemoryPolicy).toBe('noeviction');
    expect(state.serviceName).toBe('Redis');
  });

  it('uses the reserved default scope name without a fleet lookup', async () => {
    const state = await getRedisConfigState('default');
    expect(state.serviceName).toBe('Default (base)');
    expect(getFleetServiceById).not.toHaveBeenCalled();
  });

  it('persists managed.json + rendered preview, then applies live CONFIG SET + REWRITE', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://apply-dsn:6379' }));
    const result = await saveRedisManagedConfig('rc1', { maxmemoryPolicy: 'allkeys-lru' });

    expect(result.applyError).toBeNull();
    expect(result.managed.maxmemoryPolicy).toBe('allkeys-lru');
    expect(upsertConfigStorePayload).toHaveBeenCalledWith(
      'redis_config_store', 'service_id', 'rc1', 'managed.json', expect.objectContaining({ maxmemoryPolicy: 'allkeys-lru' })
    );
    expect(upsertConfigStorePayload).toHaveBeenCalledWith(
      'redis_config_store', 'service_id', 'rc1', 'rendered.conf', expect.objectContaining({ managedBy: 'robin-admin' })
    );
    const applyDsnInstance = instancesForDsn('redis://apply-dsn:6379')[0];
    expect(applyDsnInstance.config).toHaveBeenCalledWith('SET', 'maxmemory-policy', 'allkeys-lru');
    expect(applyDsnInstance.config).toHaveBeenCalledWith('REWRITE');
  });

  it('still persists the store write when the live apply fails, surfacing applyError', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://apply-fail-dsn:6379' }));
    RedisMock.prototype.config = vi.fn().mockRejectedValue(new Error('READONLY You cannot write'));

    const result = await saveRedisManagedConfig('rc1', { hz: 25 });
    expect(result.applyError).toMatch(/READONLY/);
    expect(result.managed.hz).toBe(25);
    // The store write happened despite the apply failure.
    expect(upsertConfigStorePayload).toHaveBeenCalledWith(
      'redis_config_store', 'service_id', 'rc1', 'managed.json', expect.objectContaining({ hz: 25 })
    );
  });

  it('applies a base save to every enabled instance and names the ones that failed', async () => {
    getEnabledFleetServices.mockResolvedValue([svc({ serviceId: 'rc1' }), svc({ serviceId: 'rc2' })]);
    getFleetServiceById.mockImplementation(async (id: string) => svc(
      id === 'rc1' ? { serviceId: 'rc1', metricsUrl: 'redis://base-ok:6379' } : { serviceId: 'rc2', metricsUrl: null },
    ));

    const result = await saveRedisManagedConfig('default', { hz: 30 });

    expect(getEnabledFleetServices).toHaveBeenCalledWith('redis');
    expect(instancesForDsn('redis://base-ok:6379')[0].config).toHaveBeenCalledWith('REWRITE');
    expect(result.applyError).toBe('rc2: No Redis admin DSN configured for this service');
  });

  it('re-applies the inherited base when an override is reset', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://reset-dsn:6379' }));

    const result = await resetRedisConfig('rc1');

    expect(deleteConfigStoreEntry).toHaveBeenCalledWith('redis_config_store', 'service_id', 'rc1', 'managed.json');
    expect(instancesForDsn('redis://reset-dsn:6379')[0].config).toHaveBeenCalledWith('REWRITE');
    expect(result.applyError).toBeNull();
  });

  it('renders the current managed config on demand', async () => {
    getFleetServiceById.mockResolvedValue(svc());
    getConfigStorePayload.mockResolvedValue({ hz: 15 });
    const rendered = await getRedisConfigRendered('rc1');
    expect(rendered).toContain('CONFIG SET hz 15');
  });

  it('reports overall status combining config + reachability', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://status-dsn:6379' }));
    RedisMock.prototype.info = vi.fn().mockResolvedValue('role:master\n');
    const status = await getRedisStatus('rc1');
    expect(status.reachable).toBe(true);
    expect(status.managed.maxmemoryPolicy).toBe('noeviction');
  });
});

describe('reloadRedis', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedisPrototypeDefaults();
    delete process.env.REDIS_ADMIN_DSN;
  });

  it('issues CONFIG REWRITE', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://reload-dsn:6379' }));
    RedisMock.prototype.config = vi.fn().mockResolvedValue('OK');
    const out = await reloadRedis('rc1');
    expect(out).toBe('OK');
    expect(instancesForDsn('redis://reload-dsn:6379')[0].config).toHaveBeenCalledWith('REWRITE');
  });

  it('throws when there is no admin DSN to reload', async () => {
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: null }));
    await expect(reloadRedis('rc1')).rejects.toThrow(/DSN/);
  });
});

describe('ops: slowlog / clients / bgsave / stats / latency', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetRedisPrototypeDefaults();
    delete process.env.REDIS_ADMIN_DSN;
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://ops-dsn:6379' }));
  });

  it('getRedisSlowlog parses SLOWLOG GET into entries', async () => {
    RedisMock.prototype.slowlog = vi.fn().mockResolvedValue([[1, 1700000000, 1000, ['GET', 'x']]]);
    const entries = await getRedisSlowlog('rc1', 10);
    expect(entries).toEqual([{ id: 1, timestampEpoch: 1700000000, durationMicros: 1000, command: ['GET', 'x'], clientAddress: '', clientName: '' }]);
    expect(instancesForDsn('redis://ops-dsn:6379').at(-1)?.slowlog).toHaveBeenCalledWith('GET', 10);
  });

  it('resetRedisSlowlog issues SLOWLOG RESET and returns a confirmation string', async () => {
    RedisMock.prototype.slowlog = vi.fn().mockResolvedValue('OK');
    const out = await resetRedisSlowlog('rc1');
    expect(out).toBe('OK');
    expect(instancesForDsn('redis://ops-dsn:6379').at(-1)?.slowlog).toHaveBeenCalledWith('RESET');
  });

  it('getRedisClients parses CLIENT LIST', async () => {
    RedisMock.prototype.client = vi.fn().mockResolvedValue('id=1 addr=1.2.3.4:1 name= age=1 idle=0 db=0 cmd=get user=default');
    const clients = await getRedisClients('rc1');
    expect(clients).toEqual([{ id: 1, addr: '1.2.3.4:1', name: '', ageSecs: 1, idleSecs: 0, db: 0, cmd: 'get', user: 'default' }]);
  });

  it('killRedisClient validates the client id before issuing CLIENT KILL', async () => {
    await expect(killRedisClient('rc1', -1)).rejects.toThrow(/Invalid Redis client id/);
    await expect(killRedisClient('rc1', 0)).rejects.toThrow(/Invalid Redis client id/);
    await expect(killRedisClient('rc1', 1.5)).rejects.toThrow(/Invalid Redis client id/);
    await expect(killRedisClient('rc1', 'not-a-number')).rejects.toThrow(/Invalid Redis client id/);

    RedisMock.prototype.client = vi.fn().mockResolvedValue(1);
    const out = await killRedisClient('rc1', 42);
    expect(out).toBe('1');
    expect(instancesForDsn('redis://ops-dsn:6379').at(-1)?.client).toHaveBeenCalledWith('KILL', 'ID', '42');
  });

  it('killRedisClient also accepts a string client id (as delivered by an HTTP route)', async () => {
    RedisMock.prototype.client = vi.fn().mockResolvedValue(1);
    const out = await killRedisClient('rc1', '99');
    expect(out).toBe('1');
    expect(instancesForDsn('redis://ops-dsn:6379').at(-1)?.client).toHaveBeenCalledWith('KILL', 'ID', '99');
  });

  it('redisBgsave/redisBgrewriteaof/redisResetStats call the matching command', async () => {
    await redisBgsave('rc1');
    expect(instancesForDsn('redis://ops-dsn:6379').at(-1)?.bgsave).toHaveBeenCalled();
    await redisBgrewriteaof('rc1');
    expect(instancesForDsn('redis://ops-dsn:6379').at(-1)?.bgrewriteaof).toHaveBeenCalled();
    await redisResetStats('rc1');
    expect(instancesForDsn('redis://ops-dsn:6379').at(-1)?.config).toHaveBeenCalledWith('RESETSTAT');
  });

  it('getRedisLatency parses LATENCY LATEST', async () => {
    RedisMock.prototype.latency = vi.fn().mockResolvedValue([['command', 1700000000, 5, 10]]);
    const events = await getRedisLatency('rc1');
    expect(events).toEqual([{ event: 'command', latestTimestampEpoch: 1700000000, latestMs: 5 }]);
  });

  it('never exposes a FLUSHDB/FLUSHALL-style export', async () => {
    const redisModule = await import('./redis.js');
    const exportNames = Object.keys(redisModule);
    expect(exportNames.some((n) => /flush/i.test(n))).toBe(false);
  });
});

describe('closeRedisClients', () => {
  it('quits every cached client and clears the cache', async () => {
    vi.clearAllMocks();
    resetRedisPrototypeDefaults();
    getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'redis://close-dsn:6379' }));
    RedisMock.prototype.info = vi.fn().mockResolvedValue('role:master\n');
    await getRedisLiveMetrics('rc1');
    const created = instancesForDsn('redis://close-dsn:6379');
    expect(created.length).toBeGreaterThan(0);

    await closeRedisClients();
    for (const instance of created) {
      expect(instance.quit).toHaveBeenCalled();
    }

    // A subsequent call must construct a fresh client (the cache was cleared).
    await getRedisLiveMetrics('rc1');
    expect(instancesForDsn('redis://close-dsn:6379').length).toBe(created.length + 1);
  });
});
