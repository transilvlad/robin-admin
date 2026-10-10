import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  parseRedisInfo,
  parseRedisSlowlogEntries,
  parseRedisClientList,
  parseRedisLatencyLatest,
  normalizeRedisConfig,
  renderRedisConfig,
  resolveRedisDsn,
  buildRedisSnapshotFromInfo,
} from './redis.js';

describe('buildRedisSnapshotFromInfo', () => {
  it('assembles a live snapshot from a raw INFO reply', () => {
    const info = [
      '# Server', 'role:master', 'uptime_in_seconds:100',
      '# Clients', 'connected_clients:7',
      '# Memory', 'used_memory:1048576', 'maxmemory:0',
      '# Stats', 'keyspace_hits:80', 'keyspace_misses:20', 'instantaneous_ops_per_sec:5',
      '# Keyspace', 'db0:keys=42,expires=3,avg_ttl=0',
    ].join('\n');
    const snap = buildRedisSnapshotFromInfo('r1', info);
    expect(snap.serviceType).toBe('redis');
    expect(snap.reachable).toBe(true);
    expect(snap.role).toBe('master');
    expect(snap.connectedClients).toBe(7);
    expect(snap.memoryUsedBytes).toBe(1048576);
    expect(snap.dbKeys).toBe(42);
    expect(snap.hitRatio).toBeCloseTo(0.8);
    expect(snap.rawInfo).toContain('role:master');
  });
});

describe('parseRedisInfo', () => {
  it('parses server/clients/memory/stats/persistence/replication fields', () => {
    const raw = [
      '# Server',
      'role:master',
      'uptime_in_seconds:12345',
      '# Clients',
      'connected_clients:7',
      'blocked_clients:1',
      'maxclients:10000',
      '# Memory',
      'used_memory:1048576',
      'used_memory_peak:2097152',
      'used_memory_rss:1572864',
      'maxmemory:0',
      'mem_fragmentation_ratio:1.05',
      '# Stats',
      'total_connections_received:99',
      'total_commands_processed:500',
      'instantaneous_ops_per_sec:42',
      'rejected_connections:2',
      'total_net_input_bytes:1000',
      'total_net_output_bytes:2000',
      'evicted_keys:3',
      'expired_keys:4',
      'keyspace_hits:80',
      'keyspace_misses:20',
      'pubsub_channels:5',
      '# Replication',
      'connected_slaves:1',
      'master_link_status:up',
      '# Persistence',
      'rdb_changes_since_last_save:6',
      'rdb_last_save_time:1700000000',
      'rdb_last_bgsave_status:ok',
      'aof_enabled:1',
      'aof_last_write_status:ok',
      '# Keyspace',
      'db0:keys=10,expires=2,avg_ttl=0',
      'db1:keys=5,expires=0,avg_ttl=0',
    ].join('\n');

    const out = parseRedisInfo(raw);
    expect(out.role).toBe('master');
    expect(out.uptimeSecs).toBe(12345);
    expect(out.connectedClients).toBe(7);
    expect(out.blockedClients).toBe(1);
    expect(out.maxClients).toBe(10000);
    expect(out.memoryUsedBytes).toBe(1048576);
    expect(out.memoryPeakBytes).toBe(2097152);
    expect(out.memoryRssBytes).toBe(1572864);
    expect(out.maxMemoryBytes).toBe(0);
    expect(out.memFragmentationRatio).toBeCloseTo(1.05);
    expect(out.keyspaceHits).toBe(80);
    expect(out.keyspaceMisses).toBe(20);
    expect(out.hitRatio).toBeCloseTo(0.8);
    expect(out.instantaneousOpsPerSec).toBe(42);
    expect(out.totalCommandsProcessed).toBe(500);
    expect(out.totalConnectionsReceived).toBe(99);
    expect(out.rejectedConnections).toBe(2);
    expect(out.totalNetInputBytes).toBe(1000);
    expect(out.totalNetOutputBytes).toBe(2000);
    expect(out.connectedSlaves).toBe(1);
    expect(out.masterLinkStatus).toBe('up');
    expect(out.rdbChangesSinceLastSave).toBe(6);
    expect(out.rdbLastSaveTime).toBe(1700000000);
    expect(out.rdbLastBgsaveStatus).toBe('ok');
    expect(out.aofEnabled).toBe(true);
    expect(out.aofLastWriteStatus).toBe('ok');
    expect(out.pubsubChannels).toBe(5);
    // Keyspace section is summed across every dbN line.
    expect(out.dbKeys).toBe(15);
    expect(out.dbExpires).toBe(2);
  });

  it('defaults hitRatio to 0 when there have been no hits or misses', () => {
    const out = parseRedisInfo('# Stats\nkeyspace_hits:0\nkeyspace_misses:0\n');
    expect(out.hitRatio).toBe(0);
  });

  it('ignores comments/blank lines and ignores malformed rows without a colon', () => {
    const out = parseRedisInfo('# comment\n\nnotakeyvalue\nrole:master\n');
    expect(out.role).toBe('master');
  });
});

