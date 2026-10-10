import Redis from 'ioredis';
import {
  REDIS_CONFIG_STORE_TABLE,
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

// Direct-client mode uses Redis' native admin protocol for both metrics and
// config apply.
const CONNECT_TIMEOUT_MS = 8000;
const COMMAND_TIMEOUT_MS = 8000;

// The reserved 'default' scope is the shared base config. It has no
// fleet_services row, so the service resolver/probes must tolerate it.
const DEFAULT_SCOPE_ID = 'default';
const DEFAULT_SCOPE_NAME = 'Default (base)';

const MANAGED_JSON_FILE = 'managed.json';
const RENDERED_PREVIEW_FILE = 'rendered.conf';

// One `ioredis` client cached per resolved DSN, reused across poller ticks and
// route calls (never reconnect per call). A connect/command failure just marks
// `reachable=false` for that call; the cached client keeps auto-reconnecting.
const clientCache = new Map<string, Redis>();

function getClientForDsn(dsn: string): Redis {
  let client = clientCache.get(dsn);
  if (!client) {
    client = new Redis(dsn, {
      connectTimeout: CONNECT_TIMEOUT_MS,
      commandTimeout: COMMAND_TIMEOUT_MS,
      maxRetriesPerRequest: 1,
      lazyConnect: false,
      enableOfflineQueue: true,
      retryStrategy: (times: number) => Math.min(times * 500, 5000),
    });
    client.on('error', (error: Error) => {
      logger.warn('Redis admin client error', { error: error.message });
    });
    clientCache.set(dsn, client);
  }
  return client;
}

/** Close and forget every cached Redis admin client (graceful server shutdown). */
export async function closeRedisClients(): Promise<void> {
  const clients = Array.from(clientCache.values());
  clientCache.clear();
  await Promise.all(
    clients.map(async (client) => {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    })
  );
}

async function getResolvedService(serviceId: string) {
  const service = await getFleetServiceById(serviceId);
  if (!service || service.serviceType !== 'redis') {
    throw new Error('Redis service not found');
  }
  return service;
}

/** The fleet row's `metricsUrl`, else the `REDIS_ADMIN_DSN` fallback. */
export function resolveRedisDsn(service: { metricsUrl: string | null }): string | null {
  return resolveServiceDsn(service, 'REDIS_ADMIN_DSN');
}

// ---------------------------------------------------------------------------
// Managed config (safe runtime tunables only — no persistence topology, no
// bind/protected-mode/ACL changes)
// ---------------------------------------------------------------------------

const MAXMEMORY_POLICIES = new Set([
  'noeviction',
  'allkeys-lru',
  'volatile-lru',
  'allkeys-lfu',
  'volatile-lfu',
  'allkeys-random',
  'volatile-random',
  'volatile-ttl',
]);
const APPENDFSYNC_MODES = new Set(['always', 'everysec', 'no']);
const LOG_LEVELS = new Set(['debug', 'verbose', 'notice', 'warning', 'nothing']);

export interface RedisManagedConfig {
  maxmemory: string;              // e.g. "0" or "256mb" (0 = unlimited)
  maxmemoryPolicy: string;
  save: string;                   // e.g. "3600 1 300 100"; '' disables RDB snapshotting
  appendonly: boolean;
  appendfsync: string;            // 'always' | 'everysec' | 'no'
  timeout: number;                // seconds; 0 = disabled
  tcpKeepalive: number;           // seconds
  maxclients: number;
  slowlogLogSlowerThan: number;   // microseconds; -1 disables, 0 logs everything
  slowlogMaxLen: number;
  loglevel: string;
  notifyKeyspaceEvents: string;
  lazyfreeLazyEviction: boolean;
  lazyfreeLazyExpire: boolean;
  lazyfreeLazyServerDel: boolean;
  lazyfreeLazyUserDel: boolean;
  lazyfreeLazyUserFlush: boolean;
  hz: number;
  // Performance / persistence tuning (all live-settable via CONFIG SET)
  activeDefrag: boolean;
  latencyMonitorThreshold: number; // ms; 0 = disabled
  stopWritesOnBgsaveError: boolean;
  rdbCompression: boolean;
  maxmemoryClients: string;        // e.g. "0", "5%", "1gb" (Redis 7+)
}

const DEFAULT_REDIS_CONFIG: RedisManagedConfig = {
  maxmemory: '0',
  maxmemoryPolicy: 'noeviction',
  save: '3600 1 300 100 60 10000',
  appendonly: false,
  appendfsync: 'everysec',
  timeout: 0,
  tcpKeepalive: 300,
  maxclients: 10000,
  slowlogLogSlowerThan: 10000,
  slowlogMaxLen: 128,
  loglevel: 'notice',
  notifyKeyspaceEvents: '',
  lazyfreeLazyEviction: false,
  lazyfreeLazyExpire: false,
  lazyfreeLazyServerDel: false,
  lazyfreeLazyUserDel: false,
  lazyfreeLazyUserFlush: false,
  hz: 10,
  activeDefrag: false,
  latencyMonitorThreshold: 0,
  stopWritesOnBgsaveError: true,
  rdbCompression: true,
  maxmemoryClients: '0',
};

// maxmemory-clients accepts "0", a byte size, or a percentage like "5%".
const MAXMEMORY_CLIENTS_RE = /^(?:\d+(?:[kKmMgG][bB]?)?|\d+%)$/;
function normalizeMaxmemoryClients(value: unknown, fallback: string): string {
  if (typeof value === 'string' && MAXMEMORY_CLIENTS_RE.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

function normalizeInteger(value: unknown, fallback: number, min = 0): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) && n >= min ? Math.trunc(n) : fallback;
}

function normalizeSignedInteger(value: unknown, fallback: number): number {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(n) ? Math.trunc(n) : fallback;
}

function normalizeBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function normalizeEnum(value: unknown, allowed: Set<string>, fallback: string): string {
  return typeof value === 'string' && allowed.has(value) ? value : fallback;
}

// Redis memory-size directives: a bare integer (bytes) or an integer with a
// k/kb/m/mb/g/gb unit suffix (case-insensitive). Rejects anything else.
const MEMORY_SIZE_RE = /^\d+(?:[kKmMgG][bB]?)?$/;

function normalizeMemorySize(value: unknown, fallback: string): string {
  if (typeof value === 'string' && MEMORY_SIZE_RE.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

// The `save` directive is zero or more "<seconds> <changes>" pairs (an empty
// string disables RDB snapshotting entirely).
function normalizeSaveDirective(value: unknown, fallback: string): string {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  if (trimmed === '') return '';
  const parts = trimmed.split(/\s+/);
  if (parts.length === 0 || parts.length % 2 !== 0) return fallback;
  if (!parts.every((p) => /^\d+$/.test(p))) return fallback;
  return parts.join(' ');
}

// `notify-keyspace-events` accepts a class-flag string, e.g. "Ex", "KEA". Only
// allow the documented flag characters to avoid smuggling arbitrary content
// through CONFIG SET.
const NOTIFY_KEYSPACE_RE = /^[KEg$lshzxentdmA]*$/;

function normalizeNotifyKeyspaceEvents(value: unknown, fallback: string): string {
  if (typeof value === 'string' && NOTIFY_KEYSPACE_RE.test(value.trim())) {
    return value.trim();
  }
  return fallback;
}

export function normalizeRedisConfig(value: unknown): RedisManagedConfig {
  if (!value || typeof value !== 'object') {
    return { ...DEFAULT_REDIS_CONFIG };
  }
  const s = value as Record<string, unknown>;
  return {
    maxmemory: normalizeMemorySize(s.maxmemory, DEFAULT_REDIS_CONFIG.maxmemory),
    maxmemoryPolicy: normalizeEnum(s.maxmemoryPolicy, MAXMEMORY_POLICIES, DEFAULT_REDIS_CONFIG.maxmemoryPolicy),
    save: normalizeSaveDirective(s.save, DEFAULT_REDIS_CONFIG.save),
    appendonly: normalizeBoolean(s.appendonly, DEFAULT_REDIS_CONFIG.appendonly),
    appendfsync: normalizeEnum(s.appendfsync, APPENDFSYNC_MODES, DEFAULT_REDIS_CONFIG.appendfsync),
    timeout: normalizeInteger(s.timeout, DEFAULT_REDIS_CONFIG.timeout),
    tcpKeepalive: normalizeInteger(s.tcpKeepalive, DEFAULT_REDIS_CONFIG.tcpKeepalive),
    maxclients: normalizeInteger(s.maxclients, DEFAULT_REDIS_CONFIG.maxclients, 1),
    slowlogLogSlowerThan: normalizeSignedInteger(s.slowlogLogSlowerThan, DEFAULT_REDIS_CONFIG.slowlogLogSlowerThan),
    slowlogMaxLen: normalizeInteger(s.slowlogMaxLen, DEFAULT_REDIS_CONFIG.slowlogMaxLen),
    loglevel: normalizeEnum(s.loglevel, LOG_LEVELS, DEFAULT_REDIS_CONFIG.loglevel),
    notifyKeyspaceEvents: normalizeNotifyKeyspaceEvents(s.notifyKeyspaceEvents, DEFAULT_REDIS_CONFIG.notifyKeyspaceEvents),
    lazyfreeLazyEviction: normalizeBoolean(s.lazyfreeLazyEviction, DEFAULT_REDIS_CONFIG.lazyfreeLazyEviction),
    lazyfreeLazyExpire: normalizeBoolean(s.lazyfreeLazyExpire, DEFAULT_REDIS_CONFIG.lazyfreeLazyExpire),
    lazyfreeLazyServerDel: normalizeBoolean(s.lazyfreeLazyServerDel, DEFAULT_REDIS_CONFIG.lazyfreeLazyServerDel),
    lazyfreeLazyUserDel: normalizeBoolean(s.lazyfreeLazyUserDel, DEFAULT_REDIS_CONFIG.lazyfreeLazyUserDel),
    lazyfreeLazyUserFlush: normalizeBoolean(s.lazyfreeLazyUserFlush, DEFAULT_REDIS_CONFIG.lazyfreeLazyUserFlush),
    hz: normalizeInteger(s.hz, DEFAULT_REDIS_CONFIG.hz, 1),
    activeDefrag: normalizeBoolean(s.activeDefrag, DEFAULT_REDIS_CONFIG.activeDefrag),
    latencyMonitorThreshold: normalizeInteger(s.latencyMonitorThreshold, DEFAULT_REDIS_CONFIG.latencyMonitorThreshold),
    stopWritesOnBgsaveError: normalizeBoolean(s.stopWritesOnBgsaveError, DEFAULT_REDIS_CONFIG.stopWritesOnBgsaveError),
    rdbCompression: normalizeBoolean(s.rdbCompression, DEFAULT_REDIS_CONFIG.rdbCompression),
    maxmemoryClients: normalizeMaxmemoryClients(s.maxmemoryClients, DEFAULT_REDIS_CONFIG.maxmemoryClients),
  };
}

export interface RedisConfigState {
  serviceId: string;
  serviceName: string;
  managed: RedisManagedConfig;
}

// Resolve a display name for a scope. 'default' is the base; a registered
// instance uses its service name; a freeform Save-As scope (no fleet row yet)
// just shows its own id.
async function resolveScopeName(serviceId: string): Promise<string> {
  if (serviceId === DEFAULT_SCOPE_ID) return DEFAULT_SCOPE_NAME;
  const service = await getFleetServiceById(serviceId);
  return service?.name ?? serviceId;
}

export async function getRedisConfigState(serviceId: string): Promise<RedisConfigState> {
  const [serviceName, payload] = await Promise.all([
    resolveScopeName(serviceId),
    readLayeredPayload(REDIS_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE),
  ]);
  return {
    serviceId,
    serviceName,
    managed: normalizeRedisConfig(payload),
  };
}

/** All config scopes: the 'default' base plus every per-instance override owner. */
export async function listRedisConfigScopes(): Promise<string[]> {
  return listConfigStoreOwners(REDIS_CONFIG_STORE_TABLE, 'service_id');
}

/** Drop an instance's whole override so it inherits the base again, and apply the base live. */
export async function resetRedisConfig(serviceId: string): Promise<RedisConfigState & { applyError: string | null }> {
  if (serviceId === DEFAULT_SCOPE_ID) {
    throw new Error('The default base scope has no override to reset');
  }
  await deleteConfigStoreEntry(REDIS_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE);
  await deleteConfigStoreEntry(REDIS_CONFIG_STORE_TABLE, 'service_id', serviceId, RENDERED_PREVIEW_FILE);
  const state = await getRedisConfigState(serviceId);
  return { ...state, applyError: await applyRedisConfigLive(serviceId, state.managed) };
}

// One "CONFIG SET key value" line per managed knob — both the live apply
// script and the Config page's "Rendered" preview. String values that may
// contain whitespace (or the empty string) are double-quoted.
function quoteRedisConfigValue(raw: string): string {
  return `"${raw.replace(/"/g, '\\"')}"`;
}

export function renderRedisConfig(managed: RedisManagedConfig): string {
  const yesNo = (b: boolean) => (b ? 'yes' : 'no');
  const lines: string[] = [
    `CONFIG SET maxmemory ${managed.maxmemory}`,
    `CONFIG SET maxmemory-policy ${managed.maxmemoryPolicy}`,
    `CONFIG SET save ${quoteRedisConfigValue(managed.save)}`,
    `CONFIG SET appendonly ${yesNo(managed.appendonly)}`,
    `CONFIG SET appendfsync ${managed.appendfsync}`,
    `CONFIG SET timeout ${managed.timeout}`,
    `CONFIG SET tcp-keepalive ${managed.tcpKeepalive}`,
    `CONFIG SET maxclients ${managed.maxclients}`,
    `CONFIG SET slowlog-log-slower-than ${managed.slowlogLogSlowerThan}`,
    `CONFIG SET slowlog-max-len ${managed.slowlogMaxLen}`,
    `CONFIG SET loglevel ${managed.loglevel}`,
    `CONFIG SET notify-keyspace-events ${quoteRedisConfigValue(managed.notifyKeyspaceEvents)}`,
    `CONFIG SET lazyfree-lazy-eviction ${yesNo(managed.lazyfreeLazyEviction)}`,
    `CONFIG SET lazyfree-lazy-expire ${yesNo(managed.lazyfreeLazyExpire)}`,
    `CONFIG SET lazyfree-lazy-server-del ${yesNo(managed.lazyfreeLazyServerDel)}`,
    `CONFIG SET lazyfree-lazy-user-del ${yesNo(managed.lazyfreeLazyUserDel)}`,
    `CONFIG SET lazyfree-lazy-user-flush ${yesNo(managed.lazyfreeLazyUserFlush)}`,
    `CONFIG SET hz ${managed.hz}`,
    `CONFIG SET activedefrag ${yesNo(managed.activeDefrag)}`,
    `CONFIG SET latency-monitor-threshold ${managed.latencyMonitorThreshold}`,
    `CONFIG SET stop-writes-on-bgsave-error ${yesNo(managed.stopWritesOnBgsaveError)}`,
    `CONFIG SET rdbcompression ${yesNo(managed.rdbCompression)}`,
    `CONFIG SET maxmemory-clients ${managed.maxmemoryClients}`,
  ];
  return `${lines.join('\n')}\n`;
}

// The `CONFIG SET` key/value pairs applied live, parallel to renderRedisConfig
// but as data (not text) so the apply step doesn't need to re-parse its own preview.
function redisConfigSetPairs(managed: RedisManagedConfig): Array<[string, string]> {
  const yesNo = (b: boolean) => (b ? 'yes' : 'no');
  return [
    ['maxmemory', managed.maxmemory],
    ['maxmemory-policy', managed.maxmemoryPolicy],
    ['save', managed.save],
    ['appendonly', yesNo(managed.appendonly)],
    ['appendfsync', managed.appendfsync],
    ['timeout', String(managed.timeout)],
    ['tcp-keepalive', String(managed.tcpKeepalive)],
    ['maxclients', String(managed.maxclients)],
    ['slowlog-log-slower-than', String(managed.slowlogLogSlowerThan)],
    ['slowlog-max-len', String(managed.slowlogMaxLen)],
    ['loglevel', managed.loglevel],
    ['notify-keyspace-events', managed.notifyKeyspaceEvents],
    ['lazyfree-lazy-eviction', yesNo(managed.lazyfreeLazyEviction)],
    ['lazyfree-lazy-expire', yesNo(managed.lazyfreeLazyExpire)],
    ['lazyfree-lazy-server-del', yesNo(managed.lazyfreeLazyServerDel)],
    ['lazyfree-lazy-user-del', yesNo(managed.lazyfreeLazyUserDel)],
    ['lazyfree-lazy-user-flush', yesNo(managed.lazyfreeLazyUserFlush)],
    ['hz', String(managed.hz)],
    ['activedefrag', yesNo(managed.activeDefrag)],
    ['latency-monitor-threshold', String(managed.latencyMonitorThreshold)],
    ['stop-writes-on-bgsave-error', yesNo(managed.stopWritesOnBgsaveError)],
    ['rdbcompression', yesNo(managed.rdbCompression)],
    ['maxmemory-clients', managed.maxmemoryClients],
  ];
}

export interface RedisConfigSaveResult extends RedisConfigState {
  rendered: string;
  /** Set when the live CONFIG SET/REWRITE apply failed; the persisted store
   *  write above still succeeded, so the managed form + preview are not lost. */
  applyError: string | null;
}

export async function saveRedisManagedConfig(
  serviceId: string,
  patch: Partial<RedisManagedConfig>
): Promise<RedisConfigSaveResult> {
  const current = await getRedisConfigState(serviceId);
  const merged = normalizeRedisConfig({ ...current.managed, ...patch });
  const rendered = renderRedisConfig(merged);

  // Persist the managed form + rendered preview BEFORE attempting the live
  // apply, so a failed apply never loses the operator's intended state. The
  // base scope stores the full object; an instance stores only its delta.
  await writeLayeredPayload(REDIS_CONFIG_STORE_TABLE, 'service_id', serviceId, MANAGED_JSON_FILE, merged as unknown as Record<string, unknown>);
  await upsertConfigStorePayload(REDIS_CONFIG_STORE_TABLE, 'service_id', serviceId, RENDERED_PREVIEW_FILE, {
    content: rendered,
    managedBy: 'robin-admin',
  });

  const applyError = serviceId === DEFAULT_SCOPE_ID
    ? await applyRedisBaseToInstances()
    : await applyRedisConfigLive(serviceId, merged);

  return { serviceId, serviceName: current.serviceName, managed: merged, rendered, applyError };
}

/** CONFIG SET + REWRITE the managed values on one instance; returns the failure, if any. */
async function applyRedisConfigLive(serviceId: string, managed: RedisManagedConfig): Promise<string | null> {
  try {
    const service = await getResolvedService(serviceId);
    const dsn = resolveRedisDsn(service);
    // Guard with isRedisUrl for parity with the metrics/ops paths — a
    // malformed metricsUrl must not reach `new Redis(dsn)`.
    if (!isRedisUrl(dsn)) {
      throw new Error('No Redis admin DSN configured for this service');
    }
    const client = getClientForDsn(dsn);
    for (const [key, val] of redisConfigSetPairs(managed)) {
      await client.config('SET', key, val);
    }
    await client.config('REWRITE');
    return null;
  } catch (error) {
    const message = (error as Error).message;
    logger.warn('Redis managed config live apply failed', { serviceId, error: message });
    return message;
  }
}

/** A base save reaches every enabled instance, each with its own override layered on top. */
async function applyRedisBaseToInstances(): Promise<string | null> {
  const failures: string[] = [];
  for (const service of await getEnabledFleetServices('redis')) {
    const { managed } = await getRedisConfigState(service.serviceId);
    const error = await applyRedisConfigLive(service.serviceId, managed);
    if (error) failures.push(`${service.serviceId}: ${error}`);
  }
  return failures.length > 0 ? failures.join('; ') : null;
}

export async function getRedisConfigRendered(serviceId: string): Promise<string> {
  const current = await getRedisConfigState(serviceId);
  return renderRedisConfig(current.managed);
}

// ---------------------------------------------------------------------------
// Live metrics (via `INFO`, `DBSIZE`, and a small `CONFIG GET` fallback)
// ---------------------------------------------------------------------------

export interface RedisLiveMetrics {
  serviceId: string;
  serviceType: 'redis';
  timestamp: Date;
  reachable: boolean;
  role: string;
  uptimeSecs: number;
  connectedClients: number;
  blockedClients: number;
  maxClients: number;
  memoryUsedBytes: number;
  memoryPeakBytes: number;
  memoryRssBytes: number;
  maxMemoryBytes: number;
  memFragmentationRatio: number;
  evictedKeys: number;
  expiredKeys: number;
  keyspaceHits: number;
  keyspaceMisses: number;
  hitRatio: number;
  instantaneousOpsPerSec: number;
  totalCommandsProcessed: number;
  totalConnectionsReceived: number;
  rejectedConnections: number;
  totalNetInputBytes: number;
  totalNetOutputBytes: number;
  connectedSlaves: number;
  masterLinkStatus: string;
  rdbChangesSinceLastSave: number;
  rdbLastSaveTime: number;
  rdbLastBgsaveStatus: string;
  aofEnabled: boolean;
  aofLastWriteStatus: string;
  dbKeys: number;
  dbExpires: number;
  pubsubChannels: number;
  rawInfo: string;
}

function parseRedisInfoMap(raw: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const idx = trimmed.indexOf(':');
    if (idx < 0) continue;
    map.set(trimmed.slice(0, idx), trimmed.slice(idx + 1));
  }
  return map;
}

function infoInt(map: Map<string, string>, key: string): number {
  const raw = map.get(key);
  if (raw === undefined) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
}

function infoFloat(map: Map<string, string>, key: string): number {
  const raw = map.get(key);
  if (raw === undefined) return 0;
  const n = Number.parseFloat(raw);
  return Number.isFinite(n) ? n : 0;
}

function infoBool(map: Map<string, string>, key: string): boolean {
  return map.get(key) === '1';
}

function infoStr(map: Map<string, string>, key: string): string {
  return map.get(key) ?? '';
}

// Sums the per-database `dbN:keys=X,expires=Y,avg_ttl=Z` lines in the
// Keyspace section into a single instance-wide {keys, expires} pair.
function sumKeyspace(map: Map<string, string>): { keys: number; expires: number } {
  let keys = 0;
  let expires = 0;
  for (const [name, value] of map) {
    if (!/^db\d+$/.test(name)) continue;
    const keysMatch = value.match(/keys=(\d+)/);
    const expiresMatch = value.match(/expires=(\d+)/);
    if (keysMatch) keys += Number.parseInt(keysMatch[1], 10);
    if (expiresMatch) expires += Number.parseInt(expiresMatch[1], 10);
  }
  return { keys, expires };
}

/** Parse a Redis `INFO` (all sections) response into flat metric fields. Pure — no I/O. */
export function parseRedisInfo(raw: string): Partial<RedisLiveMetrics> {
  const map = parseRedisInfoMap(raw);
  const { keys, expires } = sumKeyspace(map);
  const keyspaceHits = infoInt(map, 'keyspace_hits');
  const keyspaceMisses = infoInt(map, 'keyspace_misses');
  const hitTotal = keyspaceHits + keyspaceMisses;
  return {
    role: infoStr(map, 'role'),
    uptimeSecs: infoInt(map, 'uptime_in_seconds'),
    connectedClients: infoInt(map, 'connected_clients'),
    blockedClients: infoInt(map, 'blocked_clients'),
    maxClients: infoInt(map, 'maxclients'),
    memoryUsedBytes: infoInt(map, 'used_memory'),
    memoryPeakBytes: infoInt(map, 'used_memory_peak'),
    memoryRssBytes: infoInt(map, 'used_memory_rss'),
    maxMemoryBytes: infoInt(map, 'maxmemory'),
    memFragmentationRatio: infoFloat(map, 'mem_fragmentation_ratio'),
    evictedKeys: infoInt(map, 'evicted_keys'),
    expiredKeys: infoInt(map, 'expired_keys'),
    keyspaceHits,
    keyspaceMisses,
    hitRatio: hitTotal > 0 ? keyspaceHits / hitTotal : 0,
    instantaneousOpsPerSec: infoInt(map, 'instantaneous_ops_per_sec'),
    totalCommandsProcessed: infoInt(map, 'total_commands_processed'),
    totalConnectionsReceived: infoInt(map, 'total_connections_received'),
    rejectedConnections: infoInt(map, 'rejected_connections'),
    totalNetInputBytes: infoInt(map, 'total_net_input_bytes'),
    totalNetOutputBytes: infoInt(map, 'total_net_output_bytes'),
    connectedSlaves: infoInt(map, 'connected_slaves'),
    masterLinkStatus: infoStr(map, 'master_link_status'),
    rdbChangesSinceLastSave: infoInt(map, 'rdb_changes_since_last_save'),
    rdbLastSaveTime: infoInt(map, 'rdb_last_save_time'),
    rdbLastBgsaveStatus: infoStr(map, 'rdb_last_bgsave_status'),
    aofEnabled: infoBool(map, 'aof_enabled'),
    aofLastWriteStatus: infoStr(map, 'aof_last_write_status'),
    dbKeys: keys,
    dbExpires: expires,
    pubsubChannels: infoInt(map, 'pubsub_channels'),
  };
}

/**
 * Assemble a RedisLiveMetrics from a raw `INFO` reply shipped by a robin-agent.
 * robin-admin owns the parsing (parseRedisInfo); the agent just runs INFO.
 */
export function buildRedisSnapshotFromInfo(serviceId: string, info: string): RedisLiveMetrics {
  const base: RedisLiveMetrics = {
    serviceId, serviceType: 'redis', timestamp: new Date(), reachable: true,
    role: '', uptimeSecs: 0, connectedClients: 0, blockedClients: 0, maxClients: 0,
    memoryUsedBytes: 0, memoryPeakBytes: 0, memoryRssBytes: 0, maxMemoryBytes: 0, memFragmentationRatio: 0,
    evictedKeys: 0, expiredKeys: 0, keyspaceHits: 0, keyspaceMisses: 0, hitRatio: 0,
    instantaneousOpsPerSec: 0, totalCommandsProcessed: 0, totalConnectionsReceived: 0, rejectedConnections: 0,
    totalNetInputBytes: 0, totalNetOutputBytes: 0, connectedSlaves: 0, masterLinkStatus: '',
    rdbChangesSinceLastSave: 0, rdbLastSaveTime: 0, rdbLastBgsaveStatus: '', aofEnabled: false, aofLastWriteStatus: '',
    dbKeys: 0, dbExpires: 0, pubsubChannels: 0, rawInfo: info.slice(0, 8000),
  };
  Object.assign(base, parseRedisInfo(info));
  base.rawInfo = info.slice(0, 8000);
  return base;
}

export function isRedisUrl(value: string | null | undefined): value is string {
  return isDsnFor('redis', value);
}

async function collectRedisLiveMetrics(base: RedisLiveMetrics, dsn: string): Promise<RedisLiveMetrics> {
  const client = getClientForDsn(dsn);
  try {
    const info = await client.info();
    Object.assign(base, parseRedisInfo(info));
    base.rawInfo = info.slice(0, 8000);
    base.reachable = true;
  } catch (error) {
    logger.warn('Redis INFO failed', { serviceId: base.serviceId, error: (error as Error).message });
    return base;
  }

  // DBSIZE covers the client's currently selected logical database; it backs
  // up the Keyspace-section sum when the instance is otherwise empty of
  // dbN lines (e.g. right after a FLUSHALL/restart with no other databases).
  if (base.dbKeys === 0) {
    try {
      base.dbKeys = await client.dbsize();
    } catch {
      // non-fatal
    }
  }

  // Small CONFIG GET fallback for older/edge-case builds whose INFO omits
  // maxmemory/maxclients.
  if (base.maxMemoryBytes === 0 || base.maxClients === 0) {
    try {
      const [, maxmemory] = (await client.config('GET', 'maxmemory')) as unknown as [string, string];
      const [, maxclients] = (await client.config('GET', 'maxclients')) as unknown as [string, string];
      if (base.maxMemoryBytes === 0 && maxmemory) base.maxMemoryBytes = Number.parseInt(maxmemory, 10) || 0;
      if (base.maxClients === 0 && maxclients) base.maxClients = Number.parseInt(maxclients, 10) || 0;
    } catch {
      // non-fatal
    }
  }

  return base;
}

export async function getRedisLiveMetrics(serviceId: string): Promise<RedisLiveMetrics> {
  const base: RedisLiveMetrics = {
    serviceId,
    serviceType: 'redis',
    timestamp: new Date(),
    reachable: false,
    role: '',
    uptimeSecs: 0,
    connectedClients: 0,
    blockedClients: 0,
    maxClients: 0,
    memoryUsedBytes: 0,
    memoryPeakBytes: 0,
    memoryRssBytes: 0,
    maxMemoryBytes: 0,
    memFragmentationRatio: 0,
    evictedKeys: 0,
    expiredKeys: 0,
    keyspaceHits: 0,
    keyspaceMisses: 0,
    hitRatio: 0,
    instantaneousOpsPerSec: 0,
    totalCommandsProcessed: 0,
    totalConnectionsReceived: 0,
    rejectedConnections: 0,
    totalNetInputBytes: 0,
    totalNetOutputBytes: 0,
    connectedSlaves: 0,
    masterLinkStatus: '',
    rdbChangesSinceLastSave: 0,
    rdbLastSaveTime: 0,
    rdbLastBgsaveStatus: '',
    aofEnabled: false,
    aofLastWriteStatus: '',
    dbKeys: 0,
    dbExpires: 0,
    pubsubChannels: 0,
    rawInfo: '',
  };

  // The 'default' base layer has no running server to probe.
  if (serviceId === DEFAULT_SCOPE_ID) {
    return base;
  }

  const service = await getResolvedService(serviceId);
  const dsn = resolveRedisDsn(service);
  if (!isRedisUrl(dsn)) {
    logger.warn('No usable Redis admin DSN for service', { serviceId });
    return base;
  }
  return collectRedisLiveMetrics(base, dsn);
}

export async function getRedisRawStats(serviceId: string): Promise<string> {
  const metrics = await getRedisLiveMetrics(serviceId);
  return metrics.rawInfo;
}

export async function getRedisStatus(serviceId: string) {
  const [config, metrics] = await Promise.all([
    getRedisConfigState(serviceId),
    getRedisLiveMetrics(serviceId).catch(() => null),
  ]);
  return {
    serviceId,
    serviceName: config.serviceName,
    reachable: metrics?.reachable ?? false,
    managed: config.managed,
    metrics,
  };
}

export async function reloadRedis(serviceId: string): Promise<string> {
  const service = await getResolvedService(serviceId);
  const dsn = resolveRedisDsn(service);
  if (!isRedisUrl(dsn)) {
    throw new Error('No Redis admin DSN configured for this service');
  }
  const client = getClientForDsn(dsn);
  const result = await client.config('REWRITE');
  return String(result || 'OK');
}

// ---------------------------------------------------------------------------
// Ops (observability + safe operational actions — no FLUSH*/data-loss commands)
// ---------------------------------------------------------------------------

async function getConnectedClient(serviceId: string): Promise<Redis> {
  const service = await getResolvedService(serviceId);
  const dsn = resolveRedisDsn(service);
  if (!isRedisUrl(dsn)) {
    throw new Error('No Redis admin DSN configured for this service');
  }
  return getClientForDsn(dsn);
}

export interface RedisSlowlogEntry {
  id: number;
  timestampEpoch: number;
  durationMicros: number;
  command: string[];
  clientAddress: string;
  clientName: string;
}

/** Parse the raw array-of-arrays response from `SLOWLOG GET`. Pure — no I/O. */
export function parseRedisSlowlogEntries(raw: unknown[]): RedisSlowlogEntry[] {
  const entries: RedisSlowlogEntry[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 4) continue;
    entries.push({
      id: Number(row[0]) || 0,
      timestampEpoch: Number(row[1]) || 0,
      durationMicros: Number(row[2]) || 0,
      command: Array.isArray(row[3]) ? row[3].map(String) : [],
      clientAddress: row.length > 4 ? String(row[4]) : '',
      clientName: row.length > 5 ? String(row[5]) : '',
    });
  }
  return entries;
}

export async function getRedisSlowlog(serviceId: string, count = 25): Promise<RedisSlowlogEntry[]> {
  const client = await getConnectedClient(serviceId);
  const safeCount = normalizeInteger(count, 25, 1);
  const raw = (await client.slowlog('GET', safeCount)) as unknown[];
  return parseRedisSlowlogEntries(raw);
}

export async function resetRedisSlowlog(serviceId: string): Promise<string> {
  const client = await getConnectedClient(serviceId);
  const result = await client.slowlog('RESET');
  return String(result ?? 'OK');
}

export interface RedisClientInfo {
  id: number;
  addr: string;
  name: string;
  ageSecs: number;
  idleSecs: number;
  db: number;
  cmd: string;
  user: string;
}

/** Parse the raw `CLIENT LIST` text (one client per line, space-separated `k=v` pairs). Pure — no I/O. */
export function parseRedisClientList(raw: string): RedisClientInfo[] {
  const clients: RedisClientInfo[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const fields = new Map<string, string>();
    for (const pair of trimmed.split(' ')) {
      const eq = pair.indexOf('=');
      if (eq < 0) continue;
      fields.set(pair.slice(0, eq), pair.slice(eq + 1));
    }
    clients.push({
      id: Number.parseInt(fields.get('id') ?? '', 10) || 0,
      addr: fields.get('addr') ?? '',
      name: fields.get('name') ?? '',
      ageSecs: Number.parseInt(fields.get('age') ?? '', 10) || 0,
      idleSecs: Number.parseInt(fields.get('idle') ?? '', 10) || 0,
      db: Number.parseInt(fields.get('db') ?? '', 10) || 0,
      cmd: fields.get('cmd') ?? '',
      user: fields.get('user') ?? '',
    });
  }
  return clients;
}

export async function getRedisClients(serviceId: string): Promise<RedisClientInfo[]> {
  const client = await getConnectedClient(serviceId);
  const raw = (await client.client('LIST')) as unknown as string;
  return parseRedisClientList(raw);
}

function assertValidClientId(clientId: unknown): number {
  const n = typeof clientId === 'number' ? clientId : Number.parseInt(String(clientId ?? ''), 10);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error('Invalid Redis client id');
  }
  return n;
}

