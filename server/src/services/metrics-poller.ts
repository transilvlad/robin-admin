/**
 * Metrics polling service for all supported fleet service types.
 */

import { query } from '../db/connection.js';
import { AGENT_RAW_TYPES } from './capability-rules.js';
import { getConfig } from '../db/queries/config.js';
import {
  getEnabledMetricsFleetServices,
  getMetricsFleetServiceById,
  getPrimaryMetricsFleetService,
  type MetricsFleetService,
  type MetricsServiceType,
} from '../db/queries/service-metrics.js';
import { setFleetServiceSoftwareVersion } from '../db/queries/fleet-services.js';
import {
  getFleetServiceSecret,
  RSPAMD_CONTROLLER_PASSWORD_SECRET,
  RSPAMD_ENABLE_PASSWORD_SECRET,
} from '../db/queries/fleet-service-secrets.js';
import { recordFleetServiceObservation } from '../db/queries/fleet-service-observations.js';
import { logger } from '../logger.js';
import {
  getClamavLiveMetrics,
  getClamavRawStats,
  buildClamavSnapshotFromRaw,
  type ClamavLiveMetrics,
} from './clamav.js';
import {
  getDovecotLiveMetrics,
  buildDovecotSnapshotFromRaw,
  type DovecotLiveMetrics,
} from './dovecot.js';
import {
  getPostfixLiveMetrics,
  buildPostfixSnapshotFromRaw,
  countPostfixLogLines,
  type PostfixLiveMetrics,
  type PostfixMessageCounters,
} from './postfix.js';
import {
  getRedisLiveMetrics,
  getRedisRawStats,
  buildRedisSnapshotFromInfo,
  type RedisLiveMetrics,
} from './redis.js';
import {
  getPostgresLiveMetrics,
  getPostgresRawStats,
  buildPostgresSnapshotFromRaw,
  type PostgresLiveMetrics,
} from './postgres.js';
import {
  MARIADB_NUMERIC_FIELDS,
  buildMariadbSnapshotFromRaw,
  carryMariadbSize,
  emptyMariadbMetrics,
  enforceMariadbConfig,
  getMariadbLiveMetrics,
  getMariadbRawStats,
  hasCachedMariadbSize,
  type MariadbLiveMetrics,
} from './mariadb.js';

const POLL_INTERVAL_MS = parseInt(process.env.METRICS_POLL_INTERVAL || '60000', 10);
const RETENTION_DAYS = parseInt(process.env.METRICS_RETENTION_DAYS || '14', 10);

interface RobinMetricsSample {
  timestamp: Date;
  emailReceiptStart: number;
  emailReceiptSuccess: number;
  emailReceiptLimit: number;
  emailReceiptException: number;
  rblRejections: number;
  virusRejections: number;
  spamRejections: number;
  dosRatelimitRejections: number;
  dosConnlimitRejections: number;
  dosTarpitCount: number;
  dosSlowtransferRejections: number;
  dosCommandfloodRejections: number;
  whitelistBypasses: number;
  adaptiveRatelimitApplied: number;
  geoipBlockRejections: number;
  geoipLimitApplied: number;
  distributedStoreErrors: number;
  jvmMemoryUsed: number;
  jvmMemoryMax: number;
  jvmMemoryCommitted: number;
  jvmThreadsLive: number;
  jvmThreadsDaemon: number;
  jvmThreadsPeak: number;
  jvmThreadsStarted: number;
  jvmGcPauseSeconds: number;
  jvmGcPauseCount: number;
  jvmGcMemoryAllocated: number;
  jvmGcMemoryPromoted: number;
  jvmGcLiveDataSize: number;
  jvmGcMaxDataSize: number;
  jvmBufferCount: number;
  jvmBufferMemoryUsed: number;
  jvmBufferTotalCapacity: number;
  cpuUsage: number;
  processCpuUsage: number;
  // Cumulative Robin process CPU time; not stored, only used to derive
  // processCpuUsage between consecutive polls.
  processCpuTimeNs: number;
  systemCpuCount: number;
  systemLoadAverage: number;
}

export interface RobinMetricsSnapshot extends RobinMetricsSample {
  serviceId: string | null;
  serviceType: 'robin';
}

export interface RobinMetricsHistoryRow extends RobinMetricsSnapshot {
  rateEmailStart: number;
  rateEmailSuccess: number;
  rateRejections: number;
}

export interface RspamdMetricsSnapshot {
  serviceId: string | null;
  serviceType: 'rspamd';
  timestamp: Date;
  controllerReachable: boolean;
  controllerAuthenticated: boolean;
  controllerStatusCode: number | null;
  controllerPingOk: boolean;
  controllerPingStatusCode: number | null;
  controllerHealthyOk: boolean;
  controllerHealthyStatusCode: number | null;
  controllerStatAuthenticated: boolean;
  controllerStatStatusCode: number | null;
  normalWorkerPingOk: boolean;
  normalWorkerPingStatusCode: number | null;
  scannedMessages: number;
  learnedSpam: number;
  learnedHam: number;
  actionsAddHeader: number;
  actionsReject: number;
  actionsSoftReject: number;
  actionsGreylist: number;
  actionsNoAction: number;
  actionsRewriteSubject: number;
  actionsDiscard: number;
  actionsQuarantine: number;
  spamMessages: number;
  hamMessages: number;
  connections: number;
  uptimeSeconds: number;
  memoryAllocatedBytes: number;
  memoryResidentBytes: number;
  rawMetrics: Record<string, unknown>;
}

export interface RspamdMetricsHistoryRow extends RspamdMetricsSnapshot {}

export interface ClamavMetricsHistoryRow extends ClamavLiveMetrics {}

export interface DovecotMetricsHistoryRow extends DovecotLiveMetrics {}

export interface PostfixMetricsHistoryRow extends PostfixLiveMetrics {}

export interface RedisMetricsHistoryRow extends RedisLiveMetrics {}

export interface PostgresMetricsHistoryRow extends PostgresLiveMetrics {}

export interface MariadbMetricsHistoryRow extends MariadbLiveMetrics {}

export type ServiceMetricsSnapshot = RobinMetricsSnapshot | RspamdMetricsSnapshot | ClamavLiveMetrics | DovecotLiveMetrics | PostfixLiveMetrics | RedisLiveMetrics | PostgresLiveMetrics | MariadbLiveMetrics;
export type ServiceMetricsHistoryRow = RobinMetricsHistoryRow | RspamdMetricsHistoryRow | ClamavMetricsHistoryRow | DovecotMetricsHistoryRow | PostfixMetricsHistoryRow | RedisMetricsHistoryRow | PostgresMetricsHistoryRow | MariadbMetricsHistoryRow;

type HistoryTable = 'robin_metrics_history' | 'rspamd_metrics_history' | 'clamav_metrics_history' | 'dovecot_metrics_history' | 'postfix_metrics_history' | 'redis_metrics_history' | 'postgres_metrics_history' | 'mariadb_metrics_history';
export type { MetricsServiceType } from '../db/queries/service-metrics.js';

interface RobinRates {
  rateEmailStart: number;
  rateEmailSuccess: number;
  rateRejections: number;
}

interface EndpointProbe {
  ok: boolean;
  reachable: boolean;
  statusCode: number | null;
}

interface TextResponse extends EndpointProbe {
  text: string | null;
}

interface PrometheusResponse extends TextResponse {
  metrics: Map<string, number>;
}

interface JsonResponse extends EndpointProbe {
  data: Record<string, unknown> | null;
}

interface RobinHistoryRowDb {
  fleet_service_id: number;
  timestamp: Date;
  service_id: string;
  current_service_id?: string | null;
  email_receipt_start: number | string;
  email_receipt_success: number | string;
  email_receipt_limit: number | string;
  email_receipt_exception: number | string | null;
  rbl_rejections: number | string;
  virus_rejections: number | string;
  spam_rejections: number | string;
  dos_ratelimit_rejections: number | string;
  dos_connlimit_rejections: number | string;
  dos_tarpit_count: number | string;
  dos_slowtransfer_rejections: number | string;
  dos_commandflood_rejections: number | string;
  whitelist_bypasses: number | string;
  adaptive_ratelimit_applied: number | string;
  geoip_block_rejections: number | string;
  geoip_limit_applied: number | string;
  distributed_store_errors: number | string;
  jvm_memory_used: number | string;
  jvm_memory_max: number | string;
  jvm_memory_committed: number | string | null;
  jvm_threads_live: number | string;
  jvm_threads_daemon: number | string | null;
  jvm_threads_peak: number | string | null;
  jvm_threads_started: number | string | null;
  jvm_gc_pause_seconds: number | string;
  jvm_gc_pause_count: number | string | null;
  jvm_gc_memory_allocated: number | string | null;
  jvm_gc_memory_promoted: number | string | null;
  jvm_gc_live_data_size: number | string | null;
  jvm_gc_max_data_size: number | string | null;
  jvm_buffer_count: number | string | null;
  jvm_buffer_memory_used: number | string | null;
  jvm_buffer_total_capacity: number | string | null;
  cpu_usage: number | string;
  process_cpu_usage: number | string | null;
  process_cpu_time_ns: number | string | null;
  system_cpu_count: number | string | null;
  system_load_average: number | string | null;
  rate_email_start: number | string;
  rate_email_success: number | string;
  rate_rejections: number | string;
}

interface RspamdHistoryRowDb {
  fleet_service_id: number;
  timestamp: Date;
  service_id: string;
  current_service_id?: string | null;
  controller_reachable: boolean;
  controller_authenticated: boolean;
  controller_status_code: number | null;
  controller_ping_ok: boolean;
  controller_ping_status_code: number | null;
  controller_healthy_ok: boolean;
  controller_healthy_status_code: number | null;
  controller_stat_authenticated: boolean;
  controller_stat_status_code: number | null;
  normal_worker_ping_ok: boolean;
  normal_worker_ping_status_code: number | null;
  scanned_messages: number | string;
  learned_spam: number | string;
  learned_ham: number | string;
  actions_add_header: number | string;
  actions_reject: number | string;
  actions_soft_reject: number | string;
  actions_greylist: number | string;
  actions_no_action: number | string;
  actions_rewrite_subject: number | string;
  actions_discard: number | string;
  actions_quarantine: number | string;
  spam_messages: number | string;
  ham_messages: number | string;
  connections: number | string;
  uptime_seconds: number | string;
  memory_allocated_bytes: number | string;
  memory_resident_bytes: number | string;
  raw_metrics: Record<string, unknown> | null;
}

interface ClamavHistoryRowDb {
  fleet_service_id: number;
  timestamp: Date;
  service_id: string;
  current_service_id?: string | null;
  ping_ok: boolean;
  version_text: string | null;
  engine_version: string | null;
  database_version: number | string | null;
  database_updated_at: Date | null;
  status_text: string | null;
  pools: number | string;
  threads_live: number | string;
  threads_idle: number | string;
  threads_max: number | string;
  queue_items: number | string;
  memory_heap_mb: number | string;
  memory_mmap_mb: number | string;
  memory_used_mb: number | string;
  memory_free_mb: number | string;
  memory_releasable_mb: number | string;
  memory_pools_used_mb: number | string;
  memory_pools_total_mb: number | string;
  raw_stats: string | null;
}

interface DovecotHistoryRowDb {
  fleet_service_id: number;
  timestamp: Date;
  service_id: string;
  current_service_id?: string | null;
  reachable: boolean;
  auth_success: number | string;
  auth_failure: number | string;
  login_count: number | string;
  imap_commands: number | string;
  mail_deliveries: number | string;
  session_count: number | string;
  user_count: number | string;
  raw_stats: string | null;
}

interface PostfixHistoryRowDb {
  fleet_service_id: number;
  timestamp: Date;
  service_id: string;
  current_service_id?: string | null;
  reachable: boolean;
  queue_active: number | string;
  queue_deferred: number | string;
  queue_hold: number | string;
  queue_incoming: number | string;
  queue_total: number | string;
  oldest_deferred_age_secs: number | string;
  messages_delivered: number | string;
  messages_deferred: number | string;
  messages_bounced: number | string;
  messages_rejected: number | string;
  raw_stats: string | null;
}

interface RedisHistoryRowDb {
  fleet_service_id: number;
  timestamp: Date;
  service_id: string;
  current_service_id?: string | null;
  reachable: boolean;
  role: string;
  uptime_secs: number | string;
  connected_clients: number | string;
  blocked_clients: number | string;
  max_clients: number | string;
  memory_used_bytes: number | string;
  memory_peak_bytes: number | string;
  memory_rss_bytes: number | string;
  max_memory_bytes: number | string;
  mem_fragmentation_ratio: number | string;
  evicted_keys: number | string;
  expired_keys: number | string;
  keyspace_hits: number | string;
  keyspace_misses: number | string;
  hit_ratio: number | string;
  instantaneous_ops_per_sec: number | string;
  total_commands_processed: number | string;
  total_connections_received: number | string;
  rejected_connections: number | string;
  total_net_input_bytes: number | string;
  total_net_output_bytes: number | string;
  connected_slaves: number | string;
  master_link_status: string;
  rdb_changes_since_last_save: number | string;
  rdb_last_save_time: number | string;
  rdb_last_bgsave_status: string;
  aof_enabled: boolean;
  aof_last_write_status: string;
  db_keys: number | string;
  db_expires: number | string;
  pubsub_channels: number | string;
  raw_info: string | null;
}

interface PostgresHistoryRowDb {
  fleet_service_id: number;
  timestamp: Date;
  service_id: string;
  current_service_id?: string | null;
  reachable: boolean;
  server_version_num: number | string;
  connections_total: number | string;
  connections_active: number | string;
  connections_idle: number | string;
  connections_idle_in_txn: number | string;
  connections_waiting: number | string;
  max_connections: number | string;
  connection_saturation_pct: number | string;
  xact_commit: number | string;
  xact_rollback: number | string;
  commit_ratio: number | string;
  blks_hit: number | string;
  blks_read: number | string;
  cache_hit_ratio: number | string;
  tup_returned: number | string;
  tup_fetched: number | string;
  tup_inserted: number | string;
  tup_updated: number | string;
  tup_deleted: number | string;
  deadlocks: number | string;
  temp_files: number | string;
  temp_bytes: number | string;
  conflicts: number | string;
  database_size_bytes: number | string;
  oldest_xact_age_secs: number | string;
  oldest_idle_in_txn_secs: number | string;
  blocked_queries: number | string;
  checkpoints_timed: number | string;
  checkpoints_req: number | string;
  buffers_checkpoint: number | string;
  replication_lag_bytes: number | string;
  dead_tuples_total: number | string;
  raw_stats: string | null;
}

let pollInterval: NodeJS.Timeout | null = null;
let pollInFlight = false;
// The running cycle, so shutdown can let it finish before the pools close.
let currentPoll: Promise<void> | null = null;
let pollStarting = false;
let pollStartGeneration = 0;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toNumber(value: unknown): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : 0;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : 0;
  }
  return 0;
}

