/**
 * Dashboard routes for statistics.
 */

import { Router, Request, Response } from 'express';
import { countUsers, tableExists as usersTableExists } from '../db/queries/users.js';
import { countAliases, countAutoAliases, aliasesTableExists, autoAliasesTableExists } from '../db/queries/aliases.js';
import { getQueueStats, queueTableExists } from '../db/queries/queue.js';
import { countActiveAdmins } from '../db/queries/admins.js';
import { getConfig, getConfigValue, setConfigValue, SETUP_GUIDE_PENDING_KEY } from '../db/queries/config.js';
import { getDmarcStats } from '../db/queries/dmarc.js';
import { getTlsrptStats } from '../db/queries/tlsrpt.js';
import { getForensicStats } from '../db/queries/forensic.js';
import { checkRobinHealth } from '../services/robin-api.js';
import {
  getClamavMetricsHistory,
  getDovecotMetricsHistory,
  getLiveClamavMetrics,
  getLiveDovecotMetrics,
  getLivePostfixMetrics,
  getLiveRedisMetrics,
  getLivePostgresMetrics,
  getLiveMariadbMetrics,
  getLiveRobinMetrics,
  getLiveRspamdMetrics,
  getPostfixMetricsHistory,
  getRedisMetricsHistory,
  getPostgresMetricsHistory,
  getMariadbMetricsHistory,
  getRobinMetricsHistory,
  getRspamdMetricsHistory,
  type ClamavMetricsHistoryRow,
  type DovecotMetricsHistoryRow,
  type MetricsServiceType,
  type PostfixMetricsHistoryRow,
  type RedisMetricsHistoryRow,
  type PostgresMetricsHistoryRow,
  type MariadbMetricsHistoryRow,
  type RobinMetricsHistoryRow,
  type RobinMetricsSnapshot,
  type RspamdMetricsHistoryRow,
  type RspamdMetricsSnapshot,
} from '../services/metrics-poller.js';
import type { ClamavLiveMetrics } from '../services/clamav.js';
import type { DovecotLiveMetrics } from '../services/dovecot.js';
import type { PostfixLiveMetrics } from '../services/postfix.js';
import { agentLogsLive } from '../services/service-logs.js';
import type { RedisLiveMetrics } from '../services/redis.js';
import type { PostgresLiveMetrics } from '../services/postgres.js';
import type { MariadbLiveMetrics } from '../services/mariadb.js';
import { parseServiceType } from '../services/service-types.js';
import { getRobinConfigTableName, robinConfigTableHasSchema } from '../db/queries/robin-config-meta.js';
import { getConfigStorePayload } from '../db/queries/config-store.js';
import {
  getEnabledMetricsFleetServices,
  type MetricsFleetService,
} from '../db/queries/service-metrics.js';
import { getFleetServiceCount } from '../db/queries/fleet-services.js';
import { getCurrentAdmin, requireAuth } from '../middleware/auth.js';
import { requireViewer } from '../middleware/rbac.js';
import { getAdminPreference, setAdminPreference } from '../db/queries/admin-preferences.js';
import { logger } from '../logger.js';
import * as reporting from '../db/queries/reporting.js';
import { query } from '../db/connection.js';
import { telemetryStoreConfigured } from '../services/telemetry/store-client.js';

const router = Router();

interface DashboardMetricsScope {
  serviceType: MetricsServiceType;
  serviceId: string | null;
}

interface RobinFleetDashboardService {
  serviceId: string;
  serviceType: 'robin';
  name: string;
  healthy: boolean;
  metrics: ReturnType<typeof buildRobinDashboardMetrics> | null;
}

interface RspamdFleetDashboardService {
  serviceId: string;
  serviceType: 'rspamd';
  name: string;
  healthy: boolean;
  metrics: ReturnType<typeof buildRspamdDashboardMetrics> | null;
}

interface ClamavFleetDashboardService {
  serviceId: string;
  serviceType: 'clamav';
  name: string;
  healthy: boolean;
  metrics: ReturnType<typeof buildClamavDashboardMetrics> | null;
}

interface DovecotFleetDashboardService {
  serviceId: string;
  serviceType: 'dovecot';
  name: string;
  healthy: boolean;
  metrics: ReturnType<typeof buildDovecotDashboardMetrics> | null;
}

interface PostfixFleetDashboardService {
  serviceId: string;
  serviceType: 'postfix';
  name: string;
  healthy: boolean;
  metrics: ReturnType<typeof buildPostfixDashboardMetrics> | null;
}

interface RedisFleetDashboardService {
  serviceId: string;
  serviceType: 'redis';
  name: string;
  healthy: boolean;
  metrics: ReturnType<typeof buildRedisDashboardMetrics> | null;
}

interface PostgresFleetDashboardService {
  serviceId: string;
  serviceType: 'postgres';
  name: string;
  healthy: boolean;
  metrics: ReturnType<typeof buildPostgresDashboardMetrics> | null;
}

interface MariadbFleetDashboardService {
  serviceId: string;
  serviceType: 'mariadb';
  name: string;
  healthy: boolean;
  metrics: ReturnType<typeof buildMariadbDashboardMetrics> | null;
}

type FleetDashboardService =
  | RobinFleetDashboardService
  | RspamdFleetDashboardService
  | ClamavFleetDashboardService
  | DovecotFleetDashboardService
  | PostfixFleetDashboardService
  | RedisFleetDashboardService
  | PostgresFleetDashboardService
  | MariadbFleetDashboardService;

