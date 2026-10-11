import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../db/connection.js';
import * as serviceMetrics from '../db/queries/service-metrics.js';
import * as redisService from './redis.js';
import * as postgresService from './postgres.js';
import {
  getLivePostgresMetrics,
  getLiveRedisMetrics,
  getPostgresMetricsHistory,
  getRedisMetricsHistory,
} from './metrics-poller.js';

vi.mock('../db/connection.js');
vi.mock('../db/queries/service-metrics.js');
vi.mock('./redis.js', () => ({
  getRedisLiveMetrics: vi.fn(),
  getRedisRawStats: vi.fn(),
}));
vi.mock('./postgres.js', () => ({
  getPostgresLiveMetrics: vi.fn(),
  getPostgresRawStats: vi.fn(),
}));

const mockQuery = vi.mocked(connection.query);
const mockGetMetricsFleetServiceById = vi.mocked(serviceMetrics.getMetricsFleetServiceById);
const mockGetPrimaryMetricsFleetService = vi.mocked(serviceMetrics.getPrimaryMetricsFleetService);
const mockGetRedisLiveMetrics = vi.mocked(redisService.getRedisLiveMetrics);
const mockGetPostgresLiveMetrics = vi.mocked(postgresService.getPostgresLiveMetrics);

function buildRedisHistoryRow() {
  return {
    fleet_service_id: 11,
    timestamp: new Date('2024-01-01T00:00:00Z'),
    service_id: 'redis-east',
    current_service_id: 'redis-role-a',
    reachable: true,
    role: 'master',
    uptime_secs: '100',
    connected_clients: '5',
    blocked_clients: '0',
    max_clients: '10000',
    memory_used_bytes: '1024',
    memory_peak_bytes: '2048',
    memory_rss_bytes: '1500',
    max_memory_bytes: '0',
    mem_fragmentation_ratio: '1.1',
    evicted_keys: '0',
    expired_keys: '0',
    keyspace_hits: '100',
    keyspace_misses: '10',
    hit_ratio: '0.9',
    instantaneous_ops_per_sec: '42',
    total_commands_processed: '1000',
    total_connections_received: '50',
    rejected_connections: '0',
    total_net_input_bytes: '0',
    total_net_output_bytes: '0',
    connected_slaves: '0',
    master_link_status: '',
    rdb_changes_since_last_save: '0',
    rdb_last_save_time: '0',
    rdb_last_bgsave_status: 'ok',
    aof_enabled: false,
    aof_last_write_status: 'ok',
    db_keys: '20',
    db_expires: '5',
    pubsub_channels: '0',
    raw_info: '',
  };
}

function buildPostgresHistoryRow() {
  return {
    fleet_service_id: 12,
    timestamp: new Date('2024-01-01T00:00:00Z'),
    service_id: 'pg-east',
    current_service_id: 'pg-role-a',
    reachable: true,
    server_version_num: '160001',
    connections_total: '10',
    connections_active: '3',
    connections_idle: '6',
    connections_idle_in_txn: '1',
    connections_waiting: '0',
    max_connections: '100',
    connection_saturation_pct: '10',
    xact_commit: '500',
    xact_rollback: '5',
    commit_ratio: '0.99',
    blks_hit: '1000',
    blks_read: '10',
    cache_hit_ratio: '0.99',
    tup_returned: '0',
    tup_fetched: '0',
    tup_inserted: '100',
    tup_updated: '50',
    tup_deleted: '10',
    deadlocks: '0',
    temp_files: '0',
    temp_bytes: '0',
    conflicts: '0',
    database_size_bytes: '1048576',
    oldest_xact_age_secs: '0',
    oldest_idle_in_txn_secs: '0',
    blocked_queries: '0',
    checkpoints_timed: '0',
    checkpoints_req: '0',
    buffers_checkpoint: '0',
    replication_lag_bytes: '0',
    dead_tuples_total: '0',
    raw_stats: '',
  };
}