export async function killRedisClient(serviceId: string, clientId: string | number): Promise<string> {
  const id = assertValidClientId(clientId);
  const client = await getConnectedClient(serviceId);
  const result = await client.client('KILL', 'ID', String(id));
  return String(result ?? '0');
}

export async function redisBgsave(serviceId: string): Promise<string> {
  const client = await getConnectedClient(serviceId);
  const result = await client.bgsave();
  return String(result ?? 'Background saving started');
}

export async function redisBgrewriteaof(serviceId: string): Promise<string> {
  const client = await getConnectedClient(serviceId);
  const result = await client.bgrewriteaof();
  return String(result ?? 'Background append only file rewriting started');
}

export async function redisResetStats(serviceId: string): Promise<string> {
  const client = await getConnectedClient(serviceId);
  const result = await client.config('RESETSTAT');
  return String(result ?? 'OK');
}

export interface RedisLatencyEvent {
  event: string;
  latestMs: number;
  latestTimestampEpoch: number;
}

/** Parse the raw array-of-arrays response from `LATENCY LATEST`. Pure — no I/O. */
export function parseRedisLatencyLatest(raw: unknown[]): RedisLatencyEvent[] {
  const events: RedisLatencyEvent[] = [];
  for (const row of raw) {
    if (!Array.isArray(row) || row.length < 4) continue;
    events.push({
      event: String(row[0]),
      latestTimestampEpoch: Number(row[1]) || 0,
      latestMs: Number(row[2]) || 0,
    });
  }
  return events;
}

export async function getRedisLatency(serviceId: string): Promise<RedisLatencyEvent[]> {
  const client = await getConnectedClient(serviceId);
  const raw = (await client.latency('LATEST')) as unknown[];
  return parseRedisLatencyLatest(raw);
}