interface DashboardConfigWarnings {
  staticTestUsersEnabled: boolean;
  developmentOptionsEnabled: boolean;
  enabledReasons: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function getDashboardConfigWarnings(hasRobinConfig: boolean): Promise<DashboardConfigWarnings> {
  if (!hasRobinConfig) {
    return {
      staticTestUsersEnabled: false,
      developmentOptionsEnabled: false,
      enabledReasons: [],
    };
  }

  const tableName = await getRobinConfigTableName();
  const [usersConfig, serverConfig] = await Promise.all([
    getConfigStorePayload<Record<string, unknown>>(tableName, 'server_id', 'default', 'users.json5').catch(() => null),
    getConfigStorePayload<Record<string, unknown>>(tableName, 'server_id', 'default', 'server.json5').catch(() => null),
  ]);

  const staticTestUsersEnabled = isRecord(usersConfig) && usersConfig.listEnabled === true;
  const developmentOptionsEnabled = isRecord(serverConfig)
    && (serverConfig.chaosHeaders === true || serverConfig.xclientEnabled === true);

  return {
    staticTestUsersEnabled,
    developmentOptionsEnabled,
    enabledReasons: [
      ...(staticTestUsersEnabled ? ['Static test users'] : []),
      ...(developmentOptionsEnabled ? ['server development options'] : []),
    ],
  };
}

function parseDashboardMetricsScope(req: Request): DashboardMetricsScope {
  const serviceType: MetricsServiceType = parseServiceType(req.query.serviceType) ?? 'robin';
  const candidate = typeof req.query.serviceId === 'string' ? req.query.serviceId.trim() : '';

  if (!candidate || candidate === 'default') {
    return { serviceType, serviceId: null };
  }

  return { serviceType, serviceId: candidate };
}

export function delta(current: number, previous: number): number {
  return Math.max(0, current - previous);
}

/**
 * Cumulative 24h delta of a monotonic counter, summed step-by-step rather than
 * taken as a single (last - first) subtraction. Step-summing means a mid-window
 * counter reset (e.g. a service restart) only zeroes the one straddling step
 * instead of erasing the whole window, and it stays stable when the underlying
 * history is downsampled — swapping which row represents a bucket only nudges
 * a couple of steps instead of replacing the single first/last endpoint used
 * as the whole window's baseline.
 */
export function sumDelta<T>(history: T[], pick: (row: T) => number): number {
  // A sample taken while the service was unreachable can hold zero placeholder
  // counters; a step from it to the next real sample would count the whole
  // lifetime counter. Unreachable samples that still carry a value (Postfix
  // counters come from its logs) are kept.
  const measured = history.filter((row) => {
    const flags = row as { reachable?: unknown; controllerReachable?: unknown };
    const unreachable = flags.reachable === false || flags.controllerReachable === false;
    return !(unreachable && pick(row) === 0);
  });
  let sum = 0;
  for (let i = 1; i < measured.length; i++) {
    sum += delta(pick(measured[i]), pick(measured[i - 1]));
  }
  return sum;
}

export function calculateRobinActivity24h(history: RobinMetricsHistoryRow[]) {
  if (history.length <= 1) {
    return {
      received: 0,
      delivered: 0,
      rejected: 0,
      rblRejected: 0,
      virusRejected: 0,
      spamRejected: 0,
      dosBlocked: 0,
    };
  }

  const rblRejected = sumDelta(history, (row) => row.rblRejections);
  const virusRejected = sumDelta(history, (row) => row.virusRejections);
  const spamRejected = sumDelta(history, (row) => row.spamRejections);
  const dosBlocked = sumDelta(history, (row) => (
    row.dosRatelimitRejections +
    row.dosConnlimitRejections +
    row.dosTarpitCount +
    row.dosSlowtransferRejections +
    row.dosCommandfloodRejections
  ));

  return {
    received: sumDelta(history, (row) => row.emailReceiptStart),
    delivered: sumDelta(history, (row) => row.emailReceiptSuccess),
    rejected: rblRejected + virusRejected + spamRejected,
    rblRejected,
    virusRejected,
    spamRejected,
    dosBlocked,
  };
}

function calculateRspamdActivity24h(history: RspamdMetricsHistoryRow[]) {
  if (history.length <= 1) {
    return {
      scanned: 0,
      spam: 0,
      ham: 0,
      learnedSpam: 0,
      learnedHam: 0,
      actions: {
        addHeader: 0,
        reject: 0,
        softReject: 0,
        greylist: 0,
        noAction: 0,
        rewriteSubject: 0,
        discard: 0,
        quarantine: 0,
      },
      totalActions: 0,
    };
  }

  const actions = {
    addHeader: sumDelta(history, (row) => row.actionsAddHeader),
    reject: sumDelta(history, (row) => row.actionsReject),
    softReject: sumDelta(history, (row) => row.actionsSoftReject),
    greylist: sumDelta(history, (row) => row.actionsGreylist),
    noAction: sumDelta(history, (row) => row.actionsNoAction),
    rewriteSubject: sumDelta(history, (row) => row.actionsRewriteSubject),
    discard: sumDelta(history, (row) => row.actionsDiscard),
    quarantine: sumDelta(history, (row) => row.actionsQuarantine),
  };

  return {
    scanned: sumDelta(history, (row) => row.scannedMessages),
    spam: sumDelta(history, (row) => row.spamMessages),
    ham: sumDelta(history, (row) => row.hamMessages),
    learnedSpam: sumDelta(history, (row) => row.learnedSpam),
    learnedHam: sumDelta(history, (row) => row.learnedHam),
    actions,
    totalActions: Object.values(actions).reduce((sum, value) => sum + value, 0),
  };
}

function calculateClamavActivity24h(history: ClamavMetricsHistoryRow[]) {
  return {
    peakQueue: history.reduce((max, row) => Math.max(max, row.queueItems), 0),
    peakMemoryMB: history.reduce((max, row) => Math.max(max, row.memoryUsedMB), 0),
    unhealthySamples: history.filter((row) => !row.pingOk).length,
  };
}

function calculateDovecotActivity24h(history: DovecotMetricsHistoryRow[]) {
  if (history.length <= 1) {
    return {
      logins: 0,
      authSuccess: 0,
      authFailure: 0,
      imapCommands: 0,
      mailDeliveries: 0,
      peakSessions: history.reduce((max, row) => Math.max(max, row.sessionCount), 0),
      unreachableSamples: history.filter((row) => !row.reachable).length,
    };
  }

  return {
    logins: sumDelta(history, (row) => row.loginCount),
    authSuccess: sumDelta(history, (row) => row.authSuccess),
    authFailure: sumDelta(history, (row) => row.authFailure),
    imapCommands: sumDelta(history, (row) => row.imapCommands),
    mailDeliveries: sumDelta(history, (row) => row.mailDeliveries),
    peakSessions: history.reduce((max, row) => Math.max(max, row.sessionCount), 0),
    unreachableSamples: history.filter((row) => !row.reachable).length,
  };
}

function calculatePostfixActivity24h(history: PostfixMetricsHistoryRow[]) {
  return {
    delivered: sumDelta(history, (row) => row.messagesDelivered),
    deferred: sumDelta(history, (row) => row.messagesDeferred),
    bounced: sumDelta(history, (row) => row.messagesBounced),
    rejected: sumDelta(history, (row) => row.messagesRejected),
    peakQueue: history.reduce((max, row) => Math.max(max, row.queueTotal), 0),
    peakDeferred: history.reduce((max, row) => Math.max(max, row.queueDeferred), 0),
    maxDeferredAgeSecs: history.reduce((max, row) => Math.max(max, row.oldestDeferredAgeSecs), 0),
    unreachableSamples: history.filter((row) => !row.reachable).length,
  };
}

function calculateRedisActivity24h(history: RedisMetricsHistoryRow[]) {
  if (history.length <= 1) {
    return {
      commandsProcessed: 0,
      connectionsReceived: 0,
      keyspaceHits: 0,
      keyspaceMisses: 0,
      evictedKeys: 0,
      expiredKeys: 0,
      rejectedConnections: 0,
      peakConnectedClients: history.reduce((max, row) => Math.max(max, row.connectedClients), 0),
      peakMemoryUsedBytes: history.reduce((max, row) => Math.max(max, row.memoryUsedBytes), 0),
      unreachableSamples: history.filter((row) => !row.reachable).length,
    };
  }

  return {
    commandsProcessed: sumDelta(history, (row) => row.totalCommandsProcessed),
    connectionsReceived: sumDelta(history, (row) => row.totalConnectionsReceived),
    keyspaceHits: sumDelta(history, (row) => row.keyspaceHits),
    keyspaceMisses: sumDelta(history, (row) => row.keyspaceMisses),
    evictedKeys: sumDelta(history, (row) => row.evictedKeys),
    expiredKeys: sumDelta(history, (row) => row.expiredKeys),
    rejectedConnections: sumDelta(history, (row) => row.rejectedConnections),
    peakConnectedClients: history.reduce((max, row) => Math.max(max, row.connectedClients), 0),
    peakMemoryUsedBytes: history.reduce((max, row) => Math.max(max, row.memoryUsedBytes), 0),
    unreachableSamples: history.filter((row) => !row.reachable).length,
  };
}

function calculatePostgresActivity24h(history: PostgresMetricsHistoryRow[]) {
  if (history.length <= 1) {
    return {
      xactCommit: 0,
      xactRollback: 0,
      tupInserted: 0,
      tupUpdated: 0,
      tupDeleted: 0,
      deadlocks: 0,
      tempFiles: 0,
      peakConnectionsTotal: history.reduce((max, row) => Math.max(max, row.connectionsTotal), 0),
      peakConnectionSaturationPct: history.reduce((max, row) => Math.max(max, row.connectionSaturationPct), 0),
      unreachableSamples: history.filter((row) => !row.reachable).length,
    };
  }

  return {
    xactCommit: sumDelta(history, (row) => row.xactCommit),
    xactRollback: sumDelta(history, (row) => row.xactRollback),
    tupInserted: sumDelta(history, (row) => row.tupInserted),
    tupUpdated: sumDelta(history, (row) => row.tupUpdated),
    tupDeleted: sumDelta(history, (row) => row.tupDeleted),
    deadlocks: sumDelta(history, (row) => row.deadlocks),
    tempFiles: sumDelta(history, (row) => row.tempFiles),
    peakConnectionsTotal: history.reduce((max, row) => Math.max(max, row.connectionsTotal), 0),
    peakConnectionSaturationPct: history.reduce((max, row) => Math.max(max, row.connectionSaturationPct), 0),
    unreachableSamples: history.filter((row) => !row.reachable).length,
  };
}

/**
 * MariaDB counters restart with the server (and FLUSH STATUS), and an
 * unreachable sample is all zeros: sum per-step deltas over reachable samples.
 */
export function calculateMariadbActivity24h(history: MariadbMetricsHistoryRow[]) {
  const reachable = history.filter((row) => row.reachable);
  const total = (pick: (row: MariadbMetricsHistoryRow) => number) => sumDelta(reachable, pick);
  const peak = (pick: (row: MariadbMetricsHistoryRow) => number) => history.reduce((max, row) => Math.max(max, pick(row)), 0);
  return {
    questions: total((row) => row.questions),
    comCommit: total((row) => row.comCommit),
    comRollback: total((row) => row.comRollback),
    comInsert: total((row) => row.comInsert),
    comUpdate: total((row) => row.comUpdate),
    comDelete: total((row) => row.comDelete),
    slowQueries: total((row) => row.slowQueries),
    deadlocks: total((row) => row.deadlocks),
    rowLockWaits: total((row) => row.rowLockWaits),
    abortedConnects: total((row) => row.abortedConnects),
    createdTmpDiskTables: total((row) => row.createdTmpDiskTables),
    peakThreadsConnected: peak((row) => row.threadsConnected),
    peakConnectionSaturationPct: peak((row) => row.connectionSaturationPct),
    peakOldestTrxAgeSecs: peak((row) => row.oldestTrxAgeSecs),
    unreachableSamples: history.length - reachable.length,
  };
}

function buildMariadbDashboardMetrics(metrics: MariadbLiveMetrics, activity24h = calculateMariadbActivity24h([])) {
  return {
    serviceId: metrics.serviceId,
    serviceType: metrics.serviceType,
    reachable: metrics.reachable,
    version: metrics.version,
    threadsConnected: metrics.threadsConnected,
    threadsRunning: metrics.threadsRunning,
    maxConnections: metrics.maxConnections,
    connectionSaturationPct: metrics.connectionSaturationPct,
    bufferPoolHitRatio: metrics.bufferPoolHitRatio,
    trxActive: metrics.trxActive,
    oldestTrxAgeSecs: metrics.oldestTrxAgeSecs,
    trxLockWaits: metrics.trxLockWaits,
    databaseSizeBytes: metrics.databaseSizeBytes,
    schemaCount: metrics.schemaCount,
    isReplica: metrics.isReplica,
    secondsBehindSource: metrics.secondsBehindSource,
    questions24h: activity24h.questions,
    commits24h: activity24h.comCommit,
    rollbacks24h: activity24h.comRollback,
    slowQueries24h: activity24h.slowQueries,
    deadlocks24h: activity24h.deadlocks,
    rowLockWaits24h: activity24h.rowLockWaits,
    peakThreadsConnected24h: activity24h.peakThreadsConnected,
    peakConnectionSaturationPct24h: activity24h.peakConnectionSaturationPct,
    peakOldestTrxAgeSecs24h: activity24h.peakOldestTrxAgeSecs,
    unreachableSamples24h: activity24h.unreachableSamples,
  };
}

function buildRobinDashboardMetrics(metrics: RobinMetricsSnapshot, activity24h = calculateRobinActivity24h([])) {
  return {
    serviceId: metrics.serviceId,
    serviceType: metrics.serviceType,
    memoryUsedMB: Math.round(metrics.jvmMemoryUsed / 1048576),
    memoryMaxMB: Math.round(metrics.jvmMemoryMax / 1048576),
    memoryCommittedMB: Math.round(metrics.jvmMemoryCommitted / 1048576),
    memoryPct: metrics.jvmMemoryMax > 0 ? Math.round((metrics.jvmMemoryUsed / metrics.jvmMemoryMax) * 100) : 0,
    threads: metrics.jvmThreadsLive,
    threadsDaemon: metrics.jvmThreadsDaemon,
    threadsPeak: metrics.jvmThreadsPeak,
    threadsStarted: metrics.jvmThreadsStarted,
    cpuPct: Math.round(metrics.processCpuUsage * 1000) / 10,
    processCpuPct: Math.round(metrics.processCpuUsage * 10000) / 100,
    cpuCount: metrics.systemCpuCount,
    loadAverage: metrics.systemLoadAverage,
    gcPauseSeconds: metrics.jvmGcPauseSeconds,
    gcPauseCount: metrics.jvmGcPauseCount,
    gcMemoryAllocatedMB: Math.round(metrics.jvmGcMemoryAllocated / 1048576),
    gcMemoryPromotedMB: Math.round(metrics.jvmGcMemoryPromoted / 1048576),
    gcLiveDataMB: Math.round(metrics.jvmGcLiveDataSize / 1048576),
    bufferCount: metrics.jvmBufferCount,
    bufferMemoryMB: Math.round(metrics.jvmBufferMemoryUsed / 1048576),
    totalReceived: metrics.emailReceiptStart,
    totalDelivered: metrics.emailReceiptSuccess,
    totalLimited: metrics.emailReceiptLimit,
    totalExceptions: metrics.emailReceiptException,
    rblRejections: metrics.rblRejections,
    virusRejections: metrics.virusRejections,
    spamRejections: metrics.spamRejections,
    totalRejected: metrics.rblRejections + metrics.virusRejections + metrics.spamRejections,
    dosRatelimit: metrics.dosRatelimitRejections,
    dosConnlimit: metrics.dosConnlimitRejections,
    dosTarpit: metrics.dosTarpitCount,
    dosSlowTransfer: metrics.dosSlowtransferRejections,
    dosCommandFlood: metrics.dosCommandfloodRejections,
    totalDosBlocked: metrics.dosRatelimitRejections + metrics.dosConnlimitRejections +
      metrics.dosTarpitCount + metrics.dosSlowtransferRejections + metrics.dosCommandfloodRejections,
    whitelistBypasses: metrics.whitelistBypasses,
    adaptiveRatelimit: metrics.adaptiveRatelimitApplied,
    geoipBlocked: metrics.geoipBlockRejections,
    geoipLimited: metrics.geoipLimitApplied,
    distributedErrors: metrics.distributedStoreErrors,
    received24h: activity24h.received,
    delivered24h: activity24h.delivered,
    rejected24h: activity24h.rejected,
    rblRejected24h: activity24h.rblRejected,
    virusRejected24h: activity24h.virusRejected,
    spamRejected24h: activity24h.spamRejected,
    dosBlocked24h: activity24h.dosBlocked,
  };
}

function buildRspamdDashboardMetrics(metrics: RspamdMetricsSnapshot, activity24h = calculateRspamdActivity24h([])) {
  const totalActions = metrics.actionsAddHeader +
    metrics.actionsReject +
    metrics.actionsSoftReject +
    metrics.actionsGreylist +
    metrics.actionsNoAction +
    metrics.actionsRewriteSubject +
    metrics.actionsDiscard +
    metrics.actionsQuarantine;

  return {
    serviceId: metrics.serviceId,
    serviceType: metrics.serviceType,
    controllerReachable: metrics.controllerReachable,
    controllerAuthenticated: metrics.controllerAuthenticated,
    controllerHealthy: metrics.controllerReachable && (metrics.controllerPingOk || metrics.controllerHealthyOk),
    controllerStatusCode: metrics.controllerStatusCode,
    normalWorkerPingOk: metrics.normalWorkerPingOk,
    scannedMessages: metrics.scannedMessages,
    spamMessages: metrics.spamMessages,
    hamMessages: metrics.hamMessages,
    learnedSpam: metrics.learnedSpam,
    learnedHam: metrics.learnedHam,
    totalActions,
    actionBreakdown: {
      addHeader: metrics.actionsAddHeader,
      reject: metrics.actionsReject,
      softReject: metrics.actionsSoftReject,
      greylist: metrics.actionsGreylist,
      noAction: metrics.actionsNoAction,
      rewriteSubject: metrics.actionsRewriteSubject,
      discard: metrics.actionsDiscard,
      quarantine: metrics.actionsQuarantine,
    },
    connections: metrics.connections,
    uptimeSeconds: metrics.uptimeSeconds,
    memoryAllocatedMB: Math.round(metrics.memoryAllocatedBytes / 1048576),
    memoryResidentMB: Math.round(metrics.memoryResidentBytes / 1048576),
    scanned24h: activity24h.scanned,
    spam24h: activity24h.spam,
    ham24h: activity24h.ham,
    learnedSpam24h: activity24h.learnedSpam,
    learnedHam24h: activity24h.learnedHam,
    actionBreakdown24h: activity24h.actions,
    totalActions24h: activity24h.totalActions,
  };
}

function buildClamavDashboardMetrics(metrics: ClamavLiveMetrics, activity24h = calculateClamavActivity24h([])) {
  return {
    serviceId: metrics.serviceId,
    serviceType: metrics.serviceType,
    pingOk: metrics.pingOk,
    versionText: metrics.versionText,
    engineVersion: metrics.engineVersion,
    databaseVersion: metrics.databaseVersion,
    databaseUpdatedAt: metrics.databaseUpdatedAt,
    statusText: metrics.statusText,
    pools: metrics.pools,
    threadsLive: metrics.threadsLive,
    threadsIdle: metrics.threadsIdle,
    threadsMax: metrics.threadsMax,
    queueItems: metrics.queueItems,
    memoryHeapMB: metrics.memoryHeapMB,
    memoryMmapMB: metrics.memoryMmapMB,
    memoryUsedMB: metrics.memoryUsedMB,
    memoryFreeMB: metrics.memoryFreeMB,
    memoryReleasableMB: metrics.memoryReleasableMB,
    memoryPoolsUsedMB: metrics.memoryPoolsUsedMB,
    memoryPoolsTotalMB: metrics.memoryPoolsTotalMB,
    peakQueue24h: activity24h.peakQueue,
    peakMemoryMB24h: activity24h.peakMemoryMB,
    unhealthySamples24h: activity24h.unhealthySamples,
  };
}

function buildDovecotDashboardMetrics(metrics: DovecotLiveMetrics, activity24h = calculateDovecotActivity24h([])) {
  return {
    serviceId: metrics.serviceId,
    serviceType: metrics.serviceType,
    reachable: metrics.reachable,
    authSuccess: metrics.authSuccess,
    authFailure: metrics.authFailure,
    loginCount: metrics.loginCount,
    imapCommands: metrics.imapCommands,
    mailDeliveries: metrics.mailDeliveries,
    sessionCount: metrics.sessionCount,
    userCount: metrics.userCount,
    logins24h: activity24h.logins,
    authSuccess24h: activity24h.authSuccess,
    authFailure24h: activity24h.authFailure,
    imapCommands24h: activity24h.imapCommands,
    mailDeliveries24h: activity24h.mailDeliveries,
    peakSessions24h: activity24h.peakSessions,
    unreachableSamples24h: activity24h.unreachableSamples,
  };
}

function buildPostfixDashboardMetrics(metrics: PostfixLiveMetrics, activity24h = calculatePostfixActivity24h([]), messageCounters = false) {
  return {
    serviceId: metrics.serviceId,
    serviceType: metrics.serviceType,
    reachable: metrics.reachable,
    queueActive: metrics.queueActive,
    queueDeferred: metrics.queueDeferred,
    queueHold: metrics.queueHold,
    queueIncoming: metrics.queueIncoming,
    queueTotal: metrics.queueTotal,
    oldestDeferredAgeSecs: metrics.oldestDeferredAgeSecs,
    // Log-derived; only meaningful while an agent streams the service's log.
    messageCounters,
    delivered24h: activity24h.delivered,
    deferred24h: activity24h.deferred,
    bounced24h: activity24h.bounced,
    rejected24h: activity24h.rejected,
    peakQueue24h: activity24h.peakQueue,
    peakDeferred24h: activity24h.peakDeferred,
    maxDeferredAgeSecs24h: activity24h.maxDeferredAgeSecs,
    unreachableSamples24h: activity24h.unreachableSamples,
  };
}

function buildRedisDashboardMetrics(metrics: RedisLiveMetrics, activity24h = calculateRedisActivity24h([])) {
  return {
    serviceId: metrics.serviceId,
    serviceType: metrics.serviceType,
    reachable: metrics.reachable,
    role: metrics.role,
    connectedClients: metrics.connectedClients,
    blockedClients: metrics.blockedClients,
    maxClients: metrics.maxClients,
    memoryUsedBytes: metrics.memoryUsedBytes,
    memoryPeakBytes: metrics.memoryPeakBytes,
    maxMemoryBytes: metrics.maxMemoryBytes,
    memFragmentationRatio: metrics.memFragmentationRatio,
    hitRatio: metrics.hitRatio,
    instantaneousOpsPerSec: metrics.instantaneousOpsPerSec,
    evictedKeys: metrics.evictedKeys,
    expiredKeys: metrics.expiredKeys,
    dbKeys: metrics.dbKeys,
    dbExpires: metrics.dbExpires,
    connectedSlaves: metrics.connectedSlaves,
    opsProcessed24h: activity24h.commandsProcessed,
    connectionsReceived24h: activity24h.connectionsReceived,
    keyspaceHits24h: activity24h.keyspaceHits,
    keyspaceMisses24h: activity24h.keyspaceMisses,
    evictedKeys24h: activity24h.evictedKeys,
    expiredKeys24h: activity24h.expiredKeys,
    rejectedConnections24h: activity24h.rejectedConnections,
    peakConnectedClients24h: activity24h.peakConnectedClients,
    peakMemoryUsedBytes24h: activity24h.peakMemoryUsedBytes,
    unreachableSamples24h: activity24h.unreachableSamples,
  };
}

function buildPostgresDashboardMetrics(metrics: PostgresLiveMetrics, activity24h = calculatePostgresActivity24h([])) {
  return {
    serviceId: metrics.serviceId,
    serviceType: metrics.serviceType,
    reachable: metrics.reachable,
    connectionsTotal: metrics.connectionsTotal,
    connectionsActive: metrics.connectionsActive,
    connectionsIdle: metrics.connectionsIdle,
    connectionsIdleInTxn: metrics.connectionsIdleInTxn,
    connectionsWaiting: metrics.connectionsWaiting,
    maxConnections: metrics.maxConnections,
    connectionSaturationPct: metrics.connectionSaturationPct,
    cacheHitRatio: metrics.cacheHitRatio,
    commitRatio: metrics.commitRatio,
    databaseSizeBytes: metrics.databaseSizeBytes,
    blockedQueries: metrics.blockedQueries,
    deadTuplesTotal: metrics.deadTuplesTotal,
    replicationLagBytes: metrics.replicationLagBytes,
    xactCommit24h: activity24h.xactCommit,
    xactRollback24h: activity24h.xactRollback,
    tupInserted24h: activity24h.tupInserted,
    tupUpdated24h: activity24h.tupUpdated,
    tupDeleted24h: activity24h.tupDeleted,
    deadlocks24h: activity24h.deadlocks,
    tempFiles24h: activity24h.tempFiles,
    peakConnectionsTotal24h: activity24h.peakConnectionsTotal,
    peakConnectionSaturationPct24h: activity24h.peakConnectionSaturationPct,
    unreachableSamples24h: activity24h.unreachableSamples,
  };
}

function isRobinFleetService(service: FleetDashboardService): service is RobinFleetDashboardService {
  return service.serviceType === 'robin';
}

function getFleetActivityScore(service: FleetDashboardService): number {
  if (!service.metrics) {
    return 0;
  }

  if (service.serviceType === 'robin') {
    return service.metrics.received24h + service.metrics.delivered24h;
  }

  if (service.serviceType === 'rspamd') {
    return service.metrics.scanned24h + service.metrics.totalActions24h;
  }

  if (service.serviceType === 'dovecot') {
    return service.metrics.logins24h + service.metrics.imapCommands24h + service.metrics.sessionCount;
  }

  if (service.serviceType === 'postfix') {
    return service.metrics.queueTotal + service.metrics.peakQueue24h;
  }

  if (service.serviceType === 'redis') {
    return service.metrics.opsProcessed24h + service.metrics.connectedClients;
  }

  if (service.serviceType === 'postgres') {
    return service.metrics.xactCommit24h + service.metrics.xactRollback24h + service.metrics.connectionsActive;
  }

  if (service.serviceType === 'mariadb') {
    return service.metrics.questions24h + service.metrics.threadsConnected;
  }

  return service.metrics.queueItems + service.metrics.peakQueue24h + service.metrics.memoryUsedMB;
}

function buildRobinFleetDashboardService(
  service: MetricsFleetService,
  live: RobinMetricsSnapshot | null,
  history: RobinMetricsHistoryRow[]
): RobinFleetDashboardService {
  const activity24h = calculateRobinActivity24h(history);

  return {
    serviceId: service.serviceId,
    serviceType: 'robin',
    name: service.name,
    healthy: live !== null,
    metrics: live ? buildRobinDashboardMetrics(live, activity24h) : null,
  };
}

function buildRspamdFleetDashboardService(
  service: MetricsFleetService,
  live: RspamdMetricsSnapshot | null,
  history: RspamdMetricsHistoryRow[]
): RspamdFleetDashboardService {
  const activity24h = calculateRspamdActivity24h(history);
  const healthy = Boolean(
    live &&
    live.controllerReachable &&
    (live.controllerAuthenticated || live.controllerPingOk || live.controllerHealthyOk)
  );

  return {
    serviceId: service.serviceId,
    serviceType: 'rspamd',
    name: service.name,
    healthy,
    metrics: live ? buildRspamdDashboardMetrics(live, activity24h) : null,
  };
}

function buildClamavFleetDashboardService(
  service: MetricsFleetService,
  live: ClamavLiveMetrics | null,
  history: ClamavMetricsHistoryRow[]
): ClamavFleetDashboardService {
  const activity24h = calculateClamavActivity24h(history);

  return {
    serviceId: service.serviceId,
    serviceType: 'clamav',
    name: service.name,
    healthy: Boolean(live?.pingOk),
    metrics: live ? buildClamavDashboardMetrics(live, activity24h) : null,
  };
}

function buildDovecotFleetDashboardService(
  service: MetricsFleetService,
  live: DovecotLiveMetrics | null,
  history: DovecotMetricsHistoryRow[]
): DovecotFleetDashboardService {
  const activity24h = calculateDovecotActivity24h(history);

  return {
    serviceId: service.serviceId,
    serviceType: 'dovecot',
    name: service.name,
    healthy: Boolean(live?.reachable),
    metrics: live ? buildDovecotDashboardMetrics(live, activity24h) : null,
  };
}

function buildPostfixFleetDashboardService(
  service: MetricsFleetService,
  live: PostfixLiveMetrics | null,
  history: PostfixMetricsHistoryRow[],
  messageCounters: boolean
): PostfixFleetDashboardService {
  const activity24h = calculatePostfixActivity24h(history);

  return {
    serviceId: service.serviceId,
    serviceType: 'postfix',
    name: service.name,
    healthy: Boolean(live?.reachable),
    metrics: live ? buildPostfixDashboardMetrics(live, activity24h, messageCounters) : null,
  };
}

function buildRedisFleetDashboardService(
  service: MetricsFleetService,
  live: RedisLiveMetrics | null,
  history: RedisMetricsHistoryRow[]
): RedisFleetDashboardService {
  const activity24h = calculateRedisActivity24h(history);

  return {
    serviceId: service.serviceId,
    serviceType: 'redis',
    name: service.name,
    healthy: Boolean(live?.reachable),
    metrics: live ? buildRedisDashboardMetrics(live, activity24h) : null,
  };
}

function buildPostgresFleetDashboardService(
  service: MetricsFleetService,
  live: PostgresLiveMetrics | null,
  history: PostgresMetricsHistoryRow[]
): PostgresFleetDashboardService {
  const activity24h = calculatePostgresActivity24h(history);

  return {
    serviceId: service.serviceId,
    serviceType: 'postgres',
    name: service.name,
    healthy: Boolean(live?.reachable),
    metrics: live ? buildPostgresDashboardMetrics(live, activity24h) : null,
  };
}

function buildMariadbFleetDashboardService(
  service: MetricsFleetService,
  live: MariadbLiveMetrics | null,
  history: MariadbMetricsHistoryRow[]
): MariadbFleetDashboardService {
  return {
    serviceId: service.serviceId,
    serviceType: 'mariadb',
    name: service.name,
    healthy: Boolean(live?.reachable),
    metrics: live ? buildMariadbDashboardMetrics(live, calculateMariadbActivity24h(history)) : null,
  };
}

/**
 * GET /api/dashboard/features
 * Get available features based on existing tables.
 * This endpoint doesn't require authentication so the UI can adapt before login.
 */
const EMPTY_FLEET_COUNTS = {
  total: 0,
  enabled: 0,
  byType: {
    robin: { total: 0, enabled: 0 },
    rspamd: { total: 0, enabled: 0 },
    clamav: { total: 0, enabled: 0 },
    dovecot: { total: 0, enabled: 0 },
    postfix: { total: 0, enabled: 0 },
    redis: { total: 0, enabled: 0 },
    postgres: { total: 0, enabled: 0 },
    mariadb: { total: 0, enabled: 0 },
  },
};

router.get('/features', async (req: Request, res: Response) => {
  try {
    const authenticated = Boolean(getCurrentAdmin(req));
    const [
      hasUsers,
      hasAliases,
      hasAutoAliases,
      hasQueue,
      hasRobinConfig,
      config,
      fleetCounts,
    ] = await Promise.all([
      usersTableExists(),
      aliasesTableExists(),
      autoAliasesTableExists(),
      queueTableExists(),
      robinConfigTableHasSchema(),
      getConfig(),
      authenticated ? getFleetServiceCount().catch(() => EMPTY_FLEET_COUNTS) : Promise.resolve(EMPTY_FLEET_COUNTS),
    ]);

    res.json({
      success: true,
      data: {
        users: hasUsers,
        aliases: hasAliases,
        autoAliases: hasAutoAliases,
        mailboxes: config.mailboxesEnabled,
        queue: hasQueue,
        dmarc: config.reportingIntegrationEnabled,
        reporting: config.reportingIntegrationEnabled,
        robin: fleetCounts.byType.robin.enabled > 0,
        fleet: config.fleetEnabled,
        monitoring: config.monitoringEnabled,
        telemetry: config.telemetryEnabled,
        modules: config.modulesEnabled,
        robinConfig: hasRobinConfig,
        rspamd: fleetCounts.byType.rspamd.enabled > 0,
        clamav: fleetCounts.byType.clamav.enabled > 0,
        dovecot: fleetCounts.byType.dovecot.enabled > 0,
        postfix: fleetCounts.byType.postfix.enabled > 0,
        redis: fleetCounts.byType.redis.enabled > 0,
        postgres: fleetCounts.byType.postgres.enabled > 0,
        mariadb: fleetCounts.byType.mariadb.enabled > 0,
        fleetEnabled: config.fleetEnabled,
        monitoringEnabled: config.monitoringEnabled,
        telemetryEnabled: config.telemetryEnabled,
        telemetryStoreConfigured: authenticated ? await telemetryStoreConfigured() : false,
        modulesEnabled: config.modulesEnabled,
        fleetServices: {
          total: fleetCounts.total,
          robin: fleetCounts.byType.robin.total,
          rspamd: fleetCounts.byType.rspamd.total,
          clamav: fleetCounts.byType.clamav.total,
          dovecot: fleetCounts.byType.dovecot.total,
          postfix: fleetCounts.byType.postfix.total,
          redis: fleetCounts.byType.redis.total,
          postgres: fleetCounts.byType.postgres.total,
          mariadb: fleetCounts.byType.mariadb.total,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get features', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get features',
    });
  }
});

// All other routes require authentication
router.use(requireAuth);
router.use(requireViewer);

/**
 * GET /api/dashboard
 * Get dashboard statistics.
 * Scoped by ?serviceType=robin|rspamd and ?serviceId=...
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const { serviceType, serviceId } = parseDashboardMetricsScope(req);

    const [hasUsers, hasAliases, hasAutoAliases, hasQueue, hasRobinConfig, config] = await Promise.all([
      usersTableExists(),
      aliasesTableExists(),
      autoAliasesTableExists(),
      queueTableExists(),
      robinConfigTableHasSchema(),
      getConfig(),
    ]);

    const metricsPromise = serviceType === 'rspamd'
      ? Promise.all([
        getLiveRspamdMetrics(serviceId ?? undefined).catch(() => null),
        getRspamdMetricsHistory(24, 500, serviceId).catch(() => []),
      ])
      : serviceType === 'clamav'
        ? Promise.all([
          getLiveClamavMetrics(serviceId ?? undefined).catch(() => null),
          getClamavMetricsHistory(24, 500, serviceId).catch(() => []),
        ])
        : serviceType === 'dovecot'
          ? Promise.all([
            getLiveDovecotMetrics(serviceId ?? undefined).catch(() => null),
            getDovecotMetricsHistory(24, 500, serviceId).catch(() => []),
          ])
          : serviceType === 'postfix'
            ? Promise.all([
              getLivePostfixMetrics(serviceId ?? undefined).catch(() => null),
              getPostfixMetricsHistory(24, 500, serviceId).catch(() => []),
            ])
            : serviceType === 'redis'
              ? Promise.all([
                getLiveRedisMetrics(serviceId ?? undefined).catch(() => null),
                getRedisMetricsHistory(24, 500, serviceId).catch(() => []),
              ])
              : serviceType === 'postgres'
                ? Promise.all([
                  getLivePostgresMetrics(serviceId ?? undefined).catch(() => null),
                  getPostgresMetricsHistory(24, 500, serviceId).catch(() => []),
                ])
                : serviceType === 'mariadb'
                  ? Promise.all([
                    getLiveMariadbMetrics(serviceId ?? undefined).catch(() => null),
                    getMariadbMetricsHistory(24, 500, serviceId).catch(() => []),
                  ])
                  : Promise.all([
                  getLiveRobinMetrics(serviceId ?? undefined).catch(() => null),
                  getRobinMetricsHistory(24, 500, serviceId).catch(() => []),
                ]);

    const [
      usersCount,
      aliasesCount,
      autoAliasesCount,
      adminsCount,
      queueStats,
      robinHealth,
      dmarcStats,
      tlsrptStats,
      forensicStats,
      [liveMetrics, metricsHistory],
      configWarnings,
    ] = await Promise.all([
      config.mailboxesEnabled && hasUsers ? countUsers() : Promise.resolve(0),
      config.mailboxesEnabled && hasAliases ? countAliases() : Promise.resolve(0),
      config.mailboxesEnabled && hasAutoAliases ? countAutoAliases() : Promise.resolve(0),
      countActiveAdmins(),
      hasQueue ? getQueueStats() : Promise.resolve({ total: 0, pending: 0, failed: 0 }),
      checkRobinHealth(),
      getDmarcStats().catch(() => ({ totalReports: 0, totalMessages: 0, errorMessages: 0, recentReports: 0, last30Days: 0 })),
      getTlsrptStats().catch(() => ({ totalReports: 0, last24Hours: 0, last30Days: 0, totalSuccess: 0, totalFailure: 0, topFailureTypes: [] })),
      getForensicStats().catch(() => ({ totalReports: 0, last24Hours: 0, last30Days: 0, byFeedbackType: [], byAuthFailure: [], topDomains: [], topSourceIps: [] })),
      metricsPromise,
      getDashboardConfigWarnings(hasRobinConfig),
    ]);

    const robinActivity24h = serviceType === 'robin'
      ? calculateRobinActivity24h(metricsHistory as RobinMetricsHistoryRow[])
      : calculateRobinActivity24h([]);
    const rspamdActivity24h = serviceType === 'rspamd'
      ? calculateRspamdActivity24h(metricsHistory as RspamdMetricsHistoryRow[])
      : calculateRspamdActivity24h([]);
    const clamavActivity24h = serviceType === 'clamav'
      ? calculateClamavActivity24h(metricsHistory as ClamavMetricsHistoryRow[])
      : calculateClamavActivity24h([]);
    const dovecotActivity24h = serviceType === 'dovecot'
      ? calculateDovecotActivity24h(metricsHistory as DovecotMetricsHistoryRow[])
      : calculateDovecotActivity24h([]);
    const postfixActivity24h = serviceType === 'postfix'
      ? calculatePostfixActivity24h(metricsHistory as PostfixMetricsHistoryRow[])
      : calculatePostfixActivity24h([]);
    const redisActivity24h = serviceType === 'redis'
      ? calculateRedisActivity24h(metricsHistory as RedisMetricsHistoryRow[])
      : calculateRedisActivity24h([]);
    const postgresActivity24h = serviceType === 'postgres'
      ? calculatePostgresActivity24h(metricsHistory as PostgresMetricsHistoryRow[])
      : calculatePostgresActivity24h([]);
    const mariadbActivity24h = serviceType === 'mariadb'
      ? calculateMariadbActivity24h(metricsHistory as MariadbMetricsHistoryRow[])
      : calculateMariadbActivity24h([]);

    const selectedServiceId = serviceType === 'rspamd'
      ? (liveMetrics as RspamdMetricsSnapshot | null)?.serviceId ?? serviceId
      : serviceType === 'clamav'
        ? (liveMetrics as ClamavLiveMetrics | null)?.serviceId ?? serviceId
        : serviceType === 'dovecot'
          ? (liveMetrics as DovecotLiveMetrics | null)?.serviceId ?? serviceId
          : serviceType === 'postfix'
            ? (liveMetrics as PostfixLiveMetrics | null)?.serviceId ?? serviceId
            : serviceType === 'redis'
              ? (liveMetrics as RedisLiveMetrics | null)?.serviceId ?? serviceId
              : serviceType === 'postgres'
                ? (liveMetrics as PostgresLiveMetrics | null)?.serviceId ?? serviceId
                : serviceType === 'mariadb'
                  ? (liveMetrics as MariadbLiveMetrics | null)?.serviceId ?? serviceId
                  : (liveMetrics as RobinMetricsSnapshot | null)?.serviceId ?? serviceId ?? 'default';

    res.json({
      success: true,
      data: {
        users: usersCount,
        aliases: aliasesCount,
        autoAliases: autoAliasesCount,
        admins: adminsCount,
        queue: queueStats,
        robinConnected: robinHealth,
        dmarc: dmarcStats,
        tlsrpt: tlsrptStats,
        forensic: forensicStats,
        configWarnings,
        selectedService: {
          serviceType,
          serviceId: selectedServiceId,
        },
        metrics: serviceType === 'rspamd'
          ? (liveMetrics && liveMetrics.serviceType === 'rspamd'
            ? buildRspamdDashboardMetrics(liveMetrics, rspamdActivity24h)
            : null)
          : serviceType === 'clamav'
            ? (liveMetrics && liveMetrics.serviceType === 'clamav'
              ? buildClamavDashboardMetrics(liveMetrics, clamavActivity24h)
              : null)
            : serviceType === 'dovecot'
              ? (liveMetrics && liveMetrics.serviceType === 'dovecot'
                ? buildDovecotDashboardMetrics(liveMetrics, dovecotActivity24h)
                : null)
              : serviceType === 'postfix'
                ? (liveMetrics && liveMetrics.serviceType === 'postfix'
                  ? buildPostfixDashboardMetrics(liveMetrics, postfixActivity24h)
                  : null)
                : serviceType === 'redis'
                  ? (liveMetrics && liveMetrics.serviceType === 'redis'
                    ? buildRedisDashboardMetrics(liveMetrics, redisActivity24h)
                    : null)
                  : serviceType === 'postgres'
                    ? (liveMetrics && liveMetrics.serviceType === 'postgres'
                      ? buildPostgresDashboardMetrics(liveMetrics, postgresActivity24h)
                      : null)
                    : serviceType === 'mariadb'
                      ? (liveMetrics && liveMetrics.serviceType === 'mariadb'
                        ? buildMariadbDashboardMetrics(liveMetrics, mariadbActivity24h)
                        : null)
                      : (liveMetrics && liveMetrics.serviceType === 'robin'
                      ? buildRobinDashboardMetrics(liveMetrics, robinActivity24h)
                      : null),
        metrics24h: serviceType === 'rspamd'
          ? rspamdActivity24h
          : serviceType === 'clamav'
            ? clamavActivity24h
            : serviceType === 'dovecot'
              ? dovecotActivity24h
              : serviceType === 'postfix'
                ? postfixActivity24h
                : serviceType === 'redis'
                  ? redisActivity24h
                  : serviceType === 'postgres'
                    ? postgresActivity24h
                    : serviceType === 'mariadb'
                      ? mariadbActivity24h
                      : robinActivity24h,
        email24h: serviceType === 'robin'
          ? {
            received: robinActivity24h.received,
            delivered: robinActivity24h.delivered,
            rejected: robinActivity24h.rejected,
          }
          : { received: 0, delivered: 0, rejected: 0 },
      },
    });
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }

    logger.error('Failed to get dashboard stats', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get dashboard stats',
    });
  }
});

/**
 * GET /api/dashboard/fleet
 * Get fleet-aggregated dashboard stats across all enabled services.
 * Each service contributes its type-specific fields plus service-aware totals.
 */
router.get('/fleet', async (_req: Request, res: Response) => {
  try {
    const services = await getEnabledMetricsFleetServices();

    const serviceSummaries = await Promise.all(services.map(async (service) => {
      if (service.serviceType === 'robin') {
        const [liveMetrics, metricsHistory] = await Promise.all([
          getLiveRobinMetrics(service.serviceId).catch(() => null),
          getRobinMetricsHistory(24, 500, service.serviceId).catch(() => []),
        ]);

        return buildRobinFleetDashboardService(service, liveMetrics, metricsHistory);
      }

      if (service.serviceType === 'rspamd') {
        const [liveMetrics, metricsHistory] = await Promise.all([
          getLiveRspamdMetrics(service.serviceId).catch(() => null),
          getRspamdMetricsHistory(24, 500, service.serviceId).catch(() => []),
        ]);

        return buildRspamdFleetDashboardService(service, liveMetrics, metricsHistory);
      }

      if (service.serviceType === 'dovecot') {
        const [liveMetrics, metricsHistory] = await Promise.all([
          getLiveDovecotMetrics(service.serviceId).catch(() => null),
          getDovecotMetricsHistory(24, 500, service.serviceId).catch(() => []),
        ]);

        return buildDovecotFleetDashboardService(service, liveMetrics, metricsHistory);
      }

      if (service.serviceType === 'postfix') {
        const [liveMetrics, metricsHistory, messageCounters] = await Promise.all([
          getLivePostfixMetrics(service.serviceId).catch(() => null),
          getPostfixMetricsHistory(24, 500, service.serviceId).catch(() => []),
          agentLogsLive(service.serviceId).catch(() => false),
        ]);

        return buildPostfixFleetDashboardService(service, liveMetrics, metricsHistory, messageCounters);
      }

      if (service.serviceType === 'redis') {
        const [liveMetrics, metricsHistory] = await Promise.all([
          getLiveRedisMetrics(service.serviceId).catch(() => null),
          getRedisMetricsHistory(24, 500, service.serviceId).catch(() => []),
        ]);

        return buildRedisFleetDashboardService(service, liveMetrics, metricsHistory);
      }

      if (service.serviceType === 'postgres') {
        const [liveMetrics, metricsHistory] = await Promise.all([
          getLivePostgresMetrics(service.serviceId).catch(() => null),
          getPostgresMetricsHistory(24, 500, service.serviceId).catch(() => []),
        ]);

        return buildPostgresFleetDashboardService(service, liveMetrics, metricsHistory);
      }

      if (service.serviceType === 'mariadb') {
        const [liveMetrics, metricsHistory] = await Promise.all([
          getLiveMariadbMetrics(service.serviceId).catch(() => null),
          getMariadbMetricsHistory(24, 500, service.serviceId).catch(() => []),
        ]);

        return buildMariadbFleetDashboardService(service, liveMetrics, metricsHistory);
      }

      const [liveMetrics, metricsHistory] = await Promise.all([
        getLiveClamavMetrics(service.serviceId).catch(() => null),
        getClamavMetricsHistory(24, 500, service.serviceId).catch(() => []),
      ]);

      return buildClamavFleetDashboardService(service, liveMetrics, metricsHistory);
    }));

    const robinServices = serviceSummaries.filter(isRobinFleetService);
    const rspamdServices = serviceSummaries.filter(
      (service): service is RspamdFleetDashboardService => service.serviceType === 'rspamd'
    );
    const clamavServices = serviceSummaries.filter(
      (service): service is ClamavFleetDashboardService => service.serviceType === 'clamav'
    );
    const dovecotServices = serviceSummaries.filter(
      (service): service is DovecotFleetDashboardService => service.serviceType === 'dovecot'
    );
    const postfixServices = serviceSummaries.filter(
      (service): service is PostfixFleetDashboardService => service.serviceType === 'postfix'
    );
    const redisServices = serviceSummaries.filter(
      (service): service is RedisFleetDashboardService => service.serviceType === 'redis'
    );
    const postgresServices = serviceSummaries.filter(
      (service): service is PostgresFleetDashboardService => service.serviceType === 'postgres'
    );
    const mariadbServices = serviceSummaries.filter(
      (service): service is MariadbFleetDashboardService => service.serviceType === 'mariadb'
    );

    const sortedServices = [...serviceSummaries].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return getFleetActivityScore(b) - getFleetActivityScore(a);
    });
    const sortedRobinServices = [...robinServices].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return ((b.metrics?.received24h ?? 0) + (b.metrics?.delivered24h ?? 0)) -
        ((a.metrics?.received24h ?? 0) + (a.metrics?.delivered24h ?? 0));
    });
    const sortedRspamdServices = [...rspamdServices].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return (b.metrics?.scanned24h ?? 0) - (a.metrics?.scanned24h ?? 0);
    });
    const sortedClamavServices = [...clamavServices].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return (b.metrics?.peakQueue24h ?? 0) - (a.metrics?.peakQueue24h ?? 0);
    });
    const sortedDovecotServices = [...dovecotServices].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return (b.metrics?.logins24h ?? 0) - (a.metrics?.logins24h ?? 0);
    });
    const sortedPostfixServices = [...postfixServices].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return (b.metrics?.queueTotal ?? 0) - (a.metrics?.queueTotal ?? 0);
    });
    const sortedRedisServices = [...redisServices].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return (b.metrics?.opsProcessed24h ?? 0) - (a.metrics?.opsProcessed24h ?? 0);
    });
    const sortedPostgresServices = [...postgresServices].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return (b.metrics?.xactCommit24h ?? 0) - (a.metrics?.xactCommit24h ?? 0);
    });
    const sortedMariadbServices = [...mariadbServices].sort((a, b) => {
      if (a.healthy !== b.healthy) {
        return a.healthy ? -1 : 1;
      }
      return (b.metrics?.questions24h ?? 0) - (a.metrics?.questions24h ?? 0);
    });

    const robinFleet = {
      totalInstances: robinServices.length,
      healthyInstances: robinServices.filter((service) => service.healthy).length,
      totalReceived: 0,
      totalDelivered: 0,
      totalRejected: 0,
      received24h: 0,
      delivered24h: 0,
      rejected24h: 0,
      avgMemoryPct: 0,
      avgCpuPct: 0,
      rejectionBreakdown24h: {
        rbl: 0,
        virus: 0,
        spam: 0,
        dos: 0,
      },
    };

    const rspamdFleet = {
      totalServices: rspamdServices.length,
      healthyServices: rspamdServices.filter((service) => service.healthy).length,
      totalScanned: 0,
      totalSpam: 0,
      totalHam: 0,
      scanned24h: 0,
      spam24h: 0,
      ham24h: 0,
      learnedSpam24h: 0,
      learnedHam24h: 0,
      totalActions24h: 0,
      avgMemoryResidentMB: 0,
      avgConnections: 0,
      actionBreakdown24h: {
        addHeader: 0,
        reject: 0,
        softReject: 0,
        greylist: 0,
        noAction: 0,
        rewriteSubject: 0,
        discard: 0,
        quarantine: 0,
      },
    };
    const clamavFleet = {
      totalServices: clamavServices.length,
      healthyServices: clamavServices.filter((service) => service.healthy).length,
      availableServices: clamavServices.filter((service) => service.metrics !== null).length,
      queueItems: 0,
      peakQueue24h: 0,
      avgMemoryUsedMB: 0,
      staleDatabaseServices: 0,
      unhealthySamples24h: 0,
      versions: [] as string[],
    };
    const dovecotFleet = {
      totalServices: dovecotServices.length,
      healthyServices: dovecotServices.filter((service) => service.healthy).length,
      availableServices: dovecotServices.filter((service) => service.metrics !== null).length,
      sessions: 0,
      users: 0,
      logins24h: 0,
      authSuccess24h: 0,
      authFailure24h: 0,
      imapCommands24h: 0,
      mailDeliveries24h: 0,
      peakSessions24h: 0,
      unreachableSamples24h: 0,
    };
    const postfixFleet = {
      totalServices: postfixServices.length,
      healthyServices: postfixServices.filter((service) => service.healthy).length,
      availableServices: postfixServices.filter((service) => service.metrics !== null).length,
      queueActive: 0,
      queueDeferred: 0,
      queueHold: 0,
      queueIncoming: 0,
      queueTotal: 0,
      messageCounters: false,
      delivered24h: 0,
      deferred24h: 0,
      bounced24h: 0,
      rejected24h: 0,
      peakQueue24h: 0,
      peakDeferred24h: 0,
      maxDeferredAgeSecs: 0,
      unreachableSamples24h: 0,
    };
    const redisFleet = {
      totalServices: redisServices.length,
      healthyServices: redisServices.filter((service) => service.healthy).length,
      availableServices: redisServices.filter((service) => service.metrics !== null).length,
      connectedClients: 0,
      memoryUsedBytes: 0,
      hitRatio: 0,
      dbKeys: 0,
      opsProcessed24h: 0,
      connectionsReceived24h: 0,
      keyspaceHits24h: 0,
      keyspaceMisses24h: 0,
      evictedKeys24h: 0,
      expiredKeys24h: 0,
      rejectedConnections24h: 0,
      peakConnectedClients24h: 0,
      peakMemoryUsedBytes24h: 0,
      unreachableSamples24h: 0,
    };
    const postgresFleet = {
      totalServices: postgresServices.length,
      healthyServices: postgresServices.filter((service) => service.healthy).length,
      availableServices: postgresServices.filter((service) => service.metrics !== null).length,
      connectionsTotal: 0,
      connectionsActive: 0,
      cacheHitRatio: 0,
      databaseSizeBytes: 0,
      xactCommit24h: 0,
      xactRollback24h: 0,
      tupInserted24h: 0,
      tupUpdated24h: 0,
      tupDeleted24h: 0,
      deadlocks24h: 0,
      tempFiles24h: 0,
      peakConnectionsTotal24h: 0,
      peakConnectionSaturationPct24h: 0,
      unreachableSamples24h: 0,
    };
    const mariadbFleet = {
      totalServices: mariadbServices.length,
      healthyServices: mariadbServices.filter((service) => service.healthy).length,
      availableServices: mariadbServices.filter((service) => service.metrics !== null).length,
      threadsConnected: 0,
      threadsRunning: 0,
      bufferPoolHitRatio: 0,
      databaseSizeBytes: 0,
      trxLockWaits: 0,
      maxOldestTrxAgeSecs: 0,
      questions24h: 0,
      commits24h: 0,
      slowQueries24h: 0,
      deadlocks24h: 0,
      peakThreadsConnected24h: 0,
      peakConnectionSaturationPct24h: 0,
      unreachableSamples24h: 0,
    };

    let robinMetricsCount = 0;
    for (const service of robinServices) {
      if (!service.metrics) {
        continue;
      }

      robinFleet.totalReceived += service.metrics.totalReceived;
      robinFleet.totalDelivered += service.metrics.totalDelivered;
      robinFleet.totalRejected += service.metrics.totalRejected;
      robinFleet.received24h += service.metrics.received24h;
      robinFleet.delivered24h += service.metrics.delivered24h;
      robinFleet.rejected24h += service.metrics.rejected24h;
      robinFleet.avgMemoryPct += service.metrics.memoryPct;
      robinFleet.avgCpuPct += service.metrics.cpuPct;
      robinFleet.rejectionBreakdown24h.rbl += service.metrics.rblRejected24h;
      robinFleet.rejectionBreakdown24h.virus += service.metrics.virusRejected24h;
      robinFleet.rejectionBreakdown24h.spam += service.metrics.spamRejected24h;
      robinFleet.rejectionBreakdown24h.dos += service.metrics.dosBlocked24h;
      robinMetricsCount += 1;
    }

    if (robinMetricsCount > 0) {
      robinFleet.avgMemoryPct = Math.round(robinFleet.avgMemoryPct / robinMetricsCount);
      robinFleet.avgCpuPct = Math.round((robinFleet.avgCpuPct * 10) / robinMetricsCount) / 10;
    }

    let rspamdMetricsCount = 0;
    for (const service of rspamdServices) {
      if (!service.metrics) {
        continue;
      }

      rspamdFleet.totalScanned += service.metrics.scannedMessages;
      rspamdFleet.totalSpam += service.metrics.spamMessages;
      rspamdFleet.totalHam += service.metrics.hamMessages;
      rspamdFleet.scanned24h += service.metrics.scanned24h;
      rspamdFleet.spam24h += service.metrics.spam24h;
      rspamdFleet.ham24h += service.metrics.ham24h;
      rspamdFleet.learnedSpam24h += service.metrics.learnedSpam24h;
      rspamdFleet.learnedHam24h += service.metrics.learnedHam24h;
      rspamdFleet.totalActions24h += service.metrics.totalActions24h;
      rspamdFleet.avgMemoryResidentMB += service.metrics.memoryResidentMB;
      rspamdFleet.avgConnections += service.metrics.connections;
      rspamdFleet.actionBreakdown24h.addHeader += service.metrics.actionBreakdown24h.addHeader;
      rspamdFleet.actionBreakdown24h.reject += service.metrics.actionBreakdown24h.reject;
      rspamdFleet.actionBreakdown24h.softReject += service.metrics.actionBreakdown24h.softReject;
      rspamdFleet.actionBreakdown24h.greylist += service.metrics.actionBreakdown24h.greylist;
      rspamdFleet.actionBreakdown24h.noAction += service.metrics.actionBreakdown24h.noAction;
      rspamdFleet.actionBreakdown24h.rewriteSubject += service.metrics.actionBreakdown24h.rewriteSubject;
      rspamdFleet.actionBreakdown24h.discard += service.metrics.actionBreakdown24h.discard;
      rspamdFleet.actionBreakdown24h.quarantine += service.metrics.actionBreakdown24h.quarantine;
      rspamdMetricsCount += 1;
    }

    if (rspamdMetricsCount > 0) {
      rspamdFleet.avgMemoryResidentMB = Math.round(rspamdFleet.avgMemoryResidentMB / rspamdMetricsCount);
      rspamdFleet.avgConnections = Math.round(rspamdFleet.avgConnections / rspamdMetricsCount);
    }

    let clamavMetricsCount = 0;
    for (const service of clamavServices) {
      if (!service.metrics) {
        continue;
      }

      clamavFleet.queueItems += service.metrics.queueItems;
      clamavFleet.peakQueue24h = Math.max(clamavFleet.peakQueue24h, service.metrics.peakQueue24h);
      clamavFleet.avgMemoryUsedMB += service.metrics.memoryUsedMB;
      clamavFleet.unhealthySamples24h += service.metrics.unhealthySamples24h;
      if (service.metrics.databaseUpdatedAt) {
        const ageMs = Date.now() - new Date(service.metrics.databaseUpdatedAt).getTime();
        if (ageMs > 3 * 24 * 60 * 60 * 1000) {
          clamavFleet.staleDatabaseServices += 1;
        }
      }
      if (service.metrics.engineVersion) {
        clamavFleet.versions.push(service.metrics.engineVersion);
      }
      clamavMetricsCount += 1;
    }

    if (clamavMetricsCount > 0) {
      clamavFleet.avgMemoryUsedMB = Math.round(clamavFleet.avgMemoryUsedMB / clamavMetricsCount);
    }

    for (const service of dovecotServices) {
      if (!service.metrics) {
        continue;
      }

      dovecotFleet.sessions += service.metrics.sessionCount;
      dovecotFleet.users += service.metrics.userCount;
      dovecotFleet.logins24h += service.metrics.logins24h;
      dovecotFleet.authSuccess24h += service.metrics.authSuccess24h;
      dovecotFleet.authFailure24h += service.metrics.authFailure24h;
      dovecotFleet.imapCommands24h += service.metrics.imapCommands24h;
      dovecotFleet.mailDeliveries24h += service.metrics.mailDeliveries24h;
      dovecotFleet.peakSessions24h = Math.max(dovecotFleet.peakSessions24h, service.metrics.peakSessions24h);
      dovecotFleet.unreachableSamples24h += service.metrics.unreachableSamples24h;
    }

    for (const service of postfixServices) {
      if (!service.metrics) {
        continue;
      }

      postfixFleet.queueActive += service.metrics.queueActive;
      postfixFleet.queueDeferred += service.metrics.queueDeferred;
      postfixFleet.queueHold += service.metrics.queueHold;
      postfixFleet.queueIncoming += service.metrics.queueIncoming;
      postfixFleet.queueTotal += service.metrics.queueTotal;
      postfixFleet.messageCounters ||= service.metrics.messageCounters;
      postfixFleet.delivered24h += service.metrics.delivered24h;
      postfixFleet.deferred24h += service.metrics.deferred24h;
      postfixFleet.bounced24h += service.metrics.bounced24h;
      postfixFleet.rejected24h += service.metrics.rejected24h;
      postfixFleet.peakQueue24h = Math.max(postfixFleet.peakQueue24h, service.metrics.peakQueue24h);
      postfixFleet.peakDeferred24h = Math.max(postfixFleet.peakDeferred24h, service.metrics.peakDeferred24h);
      postfixFleet.maxDeferredAgeSecs = Math.max(postfixFleet.maxDeferredAgeSecs, service.metrics.oldestDeferredAgeSecs);
      postfixFleet.unreachableSamples24h += service.metrics.unreachableSamples24h;
    }

    for (const service of redisServices) {
      if (!service.metrics) {
        continue;
      }

      redisFleet.connectedClients += service.metrics.connectedClients;
      redisFleet.memoryUsedBytes += service.metrics.memoryUsedBytes;
      redisFleet.hitRatio += service.metrics.hitRatio;
      redisFleet.dbKeys += service.metrics.dbKeys;
      redisFleet.opsProcessed24h += service.metrics.opsProcessed24h;
      redisFleet.connectionsReceived24h += service.metrics.connectionsReceived24h;
      redisFleet.keyspaceHits24h += service.metrics.keyspaceHits24h;
      redisFleet.keyspaceMisses24h += service.metrics.keyspaceMisses24h;
      redisFleet.evictedKeys24h += service.metrics.evictedKeys24h;
      redisFleet.expiredKeys24h += service.metrics.expiredKeys24h;
      redisFleet.rejectedConnections24h += service.metrics.rejectedConnections24h;
      redisFleet.peakConnectedClients24h = Math.max(redisFleet.peakConnectedClients24h, service.metrics.peakConnectedClients24h);
      redisFleet.peakMemoryUsedBytes24h = Math.max(redisFleet.peakMemoryUsedBytes24h, service.metrics.peakMemoryUsedBytes24h);
      redisFleet.unreachableSamples24h += service.metrics.unreachableSamples24h;
    }

    for (const service of postgresServices) {
      if (!service.metrics) {
        continue;
      }

      postgresFleet.connectionsTotal += service.metrics.connectionsTotal;
      postgresFleet.connectionsActive += service.metrics.connectionsActive;
      postgresFleet.cacheHitRatio += service.metrics.cacheHitRatio;
      postgresFleet.databaseSizeBytes += service.metrics.databaseSizeBytes;
      postgresFleet.xactCommit24h += service.metrics.xactCommit24h;
      postgresFleet.xactRollback24h += service.metrics.xactRollback24h;
      postgresFleet.tupInserted24h += service.metrics.tupInserted24h;
      postgresFleet.tupUpdated24h += service.metrics.tupUpdated24h;
      postgresFleet.tupDeleted24h += service.metrics.tupDeleted24h;
      postgresFleet.deadlocks24h += service.metrics.deadlocks24h;
      postgresFleet.tempFiles24h += service.metrics.tempFiles24h;
      postgresFleet.peakConnectionsTotal24h = Math.max(postgresFleet.peakConnectionsTotal24h, service.metrics.peakConnectionsTotal24h);
      postgresFleet.peakConnectionSaturationPct24h = Math.max(postgresFleet.peakConnectionSaturationPct24h, service.metrics.peakConnectionSaturationPct24h);
      postgresFleet.unreachableSamples24h += service.metrics.unreachableSamples24h;
    }

    for (const service of mariadbServices) {
      if (!service.metrics) {
        continue;
      }

      mariadbFleet.threadsConnected += service.metrics.threadsConnected;
      mariadbFleet.threadsRunning += service.metrics.threadsRunning;
      mariadbFleet.bufferPoolHitRatio += service.metrics.bufferPoolHitRatio;
      mariadbFleet.databaseSizeBytes += service.metrics.databaseSizeBytes ?? 0;
      mariadbFleet.trxLockWaits += service.metrics.trxLockWaits;
      mariadbFleet.maxOldestTrxAgeSecs = Math.max(mariadbFleet.maxOldestTrxAgeSecs, service.metrics.oldestTrxAgeSecs);
      mariadbFleet.questions24h += service.metrics.questions24h;
      mariadbFleet.commits24h += service.metrics.commits24h;
      mariadbFleet.slowQueries24h += service.metrics.slowQueries24h;
      mariadbFleet.deadlocks24h += service.metrics.deadlocks24h;
      mariadbFleet.peakThreadsConnected24h = Math.max(mariadbFleet.peakThreadsConnected24h, service.metrics.peakThreadsConnected24h);
      mariadbFleet.peakConnectionSaturationPct24h = Math.max(mariadbFleet.peakConnectionSaturationPct24h, service.metrics.peakConnectionSaturationPct24h);
      mariadbFleet.unreachableSamples24h += service.metrics.unreachableSamples24h;
    }

    // Ratios average over reachable services only: an unreachable one reports
    // zeros, which would drag the fleet average down.
    const reachableCount = (services: Array<{ metrics: { reachable: boolean } | null }>) =>
      services.filter((service) => service.metrics?.reachable).length;
    const reachableRedis = reachableCount(redisServices);
    const reachablePostgres = reachableCount(postgresServices);
    const reachableMariadb = reachableCount(mariadbServices);
    redisFleet.hitRatio = reachableRedis > 0
      ? redisServices.reduce((sum, service) => sum + (service.metrics?.reachable ? service.metrics.hitRatio : 0), 0) / reachableRedis
      : 0;
    postgresFleet.cacheHitRatio = reachablePostgres > 0
      ? postgresServices.reduce((sum, service) => sum + (service.metrics?.reachable ? service.metrics.cacheHitRatio : 0), 0) / reachablePostgres
      : 0;
    mariadbFleet.bufferPoolHitRatio = reachableMariadb > 0
      ? mariadbServices.reduce((sum, service) => sum + (service.metrics?.reachable ? service.metrics.bufferPoolHitRatio : 0), 0) / reachableMariadb
      : 0;

    res.json({
      success: true,
      data: {
        fleet: robinFleet,
        overview: {
          totalServices: serviceSummaries.length,
          healthyServices: serviceSummaries.filter((service) => service.healthy).length,
          byType: {
            robin: {
              totalServices: robinServices.length,
              healthyServices: robinFleet.healthyInstances,
              totals: robinFleet,
            },
            rspamd: {
              totalServices: rspamdFleet.totalServices,
              healthyServices: rspamdFleet.healthyServices,
              totals: rspamdFleet,
            },
            clamav: {
              totalServices: clamavFleet.totalServices,
              healthyServices: clamavFleet.healthyServices,
              totals: clamavFleet,
            },
            dovecot: {
              totalServices: dovecotFleet.totalServices,
              healthyServices: dovecotFleet.healthyServices,
              totals: dovecotFleet,
            },
            postfix: {
              totalServices: postfixFleet.totalServices,
              healthyServices: postfixFleet.healthyServices,
              totals: postfixFleet,
            },
            redis: {
              totalServices: redisFleet.totalServices,
              healthyServices: redisFleet.healthyServices,
              totals: redisFleet,
            },
            postgres: {
              totalServices: postgresFleet.totalServices,
              healthyServices: postgresFleet.healthyServices,
              totals: postgresFleet,
            },
            mariadb: {
              totalServices: mariadbFleet.totalServices,
              healthyServices: mariadbFleet.healthyServices,
              totals: mariadbFleet,
            },
          },
        },
        services: sortedServices,
        topServices: sortedServices.slice(0, 5),
        byType: {
          robin: sortedRobinServices,
          rspamd: sortedRspamdServices,
          clamav: sortedClamavServices,
          dovecot: sortedDovecotServices,
          postfix: sortedPostfixServices,
          redis: sortedRedisServices,
          postgres: sortedPostgresServices,
          mariadb: sortedMariadbServices,
        },
      },
    });
  } catch (error) {
    logger.error('Failed to get fleet dashboard', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get fleet dashboard',
    });
  }
});