function parsePrometheus(text: string): Map<string, number> {
  const metrics = new Map<string, number>();

  for (const line of text.split('\n')) {
    if (line.startsWith('#') || !line.trim()) continue;

    const trimmed = line.trim();
    const lastSpace = trimmed.lastIndexOf(' ');
    if (lastSpace === -1) continue;

    const key = trimmed.substring(0, lastSpace);
    const value = parseFloat(trimmed.substring(lastSpace + 1));

    if (!Number.isNaN(value)) {
      metrics.set(key, value);
    }
  }

  return metrics;
}

function parseGraphite(text: string): Map<string, number> {
  const metrics = new Map<string, number>();

  for (const line of text.split('\n')) {
    if (!line.trim()) continue;

    const parts = line.trim().split(/\s+/);
    if (parts.length < 2) continue;

    const key = parts[0];
    const value = parseFloat(parts[1]);
    if (Number.isNaN(value)) continue;

    if (metrics.has(key)) {
      let index = 2;
      while (metrics.has(`${key}_${index}`)) {
        index += 1;
      }
      metrics.set(`${key}_${index}`, value);
    } else {
      metrics.set(key, value);
    }
  }

  return metrics;
}

function getMetric(metrics: Map<string, number>, key: string): number {
  if (metrics.has(key)) {
    return metrics.get(key) ?? 0;
  }

  for (const [candidate, value] of metrics) {
    const base = candidate.split('{')[0];
    if (base === key) {
      return value;
    }
  }

  return 0;
}

function getMetricFromAliases(metrics: Map<string, number>, aliases: string[]): number {
  for (const alias of aliases) {
    const value = getMetric(metrics, alias);
    if (value !== 0) {
      return value;
    }
  }
  return 0;
}

function getLabeledMetric(
  metrics: Map<string, number>,
  baseName: string,
  labelName: string,
  labelValue: string
): number {
  const labelPattern = new RegExp(`${labelName}="${labelValue.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`);

  for (const [key, value] of metrics) {
    const [base, labels] = key.split('{');
    if (base === baseName && labels && labelPattern.test(labels)) {
      return value;
    }
  }

  return 0;
}

function sumMetrics(metrics: Map<string, number>, prefix: string): number {
  let total = 0;

  for (const [key, value] of metrics) {
    const base = key.split('{')[0];
    if (base === prefix || key.startsWith(prefix)) {
      total += value;
    }
  }

  return total;
}

function sumMetricsMatching(
  metrics: Map<string, number>,
  prefix: string,
  filter: (key: string) => boolean
): number {
  let total = 0;

  for (const [key, value] of metrics) {
    const base = key.split('{')[0];
    if ((base === prefix || key.startsWith(prefix)) && filter(key) && value >= 0) {
      total += value;
    }
  }

  return total;
}

function sumMetricsFromAliases(metrics: Map<string, number>, aliases: string[]): number {
  for (const alias of aliases) {
    const total = sumMetrics(metrics, alias);
    if (total !== 0) {
      return total;
    }
  }
  return 0;
}

function buildUrl(baseUrl: string, suffix: string): string {
  return `${baseUrl.replace(/\/$/, '')}${suffix}`;
}

function emptyProbe(): EndpointProbe {
  return { ok: false, reachable: false, statusCode: null };
}

function emptyPrometheusResponse(): PrometheusResponse {
  return { ...emptyProbe(), text: null, metrics: new Map() };
}

function emptyJsonResponse(): JsonResponse {
  return { ...emptyProbe(), data: null };
}

async function fetchText(url: string, headers?: Record<string, string>): Promise<TextResponse> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'text/plain',
        ...headers,
      },
      signal: AbortSignal.timeout(10000),
    });

    return {
      ok: response.ok,
      reachable: true,
      statusCode: response.status,
      text: await response.text(),
    };
  } catch {
    return { ok: false, reachable: false, statusCode: null, text: null };
  }
}

async function fetchJson(url: string, headers?: Record<string, string>): Promise<JsonResponse> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
        ...headers,
      },
      signal: AbortSignal.timeout(10000),
    });

    let data: Record<string, unknown> | null = null;
    try {
      const parsed = await response.json();
      data = isRecord(parsed) ? parsed : null;
    } catch {
      data = null;
    }

    return {
      ok: response.ok,
      reachable: true,
      statusCode: response.status,
      data,
    };
  } catch {
    return emptyJsonResponse();
  }
}

async function probeEndpoint(url: string, headers?: Record<string, string>): Promise<EndpointProbe> {
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(10000),
    });

    return {
      ok: response.ok,
      reachable: true,
      statusCode: response.status,
    };
  } catch {
    return emptyProbe();
  }
}

async function fetchGraphiteMetrics(metricsUrl: string): Promise<Map<string, number>> {
  const response = await fetchText(buildUrl(metricsUrl, '/metrics/graphite'));
  if (!response.ok || response.text === null) {
    throw new Error(`HTTP ${response.statusCode ?? 'unreachable'} while fetching Robin graphite metrics`);
  }
  return parseGraphite(response.text);
}

async function fetchPrometheusMetrics(metricsUrl: string): Promise<Map<string, number>> {
  const response = await fetchText(buildUrl(metricsUrl, '/metrics/prometheus'));
  if (!response.ok || response.text === null) {
    throw new Error(`HTTP ${response.statusCode ?? 'unreachable'} while fetching Robin Prometheus metrics`);
  }
  return parsePrometheus(response.text);
}

async function fetchRobinMetrics(metricsUrl: string): Promise<Map<string, number>> {
  const [graphiteMetrics, prometheusMetrics] = await Promise.all([
    fetchGraphiteMetrics(metricsUrl),
    fetchPrometheusMetrics(metricsUrl),
  ]);

  const merged = new Map<string, number>();
  const prometheusNames = new Set<string>();

  for (const [key, value] of prometheusMetrics) {
    merged.set(key, value);
    prometheusNames.add(key.split('{')[0]);
  }

  // Graphite only fills gaps: it flattens labelled counters (such as receipt
  // exceptions by type) to a single series, which must not replace the
  // labelled Prometheus series.
  for (const [key, value] of graphiteMetrics) {
    if (key.startsWith('robin_') && !prometheusNames.has(key) && !prometheusNames.has(`${key}_total`)) {
      merged.set(`${key}_total`, value);
      merged.set(key, value);
    }
  }

  return merged;
}

function extractRobinSample(metrics: Map<string, number>): RobinMetricsSample {
  const heapUsed = sumMetricsMatching(metrics, 'jvm_memory_used_bytes', (key) => key.includes('area="heap"'));
  const heapMax = getMetric(metrics, 'jvm_memory_max_bytes{area="heap",id="G1 Old Gen"}');
  const heapCommitted = sumMetricsMatching(metrics, 'jvm_memory_committed_bytes', (key) => key.includes('area="heap"'));

  return {
    timestamp: new Date(),
    emailReceiptStart: getMetric(metrics, 'robin_email_receipt_start_total'),
    emailReceiptSuccess: getMetric(metrics, 'robin_email_receipt_success_total'),
    emailReceiptLimit: getMetric(metrics, 'robin_email_receipt_limit_total'),
    emailReceiptException: sumMetricsMatching(metrics, 'robin_email_receipt_exception_total', () => true),
    rblRejections: getMetric(metrics, 'robin_email_rbl_rejection_total'),
    virusRejections: getMetric(metrics, 'robin_email_virus_rejection_total'),
    spamRejections: getMetric(metrics, 'robin_email_spam_rejection_total'),
    dosRatelimitRejections: getMetric(metrics, 'robin_dos_ratelimit_rejection_total'),
    dosConnlimitRejections: getMetric(metrics, 'robin_dos_connectionlimit_rejection_total'),
    dosTarpitCount: getMetric(metrics, 'robin_dos_tarpit_total'),
    dosSlowtransferRejections: getMetric(metrics, 'robin_dos_slowtransfer_rejection_total'),
    dosCommandfloodRejections: getMetric(metrics, 'robin_dos_commandflood_rejection_total'),
    whitelistBypasses: getMetric(metrics, 'robin_whitelist_bypass_total'),
    adaptiveRatelimitApplied: getMetric(metrics, 'robin_adaptive_ratelimit_applied_total'),
    geoipBlockRejections: getMetric(metrics, 'robin_geoip_block_rejection_total'),
    geoipLimitApplied: getMetric(metrics, 'robin_geoip_limit_applied_total'),
    distributedStoreErrors: getMetric(metrics, 'robin_distributed_store_error_total'),
    jvmMemoryUsed: heapUsed,
    jvmMemoryMax: heapMax,
    jvmMemoryCommitted: heapCommitted,
    jvmThreadsLive: getMetric(metrics, 'jvm_threads_live_threads'),
    jvmThreadsDaemon: getMetric(metrics, 'jvm_threads_daemon_threads'),
    jvmThreadsPeak: getMetric(metrics, 'jvm_threads_peak_threads'),
    jvmThreadsStarted: getMetric(metrics, 'jvm_threads_started_threads_total'),
    jvmGcPauseSeconds: sumMetrics(metrics, 'jvm_gc_pause_seconds_sum'),
    jvmGcPauseCount: sumMetrics(metrics, 'jvm_gc_pause_seconds_count'),
    jvmGcMemoryAllocated: getMetric(metrics, 'jvm_gc_memory_allocated_bytes_total'),
    jvmGcMemoryPromoted: getMetric(metrics, 'jvm_gc_memory_promoted_bytes_total'),
    jvmGcLiveDataSize: getMetric(metrics, 'jvm_gc_live_data_size_bytes'),
    jvmGcMaxDataSize: getMetric(metrics, 'jvm_gc_max_data_size_bytes'),
    jvmBufferCount: sumMetrics(metrics, 'jvm_buffer_count_buffers'),
    jvmBufferMemoryUsed: sumMetrics(metrics, 'jvm_buffer_memory_used_bytes'),
    jvmBufferTotalCapacity: sumMetrics(metrics, 'jvm_buffer_total_capacity_bytes'),
    cpuUsage: getMetric(metrics, 'system_cpu_usage'),
    processCpuUsage: getMetric(metrics, 'process_cpu_usage'),
    processCpuTimeNs: getMetric(metrics, 'process_cpu_time_ns_total'),
    systemCpuCount: getMetric(metrics, 'system_cpu_count'),
    systemLoadAverage: getMetric(metrics, 'system_load_average_1m'),
  };
}

function withRobinMetadata(serviceId: string | null, sample: RobinMetricsSample): RobinMetricsSnapshot {
  return {
    serviceId,
    serviceType: 'robin',
    ...sample,
  };
}

/**
 * Assemble a Robin snapshot from the raw Prometheus text a co-located agent
 * shipped (agent mode) — the agent fetches `/metrics/prometheus` locally and
 * forwards it. Rates are derived downstream from stored history, as for the
 * direct poll; graphite (a supplementary direct source) is simply absent here.
 */
export function buildRobinSnapshotFromRaw(serviceId: string, prometheusText: string): RobinMetricsSnapshot {
  return withRobinMetadata(serviceId, extractRobinSample(parsePrometheus(prometheusText)));
}

/**
 * Robin's CPU gauges cover only the time since their previous read, so a read
 * moments after another scrape returns 0 or one whole core. Derive the process
 * CPU share from the cumulative CPU-time counter across polls instead, and
 * keep the gauge only when there is no usable previous sample.
 */
export function withRobinProcessCpu(current: RobinMetricsSnapshot, previous: RobinMetricsSnapshot | null): RobinMetricsSnapshot {
  if (!previous || current.processCpuTimeNs <= 0 || previous.processCpuTimeNs <= 0 || current.systemCpuCount <= 0) {
    return current;
  }
  const elapsedNs = (current.timestamp.getTime() - previous.timestamp.getTime()) * 1e6;
  const cpuNs = current.processCpuTimeNs - previous.processCpuTimeNs;
  if (elapsedNs <= 0 || cpuNs < 0) return current;
  return { ...current, processCpuUsage: Math.min(1, cpuNs / (elapsedNs * current.systemCpuCount)) };
}

function calculateRobinRates(current: RobinMetricsSnapshot, previous: RobinMetricsSnapshot | null): RobinRates {
  if (!previous) {
    return { rateEmailStart: 0, rateEmailSuccess: 0, rateRejections: 0 };
  }

  const dtMinutes = Math.max((current.timestamp.getTime() - previous.timestamp.getTime()) / 60000, 0.001);
  const deltaStart = Math.max(0, current.emailReceiptStart - previous.emailReceiptStart);
  const deltaSuccess = Math.max(0, current.emailReceiptSuccess - previous.emailReceiptSuccess);

  const currentRejections = current.rblRejections + current.virusRejections + current.spamRejections +
    current.dosRatelimitRejections + current.dosConnlimitRejections;
  const previousRejections = previous.rblRejections + previous.virusRejections + previous.spamRejections +
    previous.dosRatelimitRejections + previous.dosConnlimitRejections;

  return {
    rateEmailStart: Math.round((Math.max(0, deltaStart) / dtMinutes) * 100) / 100,
    rateEmailSuccess: Math.round((Math.max(0, deltaSuccess) / dtMinutes) * 100) / 100,
    rateRejections: Math.round((Math.max(0, currentRejections - previousRejections) / dtMinutes) * 100) / 100,
  };
}

