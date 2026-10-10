/**
 * Forensic Intelligence Service
 *
 * AFRF / DMARC forensic reports are sparse but high-signal. The important
 * thing is not the reporter's coarse `auth_failure` label; it is the embedded
 * message headers and Authentication-Results block. This service normalizes the
 * reports in-process and then builds operator-facing clusters and issues from
 * that evidence.
 */

import { pool } from '../db/connection.js';
import type {
  IssueSeverity,
  SourceReportRef,
} from '../types/reporting.js';
import { createRemediation } from '../db/queries/reporting.js';
import { normalizeForensicReport } from './forensic-parser.js';
import {
  DETECTION_THRESHOLDS,
  autoResolveClearedIssues,
  loadDetectionPolicy,
  raiseIssue,
  type DetectionContext,
} from './detection-policy.js';
import {
  emptyCounters,
  failAnalysisRun,
  finishAnalysisRun,
  startAnalysisRun,
} from '../db/queries/analysis-runs.js';
import { getOrgDomain } from './sender-enrichment.js';

interface DbClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

const AUTH_FAILURE_TYPES: Record<string, {
  severity: IssueSeverity;
  description: string;
}> = {
  dmarc: { severity: 'high', description: 'DMARC failed at the embedded receiver' },
  multi: { severity: 'high', description: 'Both SPF and DKIM failed' },
  dkim: { severity: 'medium', description: 'DKIM failed while SPF did not fully compensate' },
  spf: { severity: 'low', description: 'SPF-only failure, usually forwarding noise' },
  noise: { severity: 'info', description: 'Receiver/reporter noise rather than a real auth failure' },
  unknown: { severity: 'low', description: 'Incomplete forensic evidence' },
};

export interface ForensicRecord {
  id: number;
  domain: string;
  sourceIp: string | null;
  primaryFailure: string;
  severity: 'info' | 'warn' | 'urgent';
  verdict: string;
  recommendation: string;
  subject: string | null;
  sender: string | null;
  receivedAt: Date;
}

export interface ForensicCluster {
  domain: string;
  sourceIp: string;
  authFailure: string;
  count: number;
  actionableCount: number;
  subjects: string[];
  firstSeen: Date;
  lastSeen: Date;
  senders: string[];
  /** forensic_reports.id values behind this cluster, newest first. */
  reportIds: number[];
}

