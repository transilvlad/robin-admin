/**
 * DMARC Intelligence Service
 * 
 * Analyzes DMARC aggregate reports to build:
 * - Sender inventory with classifications
 * - Domain health snapshots
 * - Issue detections
 * - Remediation suggestions
 * 
 * This service processes raw DMARC data and populates derived intelligence tables.
 */

import { pool } from '../db/connection.js';
import type {
  IssueSeverity,
  RiskFactor,
  IssueEvidence,
  SourceReportRef,
} from '../types/reporting.js';
import {
  upsertSender,
  upsertDomainHealth,
  createRemediation,
  getMutedSenderIps,
  getSenderReviewStates,
} from '../db/queries/reporting.js';
import {
  startAnalysisRun,
  finishAnalysisRun,
  failAnalysisRun,
  emptyCounters,
} from '../db/queries/analysis-runs.js';
import {
  DETECTION_THRESHOLDS,
  autoResolveClearedIssues,
  loadDetectionPolicy,
  raiseIssue,
  type DetectionContext,
} from './detection-policy.js';
import { computeComplianceMetrics } from './compliance-metrics.js';
import {
  getCoverageStaleDays,
  getDomainReportCoverage,
  getStaleReportingDomains,
} from '../db/queries/report-coverage.js';
import { query } from '../db/connection.js';
import { logger } from '../logger.js';
import { getConfig } from '../db/queries/config.js';
import { enrichSender, getDomainDnsRecords, getOrgDomain } from './sender-enrichment.js';

const SENDER_PROCESS_CONCURRENCY = 32;

interface DmarcSenderStats {
  sourceIp: string;
  domain: string;
  totalCount: number;
  passCount: number;
  failCount: number;
  spfPassCount: number;
  spfFailCount: number;
  dkimPassCount: number;
  dkimFailCount: number;
  firstSeen: Date;
  lastSeen: Date;
}

interface DbClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

interface ReportingPostureChecks {
  mtaSts: boolean;
  tlsrpt: boolean;
  bimi: boolean;
}

async function runWithConcurrency<T>(
  items: T[],
  concurrency: number,
  worker: (item: T) => Promise<void>
): Promise<void> {
  if (items.length === 0) {
    return;
  }

  let index = 0;
  const limit = Math.max(1, Math.min(concurrency, items.length));

  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (index < items.length) {
        const current = items[index++];
        if (!current) {
          return;
        }
        await worker(current);
      }
    })
  );
}

/**
 * Analyze DMARC data for a specific time period and domain
 * Updates sender inventory, domain health, and generates issues
 */
export interface DmarcAnalysisResult {
  processed: number;
  senders: number;
  /** Kept for callers that only want a single headline number. */
  issues: number;
  runId: number;
  issuesOpened: number;
  issuesRefreshed: number;
  issuesResolved: number;
  /**
   * Conditions observed but withheld because they have not yet held for
   * enough consecutive runs. Surfacing this separately is what makes the
   * persistence gate visible rather than looking like missing detection.
   */
  issuesPending: number;
}