// In-process cache for /reporting — heavy aggregation, no per-user data,
// fine to share across requests for ~60s. Resets on process restart.
let reportingCache: { at: number; data: unknown } | null = null;
const REPORTING_TTL_MS = 60_000;

/**
 * GET /api/dashboard/reporting
 * Aggregated reporting widgets for the dashboard:
 *   - latestIssues       : top 5 open by severity
 *   - issuesBySeverity   : counts for the donut
 *   - dmarcPassRate7d    : per-day fleet-wide pass rate
 *   - tlsSuccessRate7d   : per-day fleet-wide TLS success rate
 *   - topProblematicDomains : top 5 by riskScore w/ open-issue count
 *   - senderClassificationMix : counts/volume across all domains
 */
router.get('/reporting', async (_req: Request, res: Response) => {
  try {
    if (reportingCache && Date.now() - reportingCache.at < REPORTING_TTL_MS) {
      return res.json({ success: true, data: reportingCache.data, cached: true });
    }

    const [
      issueCounts,
      latest,
      problematic,
      senderMix,
      dmarcSeries,
      tlsSeries,
    ] = await Promise.all([
      reporting.getIssueCounts(),
      reporting.getIssues({ statuses: ['open'] }, { limit: 5, offset: 0 }),
      reporting.getDomainSummaries({ orderBy: 'risk', limit: 5 }),
      query<{ classification: string; count: string; volume: string }>(
        `SELECT classification, COUNT(*) AS count, COALESCE(SUM(total_volume), 0) AS volume
         FROM sender_inventory
         GROUP BY classification`
      ),
      query<{ day: string; rate: number }>(
        `SELECT snapshot_date::date AS day, AVG(dmarc_pass_rate)::real AS rate
         FROM domain_health
         WHERE snapshot_date >= CURRENT_DATE - INTERVAL '7 days'
         GROUP BY snapshot_date
         ORDER BY snapshot_date`
      ),
      query<{ day: string; rate: number }>(
        `SELECT snapshot_date::date AS day, AVG(tls_success_rate)::real AS rate
         FROM domain_health
         WHERE snapshot_date >= CURRENT_DATE - INTERVAL '7 days'
           AND tls_volume > 0
         GROUP BY snapshot_date
         ORDER BY snapshot_date`
      ),
    ]);

    const data = {
      issuesBySeverity: issueCounts,
      latestIssues: latest.issues,
      topProblematicDomains: problematic.map((d) => ({
        domain: d.domain,
        openIssues: d.openIssueCount,
        criticalIssues: d.criticalIssueCount,
        riskScore: d.latestHealth?.riskScore ?? 0,
        trend: d.trend,
      })),
      senderClassificationMix: senderMix.rows.map((r) => ({
        classification: r.classification,
        count: parseInt(r.count, 10),
        volume: parseInt(r.volume, 10),
      })),
      dmarcPassRate7d: dmarcSeries.rows.map((r) => ({
        day: new Date(r.day).toISOString().slice(0, 10),
        rate: Number(r.rate) || 0,
      })),
      tlsSuccessRate7d: tlsSeries.rows.map((r) => ({
        day: new Date(r.day).toISOString().slice(0, 10),
        rate: Number(r.rate) || 0,
      })),
    };

    reportingCache = { at: Date.now(), data };
    res.json({ success: true, data });
  } catch (error) {
    logger.error('Failed to get reporting dashboard', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to get reporting dashboard' });
  }
});

// Per-admin dashboard layout preferences (which cards are hidden).
const DASHBOARD_PREF_KEY = 'dashboard';

interface DashboardPrefs {
  hidden: string[];
}

router.get('/preferences', async (req: Request, res: Response) => {
  try {
    const admin = getCurrentAdmin(req);
    if (!admin) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    const [prefs, setupGuidePending] = await Promise.all([
      getAdminPreference<DashboardPrefs>(admin.adminId, DASHBOARD_PREF_KEY),
      getConfigValue(SETUP_GUIDE_PENDING_KEY),
    ]);
    res.json({
      success: true,
      data: {
        hidden: Array.isArray(prefs?.hidden) ? prefs!.hidden : [],
        setupGuide: setupGuidePending === 'true',
      },
    });
  } catch (error) {
    logger.error('Failed to load dashboard preferences', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to load dashboard preferences' });
  }
});

router.put('/preferences', async (req: Request, res: Response) => {
  try {
    const admin = getCurrentAdmin(req);
    if (!admin) {
      return res.status(401).json({ success: false, error: 'Not authenticated' });
    }
    const hiddenInput = (req.body as { hidden?: unknown })?.hidden;
    const hidden = Array.isArray(hiddenInput)
      ? hiddenInput.filter((id): id is string => typeof id === 'string').slice(0, 100)
      : [];
    await setAdminPreference(admin.adminId, DASHBOARD_PREF_KEY, { hidden });
    res.json({ success: true, data: { hidden } });
  } catch (error) {
    logger.error('Failed to save dashboard preferences', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to save dashboard preferences' });
  }
});

// The first-time setup guide is install-wide: once any admin dismisses it,
// it stays gone for everyone.
router.delete('/setup-guide', async (_req: Request, res: Response) => {
  try {
    await setConfigValue(SETUP_GUIDE_PENDING_KEY, 'false');
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to dismiss setup guide', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to dismiss setup guide' });
  }
});

export default router;