async function storeRobinSnapshot(
  snapshot: RobinMetricsSnapshot,
  rates: RobinRates,
  fleetServiceId: number | null
): Promise<void> {
  if (!snapshot.serviceId || fleetServiceId === null) {
    return;
  }

  await query(
    `INSERT INTO robin_metrics_history (
       fleet_service_id,
       service_id,
       timestamp,
       email_receipt_start, email_receipt_success, email_receipt_limit, email_receipt_exception,
       rbl_rejections, virus_rejections, spam_rejections,
       dos_ratelimit_rejections, dos_connlimit_rejections, dos_tarpit_count,
       dos_slowtransfer_rejections, dos_commandflood_rejections,
       whitelist_bypasses, adaptive_ratelimit_applied,
       geoip_block_rejections, geoip_limit_applied,
       distributed_store_errors,
       jvm_memory_used, jvm_memory_max, jvm_memory_committed,
       jvm_threads_live, jvm_threads_daemon, jvm_threads_peak, jvm_threads_started,
       jvm_gc_pause_seconds, jvm_gc_pause_count,
       jvm_gc_memory_allocated, jvm_gc_memory_promoted, jvm_gc_live_data_size, jvm_gc_max_data_size,
       jvm_buffer_count, jvm_buffer_memory_used, jvm_buffer_total_capacity,
       cpu_usage, process_cpu_usage, process_cpu_time_ns, system_cpu_count, system_load_average,
       rate_email_start, rate_email_success, rate_rejections
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
       $23, $24, $25, $26, $27, $28, $29, $30, $31, $32,
       $33, $34, $35, $36, $37, $38, $39, $40, $41, $42, $43, $44
      )`,
    [
      fleetServiceId,
      snapshot.serviceId,
      snapshot.timestamp,
      snapshot.emailReceiptStart, snapshot.emailReceiptSuccess, snapshot.emailReceiptLimit, snapshot.emailReceiptException,
      snapshot.rblRejections, snapshot.virusRejections, snapshot.spamRejections,
      snapshot.dosRatelimitRejections, snapshot.dosConnlimitRejections, snapshot.dosTarpitCount,
      snapshot.dosSlowtransferRejections, snapshot.dosCommandfloodRejections,
      snapshot.whitelistBypasses, snapshot.adaptiveRatelimitApplied,
      snapshot.geoipBlockRejections, snapshot.geoipLimitApplied,
      snapshot.distributedStoreErrors,
      snapshot.jvmMemoryUsed, snapshot.jvmMemoryMax, snapshot.jvmMemoryCommitted,
      snapshot.jvmThreadsLive, snapshot.jvmThreadsDaemon, snapshot.jvmThreadsPeak, snapshot.jvmThreadsStarted,
      snapshot.jvmGcPauseSeconds, snapshot.jvmGcPauseCount,
      snapshot.jvmGcMemoryAllocated, snapshot.jvmGcMemoryPromoted, snapshot.jvmGcLiveDataSize, snapshot.jvmGcMaxDataSize,
      snapshot.jvmBufferCount, snapshot.jvmBufferMemoryUsed, snapshot.jvmBufferTotalCapacity,
      snapshot.cpuUsage, snapshot.processCpuUsage, Math.round(snapshot.processCpuTimeNs), snapshot.systemCpuCount, snapshot.systemLoadAverage,
      rates.rateEmailStart, rates.rateEmailSuccess, rates.rateRejections,
    ]
  );
}

function normalizeRspamdActionKey(value: string): string {
  return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
}

function getNestedStatObject(
  stat: Record<string, unknown> | null,
  key: string
): Record<string, unknown> | null {
  if (!stat) {
    return null;
  }

  const value = stat[key];
  return isRecord(value) ? value : null;
}

function getStatNumber(stat: Record<string, unknown> | null, aliases: string[]): number {
  if (!stat) {
    return 0;
  }

  for (const alias of aliases) {
    if (alias in stat) {
      const value = toNumber(stat[alias]);
      if (value !== 0) {
        return value;
      }
    }
  }

  return 0;
}

function getRspamdActionFromStat(stat: Record<string, unknown> | null, actionName: string): number {
  const actions = getNestedStatObject(stat, 'actions');
  if (!actions) {
    return 0;
  }

  const normalizedTarget = normalizeRspamdActionKey(actionName);

  for (const [key, value] of Object.entries(actions)) {
    if (normalizeRspamdActionKey(key) === normalizedTarget) {
      if (isRecord(value)) {
        return toNumber(value.count ?? value.value ?? value.total);
      }
      return toNumber(value);
    }
  }

  return 0;
}

function sumRspamdStatfiles(stat: Record<string, unknown> | null, aliases: string[]): number {
  if (!stat) {
    return 0;
  }

  const statfiles = stat.statfiles;
  if (!Array.isArray(statfiles)) {
    return 0;
  }

  return statfiles.reduce((total, item) => {
    if (!isRecord(item)) {
      return total;
    }

    for (const alias of aliases) {
      if (alias in item) {
        return total + toNumber(item[alias]);
      }
    }

    return total;
  }, 0);
}

function getRspamdMemoryStat(stat: Record<string, unknown> | null, field: string): number {
  const memory = getNestedStatObject(stat, 'memory');
  if (!memory) {
    return 0;
  }
  return toNumber(memory[field]);
}

export async function getRspamdAuthHeaders(serviceId: string): Promise<Record<string, string> | undefined> {
  const controllerPassword = await getFleetServiceSecret(serviceId, RSPAMD_CONTROLLER_PASSWORD_SECRET);
  const enablePassword = controllerPassword
    ? null
    : await getFleetServiceSecret(serviceId, RSPAMD_ENABLE_PASSWORD_SECRET);
  const password = controllerPassword || enablePassword;
  return password ? { Password: password } : undefined;
}

export function getRspamdControllerBase(service: MetricsFleetService): string | null {
  return service.controllerUrl ?? service.metricsUrl ?? service.apiUrl;
}

function getRspamdNormalBase(service: MetricsFleetService): string | null {
  return service.normalUrl ?? service.apiUrl;
}

async function fetchRspamdPrometheusMetrics(
  controllerBase: string,
  headers?: Record<string, string>
): Promise<PrometheusResponse> {
  const response = await fetchText(buildUrl(controllerBase, '/metrics'), headers);
  return {
    ...response,
    metrics: response.ok && response.text !== null ? parsePrometheus(response.text) : new Map<string, number>(),
  };
}

async function fetchRspamdStat(
  controllerBase: string,
  headers?: Record<string, string>
): Promise<JsonResponse> {
  return fetchJson(buildUrl(controllerBase, '/stat'), headers);
}

function buildRspamdSnapshot(
  serviceId: string,
  metricsResponse: PrometheusResponse,
  statResponse: JsonResponse,
  pingProbe: EndpointProbe,
  healthyProbe: EndpointProbe,
  normalProbe: EndpointProbe
): RspamdMetricsSnapshot {
  const metrics = metricsResponse.metrics;
  const stat = statResponse.data;

  const actionsAddHeader = getMetricFromAliases(metrics, ['rspamd_actions_add_header', 'rspamd_actions_addheader'])
    || getLabeledMetric(metrics, 'rspamd_actions_total', 'type', 'add header')
    || getRspamdActionFromStat(stat, 'add header');
  const actionsReject = getMetricFromAliases(metrics, ['rspamd_actions_reject'])
    || getLabeledMetric(metrics, 'rspamd_actions_total', 'type', 'reject')
    || getRspamdActionFromStat(stat, 'reject');
  const actionsSoftReject = getMetricFromAliases(metrics, ['rspamd_actions_soft_reject', 'rspamd_actions_softreject'])
    || getLabeledMetric(metrics, 'rspamd_actions_total', 'type', 'soft reject')
    || getRspamdActionFromStat(stat, 'soft reject');
  const actionsGreylist = getMetricFromAliases(metrics, ['rspamd_actions_greylist'])
    || getLabeledMetric(metrics, 'rspamd_actions_total', 'type', 'greylist')
    || getRspamdActionFromStat(stat, 'greylist');
  const actionsNoAction = getMetricFromAliases(metrics, ['rspamd_actions_no_action', 'rspamd_actions_noaction'])
    || getLabeledMetric(metrics, 'rspamd_actions_total', 'type', 'no action')
    || getRspamdActionFromStat(stat, 'no action');
  const actionsRewriteSubject = getMetricFromAliases(metrics, ['rspamd_actions_rewrite_subject', 'rspamd_actions_rewritesubject'])
    || getLabeledMetric(metrics, 'rspamd_actions_total', 'type', 'rewrite subject')
    || getRspamdActionFromStat(stat, 'rewrite subject');
  const actionsDiscard = getMetricFromAliases(metrics, ['rspamd_actions_discard'])
    || getLabeledMetric(metrics, 'rspamd_actions_total', 'type', 'discard')
    || getRspamdActionFromStat(stat, 'discard');
  const actionsQuarantine = getMetricFromAliases(metrics, ['rspamd_actions_quarantine'])
    || getLabeledMetric(metrics, 'rspamd_actions_total', 'type', 'quarantine')
    || getRspamdActionFromStat(stat, 'quarantine');

  const rawMetrics: Record<string, unknown> = {
    prometheus: Object.fromEntries(metrics.entries()),
    stat,
  };

  return {
    serviceId,
    serviceType: 'rspamd',
    timestamp: new Date(),
    controllerReachable: metricsResponse.reachable || pingProbe.reachable || healthyProbe.reachable || statResponse.reachable,
    controllerAuthenticated: metricsResponse.ok || statResponse.ok,
    controllerStatusCode: metricsResponse.statusCode,
    controllerPingOk: pingProbe.ok,
    controllerPingStatusCode: pingProbe.statusCode,
    controllerHealthyOk: healthyProbe.ok,
    controllerHealthyStatusCode: healthyProbe.statusCode,
    controllerStatAuthenticated: statResponse.ok,
    controllerStatStatusCode: statResponse.statusCode,
    normalWorkerPingOk: normalProbe.ok,
    normalWorkerPingStatusCode: normalProbe.statusCode,
    scannedMessages: getMetricFromAliases(metrics, ['rspamd_scanned_total', 'rspamd_stats_scanned', 'rspamd_stat_scanned', 'rspamd_scanned'])
      || getStatNumber(stat, ['scanned', 'messages_scanned', 'scans']),
    learnedSpam: sumMetricsFromAliases(metrics, ['rspamd_statfiles_learned_spam'])
      || sumRspamdStatfiles(stat, ['learned_spam', 'spam']),
    learnedHam: sumMetricsFromAliases(metrics, ['rspamd_statfiles_learned_ham'])
      || sumRspamdStatfiles(stat, ['learned_ham', 'ham']),
    actionsAddHeader,
    actionsReject,
    actionsSoftReject,
    actionsGreylist,
    actionsNoAction,
    actionsRewriteSubject,
    actionsDiscard,
    actionsQuarantine,
    spamMessages: getMetricFromAliases(metrics, ['rspamd_spam_total', 'rspamd_stats_spam_count', 'rspamd_stat_spam_count', 'rspamd_spam_count'])
      || getStatNumber(stat, ['spam_count', 'spam']),
    hamMessages: getMetricFromAliases(metrics, ['rspamd_ham_total', 'rspamd_stats_ham_count', 'rspamd_stat_ham_count', 'rspamd_ham_count'])
      || getStatNumber(stat, ['ham_count', 'ham']),
    connections: getMetricFromAliases(metrics, ['rspamd_stats_connections', 'rspamd_stat_connections', 'rspamd_connections'])
      || getStatNumber(stat, ['connections']),
    uptimeSeconds: getMetricFromAliases(metrics, ['rspamd_stats_uptime', 'rspamd_stat_uptime', 'rspamd_uptime'])
      || getStatNumber(stat, ['uptime']),
    memoryAllocatedBytes: getMetricFromAliases(metrics, ['rspamd_stats_bytes_allocated', 'rspamd_bytes_allocated', 'bytes_allocated'])
      || getRspamdMemoryStat(stat, 'virtual'),
    memoryResidentBytes: getMetricFromAliases(metrics, [
      'process_resident_memory_bytes',
      'rspamd_process_resident_memory_bytes',
      'rspamd_stats_memory_resident',
      'rspamd_memory_resident',
    ]) || getRspamdMemoryStat(stat, 'resident'),
    rawMetrics,
  };
}

/**
 * Assemble an Rspamd snapshot from the raw endpoint bodies a co-located agent
 * shipped (agent mode): the controller `/metrics` (Prometheus text) and `/stat`
 * (JSON). robin-admin can't reach the controller on that host, so the agent
 * fetches them locally and forwards the text. Reachability probes are synthesised
 * from whether each body arrived (the agent only forwards what it could fetch).
 */
export function buildRspamdSnapshotFromRaw(
  serviceId: string,
  metricsText?: string,
  statJson?: string
): RspamdMetricsSnapshot {
  const hasMetrics = typeof metricsText === 'string' && metricsText.trim().length > 0;
  const metricsResponse: PrometheusResponse = {
    ok: hasMetrics,
    reachable: hasMetrics,
    statusCode: hasMetrics ? 200 : null,
    text: hasMetrics ? metricsText! : null,
    metrics: hasMetrics ? parsePrometheus(metricsText!) : new Map<string, number>(),
  };
  let statData: Record<string, unknown> | null = null;
  if (typeof statJson === 'string' && statJson.trim()) {
    try {
      const parsed = JSON.parse(statJson);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) statData = parsed as Record<string, unknown>;
    } catch {
      statData = null;
    }
  }
  const statResponse: JsonResponse = {
    ok: statData !== null,
    reachable: typeof statJson === 'string' && statJson.trim().length > 0,
    statusCode: statData !== null ? 200 : null,
    data: statData,
  };
  const up = hasMetrics || statData !== null;
  const probe: EndpointProbe = { ok: up, reachable: up, statusCode: up ? 200 : null };
  return buildRspamdSnapshot(serviceId, metricsResponse, statResponse, probe, probe, probe);
}

async function collectRspamdSnapshot(service: MetricsFleetService): Promise<RspamdMetricsSnapshot | null> {
  const controllerBase = getRspamdControllerBase(service);
  const normalBase = getRspamdNormalBase(service);

  if (!controllerBase && !normalBase) {
    return null;
  }

  const authHeaders = controllerBase ? await getRspamdAuthHeaders(service.serviceId) : undefined;
  const [metricsResponse, statResponse, pingProbe, healthyProbe, normalProbe] = await Promise.all([
    normalBase
      ? fetchRspamdPrometheusMetrics(normalBase)
      : controllerBase
        ? fetchRspamdPrometheusMetrics(controllerBase, authHeaders)
        : Promise.resolve(emptyPrometheusResponse()),
    controllerBase ? fetchRspamdStat(controllerBase, authHeaders) : Promise.resolve(emptyJsonResponse()),
    controllerBase ? probeEndpoint(buildUrl(controllerBase, '/ping')) : Promise.resolve(emptyProbe()),
    controllerBase ? probeEndpoint(buildUrl(controllerBase, '/healthy')) : Promise.resolve(emptyProbe()),
    normalBase ? probeEndpoint(buildUrl(normalBase, '/ping')) : Promise.resolve(emptyProbe()),
  ]);

  const anyReachable = metricsResponse.reachable || statResponse.reachable || pingProbe.reachable ||
    healthyProbe.reachable || normalProbe.reachable;

  if (!anyReachable) {
    return null;
  }

  return buildRspamdSnapshot(service.serviceId, metricsResponse, statResponse, pingProbe, healthyProbe, normalProbe);
}

