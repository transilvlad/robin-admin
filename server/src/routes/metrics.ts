/**
 * Metrics API routes — service-aware metrics scoped by serviceType + serviceId.
 */

import { calculateMariadbActivity24h, sumDelta } from './dashboard.js';
import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireViewer } from '../middleware/rbac.js';
import {
  getRawServiceMetrics,
  getClamavMetricsHistory,
  getDovecotMetricsHistory,
  getPostfixMetricsHistory,
  getRedisMetricsHistory,
  getPostgresMetricsHistory,
  getMariadbMetricsHistory,
  getLiveClamavMetrics,
  getLiveDovecotMetrics,
  getLivePostfixMetrics,
  getLiveRedisMetrics,
  getLivePostgresMetrics,
  getLiveMariadbMetrics,
  getLiveRobinMetrics,
  getLiveRspamdMetrics,
  getRobinMetricsHistory,
  getRspamdMetricsHistory,
  type MetricsServiceType,
} from '../services/metrics-poller.js';
import { parseServiceType } from '../services/service-types.js';
import { logger } from '../logger.js';

const router = Router();

interface MetricsScope {
  serviceType: MetricsServiceType;
  serviceId: string | null;
}

function parseMetricsScope(req: Request): MetricsScope {
  const serviceType = parseServiceType(req.query.serviceType) ?? 'robin';
  const candidate = typeof req.query.serviceId === 'string' ? req.query.serviceId.trim() : '';

  if (!candidate || candidate === 'default') {
    return { serviceType, serviceId: null };
  }

  return { serviceType, serviceId: candidate };
}

function calculateRspamdActionTotals(metrics: {
  actionsAddHeader: number;
  actionsReject: number;
  actionsSoftReject: number;
  actionsGreylist: number;
  actionsNoAction: number;
  actionsRewriteSubject: number;
  actionsDiscard: number;
  actionsQuarantine: number;
}) {
  const actionBreakdown = {
    addHeader: metrics.actionsAddHeader,
    reject: metrics.actionsReject,
    softReject: metrics.actionsSoftReject,
    greylist: metrics.actionsGreylist,
    noAction: metrics.actionsNoAction,
    rewriteSubject: metrics.actionsRewriteSubject,
    discard: metrics.actionsDiscard,
    quarantine: metrics.actionsQuarantine,
  };

  return {
    totalActions: Object.values(actionBreakdown).reduce((sum, value) => sum + value, 0),
    actionBreakdown,
  };
}

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/metrics/live
 * Get current live metrics from Robin or Rspamd.
 */