describe('parseRedisSlowlogEntries', () => {
  it('maps SLOWLOG GET rows into structured entries', () => {
    const raw = [
      [1, 1700000000, 15000, ['SET', 'foo', 'bar'], '127.0.0.1:1234', 'client-a'],
      [0, 1699999990, 500, ['GET', 'foo']],
    ];
    const entries = parseRedisSlowlogEntries(raw);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      id: 1,
      timestampEpoch: 1700000000,
      durationMicros: 15000,
      command: ['SET', 'foo', 'bar'],
      clientAddress: '127.0.0.1:1234',
      clientName: 'client-a',
    });
    expect(entries[1].clientAddress).toBe('');
    expect(entries[1].clientName).toBe('');
  });

  it('skips malformed rows', () => {
    expect(parseRedisSlowlogEntries([['too', 'short']])).toEqual([]);
    expect(parseRedisSlowlogEntries(['not-an-array' as unknown as unknown[]])).toEqual([]);
  });
});

describe('parseRedisClientList', () => {
  it('parses CLIENT LIST key=value lines', () => {
    const raw = [
      'id=3 addr=127.0.0.1:53294 name=worker age=120 idle=0 db=0 cmd=get user=default',
      'id=4 addr=127.0.0.1:53295 name= age=5 idle=2 db=1 cmd=subscribe user=default',
    ].join('\n');
    const clients = parseRedisClientList(raw);
    expect(clients).toHaveLength(2);
    expect(clients[0]).toEqual({
      id: 3, addr: '127.0.0.1:53294', name: 'worker', ageSecs: 120, idleSecs: 0, db: 0, cmd: 'get', user: 'default',
    });
    expect(clients[1].name).toBe('');
  });

  it('returns an empty array for blank input', () => {
    expect(parseRedisClientList('')).toEqual([]);
    expect(parseRedisClientList('\n\n')).toEqual([]);
  });
});

describe('parseRedisLatencyLatest', () => {
  it('maps LATENCY LATEST rows', () => {
    const raw = [['command', 1700000000, 120, 250]];
    expect(parseRedisLatencyLatest(raw)).toEqual([
      { event: 'command', latestTimestampEpoch: 1700000000, latestMs: 120 },
    ]);
  });

  it('skips malformed rows', () => {
    expect(parseRedisLatencyLatest([['too-short']])).toEqual([]);
  });
});