export async function analyzeDmarcIntelligence(options: {
  domain?: string;
  startDate?: Date;
  endDate?: Date;
  daysBack?: number;
}): Promise<DmarcAnalysisResult> {
  await loadDetectionPolicy();
  const client = await pool.connect() as unknown as DbClient;

  // Default to last 30 days
  const endDate = options.endDate || new Date();
  const startDate = options.startDate ||
    new Date(endDate.getTime() - (options.daysBack || 30) * 24 * 60 * 60 * 1000);

  // runId is assigned inside the try so a failure from startAnalysisRun
  // itself still hits the finally below and releases `client` — it used to
  // run before the try, which leaked the connection on every such failure.
  let runId: number | undefined;
  try {
    runId = await startAnalysisRun('dmarc', startDate, endDate);
    const ctx: DetectionContext = {
      kind: 'dmarc',
      runId,
      windowStart: startDate,
      windowEnd: endDate,
      counters: emptyCounters(),
    };

    const config = await getConfig();
    const postureChecks: ReportingPostureChecks = {
      mtaSts: config.reportingMtaStsChecksEnabled,
      tlsrpt: config.reportingTlsrptChecksEnabled,
      bimi: config.reportingBimiChecksEnabled,
    };
    
    // Get aggregated sender statistics
    const senderStats = await aggregateSenderStats(client, options.domain, startDate, endDate);

    // Only enrich (DNS, FCrDNS, SPF) senders whose totalVolume actually changed
    // since the last analysis. Ingest of a single report only touches its own
    // sources; every other sender in the 30-day window is unchanged, so
    // re-enriching them would burn DNS budget for no signal.
    const existingByIp = new Map<string, { totalVolume: number }>();
    if (senderStats.length > 0) {
      const domains = [...new Set(senderStats.map((s) => s.domain))];
      const ips = [...new Set(senderStats.map((s) => s.sourceIp))];
      const existing = await client.query(
        `SELECT domain, source_ip, total_volume
         FROM sender_inventory WHERE domain = ANY($1::text[]) AND source_ip = ANY($2::text[])`,
        [domains, ips]
      );
      for (const row of existing.rows) {
        existingByIp.set(
          `${row.domain as string}\u0000${row.source_ip as string}`,
          { totalVolume: Number(row.total_volume ?? 0) }
        );
      }
    }
    const changed = senderStats.filter((s) => {
      const prev = existingByIp.get(`${s.domain}\u0000${s.sourceIp}`);
      return !prev || prev.totalVolume !== s.totalCount;
    });

    let sendersProcessed = 0;
    await runWithConcurrency(changed, SENDER_PROCESS_CONCURRENCY, async (sender) => {
      await processSender(sender);
      sendersProcessed++;
    });

    // Calculate domain health
    const domains = options.domain
      ? [options.domain]
      : [...new Set(senderStats.map(s => s.domain))];

    for (const domain of domains) {
      await calculateDomainHealth(client, domain, startDate, endDate, postureChecks);
    }

    // record_type is derived at read time by joining sender_inventory in the
    // DMARC report-detail query — no per-record UPDATE on every analysis run.
    // Removed here to end the write amplification that scaled with each domain's
    // dmarc_records row count.

    // Detect issues
    await detectIssues(ctx, client, domains, startDate, endDate, postureChecks);

    // Report coverage: silence from reporters is itself a finding, and
    // without it an empty issue list is indistinguishable from "we have
    // no data at all".
    await detectReportingGaps(ctx, domains, options.domain);

    // Correlate issues that describe the same underlying fault across
    // report types, so the operator sees one story per problem.
    await correlateDomainIssues(domains);

    ctx.counters.domainsProcessed = domains.length;
    await finishAnalysisRun(runId, ctx.counters);

    return {
      processed: senderStats.length,
      senders: sendersProcessed,
      issues: ctx.counters.issuesOpened,
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

/**
 * Aggregate sender statistics from the source-grained DMARC rollup.
 *
 * Derived from the taxonomy columns rather than a raw scan:
 *   pass_count      = compliant_volume            (dkim OR spf ALIGNED)
 *   spf_pass_count  = fully_aligned + spf_aligned (spf-aligned total)
 *   dkim_pass_count = fully_aligned + dkim_aligned
 *
 * This is the query the intelligence pipeline used to run on every ingest per
 * domain; now it's an indexed grouped read of a small table.
 */
async function aggregateSenderStats(
  client: DbClient,
  domain: string | undefined,
  startDate: Date,
  endDate: Date
): Promise<DmarcSenderStats[]> {
  const startDay = startDate.toISOString().slice(0, 10);
  const endDay = endDate.toISOString().slice(0, 10);
  const domainFilter = domain ? 'AND s.domain = $3' : '';
  const params = domain ? [startDay, endDay, domain.toLowerCase()] : [startDay, endDay];

  const result = await client.query(
    `SELECT
       s.source_ip,
       s.domain,
       SUM(s.total_volume)::bigint     AS total_count,
       SUM(s.compliant_volume)::bigint AS pass_count,
       (SUM(s.total_volume) - SUM(s.compliant_volume))::bigint AS fail_count,
       (SUM(s.fully_aligned_volume) + SUM(s.spf_aligned_volume))::bigint  AS spf_pass_count,
       (SUM(s.total_volume) - SUM(s.fully_aligned_volume) - SUM(s.spf_aligned_volume))::bigint  AS spf_fail_count,
       (SUM(s.fully_aligned_volume) + SUM(s.dkim_aligned_volume))::bigint AS dkim_pass_count,
       (SUM(s.total_volume) - SUM(s.fully_aligned_volume) - SUM(s.dkim_aligned_volume))::bigint AS dkim_fail_count,
       MIN(s.day)::text AS first_seen,
       MAX(s.day)::text AS last_seen
     FROM dmarc_rollup_source_daily s
     WHERE s.day >= $1 AND s.day <= $2 ${domainFilter}
     GROUP BY s.source_ip, s.domain`,
    params
  );

  return result.rows.map((row) => ({
    sourceIp: row.source_ip as string,
    domain: row.domain as string,
    totalCount: parseInt(row.total_count as string, 10) || 0,
    passCount: parseInt(row.pass_count as string, 10) || 0,
    failCount: parseInt(row.fail_count as string, 10) || 0,
    spfPassCount: parseInt(row.spf_pass_count as string, 10) || 0,
    spfFailCount: parseInt(row.spf_fail_count as string, 10) || 0,
    dkimPassCount: parseInt(row.dkim_pass_count as string, 10) || 0,
    dkimFailCount: parseInt(row.dkim_fail_count as string, 10) || 0,
    firstSeen: new Date(`${row.first_seen as string}T00:00:00Z`),
    lastSeen: new Date(`${row.last_seen as string}T00:00:00Z`),
  }));
}

/**
 * Process a sender and update sender inventory.
 *
 * Classification is now driven by `enrichSender()` (FCrDNS + live SPF
 * expansion + PSL alignment) rather than the old fail-rate-only
 * heuristic, which couldn't distinguish own infrastructure from
 * forwarders or spoofers. Raw counts still feed in (DKIM-pass-rate is
 * what separates compliant forwarders from suspicious ones).
 */
async function processSender(sender: DmarcSenderStats): Promise<void> {
  const enrichment = await enrichSender({
    sourceIp: sender.sourceIp,
    reportDomain: sender.domain,
    counts: {
      total: sender.totalCount,
      pass: sender.passCount,
      dkimPass: sender.dkimPassCount,
      spfPass: sender.spfPassCount,
    },
  });

  const failRate = sender.totalCount > 0
    ? sender.failCount / sender.totalCount
    : 0;
  const notes = [
    enrichment.reason,
    `volume=${sender.totalCount}`,
    `fail=${(failRate * 100).toFixed(0)}%`,
    enrichment.rdnsHost
      ? `fcrdns=${enrichment.rdnsHost}`
      : enrichment.ptrHost
        ? `ptr=${enrichment.ptrHost}`
        : 'ptr=none',
  ].join(' | ');

  await upsertSender(sender.domain, sender.sourceIp, {
    classification: enrichment.classification,
    confidence: enrichment.confidence,
    sourceHost: enrichment.ptrHost ?? enrichment.rdnsHost ?? undefined,
    provider: enrichment.provider ?? undefined,
    orgDomain: enrichment.orgDomain ?? undefined,
    totalVolume: sender.totalCount,
    passCount: sender.passCount,
    failCount: sender.failCount,
    spfAligned: sender.spfPassCount,
    dkimAligned: sender.dkimPassCount,
    firstSeen: sender.firstSeen,
    lastSeen: sender.lastSeen,
    notes,
  });
}

/**
 * Calculate domain health metrics
 */
async function calculateDomainHealth(
  client: DbClient,
  domain: string,
  startDate: Date,
  endDate: Date,
  postureChecks: ReportingPostureChecks
): Promise<void> {
  // Domain-scoped DMARC totals from the coarse rollup — a grouped read over a
  // few rows per day per reporter/policy, not a scan of raw records.
  const dmarcResult = await client.query(
    `SELECT
       SUM(d.total_volume)      AS total,
       SUM(d.compliant_volume)  AS pass,
       SUM(d.fully_aligned_volume) + SUM(d.spf_aligned_volume)  AS spf_pass,
       SUM(d.fully_aligned_volume) + SUM(d.dkim_aligned_volume) AS dkim_pass
     FROM dmarc_rollup_daily d
     WHERE d.domain = $1 AND d.day >= $2 AND d.day <= $3`,
    [domain.toLowerCase(), startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10)]
  );
  
  const total = parseInt(dmarcResult.rows[0]?.total as string, 10) || 0;
  const pass = parseInt(dmarcResult.rows[0]?.pass as string, 10) || 0;
  const spfPass = parseInt(dmarcResult.rows[0]?.spf_pass as string, 10) || 0;
  const dkimPass = parseInt(dmarcResult.rows[0]?.dkim_pass as string, 10) || 0;
  
  const dmarcPassRate = total > 0 ? pass / total : 0;
  const spfPassRate = total > 0 ? spfPass / total : 0;
  const dkimPassRate = total > 0 ? dkimPass / total : 0;

  const policyResult = await client.query(`
    SELECT policy, pct, subdomain_policy
    FROM dmarc_reports
    WHERE domain = $1
    ORDER BY date_end DESC
    LIMIT 1
  `, [domain]);
  const dmarcPolicy = policyResult.rows[0]?.policy as string | null | undefined;
  const dmarcPct = policyResult.rows[0]?.pct as number | null | undefined;
  const subdomainPolicy = (policyResult.rows[0]?.subdomain_policy as string | null | undefined) || null;

  // Volume from senders that are still unclassified AND still awaiting an
  // operator decision. This is the "how much triage is left" number; a
  // sender an operator has already approved is not outstanding work even
  // if the classifier can't name it.
  const unidentifiedResult = await client.query(`
    SELECT COALESCE(SUM(total_volume), 0) AS volume
    FROM sender_inventory
    WHERE domain = $1
      AND classification = 'unknown'
      AND review_state = 'pending'
  `, [domain]);
  const unidentifiedVolume = parseInt(unidentifiedResult.rows[0]?.volume as string, 10) || 0;

  const compliance = computeComplianceMetrics({
    totalVolume: total,
    alignedPassVolume: pass,
    unidentifiedVolume,
  });
  
  // Get TLS stats
  const tlsResult = await client.query(`
    SELECT 
      SUM(total_success) as success,
      SUM(total_failure) as failure
    FROM tlsrpt_reports
    WHERE date_begin >= $1 AND date_end <= $2
  `, [startDate.toISOString(), endDate.toISOString()]);
  
  const tlsSuccess = parseInt(tlsResult.rows[0]?.success as string, 10) || 0;
  const tlsFailure = parseInt(tlsResult.rows[0]?.failure as string, 10) || 0;
  const tlsTotal = tlsSuccess + tlsFailure;
  const tlsSuccessRate = tlsTotal > 0 ? tlsSuccess / tlsTotal : 1;

  const forensicResult = await client.query(`
    SELECT COUNT(*) as total
    FROM forensic_reports
    WHERE reported_domain = $1
      AND COALESCE(arrival_date, received_date, created_at) >= $2
      AND COALESCE(arrival_date, received_date, created_at) <= $3
  `, [domain, startDate.toISOString(), endDate.toISOString()]);
  const forensicCount = parseInt(forensicResult.rows[0]?.total as string, 10) || 0;
  
  // Get sender classification counts
  const senderResult = await client.query(`
    SELECT 
      classification,
      COUNT(*) as count
    FROM sender_inventory
    WHERE domain = $1
    GROUP BY classification
  `, [domain]);
  
  const classificationCounts: Record<string, number> = {};
  senderResult.rows.forEach(row => {
    classificationCounts[row.classification as string] = parseInt(row.count as string, 10);
  });
  
  // Calculate risk score and factors. Each factor carries a `basis`
  // payload so the UI can render the threshold + measured value alongside
  // the prose description (the "based on what?" complaint).
  const riskFactors: RiskFactor[] = [];
  let riskScore = 0;

  if (dmarcPassRate < DETECTION_THRESHOLDS.dmarcFailingPassRate) {
    const severity: IssueSeverity = dmarcPassRate < 0.8 ? 'high' : 'medium';
    const weight = severity === 'high' ? 30 : 15;
    riskFactors.push({
      type: 'low_dmarc_pass_rate',
      severity,
      description: `DMARC pass rate is ${(dmarcPassRate * 100).toFixed(1)}%`,
      weight,
      basis: {
        metric: 'dmarc_pass_rate',
        value: dmarcPassRate,
        threshold: DETECTION_THRESHOLDS.dmarcFailingPassRate,
        comparator: '<',
      },
    });
    riskScore += weight;
  }

  // SPF-only failures (with DKIM compensating) are NORMAL for any
  // domain that gets forwarded — Gmail/Outlook forwarders rewrite the
  // envelope sender, breaking SPF, but DKIM survives. Penalizing the
  // domain for that flagged 78 of 582 prod domains as "risky" when
  // DMARC is actually 100% pass. We only count SPF as a risk when
  // DKIM ALSO can't compensate (the dmarcPassRate < 0.95 branch above
  // already covers that case).

  if (dkimPassRate < 0.9) {
    const severity: IssueSeverity = dkimPassRate < 0.7 ? 'high' : 'medium';
    const weight = severity === 'high' ? 25 : 10;
    riskFactors.push({
      type: 'dkim_alignment_issues',
      severity,
      description: `DKIM alignment rate is ${(dkimPassRate * 100).toFixed(1)}%`,
      weight,
      basis: { metric: 'dkim_pass_rate', value: dkimPassRate, threshold: 0.9, comparator: '<' },
    });
    riskScore += weight;
  }

  const spoofingCount = classificationCounts['spoofing'] || 0;
  if (spoofingCount > 0) {
    const severity: IssueSeverity = spoofingCount > 5 ? 'critical' : 'high';
    const weight = severity === 'critical' ? 40 : 20;
    riskFactors.push({
      type: 'spoofing_detected',
      severity,
      description: `${spoofingCount} potential spoofing source(s) detected`,
      weight,
      basis: { metric: 'spoofing_sender_count', value: spoofingCount, threshold: 0, comparator: '>' },
    });
    riskScore += weight;
  }

  const unknownCount = classificationCounts['unknown'] || 0;
  if (unknownCount > 10) {
    riskFactors.push({
      type: 'many_unknown_senders',
      severity: 'medium',
      description: `${unknownCount} unknown sender(s) need classification`,
      weight: 10,
      basis: { metric: 'unknown_sender_count', value: unknownCount, threshold: 10, comparator: '>' },
    });
    riskScore += 10;
  }

  if (tlsSuccessRate < 0.95 && tlsTotal > 0) {
    const severity: IssueSeverity = tlsSuccessRate < 0.8 ? 'high' : 'medium';
    const weight = severity === 'high' ? 20 : 10;
    riskFactors.push({
      type: 'tls_failures',
      severity,
      description: `TLS success rate is ${(tlsSuccessRate * 100).toFixed(1)}%`,
      weight,
      basis: { metric: 'tls_success_rate', value: tlsSuccessRate, threshold: 0.95, comparator: '<' },
    });
    riskScore += weight;
  }

  riskScore = Math.min(100, riskScore);

  // Resolve live DNS state once per snapshot — re-used by detectIssues()
  // via the cached snapshot in sender-enrichment.ts. Failures degrade
  // gracefully (records stay null, UI shows "no record published").
  const dns = await getDomainDnsRecords(domain).catch(() => null);

  if (postureChecks.mtaSts && (!dns?.mtaStsDnsRecord || !dns?.mtaStsPolicyText)) {
    riskFactors.push({
      type: 'mta_sts_missing',
      severity: 'medium',
      description: 'Inbound TLS policy is not fully published (missing _mta-sts TXT or policy file)',
      weight: 10,
    });
    riskScore += 10;
  } else if (postureChecks.mtaSts && dns?.mtaStsPolicyMode === 'testing') {
    riskFactors.push({
      type: 'mta_sts_testing',
      severity: 'low',
      description: 'MTA-STS is still in testing mode',
      weight: 5,
    });
    riskScore += 5;
  }

  if (postureChecks.tlsrpt && !dns?.tlsRptRecord) {
    riskFactors.push({
      type: 'tlsrpt_missing',
      severity: 'low',
      description: 'No TLS-RPT reporting record is published',
      weight: 5,
    });
    riskScore += 5;
  }

  const previousHealthResult = await client.query(`
    SELECT dmarc_volume, dmarc_pass_rate
    FROM domain_health
    WHERE domain = $1 AND snapshot_date < CURRENT_DATE
    ORDER BY snapshot_date DESC
    LIMIT 1
  `, [domain]);
  const previousVolume = parseInt(previousHealthResult.rows[0]?.dmarc_volume as string, 10) || 0;
  const previousPassRate = parseFloat(previousHealthResult.rows[0]?.dmarc_pass_rate as string) || 0;
  const volumeChangePct = previousVolume > 0 ? (total - previousVolume) / previousVolume : 0;
  const passRateChange = previousHealthResult.rows[0] ? dmarcPassRate - previousPassRate : 0;

  await upsertDomainHealth(domain, new Date(), {
    orgDomain: getOrgDomain(domain),
    dmarcPolicy: dmarcPolicy ?? null,
    dmarcPct: dmarcPct ?? null,
    subdomainPolicy,
    dmarcPassRate,
    dmarcVolume: total,
    spfPassRate,
    dkimPassRate,
    alignmentRate: dmarcPassRate,
    complianceRate: compliance.complianceRate,
    unidentifiedVolume: compliance.unidentifiedVolume,
    tlsSuccessRate,
    tlsVolume: tlsTotal,
    mtaStsMode: dns?.mtaStsPolicyMode ?? null,
    forensicCount,
    riskScore: Math.min(100, riskScore),
    riskFactors,
    volumeChangePct,
    passRateChange,
    spfRecordCurrent: dns?.spfRecord ?? null,
    dmarcRecordCurrent: dns?.dmarcRecord ?? null,
    dkimRecordsCurrent: dns?.dkimRecords ?? {},
    mtaStsDnsRecordCurrent: dns?.mtaStsDnsRecord ?? null,
    mtaStsPolicyCurrent: dns?.mtaStsPolicyText ?? null,
    tlsRptRecordCurrent: dns?.tlsRptRecord ?? null,
    bimiRecordCurrent: dns?.bimiRecord ?? null,
    spfAuthorizedIps: dns?.spfAuthorized ?? {},
    spfPermerror: dns?.spfPermerror ?? false,
    dnsCheckedAt: dns?.checkedAt ?? null,
  });
}

/**
 * Detect issues from DMARC data.
 *
 * All findings go through `raiseIssue`, which applies the persistence
 * gate for statistical detectors and lets deterministic configuration
 * findings through immediately.
 */
async function detectIssues(
  ctx: DetectionContext,
  client: DbClient,
  domains: string[],
  startDate: Date,
  endDate: Date,
  postureChecks: ReportingPostureChecks
): Promise<void> {
  for (const domain of domains) {
    // Resolve once per domain — used to enrich SPF / unknown_sender /
    // spoofing / misconfigured evidence with the *actual* DNS state and
    // the *actual* unauthorized IPs (joined from sender_inventory). Both
    // calls are cached so this is cheap on repeat passes.
    const dnsSnapshot = await getDomainDnsRecords(domain).catch(() => null);
    const mutedIps = await getMutedSenderIps(domain).catch(() => new Set<string>());
    const reviewStates = await getSenderReviewStates(domain).catch(
      () => new Map<string, 'pending' | 'approved' | 'rejected'>()
    );
    const orgDomain = getOrgDomain(domain);

    // An approved sender is an operator decision that survives runs, so
    // it is filtered here rather than being papered over afterwards by
    // resolving the issue it generated.
    const isSuppressed = (ip: string) =>
      mutedIps.has(ip) || reviewStates.get(ip) === 'approved';

    // ─── Policy posture issues (cheap, derived from latest health) ──
    // Only fire when enforcement is weaker than recommended; both are
    // reachable signals operators can act on without third-party data.
    const policyResult = await client.query(
      `SELECT dmarc_policy, dmarc_pct, subdomain_policy
       FROM domain_health
       WHERE domain = $1
       ORDER BY snapshot_date DESC
       LIMIT 1`,
      [domain]
    );
    const policy = policyResult.rows[0]?.dmarc_policy as string | undefined;
    const pct = policyResult.rows[0]?.dmarc_pct as number | undefined;
    const subdomainPolicy = policyResult.rows[0]?.subdomain_policy as string | undefined;

    if (policy === 'none') {
      const { issue } = await raiseIssue(ctx, {
        domain,
        orgDomain,
        issueType: 'dmarc_none_policy',
        severity: 'medium',
        title: `DMARC policy is "none" for ${domain}`,
        description:
          'Your DMARC record is set to monitor-only. Receivers will not quarantine or reject ' +
          'unauthenticated mail, so spoofers can still deliver impersonations. Once SPF/DKIM ' +
          'pass rates are stable, ramp the policy to quarantine then reject.',
        evidence: { metrics: { dmarcPolicy: 'none' } },
        trigger: { metric: 'dmarc_policy', value: 0, threshold: 1, comparator: '<' },
      });
      if (issue) {
        await createRemediation({
          issueId: issue.id, domain,
          suggestionType: 'dmarc_policy_ramp', priority: 2,
          title: 'Tighten DMARC policy from "none" to "quarantine"',
          description: 'Move to quarantine once you are confident the auth pass rate is steady (>95%) for at least 2 weeks.',
          actionSteps: [
            { order: 1, action: 'Confirm pass rate is >95% on the Reporting Overview' },
            { order: 2, action: 'Update the DMARC TXT record to p=quarantine; pct=10' },
            { order: 3, action: 'Monitor for two weeks, then ramp pct to 50, 100' },
            { order: 4, action: 'When stable at 100%, switch to p=reject' },
          ],
          dnsChanges: [{
            recordType: 'TXT', name: `_dmarc.${domain}`,
            suggestedValue: 'v=DMARC1; p=quarantine; pct=10; rua=mailto:dmarc@example',
            reason: 'Begin enforcing quarantine on a small sample',
          }],
          verificationSteps: [{ order: 1, description: 'Confirm RUA reports show quarantine actions', expectedOutcome: 'policy_evaluated.disposition=quarantine for unauthenticated mail', waitDays: 3 }],
          estimatedImpact: 'Blocks the easiest impersonation vector at receivers that honor DMARC.',
        });
      }
    }

    if (typeof pct === 'number' && pct > 0 && pct < 100 && policy && policy !== 'none') {
      const { issue } = await raiseIssue(ctx, {
        domain,
        orgDomain,
        issueType: 'dmarc_low_pct',
        severity: 'low',
        title: `DMARC pct=${pct} for ${domain}`,
        description: `Your DMARC policy is enforced on only ${pct}% of mail. The remainder bypasses the policy.`,
        evidence: { metrics: { dmarcPct: pct } },
        trigger: { metric: 'dmarc_pct', value: pct, threshold: 100, comparator: '<' },
      });
      if (issue) {
        await createRemediation({
          issueId: issue.id, domain,
          suggestionType: 'dmarc_pct_ramp', priority: 3,
          title: `Ramp DMARC pct to 100`,
          description: 'Increase enforcement coverage gradually after each successful ramp.',
          actionSteps: [{ order: 1, action: 'Update _dmarc TXT — set pct=50, then pct=100 after a week' }],
          dnsChanges: [],
          verificationSteps: [],
          estimatedImpact: 'Closes the partial-enforcement gap.',
        });
      }
    }

    // ─── Subdomain policy gap ────────────────────────────────────────
    // Aggregate reports arrive per header-from domain, so a domain can
    // be at p=reject while every subdomain under it is wide open via
    // sp=none. Attackers use exactly this gap, and the raw report view
    // never surfaced it because sp= was parsed but never read.
    if (
      policy &&
      (policy === 'quarantine' || policy === 'reject') &&
      subdomainPolicy === 'none'
    ) {
      const { issue } = await raiseIssue(ctx, {
        domain,
        orgDomain,
        issueType: 'dmarc_subdomain_policy_gap',
        severity: 'high',
        title: `Subdomains of ${domain} are unprotected (sp=none)`,
        description:
          `${domain} enforces p=${policy}, but its DMARC record sets sp=none, so every subdomain ` +
          'is monitor-only. Impersonators routinely target subdomains precisely because this gap ' +
          'is common. Unless a subdomain genuinely needs a weaker policy, remove sp= so subdomains ' +
          'inherit the parent policy.',
        evidence: {
          metrics: { dmarcPolicy: policy, subdomainPolicy: 'none' },
          dmarcRecord: dnsSnapshot?.dmarcRecord ?? null,
        },
        trigger: { metric: 'subdomain_policy', value: 0, threshold: 1, comparator: '<' },
      });
      if (issue) {
        await createRemediation({
          issueId: issue.id, domain,
          suggestionType: 'dmarc_subdomain_policy', priority: 2,
          title: 'Remove sp=none so subdomains inherit the parent policy',
          description:
            'With sp=none, a receiver applies no policy to mail from any subdomain regardless of ' +
            'the parent policy. Removing the tag makes subdomains inherit p=.',
          actionSteps: [
            { order: 1, action: 'Confirm no subdomain relies on monitor-only treatment' },
            { order: 2, action: `Edit _dmarc.${domain} and remove the sp=none tag (or set sp=${policy})` },
            { order: 3, action: 'Watch subdomain volume in aggregate reports for a cycle' },
          ],
          dnsChanges: [{
            recordType: 'TXT', name: `_dmarc.${domain}`,
            suggestedValue: `v=DMARC1; p=${policy}; sp=${policy}; rua=mailto:dmarc@example`,
            reason: 'Apply the parent policy to subdomains',
          }],
          verificationSteps: [
            { order: 1, description: 'Resolve the _dmarc TXT record', expectedOutcome: 'sp= matches p= or is absent' },
          ],
          estimatedImpact: 'Closes the most commonly exploited DMARC bypass.',
        });
      }
    }

    if (
      postureChecks.bimi &&
      policy &&
      (policy === 'quarantine' || policy === 'reject') &&
      pct === 100 &&
      !dnsSnapshot?.bimiRecord
    ) {
      const { issue } = await raiseIssue(ctx, {
        domain,
        orgDomain,
        issueType: 'bimi_missing',
        severity: 'low',
        title: `BIMI record is not published for ${domain}`,
        description:
          'DMARC is already enforcing at 100%, but no BIMI TXT record was found at default._bimi. Enable it only if the domain actually needs branded mailbox indicators.',
        evidence: {
          metrics: { dmarcPct: pct, hasBimiRecord: 0 },
          current: { hasBimiRecord: 0 },
        },
      });
      if (issue) {
        await createRemediation({
          issueId: issue.id,
          domain,
          suggestionType: 'bimi_setup',
          priority: 5,
          title: 'Publish a BIMI TXT record if this domain needs brand indicators',
          description: 'BIMI is optional. If mailbox brand indicators matter for this domain, publish a BIMI TXT record and the required logo / VMC assets.',
          actionSteps: [
            { order: 1, action: 'Decide whether this domain should display a brand logo in supporting inboxes' },
            { order: 2, action: 'Publish a BIMI TXT record at default._bimi.<domain>' },
            { order: 3, action: 'Host the SVG logo (and VMC if required by target providers)' },
          ],
          dnsChanges: [],
          verificationSteps: [
            { order: 1, description: 'Resolve the default._bimi TXT record', expectedOutcome: 'A BIMI TXT record is visible in DNS' },
          ],
          estimatedImpact: 'Improves brand presentation in supporting mailbox providers; no impact where BIMI is not a goal.',
        });
      }
    }

    // ─── Unknown high-volume senders (shadow IT / impersonators) ────
    // Filter out senders the operator has explicitly muted — that's the
    // "I know about this, stop nagging" signal. The mute is per-(domain,
    // source_ip), so we keep nagging about the same IP if it shows up
    // for a different domain.
    const unknownResult = await client.query(
      `SELECT id, source_ip, total_volume, source_host, classification, fail_count, pass_count,
              provider, review_state
       FROM sender_inventory
       WHERE domain = $1 AND classification = 'unknown' AND total_volume > $2
         AND review_state <> 'approved'
         AND (muted_at IS NULL OR (muted_until IS NOT NULL AND muted_until <= NOW()))`,
      [domain, DETECTION_THRESHOLDS.unknownSenderMinVolume]
    );
    const unknownRows = unknownResult.rows.filter(
      (r) => !isSuppressed(r.source_ip as string)
    );
    if (unknownRows.length > 0) {
      const senderIds = unknownRows.map((r) => r.id as number);
      const ips = unknownRows.map((r) => r.source_ip as string);
      const totalVol = unknownRows.reduce(
        (sum, r) => sum + (parseInt(r.total_volume as string, 10) || 0),
        0
      );
      const evidence = buildSenderEvidence(unknownRows, dnsSnapshot, {
        senderCount: ips.length,
        totalVolume: totalVol,
      });
      evidence.sourceReports = await collectDmarcSourceReports(
        client, domain, ips, startDate, endDate
      );
      evidence.reportIds = evidence.sourceReports.map((ref) => ref.id);

      // Name the providers we could identify — "3 unknown senders" is a
      // shrug, "3 unknown senders (SendGrid, Mailgun)" is a task list.
      const providers = [
        ...new Set(unknownRows.map((r) => r.provider as string | null).filter(Boolean)),
      ] as string[];
      const providerNote = providers.length
        ? ` Identified providers: ${providers.join(', ')}.`
        : '';

      const { issue } = await raiseIssue(ctx, {
        domain,
        orgDomain,
        issueType: 'unknown_sender',
        severity: 'medium',
        title: `${ips.length} unknown high-volume sender(s) for ${domain}`,
        description:
          'These IPs are sending meaningful volume claiming to be your domain but match neither your SPF, your DKIM, nor any forwarder pattern. Identify each one — it is either an unauthorized vendor (add to SPF) or an impersonator (escalate).' +
          providerNote,
        evidence,
        senderIds,
        trigger: {
          metric: 'unknown_sender_volume',
          value: totalVol,
          threshold: DETECTION_THRESHOLDS.unknownSenderMinVolume,
          comparator: '>',
        },
      });
      if (issue) {
        await createRemediation({
          issueId: issue.id, domain,
          suggestionType: 'sender_review', priority: 2,
          title: 'Investigate unknown high-volume senders',
          description: 'For each IP, find the underlying service and decide: authorize via SPF, set up DKIM, or block.',
          actionSteps: [
            { order: 1, action: 'List the source IPs from the issue evidence' },
            { order: 2, action: 'Check rDNS, provider badge, and recipient domain for clues to the sender' },
            { order: 3, action: 'Approve legitimate vendors from the sender table; report or block illegitimate ones' },
          ],
          dnsChanges: [],
          verificationSteps: [{ order: 1, description: 'Re-run analysis after the SPF update propagates', expectedOutcome: 'Senders re-classify as authorized or volume drops to zero', waitDays: 2 }],
          estimatedImpact: 'Eliminates the largest remaining "Unknown" risk surface for the domain.',
        });
      }
    }

    // Check for spoofing senders. Approved/muted senders are excluded —
    // an operator-confirmed spoofer they're tracking separately (e.g.
    // while pursuing legal action) shouldn't keep re-firing.
    const spoofingResult = await client.query(`
      SELECT id, source_ip, source_host, total_volume, fail_count, pass_count, confidence,
             classification, provider, review_state
      FROM sender_inventory
      WHERE domain = $1 AND classification = 'spoofing' AND fail_count > $2
        AND review_state <> 'approved'
        AND (muted_at IS NULL OR (muted_until IS NOT NULL AND muted_until <= NOW()))
    `, [domain, DETECTION_THRESHOLDS.spoofingMinFailCount]);

    for (const row of spoofingResult.rows) {
      const sourceIp = row.source_ip as string;
      if (isSuppressed(sourceIp)) continue;
      const failVolume = parseInt(row.fail_count as string, 10) || 0;
      const totalVolume = parseInt(row.total_volume as string, 10) || 0;
      const confidenceScore = parseFloat(row.confidence as string) || 0;

      const evidence = buildSenderEvidence([row], dnsSnapshot, {
        failVolume,
        totalVolume,
        confidenceScore,
      });
      evidence.sourceReports = await collectDmarcSourceReports(
        client, domain, [sourceIp], startDate, endDate
      );
      evidence.reportIds = evidence.sourceReports.map((ref) => ref.id);

      const provider = row.provider as string | null;
      const { issue } = await raiseIssue(ctx, {
        domain,
        orgDomain,
        issueType: 'spoofing_detected',
        severity: 'critical',
        title: `Potential spoofing from ${sourceIp}${provider ? ` (${provider})` : ''}`,
        description: `IP address ${sourceIp} is sending mail claiming to be from ${domain} but failing authentication. ${failVolume} failed messages detected.`,
        evidence,
        senderIds: [row.id as number],
        trigger: {
          metric: 'fail_count',
          value: failVolume,
          threshold: DETECTION_THRESHOLDS.spoofingMinFailCount,
          comparator: '>',
        },
      });
      if (!issue) continue;

      // Create remediation for spoofing
      await createRemediation({
        issueId: issue.id,
        domain,
        suggestionType: 'spoofing_mitigation',
        priority: 1,
        title: 'Block or monitor spoofing source',
        description: `The IP ${sourceIp} is likely attempting to impersonate ${domain}. Consider blocking this IP or escalating to your security team.`,
        actionSteps: [
          { order: 1, action: 'Verify this IP is not a legitimate sender you forgot to authorize' },
          { order: 2, action: 'Check if this IP belongs to a compromised server or service' },
          { order: 3, action: 'Consider moving DMARC policy to quarantine or reject if not already' },
          { order: 4, action: 'Report persistent spoofing to your email provider' },
        ],
        dnsChanges: [],
        verificationSteps: [
          { order: 1, description: 'Monitor next DMARC report period', expectedOutcome: 'Volume from this IP should decrease or stop' },
        ],
        estimatedImpact: 'Reduces spoofing risk and improves domain reputation',
      });
    }
    
    // ─── DMARC alignment failure detector ────────────────────────────
    //
    // Only fires on *actionable* failures: records where BOTH SPF and
    // DKIM are non-pass AND the receiver did not itself explain the
    // failure as forwarding or a mailing list. On a large sending fleet
    // ~95% of "failures" carry reason_type='forwarded', and counting
    // those raised one alarm per domain for a condition nobody can fix —
    // which is what taught operators to ignore this area entirely.
    //
    // The issueType is `spf_alignment_failure`; the title and trigger
    // reflect the actual, actionable DMARC impact.
    // Same shape as before, now sourced from the coarse rollup so the query is
    // a small grouped read instead of a per-domain scan. `actionable_failures`
    // is the taxonomy's canonical "unaligned and not explained by forwarding"
    // metric — folded together with what the old code called `rejected`, since
    // disposition sits below the taxonomy and receivers overwhelmingly enforce
    // exactly the messages this metric already counts.
    const dmarcAxesResult = await client.query(
      `SELECT
         SUM(d.total_volume)              AS total,
         SUM(d.compliant_volume)          AS dmarc_pass,
         SUM(d.actionable_failure_volume) AS actionable_failures,
         SUM(d.fully_aligned_volume) + SUM(d.dkim_aligned_volume) AS dkim_pass,
         SUM(d.fully_aligned_volume) + SUM(d.spf_aligned_volume)  AS spf_pass
       FROM dmarc_rollup_daily d
       WHERE d.domain = $1 AND d.day >= $2 AND d.day <= $3`,
      [domain.toLowerCase(), startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10)]
    );

    const axesTotal = parseInt(dmarcAxesResult.rows[0]?.total as string, 10) || 0;
    const axesDmarcPass = parseInt(dmarcAxesResult.rows[0]?.dmarc_pass as string, 10) || 0;
    const axesActionable = parseInt(dmarcAxesResult.rows[0]?.actionable_failures as string, 10) || 0;
    const axesDkimPass = parseInt(dmarcAxesResult.rows[0]?.dkim_pass as string, 10) || 0;
    const dmarcPassRate = axesTotal > 0 ? axesDmarcPass / axesTotal : 1;
    const bothFailRate = axesTotal > 0 ? axesActionable / axesTotal : 0;
    const dkimPassRateForDomain = axesTotal > 0 ? axesDkimPass / axesTotal : 1;

    const ACTIONABLE_FAILURE_MIN = 10;
    const dmarcFailing = axesActionable >= ACTIONABLE_FAILURE_MIN;

    if (dmarcFailing) {
      // Severity mapped from the single actionable-failure count.
      const severity: IssueSeverity =
        axesActionable >= 500 ? 'high' : axesActionable >= 50 ? 'medium' : 'low';

      // Contributing senders straight from the source rollup — one indexed
      // grouped read of a small table. `actionable` per source = unaligned
      // volume not explained as forwarding. sender_inventory is joined for the
      // enrichment fields (classification, provider, review state, muting).
      const failingResult = await client.query(
        `SELECT
           si.id,
           s.source_ip,
           si.source_host,
           si.total_volume,
           si.fail_count,
           si.pass_count,
           si.classification,
           si.provider,
           si.review_state,
           SUM(s.total_volume)::bigint             AS volume_in_window,
           SUM(s.actionable_failure_volume)::bigint AS actionable
         FROM dmarc_rollup_source_daily s
         LEFT JOIN sender_inventory si ON si.domain = s.domain AND si.source_ip = s.source_ip
         WHERE s.domain = $1
           AND s.day >= $2 AND s.day <= $3
           AND (si.muted_at IS NULL OR (si.muted_until IS NOT NULL AND si.muted_until <= NOW()))
         GROUP BY si.id, s.source_ip, si.source_host, si.total_volume,
                  si.fail_count, si.pass_count, si.classification, si.provider, si.review_state
         HAVING SUM(s.actionable_failure_volume) >= 1
         ORDER BY actionable DESC
         LIMIT 50`,
        [domain.toLowerCase(), startDate.toISOString().slice(0, 10), endDate.toISOString().slice(0, 10)]
      );

      const failingRows = failingResult.rows.filter(
        (r) => !isSuppressed(r.source_ip as string)
      );
      const senderIds = failingRows.map((r) => r.id as number).filter((id) => id != null);
      const evidence = buildSenderEvidence(failingRows, dnsSnapshot, {
        dmarcPassRate,
        bothFailRate,
        totalVolume: axesTotal,
        failedVolume: axesActionable,
        rejectedVolume: axesActionable,
      });
      evidence.sourceReports = await collectDmarcSourceReports(
        client,
        domain,
        failingRows.map((r) => r.source_ip as string),
        startDate,
        endDate
      );
      evidence.reportIds = evidence.sourceReports.map((ref) => ref.id);

      // Build a description that names the specific senders and what
      // each one did. Generic "X messages failed" was the user's
      // complaint — the description has to point at the actual offender.
      // We list the top contributors by rejected count, falling back to
      // both-failed count if no rejections.
      const sortedRows = [...failingRows].sort((a, b) => {
        const actA = parseInt((a.actionable as string) ?? '0', 10);
        const actB = parseInt((b.actionable as string) ?? '0', 10);
        return actB - actA;
      });
      const top = sortedRows.slice(0, 5);
      const remainder = sortedRows.length - top.length;

      const lines: string[] = [];
      if (axesActionable > 0) {
        lines.push(
          `${axesActionable.toLocaleString()} of ${axesTotal.toLocaleString()} message(s) failed DMARC alignment with no forwarding explanation.`
        );
      }
      if (top.length > 0) {
        lines.push('Contributing senders:');
        for (const row of top) {
          const ip = row.source_ip as string;
          const cls = (row.classification as string) ?? 'unknown';
          const host = (row.source_host as string) ?? null;
          const act = parseInt((row.actionable as string) ?? '0', 10);
          const vol = parseInt((row.volume_in_window as string) ?? '0', 10);
          const detail: string[] = [];
          if (act > 0) detail.push(`${act} actionable failures`);
          if (vol > 0) detail.push(`${vol} total`);
          lines.push(`  • ${ip}${host ? ` (${host})` : ''} [${cls}] — ${detail.join(', ')}`);
        }
        if (remainder > 0) {
          lines.push(`  … and ${remainder} more sender(s) — see the table below.`);
        }
      }

      const { issue } = await raiseIssue(ctx, {
        domain,
        orgDomain,
        issueType: 'spf_alignment_failure',
        severity,
        title: `Unexplained DMARC failures on ${domain}`,
        description: lines.join('\n'),
        evidence,
        senderIds,
        trigger: {
          // Must describe the condition that actually fired, not a
          // nominal rate: this detector counts actionable failing
          // messages, so quoting a 95% pass-rate gate here would render
          // a self-contradicting "99.9% is below 95%" in the UI.
          metric: 'dmarc_failing_messages',
          value: axesActionable,
          threshold: ACTIONABLE_FAILURE_MIN,
          comparator: '>=',
        },
      });

      if (issue) {
        await createRemediation({
          issueId: issue.id,
          domain,
          suggestionType: 'dmarc_alignment_fix',
          priority: 2,
          title: 'Fix DMARC alignment for failing senders',
          description:
            'Each listed sender is failing both SPF and DKIM alignment, so DMARC marks their mail as failed at the receiver. ' +
            'Per-sender fix depends on classification: own infra → add to SPF + sign with DKIM; vendor → set up DKIM via the ESP; ' +
            'unknown → investigate before authorizing; spoofing → block at SMTP layer.',
          actionSteps: [
            { order: 1, action: 'Review the listed senders and their classifications in this modal' },
            { order: 2, action: 'For each legitimate sender, fix SPF or DKIM at the source (ESP / app / your own MTA)' },
            { order: 3, action: 'For unknowns, identify the underlying service before adding to SPF' },
            { order: 4, action: 'Re-run analysis after 48h to confirm the issue closes' },
          ],
          dnsChanges: [],
          verificationSteps: [
            { order: 1, description: 'Wait for next aggregate report cycle', expectedOutcome: 'DMARC pass rate (either-axis) climbs above 95%', waitDays: 2 },
          ],
          estimatedImpact: 'Closes the actual deliverability gap. Forwarder SPF noise is no longer flagged.',
        });
      }
    }

    // ─── Auto-resolve cleared alignment issues ───────────────────────
    //
    // Only closes once the condition has been absent for GRACE_RUNS
    // consecutive runs. Closing on the first clean run made issues flap
    // resolved → reopened → resolved as reports trickled in, which is
    // what taught operators to ignore issue status altogether.
    if (!dmarcFailing) {
      await autoResolveClearedIssues(
        ctx,
        domain,
        ['spf_alignment_failure', 'dkim_alignment_failure'],
        'Auto-resolved: SPF/DKIM gaps no longer cause DMARC failures (forwarder-only failures are not actionable).'
      );
    }

    // Check for misconfigured high-volume senders
    const misconfiguredResult = await client.query(`
      SELECT id, source_ip, source_host, total_volume, fail_count, pass_count, classification,
             provider, review_state
      FROM sender_inventory
      WHERE domain = $1 AND classification = 'misconfigured' AND total_volume > $2
        AND review_state <> 'approved'
        AND (muted_at IS NULL OR (muted_until IS NOT NULL AND muted_until <= NOW()))
    `, [domain, DETECTION_THRESHOLDS.misconfiguredMinVolume]);

    const misRows = misconfiguredResult.rows.filter(
      (r) => !isSuppressed(r.source_ip as string)
    );
    if (misRows.length > 0) {
      const totalMisconfigured = misRows.length;
      const totalVolume = misRows.reduce(
        (sum, row) => sum + parseInt(row.total_volume as string, 10), 0
      );
      const senderIds = misRows.map((r) => r.id as number);
      const evidence = buildSenderEvidence(misRows, dnsSnapshot, {
        senderCount: totalMisconfigured,
        totalVolume,
      });
      evidence.sourceReports = await collectDmarcSourceReports(
        client,
        domain,
        misRows.map((r) => r.source_ip as string),
        startDate,
        endDate
      );
      evidence.reportIds = evidence.sourceReports.map((ref) => ref.id);

      const { issue } = await raiseIssue(ctx, {
        domain,
        orgDomain,
        issueType: 'misconfigured_sender',
        severity: 'medium',
        title: `${totalMisconfigured} misconfigured high-volume sender(s) for ${domain}`,
        description: `${totalMisconfigured} sender(s) are sending high volumes but failing authentication checks. Total volume: ${totalVolume}`,
        evidence,
        senderIds,
        trigger: {
          metric: 'misconfigured_volume',
          value: totalVolume,
          threshold: DETECTION_THRESHOLDS.misconfiguredMinVolume,
          comparator: '>',
        },
      });
      // Pair with a remediation so the issue detail modal isn't empty.
      if (issue) {
        await createRemediation({
          issueId: issue.id,
          domain,
          suggestionType: 'sender_review',
          priority: 2,
          title: 'Review high-volume misconfigured senders',
          description:
            `Several senders for ${domain} push significant volume but consistently fail SPF/DKIM. ` +
            'Verify each is a legitimate vendor or internal service, then either authorize them in SPF / ' +
            'set up DKIM signing on your behalf, or block them at the SMTP layer if they are unauthorized.',
          actionSteps: [
            { order: 1, action: 'List the misconfigured sender IPs from the issue evidence' },
            { order: 2, action: 'For each IP, identify the underlying ESP / app / forwarder' },
            { order: 3, action: 'Add legitimate senders to SPF (or set up DKIM signing); block unauthorized ones' },
          ],
          dnsChanges: [],
          verificationSteps: [
            { order: 1, description: 'Re-run analysis after 48h of new DMARC reports', expectedOutcome: 'Pass rate for these IPs > 95%', waitDays: 2 },
          ],
          estimatedImpact: 'Restoring authentication for high-volume legitimate senders typically lifts deliverability for the whole domain.',
        });
      }
    }

    // Sender-class issues clear when the class no longer applies.
    if (unknownRows.length === 0) {
      await autoResolveClearedIssues(
        ctx, domain, ['unknown_sender'],
        'Auto-resolved: no unclassified senders above the volume threshold remain.'
      );
    }
    if (misRows.length === 0) {
      await autoResolveClearedIssues(
        ctx, domain, ['misconfigured_sender'],
        'Auto-resolved: no misconfigured senders above the volume threshold remain.'
      );
    }
  }
}

/**
 * Collect references back to the aggregate reports that produced the
 * evidence for a set of source IPs.
 *
 * This is the "how do I verify this claim?" path. Without it an issue is
 * an assertion an operator has to take on faith, which is precisely why
 * the derived layer was being bypassed in favour of the raw browser.
 */
async function collectDmarcSourceReports(
  client: DbClient,
  domain: string,
  sourceIps: string[],
  startDate: Date,
  endDate: Date,
  limit = 20
): Promise<SourceReportRef[]> {
  if (sourceIps.length === 0) return [];

  try {
    const result = await client.query(
      `SELECT dr.id, dr.report_id, dr.org_name, dr.date_begin, dr.date_end,
              rec.source_ip, SUM(rec.count) AS record_count
       FROM dmarc_records rec
       JOIN dmarc_reports dr ON rec.report_id = dr.id
       WHERE dr.domain = $1
         AND rec.source_ip = ANY($2::text[])
         AND dr.date_begin >= $3 AND dr.date_end <= $4
       GROUP BY dr.id, dr.report_id, dr.org_name, dr.date_begin, dr.date_end, rec.source_ip
       ORDER BY dr.date_end DESC, record_count DESC
       LIMIT $5`,
      [domain, [...new Set(sourceIps)], startDate.toISOString(), endDate.toISOString(), limit]
    );

    return result.rows.map((row) => ({
      kind: 'dmarc' as const,
      id: row.id as number,
      reportId: (row.report_id as string | null) ?? null,
      orgName: (row.org_name as string | null) ?? null,
      dateBegin: row.date_begin ? new Date(row.date_begin as string).toISOString() : null,
      dateEnd: row.date_end ? new Date(row.date_end as string).toISOString() : null,
      sourceIp: (row.source_ip as string | null) ?? null,
      count: parseInt(row.record_count as string, 10) || 0,
    }));
  } catch {
    // Evidence enrichment must never break detection.
    return [];
  }
}

/**
 * Raise `reports_missing` for domains that used to receive aggregate
 * reports and have gone quiet.
 */
async function detectReportingGaps(
  ctx: DetectionContext,
  domains: string[],
  scopedDomain?: string
): Promise<void> {
  const staleThresholdDays = await getCoverageStaleDays();
  // `domains` is derived from in-window report data, so a domain that has
  // been completely silent for longer than the analysis window is absent
  // from it. Union in every
  // domain we have ever received reports for and that has gone quiet.
  let candidates = domains;
  if (!scopedDomain) {
    try {
      const stale = await getStaleReportingDomains(staleThresholdDays);
      candidates = [...new Set([...domains, ...stale.map((entry) => entry.domain)])];
    } catch {
      // Fall back to the in-window domains rather than skipping detection.
    }
  }

  for (const domain of candidates) {
    try {
      const coverage = await getDomainReportCoverage(domain, ctx.windowStart, ctx.windowEnd);
      if (!coverage.expectedDailyReports) continue;

      if (coverage.gapDays > staleThresholdDays) {
        const orgDomain = getOrgDomain(domain);
        const { issue } = await raiseIssue(ctx, {
          domain,
          orgDomain,
          issueType: 'reports_missing',
          severity: coverage.gapDays > 14 ? 'high' : 'medium',
          title: `No DMARC aggregate reports for ${domain} in ${coverage.gapDays} day(s)`,
          description:
            `${domain} has received aggregate reports before, but nothing has arrived for ${coverage.gapDays} day(s). ` +
            'Until reports resume, every other finding on this domain is based on stale data — treat a clean issue list as unverified, not as good news.',
          evidence: {
            metrics: {
              gapDays: coverage.gapDays,
              lifetimeReportCount: coverage.lifetimeReportCount,
              lastReportAt: coverage.lastReportAt?.toISOString() ?? 'never',
              reporterCount: coverage.entries.filter((e) => e.kind === 'dmarc').length,
              reporters: coverage.entries
                .filter((entry) => entry.kind === 'dmarc')
                .map((entry) => entry.reporter)
                .join(', '),
            },
          },
          trigger: {
            metric: 'days_since_last_report',
            value: coverage.gapDays,
            threshold: staleThresholdDays,
            comparator: '>',
          },
        });

        if (issue) {
          await createRemediation({
            issueId: issue.id,
            domain,
            suggestionType: 'reporting_recovery',
            priority: 1,
            title: 'Restore DMARC aggregate reporting',
            description:
              'Reports stopped arriving. Usually this is a broken rua= mailbox, a DNS record change, or an ingestion failure on our side.',
            actionSteps: [
              { order: 1, action: `Resolve the DMARC TXT record for _dmarc.${domain} and confirm the rua= address` },
              { order: 2, action: 'Confirm the reporting mailbox still accepts mail and is being polled' },
              { order: 3, action: 'Check the report ingestion logs for parse or authentication failures' },
            ],
            dnsChanges: [],
            verificationSteps: [
              { order: 1, description: 'Wait 24–48h', expectedOutcome: 'New aggregate reports appear in the raw DMARC view', waitDays: 2 },
            ],
            estimatedImpact: 'Restores the data every other finding on this domain depends on.',
          });
        }
      } else {
        await autoResolveClearedIssues(
          ctx, domain, ['reports_missing'],
          'Auto-resolved: aggregate reports are arriving again.'
        );
      }
    } catch {
      // Coverage is advisory; never fail a run over it.
    }
  }
}

/**
 * Link issues that describe the same underlying fault.
 *
 * A single misconfigured relay commonly produces a DMARC alignment
 * issue, a TLS failure issue, and a forensic cluster. Presented as three
 * unrelated rows they read as three problems; linked, they read as one.
 * Correlation is by shared sender IP within a domain.
 */
async function correlateDomainIssues(domains: string[]): Promise<void> {
  for (const domain of domains) {
    try {
      const open = (await query<Record<string, unknown>>(
        `SELECT id, evidence
         FROM reporting_issues
         WHERE domain = $1 AND status IN ('open', 'acknowledged', 'in_progress', 'suppressed')`,
        [domain]
      )).rows;

      if (open.length < 2) continue;

      const ipsById = new Map<number, Set<string>>();
      for (const row of open) {
        const evidence = (row.evidence ?? {}) as IssueEvidence;
        const ips = new Set<string>([
          ...(evidence.senderIps ?? []),
          ...(evidence.unauthorizedIps ?? []).map((entry) => entry.ip),
        ]);
        if (ips.size > 0) ipsById.set(row.id as number, ips);
      }

      for (const [id, ips] of ipsById) {
        const related: number[] = [];
        for (const [otherId, otherIps] of ipsById) {
          if (otherId === id) continue;
          if ([...ips].some((ip) => otherIps.has(ip))) related.push(otherId);
        }
        await query(
          `UPDATE reporting_issues SET related_issue_ids = $2::int[] WHERE id = $1`,
          [id, related]
        );
      }
    } catch (error) {
      // Correlation is presentational; never fail a run over it. Log it
      // though — a silent catch here hid a column type mismatch.
      logger.warn(`Issue correlation failed for ${domain}`, { error });
    }
  }
}

/**
 * Build the rich evidence payload for SPF/DKIM/sender-class issues.
 *
 * Combines the live DNS snapshot (current SPF/DKIM/DMARC text + the
 * flattened authorized IP set) with the per-IP context joined from
 * sender_inventory. The frontend issue-detail modal renders both
 * sections from this payload, so it never has to make follow-up
 * round-trips and the data is frozen-in-time consistent.
 */
function buildSenderEvidence(
  rows: Array<Record<string, unknown>>,
  dnsSnapshot: Awaited<ReturnType<typeof getDomainDnsRecords>> | null,
  metrics: Record<string, number | string>
): IssueEvidence {
  const ips = rows.map((r) => r.source_ip as string);
  const unauthorizedIps = rows.map((r) => {
    const total = parseInt(r.total_volume as string, 10) || 0;
    const fail = parseInt(r.fail_count as string, 10) || 0;
    const pass = parseInt((r.pass_count as string) ?? '0', 10) || 0;
    const denom = pass + fail || total;
    return {
      ip: r.source_ip as string,
      sourceHost: (r.source_host as string | null) ?? null,
      classification: (r.classification as string) ?? 'unknown',
      totalVolume: total,
      failCount: fail,
      passRate: denom > 0 ? pass / denom : 0,
    };
  });
  const evidence: IssueEvidence = {
    senderIps: ips,
    metrics,
    unauthorizedIps,
  };
  if (dnsSnapshot) {
    evidence.spfRecord = dnsSnapshot.spfRecord;
    evidence.spfAuthorized = dnsSnapshot.spfAuthorized;
    evidence.spfPermerror = dnsSnapshot.spfPermerror;
    evidence.dmarcRecord = dnsSnapshot.dmarcRecord;
    evidence.dkimRecords = dnsSnapshot.dkimRecords;
    evidence.dnsCheckedAt = dnsSnapshot.checkedAt.toISOString();
  }
  return evidence;
}

/**
 * Run intelligence analysis as a scheduled job
 */
export async function runScheduledAnalysis(): Promise<void> {
  logger.info('[DMARC Intelligence] Starting scheduled analysis...');

  try {
    const result = await analyzeDmarcIntelligence({ daysBack: 7 });
    logger.info(
      `[DMARC Intelligence] Analysis complete: ${result.senders} senders, ${result.issues} issues`
    );
  } catch (error) {
    logger.error('[DMARC Intelligence] Analysis failed', { error: (error as Error).message });
  }
}