router.get('/live', requireViewer, async (req: Request, res: Response) => {
  try {
    const { serviceType, serviceId } = parseMetricsScope(req);

    if (serviceType === 'rspamd') {
      const metrics = await getLiveRspamdMetrics(serviceId ?? undefined);

      if (!metrics) {
        return res.json({
          success: true,
          data: null,
          message: 'Rspamd metrics endpoint unavailable',
        });
      }

      const { totalActions, actionBreakdown } = calculateRspamdActionTotals(metrics);

      return res.json({
        success: true,
        data: {
          ...metrics,
          totalActions,
          actionBreakdown,
          controllerHealthy: metrics.controllerReachable && (metrics.controllerPingOk || metrics.controllerHealthyOk),
          memoryAllocatedMB: Math.round(metrics.memoryAllocatedBytes / 1048576),
          memoryResidentMB: Math.round(metrics.memoryResidentBytes / 1048576),
        },
      });
    }

    if (serviceType === 'clamav') {
      const metrics = await getLiveClamavMetrics(serviceId ?? undefined);

      if (!metrics) {
        return res.json({
          success: true,
          data: null,
          message: 'ClamAV metrics endpoint unavailable',
        });
      }

      return res.json({
        success: true,
        data: metrics,
      });
    }

    if (serviceType === 'dovecot') {
      const metrics = await getLiveDovecotMetrics(serviceId ?? undefined);

      if (!metrics) {
        return res.json({
          success: true,
          data: null,
          message: 'Dovecot metrics endpoint unavailable',
        });
      }

      return res.json({
        success: true,
        data: metrics,
      });
    }

    if (serviceType === 'postfix') {
      const metrics = await getLivePostfixMetrics(serviceId ?? undefined);

      if (!metrics) {
        return res.json({
          success: true,
          data: null,
          message: 'Postfix metrics endpoint unavailable',
        });
      }

      return res.json({
        success: true,
        data: metrics,
      });
    }

    if (serviceType === 'redis') {
      const metrics = await getLiveRedisMetrics(serviceId ?? undefined);

      if (!metrics) {
        return res.json({
          success: true,
          data: null,
          message: 'Redis metrics endpoint unavailable',
        });
      }

      return res.json({
        success: true,
        data: metrics,
      });
    }

    if (serviceType === 'postgres') {
      const metrics = await getLivePostgresMetrics(serviceId ?? undefined);

      if (!metrics) {
        return res.json({
          success: true,
          data: null,
          message: 'Postgres metrics endpoint unavailable',
        });
      }

      return res.json({
        success: true,
        data: metrics,
      });
    }

    if (serviceType === 'mariadb') {
      const metrics = await getLiveMariadbMetrics(serviceId ?? undefined);
      return res.json({
        success: true,
        data: metrics,
        ...(metrics ? {} : { message: 'MariaDB metrics endpoint unavailable' }),
      });
    }

    const metrics = await getLiveRobinMetrics(serviceId ?? undefined);

    if (!metrics) {
      return res.json({
        success: true,
        data: null,
        message: 'Robin metrics endpoint unavailable',
      });
    }

    const totalRejections = metrics.rblRejections +
      metrics.virusRejections +
      metrics.spamRejections +
      metrics.dosRatelimitRejections +
      metrics.dosConnlimitRejections;

    const memoryPct = metrics.jvmMemoryMax > 0
      ? (metrics.jvmMemoryUsed / metrics.jvmMemoryMax) * 100
      : 0;

    res.json({
      success: true,
      data: {
        ...metrics,
        totalRejections,
        memoryPct: Math.round(memoryPct * 10) / 10,
      },
    });
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }

    logger.error('Failed to get live metrics', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch live metrics',
    });
  }
});

/**
 * GET /api/metrics/raw
 * Get raw metrics text output.
 */
router.get('/raw', requireViewer, async (req: Request, res: Response) => {
  try {
    const { serviceType, serviceId } = parseMetricsScope(req);
    const raw = await getRawServiceMetrics(serviceType, serviceId ?? undefined);
    res.type('text/plain').send(raw);
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).send(`# Error: ${(error as Error).message}`);
    }

    logger.error('Failed to get raw metrics', { error: (error as Error).message });
    res.status(500).send(`# Error: ${(error as Error).message}`);
  }
});

/**
 * GET /api/metrics/history
 * Get historical metrics for charting.
 */
router.get('/history', requireViewer, async (req: Request, res: Response) => {
  try {
    const { serviceType, serviceId } = parseMetricsScope(req);
    const hours = parseInt(req.query.hours as string || '24', 10);
    const validHours = Number.isFinite(hours) ? Math.min(Math.max(hours, 1), 24 * 30) : 24;

    if (serviceType === 'rspamd') {
      const history = await getRspamdMetricsHistory(validHours, 500, serviceId);
      const enriched = history.map((row) => ({
        ...row,
        ...calculateRspamdActionTotals(row),
      }));

      return res.json({
        success: true,
        data: enriched,
      });
    }

    if (serviceType === 'clamav') {
      const history = await getClamavMetricsHistory(validHours, 500, serviceId);
      return res.json({
        success: true,
        data: history,
      });
    }

    if (serviceType === 'dovecot') {
      const history = await getDovecotMetricsHistory(validHours, 500, serviceId);
      return res.json({
        success: true,
        data: history,
      });
    }

    if (serviceType === 'postfix') {
      const history = await getPostfixMetricsHistory(validHours, 500, serviceId);
      return res.json({
        success: true,
        data: history,
      });
    }

    if (serviceType === 'redis') {
      const history = await getRedisMetricsHistory(validHours, 500, serviceId);
      return res.json({
        success: true,
        data: history,
      });
    }

    if (serviceType === 'postgres') {
      const history = await getPostgresMetricsHistory(validHours, 500, serviceId);
      return res.json({
        success: true,
        data: history,
      });
    }

    if (serviceType === 'mariadb') {
      return res.json({
        success: true,
        data: await getMariadbMetricsHistory(validHours, 500, serviceId),
      });
    }

    const history = await getRobinMetricsHistory(validHours, 500, serviceId);
    const rateHistory = history.map((row) => ({
      ...row,
      deliveryRate: row.rateEmailSuccess,
      rejectionRate: row.rateRejections,
    }));

    res.json({
      success: true,
      data: rateHistory,
    });
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }

    logger.error('Failed to get metrics history', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch metrics history',
    });
  }
});