describe('normalizeRedisConfig', () => {
  it('returns defaults for missing/non-object input', () => {
    const defaults = normalizeRedisConfig(undefined);
    expect(defaults.maxmemory).toBe('0');
    expect(defaults.maxmemoryPolicy).toBe('noeviction');
    expect(defaults.appendfsync).toBe('everysec');
    expect(normalizeRedisConfig(null)).toEqual(defaults);
    expect(normalizeRedisConfig('nope')).toEqual(defaults);
  });

  it('accepts valid overrides', () => {
    const out = normalizeRedisConfig({
      maxmemory: '256mb',
      maxmemoryPolicy: 'allkeys-lru',
      save: '900 1',
      appendonly: true,
      appendfsync: 'always',
      timeout: 30,
      tcpKeepalive: 60,
      maxclients: 5000,
      slowlogLogSlowerThan: 0,
      slowlogMaxLen: 256,
      loglevel: 'warning',
      notifyKeyspaceEvents: 'KEA',
      lazyfreeLazyEviction: true,
      hz: 50,
    });
    expect(out.maxmemory).toBe('256mb');
    expect(out.maxmemoryPolicy).toBe('allkeys-lru');
    expect(out.save).toBe('900 1');
    expect(out.appendonly).toBe(true);
    expect(out.appendfsync).toBe('always');
    expect(out.timeout).toBe(30);
    expect(out.maxclients).toBe(5000);
    expect(out.slowlogLogSlowerThan).toBe(0);
    expect(out.loglevel).toBe('warning');
    expect(out.notifyKeyspaceEvents).toBe('KEA');
    expect(out.lazyfreeLazyEviction).toBe(true);
    expect(out.hz).toBe(50);
  });

  it('rejects an invalid maxmemory-policy enum and falls back to default', () => {
    const out = normalizeRedisConfig({ maxmemoryPolicy: 'flushall-everything' });
    expect(out.maxmemoryPolicy).toBe('noeviction');
  });

  it('rejects a malformed maxmemory size string', () => {
    const out = normalizeRedisConfig({ maxmemory: 'DROP TABLE users' });
    expect(out.maxmemory).toBe('0');
  });

  it('rejects an odd-length or non-numeric save directive', () => {
    expect(normalizeRedisConfig({ save: '900' }).save).toBe('3600 1 300 100 60 10000');
    expect(normalizeRedisConfig({ save: '900 abc' }).save).toBe('3600 1 300 100 60 10000');
    expect(normalizeRedisConfig({ save: '' }).save).toBe('');
  });

  it('rejects notify-keyspace-events characters outside the documented flag set', () => {
    const out = normalizeRedisConfig({ notifyKeyspaceEvents: 'KEA; FLUSHALL' });
    expect(out.notifyKeyspaceEvents).toBe('');
  });

  it('clamps maxclients/hz to at least 1', () => {
    expect(normalizeRedisConfig({ maxclients: 0 }).maxclients).toBe(10000);
    expect(normalizeRedisConfig({ hz: -5 }).hz).toBe(10);
  });
});

describe('renderRedisConfig', () => {
  it('renders one CONFIG SET line per managed knob, quoting string values', () => {
    const managed = normalizeRedisConfig({ save: '900 1', notifyKeyspaceEvents: 'KEA', appendonly: true });
    const rendered = renderRedisConfig(managed);
    expect(rendered).toContain('CONFIG SET maxmemory 0');
    expect(rendered).toContain('CONFIG SET maxmemory-policy noeviction');
    expect(rendered).toContain('CONFIG SET save "900 1"');
    expect(rendered).toContain('CONFIG SET appendonly yes');
    expect(rendered).toContain('CONFIG SET notify-keyspace-events "KEA"');
    expect(rendered).toContain('CONFIG SET hz 10');
  });
});

describe('resolveRedisDsn', () => {
  const ORIGINAL_ENV = process.env.REDIS_ADMIN_DSN;

  beforeEach(() => {
    delete process.env.REDIS_ADMIN_DSN;
  });

  afterEach(() => {
    if (ORIGINAL_ENV === undefined) delete process.env.REDIS_ADMIN_DSN;
    else process.env.REDIS_ADMIN_DSN = ORIGINAL_ENV;
  });

  it('prefers the fleet row metricsUrl over REDIS_ADMIN_DSN', () => {
    process.env.REDIS_ADMIN_DSN = 'redis://env-host:6379';
    expect(resolveRedisDsn({ metricsUrl: 'redis://fleet-host:6379' })).toBe('redis://fleet-host:6379');
  });

  it('falls back to REDIS_ADMIN_DSN when the fleet row has no DSN', () => {
    process.env.REDIS_ADMIN_DSN = 'redis://env-host:6379';
    expect(resolveRedisDsn({ metricsUrl: null })).toBe('redis://env-host:6379');
  });

  it('falls back to the fleet row metricsUrl when the env var is unset', () => {
    expect(resolveRedisDsn({ metricsUrl: 'redis://fleet-host:6379' })).toBe('redis://fleet-host:6379');
  });

  it('returns null when neither is set', () => {
    expect(resolveRedisDsn({ metricsUrl: null })).toBeNull();
    expect(resolveRedisDsn({ metricsUrl: '   ' })).toBeNull();
  });
});