async function storeRspamdSnapshot(
  snapshot: RspamdMetricsSnapshot,
  fleetServiceId: number | null
): Promise<void> {
  if (!snapshot.serviceId || fleetServiceId === null) {
    return;
  }

  await query(
    `INSERT INTO rspamd_metrics_history (
       fleet_service_id,
       service_id,
       timestamp,
       controller_reachable,
       controller_authenticated,
       controller_status_code,
       controller_ping_ok,
       controller_ping_status_code,
       controller_healthy_ok,
       controller_healthy_status_code,
       controller_stat_authenticated,
       controller_stat_status_code,
       normal_worker_ping_ok,
       normal_worker_ping_status_code,
       scanned_messages,
       learned_spam,
       learned_ham,
       actions_add_header,
       actions_reject,
       actions_soft_reject,
       actions_greylist,
       actions_no_action,
       actions_rewrite_subject,
       actions_discard,
       actions_quarantine,
       spam_messages,
       ham_messages,
       connections,
       uptime_seconds,
       memory_allocated_bytes,
       memory_resident_bytes,
       raw_metrics
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
       $13, $14, $15, $16, $17, $18, $19, $20, $21, $22,
       $23, $24, $25, $26, $27, $28, $29, $30, $31, $32::jsonb
      )`,
    [
      fleetServiceId,
      snapshot.serviceId,
      snapshot.timestamp,
      snapshot.controllerReachable,
      snapshot.controllerAuthenticated,
      snapshot.controllerStatusCode,
      snapshot.controllerPingOk,
      snapshot.controllerPingStatusCode,
      snapshot.controllerHealthyOk,
      snapshot.controllerHealthyStatusCode,
      snapshot.controllerStatAuthenticated,
      snapshot.controllerStatStatusCode,
      snapshot.normalWorkerPingOk,
      snapshot.normalWorkerPingStatusCode,
      snapshot.scannedMessages,
      snapshot.learnedSpam,
      snapshot.learnedHam,
      snapshot.actionsAddHeader,
      snapshot.actionsReject,
      snapshot.actionsSoftReject,
      snapshot.actionsGreylist,
      snapshot.actionsNoAction,
      snapshot.actionsRewriteSubject,
      snapshot.actionsDiscard,
      snapshot.actionsQuarantine,
      snapshot.spamMessages,
      snapshot.hamMessages,
      snapshot.connections,
      snapshot.uptimeSeconds,
      snapshot.memoryAllocatedBytes,
      snapshot.memoryResidentBytes,
      JSON.stringify(snapshot.rawMetrics ?? {}),
    ]
  );
}

async function storeClamavSnapshot(
  snapshot: ClamavLiveMetrics,
  fleetServiceId: number | null
): Promise<void> {
  if (!snapshot.serviceId || fleetServiceId === null) {
    return;
  }

  await query(
    `INSERT INTO clamav_metrics_history (
       fleet_service_id,
       service_id,
       timestamp,
       ping_ok,
       version_text,
       engine_version,
       database_version,
       database_updated_at,
       status_text,
       pools,
       threads_live,
       threads_idle,
       threads_max,
       queue_items,
       memory_heap_mb,
       memory_mmap_mb,
       memory_used_mb,
       memory_free_mb,
       memory_releasable_mb,
       memory_pools_used_mb,
       memory_pools_total_mb,
       raw_stats
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14,
       $15, $16, $17, $18, $19, $20, $21, $22
      )`,
    [
      fleetServiceId,
      snapshot.serviceId,
      snapshot.timestamp,
      snapshot.pingOk,
      snapshot.versionText,
      snapshot.engineVersion,
      snapshot.databaseVersion,
      snapshot.databaseUpdatedAt,
      snapshot.statusText,
      snapshot.pools,
      snapshot.threadsLive,
      snapshot.threadsIdle,
      snapshot.threadsMax,
      snapshot.queueItems,
      snapshot.memoryHeapMB,
      snapshot.memoryMmapMB,
      snapshot.memoryUsedMB,
      snapshot.memoryFreeMB,
      snapshot.memoryReleasableMB,
      snapshot.memoryPoolsUsedMB,
      snapshot.memoryPoolsTotalMB,
      snapshot.rawStats,
    ]
  );
}

async function storeDovecotSnapshot(
  snapshot: DovecotLiveMetrics,
  fleetServiceId: number | null
): Promise<void> {
  if (!snapshot.serviceId || fleetServiceId === null) {
    return;
  }

  await query(
    `INSERT INTO dovecot_metrics_history (
       fleet_service_id,
       service_id,
       timestamp,
       reachable,
       auth_success,
       auth_failure,
       login_count,
       imap_commands,
       mail_deliveries,
       session_count,
       user_count,
       raw_stats
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12
      )`,
    [
      fleetServiceId,
      snapshot.serviceId,
      snapshot.timestamp,
      snapshot.reachable,
      snapshot.authSuccess,
      snapshot.authFailure,
      snapshot.loginCount,
      snapshot.imapCommands,
      snapshot.mailDeliveries,
      snapshot.sessionCount,
      snapshot.userCount,
      snapshot.rawStats,
    ]
  );
}

// Cumulative Postfix message counters live in postfix_message_counters, so
// every server replica adds to the same totals and a restart keeps them. A
// service without a counters row starts from its newest stored snapshot.
const POSTFIX_LATEST_COUNTERS = `
  SELECT messages_delivered, messages_deferred, messages_bounced, messages_rejected
  FROM postfix_metrics_history
  WHERE fleet_service_id = $1
  ORDER BY timestamp DESC
  LIMIT 1`;

async function postfixCountersFor(fleetServiceId: number): Promise<PostfixMessageCounters> {
  const { rows: [row] } = await query<{ messages_delivered: string; messages_deferred: string; messages_bounced: string; messages_rejected: string }>(
    `SELECT messages_delivered, messages_deferred, messages_bounced, messages_rejected
     FROM (
       SELECT 0 AS source, messages_delivered, messages_deferred, messages_bounced, messages_rejected
       FROM postfix_message_counters WHERE fleet_service_id = $1
       UNION ALL
       SELECT 1, * FROM (${POSTFIX_LATEST_COUNTERS}) latest
     ) candidates
     ORDER BY source
     LIMIT 1`,
    [fleetServiceId]
  );
  return {
    messagesDelivered: Number(row?.messages_delivered ?? 0),
    messagesDeferred: Number(row?.messages_deferred ?? 0),
    messagesBounced: Number(row?.messages_bounced ?? 0),
    messagesRejected: Number(row?.messages_rejected ?? 0),
  };
}

/**
 * Fold new Postfix log lines (an agent's incremental log push) into the
 * service's cumulative message counters; the next queue snapshot stores them.
 * One atomic upsert, so concurrent pushes to different replicas both count.
 */
export async function ingestPostfixLogLines(fleetServiceId: number, lines: string[]): Promise<void> {
  const added = countPostfixLogLines(lines);
  if (!added.messagesDelivered && !added.messagesDeferred && !added.messagesBounced && !added.messagesRejected) {
    return;
  }
  await query(
    `INSERT INTO postfix_message_counters AS counters (
       fleet_service_id, messages_delivered, messages_deferred, messages_bounced, messages_rejected
     )
     SELECT $1,
            COALESCE(latest.messages_delivered, 0) + $2::bigint,
            COALESCE(latest.messages_deferred, 0) + $3::bigint,
            COALESCE(latest.messages_bounced, 0) + $4::bigint,
            COALESCE(latest.messages_rejected, 0) + $5::bigint
     FROM (SELECT 1) seed
     LEFT JOIN LATERAL (${POSTFIX_LATEST_COUNTERS}) latest ON true
     ON CONFLICT (fleet_service_id) DO UPDATE SET
       messages_delivered = counters.messages_delivered + $2::bigint,
       messages_deferred = counters.messages_deferred + $3::bigint,
       messages_bounced = counters.messages_bounced + $4::bigint,
       messages_rejected = counters.messages_rejected + $5::bigint,
       updated_at = CURRENT_TIMESTAMP`,
    [fleetServiceId, added.messagesDelivered, added.messagesDeferred, added.messagesBounced, added.messagesRejected]
  );
}

// A postfix_exporter reports queue depth only; the message counters come from
// the log lines a log agent pushes (ingestPostfixLogLines), so a direct
// service with a log agent still counts deliveries.
async function withPostfixLogCounters(snapshot: PostfixLiveMetrics, fleetServiceId: number): Promise<PostfixLiveMetrics> {
  return { ...snapshot, ...await postfixCountersFor(fleetServiceId) };
}

async function storePostfixSnapshot(
  snapshot: PostfixLiveMetrics,
  fleetServiceId: number | null
): Promise<void> {
  if (!snapshot.serviceId || fleetServiceId === null) {
    return;
  }

  await query(
    `INSERT INTO postfix_metrics_history (
       fleet_service_id,
       service_id,
       timestamp,
       reachable,
       queue_active,
       queue_deferred,
       queue_hold,
       queue_incoming,
       queue_total,
       oldest_deferred_age_secs,
       messages_delivered,
       messages_deferred,
       messages_bounced,
       messages_rejected,
       raw_stats
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15
      )`,
    [
      fleetServiceId,
      snapshot.serviceId,
      snapshot.timestamp,
      snapshot.reachable,
      snapshot.queueActive,
      snapshot.queueDeferred,
      snapshot.queueHold,
      snapshot.queueIncoming,
      snapshot.queueTotal,
      snapshot.oldestDeferredAgeSecs,
      snapshot.messagesDelivered,
      snapshot.messagesDeferred,
      snapshot.messagesBounced,
      snapshot.messagesRejected,
      snapshot.rawStats,
    ]
  );
}

async function storeRedisSnapshot(
  snapshot: RedisLiveMetrics,
  fleetServiceId: number | null
): Promise<void> {
  if (!snapshot.serviceId || fleetServiceId === null) {
    return;
  }

  await query(
    `INSERT INTO redis_metrics_history (
       fleet_service_id,
       service_id,
       timestamp,
       reachable,
       role,
       uptime_secs,
       connected_clients,
       blocked_clients,
       max_clients,
       memory_used_bytes,
       memory_peak_bytes,
       memory_rss_bytes,
       max_memory_bytes,
       mem_fragmentation_ratio,
       evicted_keys,
       expired_keys,
       keyspace_hits,
       keyspace_misses,
       hit_ratio,
       instantaneous_ops_per_sec,
       total_commands_processed,
       total_connections_received,
       rejected_connections,
       total_net_input_bytes,
       total_net_output_bytes,
       connected_slaves,
       master_link_status,
       rdb_changes_since_last_save,
       rdb_last_save_time,
       rdb_last_bgsave_status,
       aof_enabled,
       aof_last_write_status,
       db_keys,
       db_expires,
       pubsub_channels,
       raw_info
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36
      )`,
    [
      fleetServiceId,
      snapshot.serviceId,
      snapshot.timestamp,
      snapshot.reachable,
      snapshot.role,
      snapshot.uptimeSecs,
      snapshot.connectedClients,
      snapshot.blockedClients,
      snapshot.maxClients,
      snapshot.memoryUsedBytes,
      snapshot.memoryPeakBytes,
      snapshot.memoryRssBytes,
      snapshot.maxMemoryBytes,
      snapshot.memFragmentationRatio,
      snapshot.evictedKeys,
      snapshot.expiredKeys,
      snapshot.keyspaceHits,
      snapshot.keyspaceMisses,
      snapshot.hitRatio,
      snapshot.instantaneousOpsPerSec,
      snapshot.totalCommandsProcessed,
      snapshot.totalConnectionsReceived,
      snapshot.rejectedConnections,
      snapshot.totalNetInputBytes,
      snapshot.totalNetOutputBytes,
      snapshot.connectedSlaves,
      snapshot.masterLinkStatus,
      snapshot.rdbChangesSinceLastSave,
      snapshot.rdbLastSaveTime,
      snapshot.rdbLastBgsaveStatus,
      snapshot.aofEnabled,
      snapshot.aofLastWriteStatus,
      snapshot.dbKeys,
      snapshot.dbExpires,
      snapshot.pubsubChannels,
      snapshot.rawInfo,
    ]
  );
}

async function storePostgresSnapshot(
  snapshot: PostgresLiveMetrics,
  fleetServiceId: number | null
): Promise<void> {
  if (!snapshot.serviceId || fleetServiceId === null) {
    return;
  }

  await query(
    `INSERT INTO postgres_metrics_history (
       fleet_service_id,
       service_id,
       timestamp,
       reachable,
       server_version_num,
       connections_total,
       connections_active,
       connections_idle,
       connections_idle_in_txn,
       connections_waiting,
       max_connections,
       connection_saturation_pct,
       xact_commit,
       xact_rollback,
       commit_ratio,
       blks_hit,
       blks_read,
       cache_hit_ratio,
       tup_returned,
       tup_fetched,
       tup_inserted,
       tup_updated,
       tup_deleted,
       deadlocks,
       temp_files,
       temp_bytes,
       conflicts,
       database_size_bytes,
       oldest_xact_age_secs,
       oldest_idle_in_txn_secs,
       blocked_queries,
       checkpoints_timed,
       checkpoints_req,
       buffers_checkpoint,
       replication_lag_bytes,
       dead_tuples_total,
       raw_stats
      ) VALUES (
       $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
       $19, $20, $21, $22, $23, $24, $25, $26, $27, $28, $29, $30, $31, $32, $33, $34, $35, $36,
       $37
      )`,
    [
      fleetServiceId,
      snapshot.serviceId,
      snapshot.timestamp,
      snapshot.reachable,
      snapshot.serverVersionNum,
      snapshot.connectionsTotal,
      snapshot.connectionsActive,
      snapshot.connectionsIdle,
      snapshot.connectionsIdleInTxn,
      snapshot.connectionsWaiting,
      snapshot.maxConnections,
      snapshot.connectionSaturationPct,
      snapshot.xactCommit,
      snapshot.xactRollback,
      snapshot.commitRatio,
      snapshot.blksHit,
      snapshot.blksRead,
      snapshot.cacheHitRatio,
      snapshot.tupReturned,
      snapshot.tupFetched,
      snapshot.tupInserted,
      snapshot.tupUpdated,
      snapshot.tupDeleted,
      snapshot.deadlocks,
      snapshot.tempFiles,
      snapshot.tempBytes,
      snapshot.conflicts,
      snapshot.databaseSizeBytes,
      snapshot.oldestXactAgeSecs,
      snapshot.oldestIdleInTxnSecs,
      snapshot.blockedQueries,
      snapshot.checkpointsTimed,
      snapshot.checkpointsReq,
      snapshot.buffersCheckpoint,
      snapshot.replicationLagBytes,
      snapshot.deadTuplesTotal,
      snapshot.rawStats,
    ]
  );
}

const snakeCase = (key: string) => key.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
const MARIADB_NUMERIC_COLUMNS = MARIADB_NUMERIC_FIELDS.map(snakeCase);
const MARIADB_COLUMNS = [
  'fleet_service_id', 'service_id', 'timestamp', 'reachable', 'version', ...MARIADB_NUMERIC_COLUMNS,
  'database_size_bytes', 'is_replica', 'replica_io_running', 'replica_sql_running', 'seconds_behind_source', 'raw_stats',
];

/** Fill a snapshot that skipped the slow size query from the last stored one. */
async function withKnownMariadbSize(snapshot: MariadbLiveMetrics, fleetServiceId: number): Promise<MariadbLiveMetrics> {
  if (snapshot.databaseSizeBytes !== null || hasCachedMariadbSize(snapshot.serviceId)) {
    return carryMariadbSize(snapshot);
  }
  const result = await query<{ database_size_bytes: string | null }>(
    `SELECT database_size_bytes FROM mariadb_metrics_history
     WHERE fleet_service_id = $1 AND database_size_bytes IS NOT NULL
     ORDER BY timestamp DESC LIMIT 1`,
    [fleetServiceId]
  );
  const stored = result.rows[0]?.database_size_bytes;
  return carryMariadbSize(snapshot, stored === undefined || stored === null ? null : toNumber(stored));
}