// The 24h totals and peaks read every sample: sampling down to a chart-sized
// set keeps one row per bucket, so a short spike (a queue that drains within
// a minute) could vanish from "Peak queue". A day at the fastest poll interval
// (5s) is 17,280 rows, so this bound never samples.
const STATS_HISTORY_POINTS = 20_000;

/**
 * GET /api/metrics/stats
 * Get summary statistics for dashboard cards.
 */
router.get('/stats', requireViewer, async (req: Request, res: Response) => {
  try {
    const { serviceType, serviceId } = parseMetricsScope(req);

    if (serviceType === 'rspamd') {
      const [live, history] = await Promise.all([
        getLiveRspamdMetrics(serviceId ?? undefined),
        getRspamdMetricsHistory(24, STATS_HISTORY_POINTS, serviceId),
      ]);

      const first = history[0];
      const last = history[history.length - 1];
      const totals24h = last && first
        ? {
          scanned: Math.max(0, last.scannedMessages - first.scannedMessages),
          spam: Math.max(0, last.spamMessages - first.spamMessages),
          ham: Math.max(0, last.hamMessages - first.hamMessages),
          learnedSpam: Math.max(0, last.learnedSpam - first.learnedSpam),
          learnedHam: Math.max(0, last.learnedHam - first.learnedHam),
          actions: {
            addHeader: Math.max(0, last.actionsAddHeader - first.actionsAddHeader),
            reject: Math.max(0, last.actionsReject - first.actionsReject),
            softReject: Math.max(0, last.actionsSoftReject - first.actionsSoftReject),
            greylist: Math.max(0, last.actionsGreylist - first.actionsGreylist),
            noAction: Math.max(0, last.actionsNoAction - first.actionsNoAction),
            rewriteSubject: Math.max(0, last.actionsRewriteSubject - first.actionsRewriteSubject),
            discard: Math.max(0, last.actionsDiscard - first.actionsDiscard),
            quarantine: Math.max(0, last.actionsQuarantine - first.actionsQuarantine),
          },
        }
        : {
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
        };

      return res.json({
        success: true,
        data: {
          serviceType,
          serviceId: live?.serviceId ?? serviceId,
          live: live ? {
            controllerReachable: live.controllerReachable,
            controllerAuthenticated: live.controllerAuthenticated,
            normalWorkerPingOk: live.normalWorkerPingOk,
            scannedMessages: live.scannedMessages,
            spamMessages: live.spamMessages,
            hamMessages: live.hamMessages,
            learnedSpam: live.learnedSpam,
            learnedHam: live.learnedHam,
            connections: live.connections,
            uptimeSeconds: live.uptimeSeconds,
            memoryAllocatedMB: Math.round(live.memoryAllocatedBytes / 1048576),
            memoryResidentMB: Math.round(live.memoryResidentBytes / 1048576),
            ...calculateRspamdActionTotals(live),
          } : null,
          totals24h: {
            ...totals24h,
            totalActions: Object.values(totals24h.actions).reduce((sum, value) => sum + value, 0),
          },
          historyCount: history.length,
        },
      });
    }

    if (serviceType === 'clamav') {
      const [live, history] = await Promise.all([
        getLiveClamavMetrics(serviceId ?? undefined),
        getClamavMetricsHistory(24, STATS_HISTORY_POINTS, serviceId),
      ]);

      const first = history[0];
      const last = history[history.length - 1];
      const totals24h = last && first
        ? {
          queueDelta: Math.max(0, last.queueItems - first.queueItems),
          peakQueue: history.reduce((max, row) => Math.max(max, row.queueItems), 0),
          peakMemoryMB: history.reduce((max, row) => Math.max(max, row.memoryUsedMB), 0),
          unhealthySamples: history.filter((row) => !row.pingOk).length,
        }
        : {
          queueDelta: 0,
          peakQueue: history.reduce((max, row) => Math.max(max, row.queueItems), 0),
          peakMemoryMB: history.reduce((max, row) => Math.max(max, row.memoryUsedMB), 0),
          unhealthySamples: history.filter((row) => !row.pingOk).length,
        };

      return res.json({
        success: true,
        data: {
          serviceType,
          serviceId: live?.serviceId ?? serviceId,
          live: live ? {
            pingOk: live.pingOk,
            engineVersion: live.engineVersion,
            databaseVersion: live.databaseVersion,
            databaseUpdatedAt: live.databaseUpdatedAt,
            statusText: live.statusText,
            pools: live.pools,
            queueItems: live.queueItems,
            threadsLive: live.threadsLive,
            threadsIdle: live.threadsIdle,
            threadsMax: live.threadsMax,
            memoryUsedMB: live.memoryUsedMB,
            memoryHeapMB: live.memoryHeapMB,
            memoryMmapMB: live.memoryMmapMB,
            memoryFreeMB: live.memoryFreeMB,
            memoryReleasableMB: live.memoryReleasableMB,
            memoryPoolsUsedMB: live.memoryPoolsUsedMB,
            memoryPoolsTotalMB: live.memoryPoolsTotalMB,
          } : null,
          totals24h,
          historyCount: history.length,
        },
      });
    }

    if (serviceType === 'dovecot') {
      const [live, history] = await Promise.all([
        getLiveDovecotMetrics(serviceId ?? undefined),
        getDovecotMetricsHistory(24, STATS_HISTORY_POINTS, serviceId),
      ]);

      // Step-summed so a Dovecot restart (counter reset) doesn't zero the window.
      const totals24h = {
        logins: sumDelta(history, (row) => row.loginCount),
        authSuccess: sumDelta(history, (row) => row.authSuccess),
        authFailure: sumDelta(history, (row) => row.authFailure),
        imapCommands: sumDelta(history, (row) => row.imapCommands),
        mailDeliveries: sumDelta(history, (row) => row.mailDeliveries),
        peakSessions: history.reduce((max, row) => Math.max(max, row.sessionCount), 0),
        unreachableSamples: history.filter((row) => !row.reachable).length,
      };

      return res.json({
        success: true,
        data: {
          serviceType,
          serviceId: live?.serviceId ?? serviceId,
          live: live ? {
            reachable: live.reachable,
            authSuccess: live.authSuccess,
            authFailure: live.authFailure,
            loginCount: live.loginCount,
            imapCommands: live.imapCommands,
            mailDeliveries: live.mailDeliveries,
            sessionCount: live.sessionCount,
            userCount: live.userCount,
          } : null,
          totals24h,
          historyCount: history.length,
        },
      });
    }

    if (serviceType === 'postfix') {
      const [live, history] = await Promise.all([
        getLivePostfixMetrics(serviceId ?? undefined),
        getPostfixMetricsHistory(24, STATS_HISTORY_POINTS, serviceId),
      ]);

      const totals24h = {
        peakQueue: history.reduce((max, row) => Math.max(max, row.queueTotal), 0),
        peakDeferred: history.reduce((max, row) => Math.max(max, row.queueDeferred), 0),
        maxDeferredAgeSecs: history.reduce((max, row) => Math.max(max, row.oldestDeferredAgeSecs), 0),
        unreachableSamples: history.filter((row) => !row.reachable).length,
        delivered: sumDelta(history, (row) => row.messagesDelivered),
        deferred: sumDelta(history, (row) => row.messagesDeferred),
        bounced: sumDelta(history, (row) => row.messagesBounced),
        rejected: sumDelta(history, (row) => row.messagesRejected),
      };

      return res.json({
        success: true,
        data: {
          serviceType,
          serviceId: live?.serviceId ?? serviceId,
          live: live ? {
            reachable: live.reachable,
            queueActive: live.queueActive,
            queueDeferred: live.queueDeferred,
            queueHold: live.queueHold,
            queueIncoming: live.queueIncoming,
            queueTotal: live.queueTotal,
            oldestDeferredAgeSecs: live.oldestDeferredAgeSecs,
          } : null,
          totals24h,
          historyCount: history.length,
        },
      });
    }

    if (serviceType === 'redis') {
      const [live, history] = await Promise.all([
        getLiveRedisMetrics(serviceId ?? undefined),
        getRedisMetricsHistory(24, STATS_HISTORY_POINTS, serviceId),
      ]);

      const first = history[0];
      const last = history[history.length - 1];
      const totals24h = last && first
        ? {
          opsProcessed: Math.max(0, last.totalCommandsProcessed - first.totalCommandsProcessed),
          connectionsReceived: Math.max(0, last.totalConnectionsReceived - first.totalConnectionsReceived),
          keyspaceHits: Math.max(0, last.keyspaceHits - first.keyspaceHits),
          keyspaceMisses: Math.max(0, last.keyspaceMisses - first.keyspaceMisses),
          evictedKeys: Math.max(0, last.evictedKeys - first.evictedKeys),
          expiredKeys: Math.max(0, last.expiredKeys - first.expiredKeys),
          rejectedConnections: Math.max(0, last.rejectedConnections - first.rejectedConnections),
          peakConnectedClients: history.reduce((max, row) => Math.max(max, row.connectedClients), 0),
          peakMemoryUsedBytes: history.reduce((max, row) => Math.max(max, row.memoryUsedBytes), 0),
          unreachableSamples: history.filter((row) => !row.reachable).length,
        }
        : {
          opsProcessed: 0,
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

      return res.json({
        success: true,
        data: {
          serviceType,
          serviceId: live?.serviceId ?? serviceId,
          live: live ? {
            reachable: live.reachable,
            role: live.role,
            connectedClients: live.connectedClients,
            blockedClients: live.blockedClients,
            memoryUsedBytes: live.memoryUsedBytes,
            memoryPeakBytes: live.memoryPeakBytes,
            maxMemoryBytes: live.maxMemoryBytes,
            hitRatio: live.hitRatio,
            instantaneousOpsPerSec: live.instantaneousOpsPerSec,
            dbKeys: live.dbKeys,
            dbExpires: live.dbExpires,
            connectedSlaves: live.connectedSlaves,
            evictedKeys: live.evictedKeys,
            expiredKeys: live.expiredKeys,
          } : null,
          totals24h,
          historyCount: history.length,
        },
      });
    }

    if (serviceType === 'postgres') {
      const [live, history] = await Promise.all([
        getLivePostgresMetrics(serviceId ?? undefined),
        getPostgresMetricsHistory(24, STATS_HISTORY_POINTS, serviceId),
      ]);

      const first = history[0];
      const last = history[history.length - 1];
      const totals24h = last && first
        ? {
          xactCommit: Math.max(0, last.xactCommit - first.xactCommit),
          xactRollback: Math.max(0, last.xactRollback - first.xactRollback),
          tupInserted: Math.max(0, last.tupInserted - first.tupInserted),
          tupUpdated: Math.max(0, last.tupUpdated - first.tupUpdated),
          tupDeleted: Math.max(0, last.tupDeleted - first.tupDeleted),
          deadlocks: Math.max(0, last.deadlocks - first.deadlocks),
          tempFiles: Math.max(0, last.tempFiles - first.tempFiles),
          tempBytes: Math.max(0, (last.tempBytes ?? 0) - (first.tempBytes ?? 0)),
          peakConnectionsTotal: history.reduce((max, row) => Math.max(max, row.connectionsTotal), 0),
          peakConnectionSaturationPct: history.reduce((max, row) => Math.max(max, row.connectionSaturationPct), 0),
          unreachableSamples: history.filter((row) => !row.reachable).length,
        }
        : {
          xactCommit: 0,
          xactRollback: 0,
          tupInserted: 0,
          tupUpdated: 0,
          tupDeleted: 0,
          deadlocks: 0,
          tempFiles: 0,
          tempBytes: 0,
          peakConnectionsTotal: history.reduce((max, row) => Math.max(max, row.connectionsTotal), 0),
          peakConnectionSaturationPct: history.reduce((max, row) => Math.max(max, row.connectionSaturationPct), 0),
          unreachableSamples: history.filter((row) => !row.reachable).length,
        };

      return res.json({
        success: true,
        data: {
          serviceType,
          serviceId: live?.serviceId ?? serviceId,
          live: live ? {
            reachable: live.reachable,
            connectionsTotal: live.connectionsTotal,
            connectionsActive: live.connectionsActive,
            connectionsIdle: live.connectionsIdle,
            maxConnections: live.maxConnections,
            connectionSaturationPct: live.connectionSaturationPct,
            cacheHitRatio: live.cacheHitRatio,
            commitRatio: live.commitRatio,
            databaseSizeBytes: live.databaseSizeBytes,
            blockedQueries: live.blockedQueries,
            deadTuplesTotal: live.deadTuplesTotal,
          } : null,
          totals24h,
          historyCount: history.length,
        },
      });
    }

    if (serviceType === 'mariadb') {
      const [live, history] = await Promise.all([
        getLiveMariadbMetrics(serviceId ?? undefined),
        getMariadbMetricsHistory(24, STATS_HISTORY_POINTS, serviceId),
      ]);
      return res.json({
        success: true,
        data: {
          serviceType,
          serviceId: live?.serviceId ?? serviceId,
          live: live ? {
            reachable: live.reachable,
            version: live.version,
            threadsConnected: live.threadsConnected,
            threadsRunning: live.threadsRunning,
            maxConnections: live.maxConnections,
            connectionSaturationPct: live.connectionSaturationPct,
            bufferPoolHitRatio: live.bufferPoolHitRatio,
            trxActive: live.trxActive,
            oldestTrxAgeSecs: live.oldestTrxAgeSecs,
            trxLockWaits: live.trxLockWaits,
            databaseSizeBytes: live.databaseSizeBytes,
            schemaCount: live.schemaCount,
            isReplica: live.isReplica,
            secondsBehindSource: live.secondsBehindSource,
          } : null,
          totals24h: calculateMariadbActivity24h(history),
          historyCount: history.length,
        },
      });
    }

    const [live, history] = await Promise.all([
      getLiveRobinMetrics(serviceId ?? undefined),
      getRobinMetricsHistory(24, STATS_HISTORY_POINTS, serviceId),
    ]);

    let totalDelivered24h = 0;
    let totalRejected24h = 0;

    for (let i = 1; i < history.length; i += 1) {
      const prev = history[i - 1];
      const curr = history[i];

      const delivered = curr.emailReceiptSuccess - prev.emailReceiptSuccess;
      const rejected = (curr.rblRejections + curr.virusRejections + curr.spamRejections) -
        (prev.rblRejections + prev.virusRejections + prev.spamRejections);

      if (delivered > 0) totalDelivered24h += delivered;
      if (rejected > 0) totalRejected24h += rejected;
    }

    const latest = history[history.length - 1];

    res.json({
      success: true,
      data: {
        serviceType,
        serviceId: live?.serviceId ?? serviceId ?? 'default',
        live: live ? {
          memoryUsedMB: Math.round(live.jvmMemoryUsed / 1048576),
          memoryMaxMB: Math.round(live.jvmMemoryMax / 1048576),
          memoryPct: live.jvmMemoryMax > 0 ? Math.round((live.jvmMemoryUsed / live.jvmMemoryMax) * 100) : 0,
          threads: live.jvmThreadsLive,
          cpuPct: Math.round(live.processCpuUsage * 1000) / 10,
          totalReceived: live.emailReceiptStart,
          totalDelivered: live.emailReceiptSuccess,
          totalRejected: live.rblRejections + live.virusRejections + live.spamRejections,
        } : null,
        rates: latest ? {
          deliveryRate: latest.rateEmailSuccess,
          rejectionRate: latest.rateRejections,
        } : null,
        totals24h: {
          delivered: totalDelivered24h,
          rejected: totalRejected24h,
        },
        historyCount: history.length,
      },
    });
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({
        success: false,
        error: (error as Error).message,
      });
    }

    logger.error('Failed to get metrics stats', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to fetch metrics stats',
    });
  }
});

export default router;