interface ForensicDomainStats {
  domain: string;
  totalReports: number;
  actionableReports: number;
  uniqueSources: number;
  authFailures: { type: string; count: number }[];
  topSourceIps: { ip: string; count: number }[];
  recentSpike: boolean;
  /** Reports in the most recent 7 days of the window. */
  recentCount: number;
  /** Reports in the 7 days before that, the spike baseline. */
  previousCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

function classifyRiskLevel(stats: ForensicDomainStats): 'low' | 'medium' | 'high' {
  if (stats.actionableReports >= 5 || (stats.recentSpike && stats.actionableReports > 0)) {
    return 'high';
  }
  if (stats.actionableReports >= 1 || stats.totalReports >= 5) {
    return 'medium';
  }
  return 'low';
}

async function loadForensicRecords(
  client: DbClient,
  domain: string | undefined,
  startDate: Date,
  endDate: Date
): Promise<ForensicRecord[]> {
  const result = await client.query(
    `SELECT id, original_mail_from, original_rcpt_to, source_ip, reported_domain,
            auth_failure, authentication_results, subject, arrival_date, received_date,
            created_at, original_headers, dkim_domain, dkim_selector
     FROM forensic_reports
     WHERE COALESCE(arrival_date, received_date, created_at) >= $1
       AND COALESCE(arrival_date, received_date, created_at) <= $2
     ORDER BY COALESCE(arrival_date, received_date, created_at) DESC`,
    [startDate.toISOString(), endDate.toISOString()]
  );

  return result.rows
    .map((row) => {
      const normalized = normalizeForensicReport({
        originalHeaders: (row.original_headers as string | null) ?? null,
        originalMailFrom: (row.original_mail_from as string | null) ?? null,
        originalRcptTo: (row.original_rcpt_to as string | null) ?? null,
        sourceIp: (row.source_ip as string | null) ?? null,
        reportedDomain: (row.reported_domain as string | null) ?? null,
        authFailure: (row.auth_failure as string | null) ?? null,
        authenticationResults: (row.authentication_results as string | null) ?? null,
        dkimDomain: (row.dkim_domain as string | null) ?? null,
        dkimSelector: (row.dkim_selector as string | null) ?? null,
        subject: (row.subject as string | null) ?? null,
      });

      if (!normalized.domain) return null;
      if (domain && normalized.domain !== domain.toLowerCase()) return null;

      return {
        id: row.id as number,
        domain: normalized.domain,
        sourceIp: normalized.sourceIp,
        primaryFailure: normalized.primaryFailure === 'spf' && normalized.interpretation.severity === 'info'
          ? 'noise'
          : normalized.primaryFailure,
        severity: normalized.interpretation.severity,
        verdict: normalized.interpretation.verdict,
        recommendation: normalized.interpretation.recommendation,
        subject: normalized.subject,
        sender: normalized.fromAddress,
        receivedAt: new Date(
          (row.arrival_date as string | null) ??
          (row.received_date as string | null) ??
          (row.created_at as string)
        ),
      } satisfies ForensicRecord;
    })
    .filter((record): record is ForensicRecord => !!record);
}

function aggregateForensicStats(
  records: ForensicRecord[],
  endDate: Date
): ForensicDomainStats[] {
  const byDomain = new Map<string, ForensicRecord[]>();
  for (const record of records) {
    const bucket = byDomain.get(record.domain) ?? [];
    bucket.push(record);
    byDomain.set(record.domain, bucket);
  }

  return [...byDomain.entries()].map(([domain, domainRecords]) => {
    const actionableReports = domainRecords.filter((record) => record.severity !== 'info').length;
    const uniqueSources = new Set(domainRecords.map((record) => record.sourceIp).filter(Boolean)).size;
    const firstSeen = new Date(Math.min(...domainRecords.map((record) => record.receivedAt.getTime())));
    const lastSeen = new Date(Math.max(...domainRecords.map((record) => record.receivedAt.getTime())));

    const failureCounts = new Map<string, number>();
    const sourceCounts = new Map<string, number>();
    for (const record of domainRecords) {
      failureCounts.set(record.primaryFailure, (failureCounts.get(record.primaryFailure) ?? 0) + 1);
      if (record.sourceIp) {
        sourceCounts.set(record.sourceIp, (sourceCounts.get(record.sourceIp) ?? 0) + 1);
      }
    }

    const sevenDaysAgo = new Date(endDate.getTime() - 7 * 24 * 60 * 60 * 1000);
    const fourteenDaysAgo = new Date(endDate.getTime() - 14 * 24 * 60 * 60 * 1000);
    const recentCount = domainRecords.filter((record) => record.receivedAt >= sevenDaysAgo).length;
    const previousCount = domainRecords.filter((record) => record.receivedAt >= fourteenDaysAgo && record.receivedAt < sevenDaysAgo).length;

    return {
      domain,
      totalReports: domainRecords.length,
      actionableReports,
      uniqueSources,
      authFailures: [...failureCounts.entries()]
        .map(([type, count]) => ({ type, count }))
        .sort((a, b) => b.count - a.count),
      topSourceIps: [...sourceCounts.entries()]
        .map(([ip, count]) => ({ ip, count }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 10),
      recentSpike:
        recentCount >= DETECTION_THRESHOLDS.forensicSpikeMinRecent &&
        recentCount > previousCount * DETECTION_THRESHOLDS.forensicSpikeMultiplier,
      recentCount,
      previousCount,
      firstSeen,
      lastSeen,
    };
  }).sort((a, b) => b.totalReports - a.totalReports);
}

export function clusterForensicRecords(records: ForensicRecord[]): ForensicCluster[] {
  const clusters = new Map<string, ForensicCluster>();

  for (const record of records) {
    if (!record.sourceIp) continue;

    const key = `${record.domain}|${record.sourceIp}|${record.primaryFailure}`;
    const existing = clusters.get(key) ?? {
      domain: record.domain,
      sourceIp: record.sourceIp,
      authFailure: record.primaryFailure,
      count: 0,
      actionableCount: 0,
      subjects: [],
      firstSeen: record.receivedAt,
      lastSeen: record.receivedAt,
      senders: [],
      reportIds: [],
    };

    existing.count += 1;
    if (record.severity !== 'info') existing.actionableCount += 1;
    if (record.subject && !existing.subjects.includes(record.subject)) existing.subjects.push(record.subject);
    if (record.sender && !existing.senders.includes(record.sender)) existing.senders.push(record.sender);
    if (existing.reportIds.length < 50) existing.reportIds.push(record.id);
    existing.firstSeen = existing.firstSeen < record.receivedAt ? existing.firstSeen : record.receivedAt;
    existing.lastSeen = existing.lastSeen > record.receivedAt ? existing.lastSeen : record.receivedAt;
    clusters.set(key, existing);
  }

  return [...clusters.values()]
    .filter((cluster) => cluster.count >= DETECTION_THRESHOLDS.forensicClusterMinOccurrences)
    .sort((a, b) => b.actionableCount - a.actionableCount || b.count - a.count)
    .slice(0, 100);
}

/**
 * Persist clusters so the UI, issue evidence and future runs all refer to
 * the same cluster identity instead of each recomputing its own view.
 */
async function persistForensicClusters(
  client: DbClient,
  clusters: ForensicCluster[],
  runId: number | null
): Promise<void> {
  for (const cluster of clusters) {
    try {
      await client.query(
        `INSERT INTO forensic_clusters (
           domain, source_ip, auth_failure, occurrence_count, actionable_count,
           first_seen, last_seen, last_run_id, subjects, senders, report_ids, updated_at
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10::jsonb,$11::jsonb, NOW())
         ON CONFLICT (domain, source_ip, auth_failure) DO UPDATE SET
           occurrence_count = EXCLUDED.occurrence_count,
           actionable_count = EXCLUDED.actionable_count,
           first_seen = LEAST(forensic_clusters.first_seen, EXCLUDED.first_seen),
           last_seen = GREATEST(forensic_clusters.last_seen, EXCLUDED.last_seen),
           last_run_id = EXCLUDED.last_run_id,
           subjects = EXCLUDED.subjects,
           senders = EXCLUDED.senders,
           report_ids = EXCLUDED.report_ids,
           updated_at = NOW()`,
        [
          cluster.domain,
          cluster.sourceIp,
          cluster.authFailure,
          cluster.count,
          cluster.actionableCount,
          cluster.firstSeen.toISOString(),
          cluster.lastSeen.toISOString(),
          runId,
          JSON.stringify(cluster.subjects.slice(0, 20)),
          JSON.stringify(cluster.senders.slice(0, 20)),
          JSON.stringify(cluster.reportIds),
        ]
      );
    } catch {
      // Cluster persistence is a convenience for the UI; never let it
      // abort the analysis run.
    }
  }
}

function clusterSourceReports(cluster: ForensicCluster): SourceReportRef[] {
  return cluster.reportIds.slice(0, 20).map((id) => ({
    kind: 'forensic' as const,
    id,
    reportId: null,
    orgName: null,
    dateBegin: cluster.firstSeen.toISOString(),
    dateEnd: cluster.lastSeen.toISOString(),
    sourceIp: cluster.sourceIp,
    count: 1,
  }));
}

/**
 * Analyze forensic reports for security intelligence.
 */
export async function analyzeForensicIntelligence(options: {
  domain?: string;
  startDate?: Date;
  endDate?: Date;
  daysBack?: number;
}): Promise<{
  processed: number;
  issues: number;
  clusters: number;
  runId: number | null;
  issuesOpened: number;
  issuesRefreshed: number;
  issuesResolved: number;
  issuesPending: number;
}> {
  await loadDetectionPolicy();
  const client = await pool.connect() as unknown as DbClient;

  const endDate = options.endDate || new Date();
  const startDate = options.startDate ||
    new Date(endDate.getTime() - (options.daysBack || 30) * 24 * 60 * 60 * 1000);

  // Assign runId inside the try so startAnalysisRun failures still release the
  // checked-out client in the finally block.
  let runId: number | undefined;
  try {
    runId = await startAnalysisRun('forensic', startDate, endDate);
    const ctx: DetectionContext = {
      kind: 'forensic',
      runId,
      windowStart: startDate,
      windowEnd: endDate,
      counters: emptyCounters(),
    };

    const records = await loadForensicRecords(client, options.domain, startDate, endDate);
    const domainStats = aggregateForensicStats(records, endDate);
    const clusters = clusterForensicRecords(records);

    await persistForensicClusters(client, clusters, runId);

    for (const stats of domainStats) {
      await detectForensicIssues(
        ctx,
        stats,
        clusters.filter((cluster) => cluster.domain === stats.domain)
      );
    }

    ctx.counters.domainsProcessed = domainStats.length;
    await finishAnalysisRun(runId, ctx.counters);

    return {
      processed: domainStats.length,
      issues: ctx.counters.issuesOpened + ctx.counters.issuesRefreshed,
      clusters: clusters.length,
      runId,
      issuesOpened: ctx.counters.issuesOpened,
      issuesRefreshed: ctx.counters.issuesRefreshed,
      issuesResolved: ctx.counters.issuesResolved,
      issuesPending: ctx.counters.issuesPending,
    };
  } catch (error) {
    if (runId !== undefined) {
      await failAnalysisRun(runId, (error as Error).message).catch(() => {});
    }
    throw error;
  } finally {
    client.release();
  }
}

async function detectForensicIssues(
  ctx: DetectionContext,
  stats: ForensicDomainStats,
  clusters: ForensicCluster[]
): Promise<void> {
  const orgDomain = getOrgDomain(stats.domain);

  if (stats.recentSpike && stats.actionableReports > 0) {
    const { issue } = await raiseIssue(ctx, {
      domain: stats.domain,
      orgDomain,
      issueType: 'forensic_spike',
      severity: classifyRiskLevel(stats) === 'high' ? 'high' : 'medium',
      title: `Actionable forensic spike for ${stats.domain}`,
      description: `${stats.actionableReports} actionable forensic report(s) were observed recently across ${stats.uniqueSources} source(s).`,
      evidence: {
        metrics: {
          actionableReports: stats.actionableReports,
          totalReports: stats.totalReports,
          uniqueSources: stats.uniqueSources,
        },
      },
      trigger: {
        metric: 'forensic_spike_ratio',
        value: stats.previousCount > 0
          ? stats.recentCount / stats.previousCount
          : stats.recentCount,
        threshold: DETECTION_THRESHOLDS.forensicSpikeMultiplier,
        comparator: '>',
      },
    });

    if (issue) {
      await createRemediation({
        issueId: issue.id,
        domain: stats.domain,
        suggestionType: 'forensic_investigation',
        priority: 1,
        title: 'Investigate the current forensic spike',
        description: 'Look at the repeated failing sources first; forensic spikes usually mean either an unauthorized sender rollout or active impersonation.',
        actionSteps: [
          { order: 1, action: 'Review repeated failing source IPs and subjects on the Forensic Intelligence page' },
          { order: 2, action: 'Decide whether each source is a legitimate sender or impersonation traffic' },
          { order: 3, action: 'Authorize legitimate sources via SPF/DKIM or block the impersonators' },
        ],
        dnsChanges: [],
        verificationSteps: [
          { order: 1, description: 'Wait for the next forensic cycle', expectedOutcome: 'Actionable forensic volume drops materially' },
        ],
        estimatedImpact: 'Reduces active impersonation or sender misconfiguration noise quickly.',
      });
    }
  } else {
    await autoResolveClearedIssues(
      ctx, stats.domain, ['forensic_spike'],
      'Auto-resolved: forensic volume returned to its baseline.'
    );
  }

  // Every actionable cluster is a distinct source doing a distinct thing,
  // so each is reported on its own — fixing the top source must not hide
  // identical problems coming from other IPs.
  const actionable = clusters
    .filter((cluster) => cluster.actionableCount > 0)
    .sort((a, b) => b.actionableCount - a.actionableCount || b.count - a.count)
    .slice(0, DETECTION_THRESHOLDS.forensicClusterMaxIssues);

  for (const cluster of actionable) {
    const taxonomy = AUTH_FAILURE_TYPES[cluster.authFailure] ?? AUTH_FAILURE_TYPES.unknown;
    const sourceReports = clusterSourceReports(cluster);
    const { issue } = await raiseIssue(ctx, {
      domain: stats.domain,
      orgDomain,
      issueType: 'repeated_auth_failure',
      severity: taxonomy.severity,
      title: `Repeated forensic failures from ${cluster.sourceIp}`,
      description: `${cluster.count} forensic report(s) from ${cluster.sourceIp} clustered as ${cluster.authFailure}. ${taxonomy.description}.`,
      evidence: {
        senderIps: [cluster.sourceIp],
        samples: cluster.subjects.slice(0, 5).map((subject) => ({ subject })),
        sourceReports,
        reportIds: sourceReports.map((ref) => ref.id),
        metrics: {
          count: cluster.count,
          actionableCount: cluster.actionableCount,
          authFailure: cluster.authFailure,
        },
      },
      trigger: {
        metric: 'forensic_cluster_occurrences',
        value: cluster.count,
        threshold: DETECTION_THRESHOLDS.forensicClusterMinOccurrences,
        comparator: '>=',
      },
    });

    if (!issue) continue;

    await createRemediation({
      issueId: issue.id,
      domain: stats.domain,
      suggestionType: 'source_investigation',
      priority: 1,
      title: `Investigate ${cluster.sourceIp}`,
      description: taxonomy.description,
      actionSteps: [
        { order: 1, action: 'Identify the sender or service behind this source IP' },
        { order: 2, action: 'If legitimate, fix SPF/DKIM alignment at the source' },
        { order: 3, action: 'If illegitimate, treat it as impersonation traffic and block/escalate' },
      ],
      dnsChanges: [],
      verificationSteps: [
        { order: 1, description: 'Watch subsequent forensic reports from this source', expectedOutcome: 'Repeated failures stop or materially decline' },
      ],
      estimatedImpact: 'Targets a specific recurring forensic source.',
    });
  }

  if (actionable.length === 0) {
    await autoResolveClearedIssues(
      ctx, stats.domain, ['repeated_auth_failure'],
      'Auto-resolved: no recurring forensic cluster remains for this domain.'
    );
  }
}

/**
 * Get forensic incident clusters for a domain.
 */
export async function getForensicClusters(
  domain: string,
  daysBack: number = 30
): Promise<ForensicCluster[]> {
  const client = await pool.connect() as unknown as DbClient;

  try {
    const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const records = await loadForensicRecords(client, domain, startDate, new Date());
    return clusterForensicRecords(records);
  } finally {
    client.release();
  }
}

/**
 * Get forensic summary for a domain.
 */
export async function getForensicSummary(
  domain: string,
  daysBack: number = 30
): Promise<{
  domain: string;
  totalReports: number;
  actionableReports: number;
  uniqueSources: number;
  authFailureBreakdown: { type: string; count: number; description: string }[];
  topSourceIps: { ip: string; count: number }[];
  recentTrend: 'increasing' | 'stable' | 'decreasing';
  riskLevel: 'low' | 'medium' | 'high';
}> {
  const client = await pool.connect() as unknown as DbClient;

  try {
    const endDate = new Date();
    const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    const records = await loadForensicRecords(client, domain, startDate, endDate);
    const stats = aggregateForensicStats(records, endDate).find((item) => item.domain === domain);

    if (!stats) {
      return {
        domain,
        totalReports: 0,
        actionableReports: 0,
        uniqueSources: 0,
        authFailureBreakdown: [],
        topSourceIps: [],
        recentTrend: 'stable',
        riskLevel: 'low',
      };
    }

    const midpoint = new Date(Date.now() - (daysBack / 2) * 24 * 60 * 60 * 1000);
    const recentCount = records.filter((record) => record.receivedAt >= midpoint).length;
    const olderCount = records.filter((record) => record.receivedAt < midpoint).length;
    let recentTrend: 'increasing' | 'stable' | 'decreasing' = 'stable';
    if (olderCount > 0) {
      const ratio = recentCount / olderCount;
      if (ratio > 1.5) recentTrend = 'increasing';
      else if (ratio < 0.5) recentTrend = 'decreasing';
    }

    return {
      domain,
      totalReports: stats.totalReports,
      actionableReports: stats.actionableReports,
      uniqueSources: stats.uniqueSources,
      authFailureBreakdown: stats.authFailures.map((failure) => ({
        type: failure.type,
        count: failure.count,
        description: (AUTH_FAILURE_TYPES[failure.type] ?? AUTH_FAILURE_TYPES.unknown).description,
      })),
      topSourceIps: stats.topSourceIps,
      recentTrend,
      riskLevel: classifyRiskLevel(stats),
    };
  } finally {
    client.release();
  }
}