async function storeMariadbSnapshot(snapshot: MariadbLiveMetrics, fleetServiceId: number | null): Promise<void> {
  if (!snapshot.serviceId || fleetServiceId === null) {
    return;
  }
  const values: unknown[] = [
    fleetServiceId,
    snapshot.serviceId,
    snapshot.timestamp,
    snapshot.reachable,
    snapshot.version.slice(0, 128),
    ...MARIADB_NUMERIC_FIELDS.map((field) => snapshot[field]),
    snapshot.databaseSizeBytes,
    snapshot.isReplica,
    snapshot.replicaIoRunning,
    snapshot.replicaSqlRunning,
    snapshot.secondsBehindSource,
    snapshot.rawStats,
  ];
  await query(
    `INSERT INTO mariadb_metrics_history (${MARIADB_COLUMNS.join(', ')})
     VALUES (${values.map((_, index) => `$${index + 1}`).join(', ')})`,
    values
  );
}

async function pruneOldMetrics(): Promise<void> {
  try {
    const config = await getConfig();
    const retentionDays = Math.max(1, Math.min(3650, config.metricsRetentionDays || RETENTION_DAYS));
    const [robinResult, rspamdResult, clamavResult, dovecotResult, postfixResult, redisResult, postgresResult, mariadbResult] = await Promise.all([
      query(
        `DELETE FROM robin_metrics_history
         WHERE timestamp < NOW() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
      ),
      query(
        `DELETE FROM rspamd_metrics_history
         WHERE timestamp < NOW() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
      ),
      query(
        `DELETE FROM clamav_metrics_history
         WHERE timestamp < NOW() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
      ),
      query(
        `DELETE FROM dovecot_metrics_history
         WHERE timestamp < NOW() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
      ),
      query(
        `DELETE FROM postfix_metrics_history
         WHERE timestamp < NOW() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
      ),
      query(
        `DELETE FROM redis_metrics_history
         WHERE timestamp < NOW() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
      ),
      query(
        `DELETE FROM postgres_metrics_history
         WHERE timestamp < NOW() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
      ),
      query(
        `DELETE FROM mariadb_metrics_history
         WHERE timestamp < NOW() - ($1::int * INTERVAL '1 day')`,
        [retentionDays]
      ),
    ]);

    const pruned = (robinResult.rowCount ?? 0) + (rspamdResult.rowCount ?? 0) + (clamavResult.rowCount ?? 0) + (dovecotResult.rowCount ?? 0) + (postfixResult.rowCount ?? 0) + (redisResult.rowCount ?? 0) + (postgresResult.rowCount ?? 0) + (mariadbResult.rowCount ?? 0);
    if (pruned > 0) {
      logger.debug(`Pruned ${pruned} old metrics records`);
    }
  } catch (error) {
    logger.error('Failed to prune old metrics', { error: (error as Error).message });
  }
}

async function resolveRobinService(serviceId?: string): Promise<MetricsFleetService | null> {
  if (serviceId && serviceId !== 'default') {
    return getMetricsFleetServiceById(serviceId, 'robin');
  }
  return getPrimaryMetricsFleetService('robin');
}

async function resolveRspamdService(serviceId?: string): Promise<MetricsFleetService | null> {
  if (serviceId) {
    return getMetricsFleetServiceById(serviceId, 'rspamd');
  }
  return getPrimaryMetricsFleetService('rspamd');
}

async function resolveClamavService(serviceId?: string): Promise<MetricsFleetService | null> {
  if (serviceId) {
    return getMetricsFleetServiceById(serviceId, 'clamav');
  }
  return getPrimaryMetricsFleetService('clamav');
}

async function resolveDovecotService(serviceId?: string): Promise<MetricsFleetService | null> {
  if (serviceId) {
    return getMetricsFleetServiceById(serviceId, 'dovecot');
  }
  return getPrimaryMetricsFleetService('dovecot');
}

async function resolvePostfixService(serviceId?: string): Promise<MetricsFleetService | null> {
  if (serviceId) {
    return getMetricsFleetServiceById(serviceId, 'postfix');
  }
  return getPrimaryMetricsFleetService('postfix');
}

async function resolveRedisService(serviceId?: string): Promise<MetricsFleetService | null> {
  if (serviceId) {
    return getMetricsFleetServiceById(serviceId, 'redis');
  }
  return getPrimaryMetricsFleetService('redis');
}

async function resolvePostgresService(serviceId?: string): Promise<MetricsFleetService | null> {
  if (serviceId) {
    return getMetricsFleetServiceById(serviceId, 'postgres');
  }
  return getPrimaryMetricsFleetService('postgres');
}

async function resolveMariadbService(serviceId?: string): Promise<MetricsFleetService | null> {
  if (serviceId) {
    return getMetricsFleetServiceById(serviceId, 'mariadb');
  }
  return getPrimaryMetricsFleetService('mariadb');
}

function getDefaultRobinMetricsUrl(): string {
  return process.env.ROBIN_METRICS_URL || 'http://localhost:8080';
}

export async function getLiveRobinMetrics(serviceId?: string): Promise<RobinMetricsSnapshot | null> {
  try {
    const service = await resolveRobinService(serviceId);

    if (serviceId && serviceId !== 'default' && !service) {
      logger.debug('Robin service not found for live metrics', { serviceId });
      return null;
    }

    if (service?.collectionMode === 'agent') {
      return getLatestAgentSnapshot('robin', service.serviceId) as Promise<RobinMetricsSnapshot | null>;
    }

    const metricsUrl = service?.metricsUrl || service?.apiUrl || getDefaultRobinMetricsUrl();
    const serviceKey = service?.serviceId ?? 'default';
    const raw = await fetchRobinMetrics(metricsUrl);
    return withRobinMetadata(serviceKey, extractRobinSample(raw));
  } catch (error) {
    logger.debug('Failed to fetch Robin live metrics', { serviceId, error: (error as Error).message });
    return null;
  }
}

export async function getLiveRspamdMetrics(serviceId?: string): Promise<RspamdMetricsSnapshot | null> {
  try {
    const service = await resolveRspamdService(serviceId);
    if (!service) {
      logger.debug('Rspamd service not found for live metrics', { serviceId });
      return null;
    }
    if (service.collectionMode === 'agent') {
      return getLatestAgentSnapshot('rspamd', service.serviceId) as Promise<RspamdMetricsSnapshot | null>;
    }
    return collectRspamdSnapshot(service);
  } catch (error) {
    logger.debug('Failed to fetch Rspamd live metrics', { serviceId, error: (error as Error).message });
    return null;
  }
}

export async function getLiveClamavMetrics(serviceId?: string): Promise<ClamavLiveMetrics | null> {
  try {
    const service = await resolveClamavService(serviceId);
    if (!service) {
      logger.debug('ClamAV service not found for live metrics', { serviceId });
      return null;
    }
    if (service.collectionMode === 'agent') {
      return getLatestAgentSnapshot('clamav', service.serviceId) as Promise<ClamavLiveMetrics | null>;
    }
    return getClamavLiveMetrics(service.serviceId);
  } catch (error) {
    logger.debug('Failed to fetch ClamAV live metrics', { serviceId, error: (error as Error).message });
    return null;
  }
}

export async function getLiveDovecotMetrics(serviceId?: string): Promise<DovecotLiveMetrics | null> {
  try {
    const service = await resolveDovecotService(serviceId);
    if (!service) {
      logger.debug('Dovecot service not found for live metrics', { serviceId });
      return null;
    }
    if (service.collectionMode === 'agent') {
      return getLatestAgentSnapshot('dovecot', service.serviceId) as Promise<DovecotLiveMetrics | null>;
    }
    return getDovecotLiveMetrics(service.serviceId);
  } catch (error) {
    logger.debug('Failed to fetch Dovecot live metrics', { serviceId, error: (error as Error).message });
    return null;
  }
}

export async function getLivePostfixMetrics(serviceId?: string): Promise<PostfixLiveMetrics | null> {
  try {
    const service = await resolvePostfixService(serviceId);
    if (!service) {
      logger.debug('Postfix service not found for live metrics', { serviceId });
      return null;
    }
    if (service.collectionMode === 'agent') {
      return getLatestAgentSnapshot('postfix', service.serviceId) as Promise<PostfixLiveMetrics | null>;
    }
    return withPostfixLogCounters(await getPostfixLiveMetrics(service.serviceId), service.id);
  } catch (error) {
    logger.debug('Failed to fetch Postfix live metrics', { serviceId, error: (error as Error).message });
    return null;
  }
}

export async function getLiveRedisMetrics(serviceId?: string): Promise<RedisLiveMetrics | null> {
  try {
    const service = await resolveRedisService(serviceId);
    if (!service) {
      logger.debug('Redis service not found for live metrics', { serviceId });
      return null;
    }
    if (service.collectionMode === 'agent') {
      return getLatestAgentSnapshot('redis', service.serviceId) as Promise<RedisLiveMetrics | null>;
    }
    return getRedisLiveMetrics(service.serviceId);
  } catch (error) {
    logger.debug('Failed to fetch Redis live metrics', { serviceId, error: (error as Error).message });
    return null;
  }
}

export async function getLivePostgresMetrics(serviceId?: string): Promise<PostgresLiveMetrics | null> {
  try {
    const service = await resolvePostgresService(serviceId);
    if (!service) {
      logger.debug('Postgres service not found for live metrics', { serviceId });
      return null;
    }
    if (service.collectionMode === 'agent') {
      return getLatestAgentSnapshot('postgres', service.serviceId) as Promise<PostgresLiveMetrics | null>;
    }
    return getPostgresLiveMetrics(service.serviceId);
  } catch (error) {
    logger.debug('Failed to fetch Postgres live metrics', { serviceId, error: (error as Error).message });
    return null;
  }
}

export async function getLiveMariadbMetrics(serviceId?: string): Promise<MariadbLiveMetrics | null> {
  try {
    const service = await resolveMariadbService(serviceId);
    if (!service) {
      logger.debug('MariaDB service not found for live metrics', { serviceId });
      return null;
    }
    if (service.collectionMode === 'agent') {
      return getLatestAgentSnapshot('mariadb', service.serviceId) as Promise<MariadbLiveMetrics | null>;
    }
    return getMariadbLiveMetrics(service.serviceId);
  } catch (error) {
    logger.debug('Failed to fetch MariaDB live metrics', { serviceId, error: (error as Error).message });
    return null;
  }
}

export async function getLiveServiceMetrics(
  serviceType: MetricsServiceType = 'robin',
  serviceId?: string
): Promise<ServiceMetricsSnapshot | null> {
  // Agent-mode services are pushed, not polled — serve their most recent stored
  // snapshot rather than reaching out (robin-admin can't reach the host anyway).
  if (serviceId && serviceId !== 'default') {
    const svc = await getMetricsFleetServiceById(serviceId, serviceType);
    if (svc?.collectionMode === 'agent') {
      return getLatestAgentSnapshot(serviceType, serviceId);
    }
  }
  if (serviceType === 'rspamd') {
    return getLiveRspamdMetrics(serviceId);
  }
  if (serviceType === 'clamav') {
    return getLiveClamavMetrics(serviceId);
  }
  if (serviceType === 'dovecot') {
    return getLiveDovecotMetrics(serviceId);
  }
  if (serviceType === 'postfix') {
    return getLivePostfixMetrics(serviceId);
  }
  if (serviceType === 'redis') {
    return getLiveRedisMetrics(serviceId);
  }
  if (serviceType === 'postgres') {
    return getLivePostgresMetrics(serviceId);
  }
  if (serviceType === 'mariadb') {
    return getLiveMariadbMetrics(serviceId);
  }
  return getLiveRobinMetrics(serviceId);
}

// Agents push every 30 seconds or so. A newer snapshot than this is current;
// an older one means the agent or the service stopped reporting.
const AGENT_SNAPSHOT_STALE_MS = 5 * 60 * 1000;

/**
 * Most recent stored snapshot for an agent-pushed (agent-mode) service, or
 * null when it is stale, so a silent agent or service reads as down instead
 * of showing its last good values for up to a day.
 */
async function getLatestAgentSnapshot(
  serviceType: MetricsServiceType,
  serviceId: string
): Promise<ServiceMetricsSnapshot | null> {
  const snapshot = await loadLatestAgentSnapshot(serviceType, serviceId);
  if (!snapshot) return null;
  const timestamp = (snapshot as { timestamp?: Date | string }).timestamp;
  const age = timestamp ? Date.now() - new Date(timestamp).getTime() : Number.POSITIVE_INFINITY;
  return age <= AGENT_SNAPSHOT_STALE_MS ? snapshot : null;
}

async function loadLatestAgentSnapshot(
  serviceType: MetricsServiceType,
  serviceId: string
): Promise<ServiceMetricsSnapshot | null> {
  switch (serviceType) {
    case 'dovecot': return loadLatestHistoryRow<DovecotHistoryRowDb, DovecotMetricsHistoryRow>('dovecot_metrics_history', serviceType, serviceId, mapDovecotHistoryRow);
    case 'postfix': return loadLatestHistoryRow<PostfixHistoryRowDb, PostfixMetricsHistoryRow>('postfix_metrics_history', serviceType, serviceId, mapPostfixHistoryRow);
    case 'redis': return loadLatestHistoryRow<RedisHistoryRowDb, RedisMetricsHistoryRow>('redis_metrics_history', serviceType, serviceId, mapRedisHistoryRow);
    case 'clamav': return loadLatestHistoryRow<ClamavHistoryRowDb, ClamavMetricsHistoryRow>('clamav_metrics_history', serviceType, serviceId, mapClamavHistoryRow);
    case 'rspamd': return loadLatestHistoryRow<RspamdHistoryRowDb, RspamdMetricsHistoryRow>('rspamd_metrics_history', serviceType, serviceId, mapRspamdHistoryRow);
    case 'robin': return loadLatestHistoryRow<RobinHistoryRowDb, RobinMetricsHistoryRow>('robin_metrics_history', serviceType, serviceId, mapRobinHistoryRow);
    case 'postgres': return loadLatestHistoryRow<PostgresHistoryRowDb, PostgresMetricsHistoryRow>('postgres_metrics_history', serviceType, serviceId, mapPostgresHistoryRow);
    case 'mariadb': return loadLatestHistoryRow<Record<string, unknown>, MariadbMetricsHistoryRow>('mariadb_metrics_history', serviceType, serviceId, mapMariadbHistoryRow);
  }
}

/**
 * Store a metrics snapshot pushed by a co-located agent for a service it owns.
 * robin-admin parses the raw collector output (the agent stays a thin executor).
 */
export async function ingestAgentMetrics(
  service: { id: number; serviceId: string; serviceType: MetricsServiceType },
  body: { statsDump?: string; who?: string; postqueue?: string; info?: string; version?: string; stats?: string; metrics?: string; stat?: string; prometheus?: string; snapshot?: string }
): Promise<ServiceMetricsSnapshot> {
  if (service.serviceType === 'dovecot') {
    if (typeof body.statsDump !== 'string' || !body.statsDump.trim()) {
      throw new Error('statsDump is required for dovecot agent metrics');
    }
    const snapshot = buildDovecotSnapshotFromRaw(service.serviceId, body.statsDump, body.who);
    await storeDovecotSnapshot(snapshot, service.id);
    // `dovecot --version`, e.g. "2.4.2 (0962ed2104)": config renders for it.
    const version = body.version?.trim().split(/\s+/)[0];
    if (version) await setFleetServiceSoftwareVersion(service.id, version.slice(0, 64));
    return snapshot;
  }
  if (service.serviceType === 'postfix') {
    // An empty string is valid: `postqueue -j` prints nothing for an empty queue,
    // and the agent only sends the field when the command SUCCEEDED — so ""
    // means "reachable, queue empty", which parses to a zeroed snapshot. Only a
    // missing field is an error.
    if (typeof body.postqueue !== 'string') {
      throw new Error('postqueue output is required for postfix agent metrics');
    }
    const snapshot = buildPostfixSnapshotFromRaw(service.serviceId, body.postqueue, { ...await postfixCountersFor(service.id) });
    await storePostfixSnapshot(snapshot, service.id);
    return snapshot;
  }
  if (service.serviceType === 'redis') {
    if (typeof body.info !== 'string' || !body.info.trim()) {
      throw new Error('info output is required for redis agent metrics');
    }
    const snapshot = buildRedisSnapshotFromInfo(service.serviceId, body.info);
    await storeRedisSnapshot(snapshot, service.id);
    return snapshot;
  }
  if (service.serviceType === 'clamav') {
    if ((typeof body.stats !== 'string' || !body.stats.trim()) && (typeof body.version !== 'string' || !body.version.trim())) {
      throw new Error('stats or version output is required for clamav agent metrics');
    }
    const snapshot = buildClamavSnapshotFromRaw(service.serviceId, body.version ?? null, body.stats ?? '');
    await storeClamavSnapshot(snapshot, service.id);
    return snapshot;
  }
  if (service.serviceType === 'rspamd') {
    if ((typeof body.metrics !== 'string' || !body.metrics.trim()) && (typeof body.stat !== 'string' || !body.stat.trim())) {
      throw new Error('metrics or stat output is required for rspamd agent metrics');
    }
    const snapshot = buildRspamdSnapshotFromRaw(service.serviceId, body.metrics, body.stat);
    await storeRspamdSnapshot(snapshot, service.id);
    return snapshot;
  }
  if (service.serviceType === 'robin') {
    if (typeof body.prometheus !== 'string' || !body.prometheus.trim()) {
      throw new Error('prometheus output is required for robin agent metrics');
    }
    const previous = await loadPreviousRobinSnapshot(service.id);
    const snapshot = withRobinProcessCpu(buildRobinSnapshotFromRaw(service.serviceId, body.prometheus), previous);
    const rates = calculateRobinRates(snapshot, previous);
    await storeRobinSnapshot(snapshot, rates, service.id);
    return snapshot;
  }
  if (service.serviceType === 'postgres') {
    if (typeof body.snapshot !== 'string' || !body.snapshot.trim()) {
      throw new Error('snapshot JSON is required for postgres agent metrics');
    }
    const snapshot = buildPostgresSnapshotFromRaw(service.serviceId, body.snapshot);
    await storePostgresSnapshot(snapshot, service.id);
    return snapshot;
  }
  if (service.serviceType === 'mariadb') {
    if (typeof body.snapshot !== 'string' || !body.snapshot.trim()) {
      throw new Error('snapshot output is required for mariadb agent metrics');
    }
    const snapshot = await withKnownMariadbSize(buildMariadbSnapshotFromRaw(service.serviceId, body.snapshot), service.id);
    await storeMariadbSnapshot(snapshot, service.id);
    // Re-applies managed variables a restart reverted, when robin-admin also holds a DSN.
    void enforceMariadbConfig(snapshot);
    return snapshot;
  }
  throw new Error(`Agent metrics ingest is not yet supported for ${service.serviceType}`);
}

export async function getLiveMetrics(serviceId?: string): Promise<RobinMetricsSnapshot | null> {
  return getLiveRobinMetrics(serviceId);
}

export async function getRawRobinMetrics(serviceId?: string): Promise<string> {
  const service = await resolveRobinService(serviceId);

  if (serviceId && serviceId !== 'default' && !service) {
    return `# Error: Robin service '${serviceId}' not found`;
  }

  const metricsUrl = service?.metricsUrl || service?.apiUrl || getDefaultRobinMetricsUrl();
  const response = await fetchText(buildUrl(metricsUrl, '/metrics/prometheus'));

  if (!response.ok || response.text === null) {
    return `# Error fetching metrics: HTTP ${response.statusCode ?? 'unreachable'}`;
  }

  return response.text;
}

export async function getRawRspamdMetrics(serviceId?: string): Promise<string> {
  const service = await resolveRspamdService(serviceId);

  if (!service) {
    return serviceId
      ? `# Error: Rspamd service '${serviceId}' not found`
      : '# Error: No enabled Rspamd service is configured';
  }

  const normalBase = getRspamdNormalBase(service);
  const controllerBase = getRspamdControllerBase(service);
  const metricsBase = normalBase ?? controllerBase;
  if (!metricsBase) {
    return `# Error: Rspamd service '${service.serviceId}' has no normal, controller, or metrics endpoint configured`;
  }

  const headers = metricsBase === controllerBase
    ? await getRspamdAuthHeaders(service.serviceId)
    : undefined;
  const response = await fetchText(buildUrl(metricsBase, '/metrics'), headers);

  if (!response.ok || response.text === null) {
    return `# Error fetching metrics: HTTP ${response.statusCode ?? 'unreachable'}`;
  }

  return response.text;
}

export async function getRawClamavMetrics(serviceId?: string): Promise<string> {
  const service = await resolveClamavService(serviceId);

  if (!service) {
    return serviceId
      ? `# Error: ClamAV service '${serviceId}' not found`
      : '# Error: No enabled ClamAV service is configured';
  }

  try {
    return await getClamavRawStats(service.serviceId);
  } catch (error) {
    return `# Error fetching stats: ${(error as Error).message}`;
  }
}

export async function getRawDovecotMetrics(serviceId?: string): Promise<string> {
  const service = await resolveDovecotService(serviceId);

  if (!service) {
    return serviceId
      ? `# Error: Dovecot service '${serviceId}' not found`
      : '# Error: No enabled Dovecot service is configured';
  }

  try {
    return (await getLiveDovecotMetrics(service.serviceId))?.rawStats || '# No stats returned';
  } catch (error) {
    return `# Error fetching stats: ${(error as Error).message}`;
  }
}

export async function getRawPostfixMetrics(serviceId?: string): Promise<string> {
  const service = await resolvePostfixService(serviceId);

  if (!service) {
    return serviceId
      ? `# Error: Postfix service '${serviceId}' not found`
      : '# Error: No enabled Postfix service is configured';
  }

  try {
    return (await getLivePostfixMetrics(service.serviceId))?.rawStats || '# No stats returned';
  } catch (error) {
    return `# Error fetching stats: ${(error as Error).message}`;
  }
}

export async function getRawRedisMetrics(serviceId?: string): Promise<string> {
  const service = await resolveRedisService(serviceId);

  if (!service) {
    return serviceId
      ? `# Error: Redis service '${serviceId}' not found`
      : '# Error: No enabled Redis service is configured';
  }

  try {
    return await getRedisRawStats(service.serviceId);
  } catch (error) {
    return `# Error fetching stats: ${(error as Error).message}`;
  }
}

export async function getRawPostgresMetrics(serviceId?: string): Promise<string> {
  const service = await resolvePostgresService(serviceId);

  if (!service) {
    return serviceId
      ? `# Error: Postgres service '${serviceId}' not found`
      : '# Error: No enabled Postgres service is configured';
  }

  try {
    return await getPostgresRawStats(service.serviceId);
  } catch (error) {
    return `# Error fetching stats: ${(error as Error).message}`;
  }
}

export async function getRawMariadbMetrics(serviceId?: string): Promise<string> {
  const service = await resolveMariadbService(serviceId);

  if (!service) {
    return serviceId
      ? `# Error: MariaDB service '${serviceId}' not found`
      : '# Error: No enabled MariaDB service is configured';
  }

  try {
    return await getMariadbRawStats(service.serviceId);
  } catch (error) {
    return `# Error fetching stats: ${(error as Error).message}`;
  }
}

export async function getRawServiceMetrics(
  serviceType: MetricsServiceType = 'robin',
  serviceId?: string
): Promise<string> {
  // An agent-collected service can't be read from here; serve the raw output
  // stored with its latest snapshot.
  if (serviceId && serviceId !== 'default' && (AGENT_RAW_TYPES as readonly string[]).includes(serviceType)) {
    const svc = await getMetricsFleetServiceById(serviceId, serviceType);
    if (svc?.collectionMode === 'agent') {
      const snapshot = await getLatestAgentSnapshot(serviceType, serviceId) as { rawStats?: string; rawInfo?: string } | null;
      if (!snapshot) return '# The agent has not pushed a snapshot yet';
      return snapshot.rawStats || snapshot.rawInfo || (serviceType === 'postfix'
        ? '# postqueue -j printed nothing: the queue is empty'
        : '# The agent pushed an empty collector output');
    }
  }
  if (serviceType === 'rspamd') {
    return getRawRspamdMetrics(serviceId);
  }
  if (serviceType === 'clamav') {
    return getRawClamavMetrics(serviceId);
  }
  if (serviceType === 'dovecot') {
    return getRawDovecotMetrics(serviceId);
  }
  if (serviceType === 'postfix') {
    return getRawPostfixMetrics(serviceId);
  }
  if (serviceType === 'redis') {
    return getRawRedisMetrics(serviceId);
  }
  if (serviceType === 'postgres') {
    return getRawPostgresMetrics(serviceId);
  }
  if (serviceType === 'mariadb') {
    return getRawMariadbMetrics(serviceId);
  }
  return getRawRobinMetrics(serviceId);
}


function buildHistoryWhereClause(hours: number, fleetServiceId?: number | null): {
  whereClause: string;
  params: number[];
} {
  const params = [hours];
  const whereParts = [`history.timestamp >= NOW() - ($1::int * INTERVAL '1 hour')`];

  if (fleetServiceId !== undefined && fleetServiceId !== null) {
    params.push(fleetServiceId);
    whereParts.push(`history.fleet_service_id = $${params.length}`);
  }

  return {
    whereClause: whereParts.join(' AND '),
    params,
  };
}

// The newest sample within the last 24h: agent-collected "live" values. One
// indexed row read, rather than loading and reducing the whole day's history.
async function loadLatestHistoryRow<T extends object, R>(
  tableName: HistoryTable,
  serviceType: MetricsServiceType,
  serviceId: string,
  map: (row: T) => R
): Promise<R | null> {
  const service = await getMetricsFleetServiceById(serviceId, serviceType);
  if (!service) return null;
  const { whereClause, params } = buildHistoryWhereClause(24, service.id);
  const result = await query<T>(
    `SELECT history.*, services.service_id AS current_service_id
     FROM ${tableName} history
     JOIN fleet_services services ON services.id = history.fleet_service_id
     WHERE ${whereClause}
     ORDER BY history.timestamp DESC
     LIMIT 1`,
    params
  );
  return result.rows[0] ? map(result.rows[0]) : null;
}

async function loadHistoryRows<T extends object>(
  tableName: HistoryTable,
  hours: number,
  maxPoints: number,
  fleetServiceId?: number | null
): Promise<T[]> {
  const { whereClause, params } = buildHistoryWhereClause(hours, fleetServiceId);
  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) AS count FROM ${tableName} history WHERE ${whereClause}`,
    params
  );
  const totalCount = parseInt(countResult.rows[0]?.count ?? '0', 10);

  let sql: string;
  if (totalCount > maxPoints) {
    sql = `
      WITH ranked AS (
        SELECT history.*, NTILE(${maxPoints}) OVER (ORDER BY history.timestamp) AS bucket
        FROM ${tableName} history
        WHERE ${whereClause}
      ),
      bucketed AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY bucket ORDER BY timestamp) AS rn
        FROM ranked
      ),
      latest AS (
        SELECT *, 1 AS rn
        FROM ranked
        ORDER BY timestamp DESC
        LIMIT 1
      ),
      sampled AS (
        SELECT * FROM bucketed WHERE rn = 1
        UNION
        SELECT * FROM latest
      )
      SELECT sampled.*, services.service_id AS current_service_id
      FROM sampled
      JOIN fleet_services services ON services.id = sampled.fleet_service_id
      ORDER BY timestamp ASC
    `;
  } else {
    sql = `
      SELECT history.*, services.service_id AS current_service_id
      FROM ${tableName} history
      JOIN fleet_services services ON services.id = history.fleet_service_id
      WHERE ${whereClause}
      ORDER BY timestamp ASC
    `;
  }

  const result = await query<T>(sql, params);
  return result.rows;
}

/**
 * The sample a new Robin sample's rates and CPU usage are measured against:
 * the newest stored one, so every server replica, and a restarted server,
 * agrees on it.
 */
async function loadPreviousRobinSnapshot(fleetServiceId: number): Promise<RobinMetricsSnapshot | null> {
  const { rows: [row] } = await query<RobinHistoryRowDb>(
    `SELECT history.*, services.service_id AS current_service_id
     FROM robin_metrics_history history
     JOIN fleet_services services ON services.id = history.fleet_service_id
     WHERE history.fleet_service_id = $1
     ORDER BY history.timestamp DESC
     LIMIT 1`,
    [fleetServiceId]
  );
  return row ? mapRobinHistoryRow(row) : null;
}

function mapRobinHistoryRow(row: RobinHistoryRowDb): RobinMetricsHistoryRow {
  const currentServiceId = row.current_service_id ?? row.service_id;
  return {
    serviceId: currentServiceId,
    serviceType: 'robin',
    timestamp: row.timestamp,
    emailReceiptStart: toNumber(row.email_receipt_start),
    emailReceiptSuccess: toNumber(row.email_receipt_success),
    emailReceiptLimit: toNumber(row.email_receipt_limit),
    emailReceiptException: toNumber(row.email_receipt_exception),
    rblRejections: toNumber(row.rbl_rejections),
    virusRejections: toNumber(row.virus_rejections),
    spamRejections: toNumber(row.spam_rejections),
    dosRatelimitRejections: toNumber(row.dos_ratelimit_rejections),
    dosConnlimitRejections: toNumber(row.dos_connlimit_rejections),
    dosTarpitCount: toNumber(row.dos_tarpit_count),
    dosSlowtransferRejections: toNumber(row.dos_slowtransfer_rejections),
    dosCommandfloodRejections: toNumber(row.dos_commandflood_rejections),
    whitelistBypasses: toNumber(row.whitelist_bypasses),
    adaptiveRatelimitApplied: toNumber(row.adaptive_ratelimit_applied),
    geoipBlockRejections: toNumber(row.geoip_block_rejections),
    geoipLimitApplied: toNumber(row.geoip_limit_applied),
    distributedStoreErrors: toNumber(row.distributed_store_errors),
    jvmMemoryUsed: toNumber(row.jvm_memory_used),
    jvmMemoryMax: toNumber(row.jvm_memory_max),
    jvmMemoryCommitted: toNumber(row.jvm_memory_committed),
    jvmThreadsLive: toNumber(row.jvm_threads_live),
    jvmThreadsDaemon: toNumber(row.jvm_threads_daemon),
    jvmThreadsPeak: toNumber(row.jvm_threads_peak),
    jvmThreadsStarted: toNumber(row.jvm_threads_started),
    jvmGcPauseSeconds: toNumber(row.jvm_gc_pause_seconds),
    jvmGcPauseCount: toNumber(row.jvm_gc_pause_count),
    jvmGcMemoryAllocated: toNumber(row.jvm_gc_memory_allocated),
    jvmGcMemoryPromoted: toNumber(row.jvm_gc_memory_promoted),
    jvmGcLiveDataSize: toNumber(row.jvm_gc_live_data_size),
    jvmGcMaxDataSize: toNumber(row.jvm_gc_max_data_size),
    jvmBufferCount: toNumber(row.jvm_buffer_count),
    jvmBufferMemoryUsed: toNumber(row.jvm_buffer_memory_used),
    jvmBufferTotalCapacity: toNumber(row.jvm_buffer_total_capacity),
    cpuUsage: toNumber(row.cpu_usage),
    processCpuUsage: toNumber(row.process_cpu_usage),
    processCpuTimeNs: toNumber(row.process_cpu_time_ns),
    systemCpuCount: toNumber(row.system_cpu_count),
    systemLoadAverage: toNumber(row.system_load_average),
    rateEmailStart: toNumber(row.rate_email_start),
    rateEmailSuccess: toNumber(row.rate_email_success),
    rateRejections: toNumber(row.rate_rejections),
  };
}

function mapRspamdHistoryRow(row: RspamdHistoryRowDb): RspamdMetricsHistoryRow {
  const currentServiceId = row.current_service_id ?? row.service_id;
  return {
    serviceId: currentServiceId,
    serviceType: 'rspamd',
    timestamp: row.timestamp,
    controllerReachable: row.controller_reachable,
    controllerAuthenticated: row.controller_authenticated,
    controllerStatusCode: row.controller_status_code,
    controllerPingOk: row.controller_ping_ok,
    controllerPingStatusCode: row.controller_ping_status_code,
    controllerHealthyOk: row.controller_healthy_ok,
    controllerHealthyStatusCode: row.controller_healthy_status_code,
    controllerStatAuthenticated: row.controller_stat_authenticated,
    controllerStatStatusCode: row.controller_stat_status_code,
    normalWorkerPingOk: row.normal_worker_ping_ok,
    normalWorkerPingStatusCode: row.normal_worker_ping_status_code,
    scannedMessages: toNumber(row.scanned_messages),
    learnedSpam: toNumber(row.learned_spam),
    learnedHam: toNumber(row.learned_ham),
    actionsAddHeader: toNumber(row.actions_add_header),
    actionsReject: toNumber(row.actions_reject),
    actionsSoftReject: toNumber(row.actions_soft_reject),
    actionsGreylist: toNumber(row.actions_greylist),
    actionsNoAction: toNumber(row.actions_no_action),
    actionsRewriteSubject: toNumber(row.actions_rewrite_subject),
    actionsDiscard: toNumber(row.actions_discard),
    actionsQuarantine: toNumber(row.actions_quarantine),
    spamMessages: toNumber(row.spam_messages),
    hamMessages: toNumber(row.ham_messages),
    connections: toNumber(row.connections),
    uptimeSeconds: toNumber(row.uptime_seconds),
    memoryAllocatedBytes: toNumber(row.memory_allocated_bytes),
    memoryResidentBytes: toNumber(row.memory_resident_bytes),
    rawMetrics: isRecord(row.raw_metrics) ? row.raw_metrics : {},
  };
}

function mapClamavHistoryRow(row: ClamavHistoryRowDb): ClamavMetricsHistoryRow {
  const currentServiceId = row.current_service_id ?? row.service_id;
  return {
    serviceId: currentServiceId,
    serviceType: 'clamav',
    timestamp: row.timestamp,
    pingOk: row.ping_ok,
    versionText: row.version_text,
    engineVersion: row.engine_version,
    databaseVersion: row.database_version === null ? null : toNumber(row.database_version),
    databaseUpdatedAt: row.database_updated_at,
    statusText: row.status_text,
    pools: toNumber(row.pools),
    threadsLive: toNumber(row.threads_live),
    threadsIdle: toNumber(row.threads_idle),
    threadsMax: toNumber(row.threads_max),
    queueItems: toNumber(row.queue_items),
    memoryHeapMB: toNumber(row.memory_heap_mb),
    memoryMmapMB: toNumber(row.memory_mmap_mb),
    memoryUsedMB: toNumber(row.memory_used_mb),
    memoryFreeMB: toNumber(row.memory_free_mb),
    memoryReleasableMB: toNumber(row.memory_releasable_mb),
    memoryPoolsUsedMB: toNumber(row.memory_pools_used_mb),
    memoryPoolsTotalMB: toNumber(row.memory_pools_total_mb),
    rawStats: row.raw_stats ?? '',
  };
}

export async function getRobinMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<RobinMetricsHistoryRow[]> {
  // Without a serviceId this is the primary service, as for live metrics;
  // never every service of the type mixed together.
  const service = await resolveRobinService(serviceId ?? undefined);
  if (!service) {
    return [];
  }
  const rows = await loadHistoryRows<RobinHistoryRowDb>(
    'robin_metrics_history',
    hours,
    maxPoints,
    service.id
  );
  return rows.map(mapRobinHistoryRow);
}

export async function getRspamdMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<RspamdMetricsHistoryRow[]> {
  // Without a serviceId this is the primary service, as for live metrics;
  // never every service of the type mixed together.
  const service = await resolveRspamdService(serviceId ?? undefined);
  if (!service) {
    return [];
  }
  const rows = await loadHistoryRows<RspamdHistoryRowDb>(
    'rspamd_metrics_history',
    hours,
    maxPoints,
    service.id
  );
  return rows.map(mapRspamdHistoryRow);
}

export async function getClamavMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<ClamavMetricsHistoryRow[]> {
  // Without a serviceId this is the primary service, as for live metrics;
  // never every service of the type mixed together.
  const service = await resolveClamavService(serviceId ?? undefined);
  if (!service) {
    return [];
  }
  const rows = await loadHistoryRows<ClamavHistoryRowDb>(
    'clamav_metrics_history',
    hours,
    maxPoints,
    service.id
  );
  return rows.map(mapClamavHistoryRow);
}

function mapDovecotHistoryRow(row: DovecotHistoryRowDb): DovecotMetricsHistoryRow {
  const currentServiceId = row.current_service_id ?? row.service_id;
  return {
    serviceId: currentServiceId,
    serviceType: 'dovecot',
    timestamp: row.timestamp,
    reachable: row.reachable,
    authSuccess: toNumber(row.auth_success),
    authFailure: toNumber(row.auth_failure),
    loginCount: toNumber(row.login_count),
    imapCommands: toNumber(row.imap_commands),
    mailDeliveries: toNumber(row.mail_deliveries),
    sessionCount: toNumber(row.session_count),
    userCount: toNumber(row.user_count),
    rawStats: row.raw_stats ?? '',
  };
}

export async function getDovecotMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<DovecotMetricsHistoryRow[]> {
  // Without a serviceId this is the primary service, as for live metrics;
  // never every service of the type mixed together.
  const service = await resolveDovecotService(serviceId ?? undefined);
  if (!service) {
    return [];
  }
  const rows = await loadHistoryRows<DovecotHistoryRowDb>(
    'dovecot_metrics_history',
    hours,
    maxPoints,
    service.id
  );
  return rows.map(mapDovecotHistoryRow);
}

function mapPostfixHistoryRow(row: PostfixHistoryRowDb): PostfixMetricsHistoryRow {
  const currentServiceId = row.current_service_id ?? row.service_id;
  return {
    serviceId: currentServiceId,
    serviceType: 'postfix',
    timestamp: row.timestamp,
    reachable: row.reachable,
    queueActive: toNumber(row.queue_active),
    queueDeferred: toNumber(row.queue_deferred),
    queueHold: toNumber(row.queue_hold),
    queueIncoming: toNumber(row.queue_incoming),
    queueTotal: toNumber(row.queue_total),
    oldestDeferredAgeSecs: toNumber(row.oldest_deferred_age_secs),
    messagesDelivered: toNumber(row.messages_delivered),
    messagesDeferred: toNumber(row.messages_deferred),
    messagesBounced: toNumber(row.messages_bounced),
    messagesRejected: toNumber(row.messages_rejected),
    rawStats: row.raw_stats ?? '',
  };
}

export async function getPostfixMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<PostfixMetricsHistoryRow[]> {
  // Without a serviceId this is the primary service, as for live metrics;
  // never every service of the type mixed together.
  const service = await resolvePostfixService(serviceId ?? undefined);
  if (!service) {
    return [];
  }
  const rows = await loadHistoryRows<PostfixHistoryRowDb>(
    'postfix_metrics_history',
    hours,
    maxPoints,
    service.id
  );
  return rows.map(mapPostfixHistoryRow);
}

function mapRedisHistoryRow(row: RedisHistoryRowDb): RedisMetricsHistoryRow {
  const currentServiceId = row.current_service_id ?? row.service_id;
  return {
    serviceId: currentServiceId,
    serviceType: 'redis',
    timestamp: row.timestamp,
    reachable: row.reachable,
    role: row.role,
    uptimeSecs: toNumber(row.uptime_secs),
    connectedClients: toNumber(row.connected_clients),
    blockedClients: toNumber(row.blocked_clients),
    maxClients: toNumber(row.max_clients),
    memoryUsedBytes: toNumber(row.memory_used_bytes),
    memoryPeakBytes: toNumber(row.memory_peak_bytes),
    memoryRssBytes: toNumber(row.memory_rss_bytes),
    maxMemoryBytes: toNumber(row.max_memory_bytes),
    memFragmentationRatio: toNumber(row.mem_fragmentation_ratio),
    evictedKeys: toNumber(row.evicted_keys),
    expiredKeys: toNumber(row.expired_keys),
    keyspaceHits: toNumber(row.keyspace_hits),
    keyspaceMisses: toNumber(row.keyspace_misses),
    hitRatio: toNumber(row.hit_ratio),
    instantaneousOpsPerSec: toNumber(row.instantaneous_ops_per_sec),
    totalCommandsProcessed: toNumber(row.total_commands_processed),
    totalConnectionsReceived: toNumber(row.total_connections_received),
    rejectedConnections: toNumber(row.rejected_connections),
    totalNetInputBytes: toNumber(row.total_net_input_bytes),
    totalNetOutputBytes: toNumber(row.total_net_output_bytes),
    connectedSlaves: toNumber(row.connected_slaves),
    masterLinkStatus: row.master_link_status,
    rdbChangesSinceLastSave: toNumber(row.rdb_changes_since_last_save),
    rdbLastSaveTime: toNumber(row.rdb_last_save_time),
    rdbLastBgsaveStatus: row.rdb_last_bgsave_status,
    aofEnabled: row.aof_enabled,
    aofLastWriteStatus: row.aof_last_write_status,
    dbKeys: toNumber(row.db_keys),
    dbExpires: toNumber(row.db_expires),
    pubsubChannels: toNumber(row.pubsub_channels),
    rawInfo: row.raw_info ?? '',
  };
}

export async function getRedisMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<RedisMetricsHistoryRow[]> {
  // Without a serviceId this is the primary service, as for live metrics;
  // never every service of the type mixed together.
  const service = await resolveRedisService(serviceId ?? undefined);
  if (!service) {
    return [];
  }
  const rows = await loadHistoryRows<RedisHistoryRowDb>(
    'redis_metrics_history',
    hours,
    maxPoints,
    service.id
  );
  return rows.map(mapRedisHistoryRow);
}

function mapPostgresHistoryRow(row: PostgresHistoryRowDb): PostgresMetricsHistoryRow {
  const currentServiceId = row.current_service_id ?? row.service_id;
  return {
    serviceId: currentServiceId,
    serviceType: 'postgres',
    timestamp: row.timestamp,
    reachable: row.reachable,
    serverVersionNum: toNumber(row.server_version_num),
    connectionsTotal: toNumber(row.connections_total),
    connectionsActive: toNumber(row.connections_active),
    connectionsIdle: toNumber(row.connections_idle),
    connectionsIdleInTxn: toNumber(row.connections_idle_in_txn),
    connectionsWaiting: toNumber(row.connections_waiting),
    maxConnections: toNumber(row.max_connections),
    connectionSaturationPct: toNumber(row.connection_saturation_pct),
    xactCommit: toNumber(row.xact_commit),
    xactRollback: toNumber(row.xact_rollback),
    commitRatio: toNumber(row.commit_ratio),
    blksHit: toNumber(row.blks_hit),
    blksRead: toNumber(row.blks_read),
    cacheHitRatio: toNumber(row.cache_hit_ratio),
    tupReturned: toNumber(row.tup_returned),
    tupFetched: toNumber(row.tup_fetched),
    tupInserted: toNumber(row.tup_inserted),
    tupUpdated: toNumber(row.tup_updated),
    tupDeleted: toNumber(row.tup_deleted),
    deadlocks: toNumber(row.deadlocks),
    tempFiles: toNumber(row.temp_files),
    tempBytes: toNumber(row.temp_bytes),
    conflicts: toNumber(row.conflicts),
    databaseSizeBytes: toNumber(row.database_size_bytes),
    oldestXactAgeSecs: toNumber(row.oldest_xact_age_secs),
    oldestIdleInTxnSecs: toNumber(row.oldest_idle_in_txn_secs),
    blockedQueries: toNumber(row.blocked_queries),
    checkpointsTimed: toNumber(row.checkpoints_timed),
    checkpointsReq: toNumber(row.checkpoints_req),
    buffersCheckpoint: toNumber(row.buffers_checkpoint),
    replicationLagBytes: toNumber(row.replication_lag_bytes),
    deadTuplesTotal: toNumber(row.dead_tuples_total),
    rawStats: row.raw_stats ?? '',
  };
}

export async function getPostgresMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<PostgresMetricsHistoryRow[]> {
  // Without a serviceId this is the primary service, as for live metrics;
  // never every service of the type mixed together.
  const service = await resolvePostgresService(serviceId ?? undefined);
  if (!service) {
    return [];
  }
  const rows = await loadHistoryRows<PostgresHistoryRowDb>(
    'postgres_metrics_history',
    hours,
    maxPoints,
    service.id
  );
  return rows.map(mapPostgresHistoryRow);
}

function mapMariadbHistoryRow(row: Record<string, unknown>): MariadbMetricsHistoryRow {
  const metrics = emptyMariadbMetrics(String(row.current_service_id ?? row.service_id));
  MARIADB_NUMERIC_FIELDS.forEach((field, index) => {
    (metrics as unknown as Record<string, number>)[field] = toNumber(row[MARIADB_NUMERIC_COLUMNS[index]] as number | string);
  });
  const nullableNumber = (value: unknown) => (value === null || value === undefined ? null : toNumber(value as number | string));
  return {
    ...metrics,
    timestamp: row.timestamp as Date,
    reachable: Boolean(row.reachable),
    version: String(row.version ?? ''),
    databaseSizeBytes: nullableNumber(row.database_size_bytes),
    isReplica: Boolean(row.is_replica),
    replicaIoRunning: Boolean(row.replica_io_running),
    replicaSqlRunning: Boolean(row.replica_sql_running),
    secondsBehindSource: nullableNumber(row.seconds_behind_source),
    rawStats: String(row.raw_stats ?? ''),
  };
}

export async function getMariadbMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<MariadbMetricsHistoryRow[]> {
  // Without a serviceId this is the primary service, as for live metrics;
  // never every service of the type mixed together.
  const service = await resolveMariadbService(serviceId ?? undefined);
  if (!service) {
    return [];
  }
  const rows = await loadHistoryRows<Record<string, unknown>>('mariadb_metrics_history', hours, maxPoints, service.id);
  return rows.map(mapMariadbHistoryRow);
}

export async function getServiceMetricsHistory(
  serviceType: MetricsServiceType = 'robin',
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<ServiceMetricsHistoryRow[]> {
  if (serviceType === 'rspamd') {
    return getRspamdMetricsHistory(hours, maxPoints, serviceId);
  }
  if (serviceType === 'clamav') {
    return getClamavMetricsHistory(hours, maxPoints, serviceId);
  }
  if (serviceType === 'dovecot') {
    return getDovecotMetricsHistory(hours, maxPoints, serviceId);
  }
  if (serviceType === 'postfix') {
    return getPostfixMetricsHistory(hours, maxPoints, serviceId);
  }
  if (serviceType === 'redis') {
    return getRedisMetricsHistory(hours, maxPoints, serviceId);
  }
  if (serviceType === 'postgres') {
    return getPostgresMetricsHistory(hours, maxPoints, serviceId);
  }
  if (serviceType === 'mariadb') {
    return getMariadbMetricsHistory(hours, maxPoints, serviceId);
  }
  return getRobinMetricsHistory(hours, maxPoints, serviceId);
}

export async function getMetricsHistory(
  hours: number = 24,
  maxPoints: number = 500,
  serviceId?: string | null
): Promise<RobinMetricsHistoryRow[]> {
  return getRobinMetricsHistory(hours, maxPoints, serviceId);
}

async function pollRobinService(service: MetricsFleetService): Promise<void> {
  try {
    const metricsUrl = service.metricsUrl || service.apiUrl;
    if (!metricsUrl) {
      logger.debug('Skipping Robin metrics poll with no metrics URL', { serviceId: service.serviceId });
      await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: null, errorCode: 'missing_endpoint' });
      return;
    }

    const raw = await fetchRobinMetrics(metricsUrl);
    const previous = await loadPreviousRobinSnapshot(service.id);
    const snapshot = withRobinProcessCpu(withRobinMetadata(service.serviceId, extractRobinSample(raw)), previous);
    const rates = calculateRobinRates(snapshot, previous);

    await storeRobinSnapshot(snapshot, rates, service.id);
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: true, observedAt: snapshot.timestamp });

    logger.debug('Robin metrics snapshot stored', {
      serviceId: service.serviceId,
      emailStart: snapshot.emailReceiptStart,
      emailSuccess: snapshot.emailReceiptSuccess,
      rateStart: rates.rateEmailStart,
    });
  } catch (error) {
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
    logger.debug('Failed to poll Robin metrics', {
      serviceId: service.serviceId,
      error: (error as Error).message,
    });
  }
}

async function pollRspamdService(service: MetricsFleetService): Promise<void> {
  try {
    const snapshot = await collectRspamdSnapshot(service);
    if (!snapshot) {
      await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
      logger.debug('Failed to poll Rspamd metrics', { serviceId: service.serviceId, error: 'service unreachable' });
      return;
    }

    await storeRspamdSnapshot(snapshot, service.id);
    await recordFleetServiceObservation({
      fleetServiceId: service.id,
      reachable: snapshot.controllerReachable || snapshot.normalWorkerPingOk,
      observedAt: snapshot.timestamp,
    });

    logger.debug('Rspamd metrics snapshot stored', {
      serviceId: service.serviceId,
      scannedMessages: snapshot.scannedMessages,
      spamMessages: snapshot.spamMessages,
      hamMessages: snapshot.hamMessages,
    });
  } catch (error) {
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
    logger.debug('Failed to poll Rspamd metrics', {
      serviceId: service.serviceId,
      error: (error as Error).message,
    });
  }
}

async function pollClamavService(service: MetricsFleetService): Promise<void> {
  try {
    const snapshot = await getClamavLiveMetrics(service.serviceId);
    if (!snapshot) {
      await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
      logger.debug('Failed to poll ClamAV metrics', { serviceId: service.serviceId, error: 'service unreachable' });
      return;
    }

    await storeClamavSnapshot(snapshot, service.id);
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: snapshot.pingOk, observedAt: snapshot.timestamp });

    logger.debug('ClamAV metrics snapshot stored', {
      serviceId: service.serviceId,
      pingOk: snapshot.pingOk,
      version: snapshot.engineVersion,
      queueItems: snapshot.queueItems,
    });
  } catch (error) {
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
    logger.debug('Failed to poll ClamAV metrics', {
      serviceId: service.serviceId,
      error: (error as Error).message,
    });
  }
}

async function pollDovecotService(service: MetricsFleetService): Promise<void> {
  try {
    const snapshot = await getDovecotLiveMetrics(service.serviceId);
    if (!snapshot) {
      await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
      logger.debug('Failed to poll Dovecot metrics', { serviceId: service.serviceId, error: 'service unreachable' });
      return;
    }

    await storeDovecotSnapshot(snapshot, service.id);
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: snapshot.reachable, observedAt: snapshot.timestamp });

    logger.debug('Dovecot metrics snapshot stored', {
      serviceId: service.serviceId,
      reachable: snapshot.reachable,
      sessions: snapshot.sessionCount,
      logins: snapshot.loginCount,
    });
  } catch (error) {
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
    logger.debug('Failed to poll Dovecot metrics', {
      serviceId: service.serviceId,
      error: (error as Error).message,
    });
  }
}

async function pollPostfixService(service: MetricsFleetService): Promise<void> {
  try {
    const snapshot = await withPostfixLogCounters(await getPostfixLiveMetrics(service.serviceId), service.id);
    if (!snapshot) {
      await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
      logger.debug('Failed to poll Postfix metrics', { serviceId: service.serviceId, error: 'service unreachable' });
      return;
    }

    await storePostfixSnapshot(snapshot, service.id);
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: snapshot.reachable, observedAt: snapshot.timestamp });

    logger.debug('Postfix metrics snapshot stored', {
      serviceId: service.serviceId,
      reachable: snapshot.reachable,
      queueTotal: snapshot.queueTotal,
      deferred: snapshot.queueDeferred,
    });
  } catch (error) {
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
    logger.debug('Failed to poll Postfix metrics', {
      serviceId: service.serviceId,
      error: (error as Error).message,
    });
  }
}

async function pollRedisService(service: MetricsFleetService): Promise<void> {
  try {
    const snapshot = await getRedisLiveMetrics(service.serviceId);
    if (!snapshot) {
      await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
      logger.debug('Failed to poll Redis metrics', { serviceId: service.serviceId, error: 'service unreachable' });
      return;
    }

    await storeRedisSnapshot(snapshot, service.id);
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: snapshot.reachable, observedAt: snapshot.timestamp });

    logger.debug('Redis metrics snapshot stored', {
      serviceId: service.serviceId,
      reachable: snapshot.reachable,
      connectedClients: snapshot.connectedClients,
      hitRatio: snapshot.hitRatio,
    });
  } catch (error) {
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
    logger.debug('Failed to poll Redis metrics', {
      serviceId: service.serviceId,
      error: (error as Error).message,
    });
  }
}

async function pollPostgresService(service: MetricsFleetService): Promise<void> {
  try {
    const snapshot = await getPostgresLiveMetrics(service.serviceId);
    if (!snapshot) {
      await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
      logger.debug('Failed to poll Postgres metrics', { serviceId: service.serviceId, error: 'service unreachable' });
      return;
    }

    await storePostgresSnapshot(snapshot, service.id);
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: snapshot.reachable, observedAt: snapshot.timestamp });

    logger.debug('Postgres metrics snapshot stored', {
      serviceId: service.serviceId,
      reachable: snapshot.reachable,
      connectionsTotal: snapshot.connectionsTotal,
      cacheHitRatio: snapshot.cacheHitRatio,
    });
  } catch (error) {
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
    logger.debug('Failed to poll Postgres metrics', {
      serviceId: service.serviceId,
      error: (error as Error).message,
    });
  }
}

async function pollMariadbService(service: MetricsFleetService): Promise<void> {
  try {
    const snapshot = await withKnownMariadbSize(await getMariadbLiveMetrics(service.serviceId), service.id);
    await storeMariadbSnapshot(snapshot, service.id);
    await recordFleetServiceObservation({
      fleetServiceId: service.id,
      reachable: snapshot.reachable,
      observedAt: snapshot.timestamp,
      ...(snapshot.reachable ? {} : { errorCode: 'collection_failed' }),
    });
    await enforceMariadbConfig(snapshot);
    logger.debug('MariaDB metrics snapshot stored', {
      serviceId: service.serviceId,
      reachable: snapshot.reachable,
      threadsConnected: snapshot.threadsConnected,
    });
  } catch (error) {
    await recordFleetServiceObservation({ fleetServiceId: service.id, reachable: false, errorCode: 'collection_failed' });
    logger.debug('Failed to poll MariaDB metrics', {
      serviceId: service.serviceId,
      error: (error as Error).message,
    });
  }
}

async function pollOnce(): Promise<void> {
  try {
    // Direct-mode services only: agent-mode services push their metrics to the
    // ingest endpoint instead of robin-admin reaching out (Phase 3 inversion).
    const services = (await getEnabledMetricsFleetServices()).filter((service) => service.collectionMode !== 'agent');
    if (services.length === 0) {
      logger.debug('No enabled direct-mode fleet services to poll for metrics');
      return;
    }

    const robinServices = services.filter((service) => service.serviceType === 'robin');
    const rspamdServices = services.filter((service) => service.serviceType === 'rspamd');
    const clamavServices = services.filter((service) => service.serviceType === 'clamav');
    const dovecotServices = services.filter((service) => service.serviceType === 'dovecot');
    const postfixServices = services.filter((service) => service.serviceType === 'postfix');
    const redisServices = services.filter((service) => service.serviceType === 'redis');
    const postgresServices = services.filter((service) => service.serviceType === 'postgres');
    const mariadbServices = services.filter((service) => service.serviceType === 'mariadb');

    await Promise.all([
      ...robinServices.map(pollRobinService),
      ...rspamdServices.map(pollRspamdService),
      ...clamavServices.map(pollClamavService),
      ...dovecotServices.map(pollDovecotService),
      ...postfixServices.map(pollPostfixService),
      ...redisServices.map(pollRedisService),
      ...postgresServices.map(pollPostgresService),
      ...mariadbServices.map(pollMariadbService),
    ]);

    logger.debug('Polled fleet metrics', {
      robinServices: robinServices.length,
      rspamdServices: rspamdServices.length,
      clamavServices: clamavServices.length,
      dovecotServices: dovecotServices.length,
      postfixServices: postfixServices.length,
      redisServices: redisServices.length,
      postgresServices: postgresServices.length,
      mariadbServices: mariadbServices.length,
    });
  } catch (error) {
    logger.error('Failed to poll metrics', { error: (error as Error).message });
  }
}

async function runPollCycle(): Promise<void> {
  if (pollInFlight) {
    logger.warn('Skipping metrics poll because the previous cycle is still running');
    return;
  }

  pollInFlight = true;
  currentPoll = (async () => {
    try {
      await pollOnce();

      if (Math.random() < 0.1) {
        await pruneOldMetrics();
      }
    } finally {
      pollInFlight = false;
      currentPoll = null;
    }
  })();
  await currentPoll;
}

export function reconfigureMetricsPoller(): void {
  pollStartGeneration += 1;
  pollStarting = false;
  if (pollInterval) clearInterval(pollInterval);
  pollInterval = null;
  // Keep the active cycle and its pools alive; runPollCycle prevents overlap.
  startMetricsPoller();
}

export function startMetricsPoller(): void {
  if (pollInterval || pollStarting) {
    logger.warn('Metrics poller already running');
    return;
  }

  pollStarting = true;
  const startGeneration = ++pollStartGeneration;
  void getConfig().then((config) => {
    if (startGeneration !== pollStartGeneration) {
      return;
    }
    const intervalMs = Math.max(5000, Math.min(3600000, config.metricsPollIntervalMs || POLL_INTERVAL_MS));
    logger.info(`Starting metrics poller (interval: ${intervalMs}ms, retention: ${config.metricsRetentionDays || RETENTION_DAYS} days)`);
    void runPollCycle();
    pollInterval = setInterval(async () => {
      await runPollCycle();
    }, intervalMs);
  }).catch((error) => {
    logger.error('Failed to start metrics poller', { error: (error as Error).message });
  }).finally(() => {
    pollStarting = false;
  });
}

// Docker sends SIGKILL 10s after SIGTERM; leave room for the rest of shutdown.
const STOP_WAIT_MS = 8000;

/**
 * Stop polling and wait (briefly) for a cycle already running. Closing the
 * service pools under a running cycle makes its collections fail, and they
 * would be stored as unreachable samples: a false outage on every restart.
 */
export async function stopMetricsPoller(): Promise<void> {
  pollStartGeneration += 1;
  pollStarting = false;
  if (pollInterval) {
    clearInterval(pollInterval);
    pollInterval = null;
  }
  const running = currentPoll;
  if (running) {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([
      running.catch(() => undefined),
      new Promise<void>((resolve) => { timer = setTimeout(resolve, STOP_WAIT_MS); }),
    ]);
    clearTimeout(timer);
  }
  logger.info('Metrics poller stopped');
}