describe('metrics-poller (redis/postgres)', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockGetMetricsFleetServiceById.mockReset();
    mockGetPrimaryMetricsFleetService.mockReset();
    mockGetRedisLiveMetrics.mockReset();
    mockGetPostgresLiveMetrics.mockReset();
  });

  it('delegates live Redis metrics to services/redis.js for the resolved service', async () => {
    mockGetMetricsFleetServiceById.mockResolvedValue({
      id: 11,
      serviceId: 'redis-role-a',
      serviceType: 'redis',
      name: 'Redis Role A',
      description: null,
      apiUrl: null,
      healthUrl: null,
      metricsUrl: 'redis://redis-role-a:6379',
      controllerUrl: null,
      normalUrl: null,
      enabled: true,
    } as never);
    mockGetRedisLiveMetrics.mockResolvedValue({
      serviceId: 'redis-role-a',
      serviceType: 'redis',
      reachable: true,
      connectedClients: 5,
    } as never);

    const result = await getLiveRedisMetrics('redis-role-a');

    expect(mockGetMetricsFleetServiceById).toHaveBeenCalledWith('redis-role-a', 'redis');
    expect(mockGetRedisLiveMetrics).toHaveBeenCalledWith('redis-role-a');
    expect(result).toMatchObject({ serviceId: 'redis-role-a', reachable: true, connectedClients: 5 });
  });

  it('returns null when no Redis service resolves', async () => {
    mockGetPrimaryMetricsFleetService.mockResolvedValue(null);

    const result = await getLiveRedisMetrics();

    expect(result).toBeNull();
    expect(mockGetRedisLiveMetrics).not.toHaveBeenCalled();
  });

  it('delegates live Postgres metrics to services/postgres.js for the resolved service', async () => {
    mockGetMetricsFleetServiceById.mockResolvedValue({
      id: 12,
      serviceId: 'pg-role-a',
      serviceType: 'postgres',
      name: 'Postgres Role A',
      description: null,
      apiUrl: null,
      healthUrl: null,
      metricsUrl: 'postgres://pg-role-a:5432/robin',
      controllerUrl: null,
      normalUrl: null,
      enabled: true,
    } as never);
    mockGetPostgresLiveMetrics.mockResolvedValue({
      serviceId: 'pg-role-a',
      serviceType: 'postgres',
      reachable: true,
      connectionsActive: 3,
    } as never);

    const result = await getLivePostgresMetrics('pg-role-a');

    expect(mockGetMetricsFleetServiceById).toHaveBeenCalledWith('pg-role-a', 'postgres');
    expect(mockGetPostgresLiveMetrics).toHaveBeenCalledWith('pg-role-a');
    expect(result).toMatchObject({ serviceId: 'pg-role-a', reachable: true, connectionsActive: 3 });
  });

  it('maps Redis history rows to service-aware metric objects', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [buildRedisHistoryRow()], rowCount: 1 } as never);

    mockGetMetricsFleetServiceById.mockResolvedValueOnce({
      id: 11,
      serviceId: 'redis-role-a',
      serviceType: 'redis',
      name: 'Redis Role A',
      description: null,
      apiUrl: null,
      healthUrl: null,
      metricsUrl: 'redis://redis-role-a:6379',
      controllerUrl: null,
      normalUrl: null,
      enabled: true,
    } as never);

    const result = await getRedisMetricsHistory(24, 500, 'redis-role-a');

    expect(result).toEqual([
      expect.objectContaining({
        serviceId: 'redis-role-a',
        serviceType: 'redis',
        connectedClients: 5,
        totalCommandsProcessed: 1000,
        dbKeys: 20,
      }),
    ]);

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT COUNT(*) AS count FROM redis_metrics_history'),
      [24, 11]
    );
  });

  it('maps Postgres history rows to service-aware metric objects', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [{ count: '1' }], rowCount: 1 } as never)
      .mockResolvedValueOnce({ rows: [buildPostgresHistoryRow()], rowCount: 1 } as never);

    mockGetMetricsFleetServiceById.mockResolvedValueOnce({
      id: 12,
      serviceId: 'pg-role-a',
      serviceType: 'postgres',
      name: 'Postgres Role A',
      description: null,
      apiUrl: null,
      healthUrl: null,
      metricsUrl: 'postgres://pg-role-a:5432/robin',
      controllerUrl: null,
      normalUrl: null,
      enabled: true,
    } as never);

    const result = await getPostgresMetricsHistory(24, 500, 'pg-role-a');

    expect(result).toEqual([
      expect.objectContaining({
        serviceId: 'pg-role-a',
        serviceType: 'postgres',
        connectionsActive: 3,
        xactCommit: 500,
        databaseSizeBytes: 1048576,
      }),
    ]);

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT COUNT(*) AS count FROM postgres_metrics_history'),
      [24, 12]
    );
  });
});
