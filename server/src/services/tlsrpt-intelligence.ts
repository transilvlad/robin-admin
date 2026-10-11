/**
 * TLSRPT Intelligence Service
 * 
 * Analyzes TLS-RPT reports to build:
 * - Transport health metrics per domain
 * - TLS failure taxonomies and patterns
 * - MTA-STS readiness assessment
 * - Issue detection and remediation suggestions
 */

import { pool } from '../db/connection.js';
import type { 
  IssueSeverity,
  IssueEvidence,
  IssueType,
} from '../types/reporting.js';
import {
  upsertDomainHealth,
  upsertSender,
  createRemediation,
  getTlsrptDomains,
} from '../db/queries/reporting.js';
import { getConfig } from '../db/queries/config.js';
import { getDomainDnsRecords, getOrgDomain } from './sender-enrichment.js';
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

interface DbClient {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[] }>;
  release: () => void;
}

// TLS failure type classifications
const TLS_FAILURE_TAXONOMY: Record<string, {
  category: 'certificate' | 'hostname' | 'policy' | 'negotiation' | 'dns' | 'other';
  severity: IssueSeverity;
  description: string;
}> = {
  'starttls-not-supported': {
    category: 'negotiation',
    severity: 'high',
    description: 'Remote server does not support STARTTLS',
  },
  'certificate-host-mismatch': {
    category: 'hostname',
    severity: 'high',
    description: 'Certificate hostname does not match expected domain',
  },
  'certificate-expired': {
    category: 'certificate',
    severity: 'critical',
    description: 'Remote server certificate has expired',
  },
  'certificate-not-trusted': {
    category: 'certificate',
    severity: 'high',
    description: 'Remote server certificate is not trusted',
  },
  'validation-failure': {
    category: 'certificate',
    severity: 'high',
    description: 'Certificate validation failed',
  },
  'tlsa-invalid': {
    category: 'dns',
    severity: 'medium',
    description: 'DANE TLSA record is invalid',
  },
  'dnssec-invalid': {
    category: 'dns',
    severity: 'medium',
    description: 'DNSSEC validation failed',
  },
  'dane-required': {
    category: 'policy',
    severity: 'medium',
    description: 'DANE is required but validation failed',
  },
  'sts-policy-fetch-error': {
    category: 'policy',
    severity: 'medium',
    description: 'Unable to fetch MTA-STS policy',
  },
  'sts-policy-invalid': {
    category: 'policy',
    severity: 'medium',
    description: 'MTA-STS policy is invalid',
  },
  'sts-webpki-invalid': {
    category: 'policy',
    severity: 'high',
    description: 'MTA-STS requires valid WebPKI certificate',
  },
};

interface TlsrptDomainStats {
  policyDomain: string;
  policyType: string;
  totalSuccess: number;
  totalFailure: number;
  failureTypes: { resultType: string; count: number }[];
  affectedMxHosts: string[];
  firstSeen: Date;
  lastSeen: Date;
}

interface ReportingPostureChecks {
  mtaSts: boolean;
  dane: boolean;
  bimi: boolean;
}

async function getReportingPostureChecks(): Promise<ReportingPostureChecks> {
  const config = await getConfig();
  return {
    mtaSts: config.reportingMtaStsChecksEnabled,
    dane: config.reportingDaneChecksEnabled,
    bimi: config.reportingBimiChecksEnabled,
  };
}

function describeMtaStsGap(domain: string, dns: Awaited<ReturnType<typeof getDomainDnsRecords>> | null) {
  if (!dns?.mtaStsDnsRecord && !dns?.mtaStsPolicyText) {
    return {
      issueType: 'mta_sts_missing' as const,
      title: `MTA-STS TXT record and policy file are missing for ${domain}`,
      description: 'Receivers cannot discover or enforce inbound TLS because neither the _mta-sts TXT record nor the hosted mta-sts.txt policy file is published.',
      problem: 'both_missing',
      remediationTitle: 'Publish the MTA-STS TXT record and hosted policy file',
      remediationDescription: 'Publish both the _mta-sts TXT record and the HTTPS policy file so receiving MTAs can discover and enforce inbound TLS.',
      verification: [
        { order: 1, description: 'Resolve the _mta-sts TXT record', expectedOutcome: 'v=STSv1; id=... is visible in DNS' },
        { order: 2, description: 'Fetch the hosted policy file', expectedOutcome: '200 OK and a valid mode: line' },
      ],
    };
  }

  if (!dns?.mtaStsDnsRecord) {
    return {
      issueType: 'mta_sts_missing' as const,
      title: `MTA-STS TXT record is missing for ${domain}`,
      description: 'The hosted MTA-STS policy file exists, but the _mta-sts TXT record is missing, so receivers cannot discover policy updates.',
      problem: 'dns_record_missing',
      remediationTitle: 'Publish the _mta-sts TXT record',
      remediationDescription: 'Publish the discovery TXT record so receivers can locate and cache the hosted MTA-STS policy.',
      verification: [
        { order: 1, description: 'Resolve the _mta-sts TXT record', expectedOutcome: 'v=STSv1; id=... is visible in DNS' },
      ],
    };
  }

  if (!dns?.mtaStsPolicyText) {
    return {
      issueType: 'mta_sts_missing' as const,
      title: `MTA-STS policy file is missing for ${domain}`,
      description: 'The _mta-sts TXT record is published, but the HTTPS policy file could not be fetched. Receivers cannot enforce the advertised policy.',
      problem: 'policy_file_missing',
      remediationTitle: 'Host the MTA-STS policy file',
      remediationDescription: 'Serve https://mta-sts.<domain>/.well-known/mta-sts.txt with a valid MTA-STS policy.',
      verification: [
        { order: 1, description: 'Fetch the hosted policy file', expectedOutcome: '200 OK and a valid mode: line' },
      ],
    };
  }

  if (!dns.mtaStsPolicyMode) {
    return {
      issueType: 'mta_sts_invalid' as const,
      title: `MTA-STS policy file is invalid for ${domain}`,
      description: 'The hosted MTA-STS policy file was fetched, but no valid mode: directive could be parsed from it.',
      problem: 'policy_invalid',
      remediationTitle: 'Fix the MTA-STS policy syntax',
      remediationDescription: 'Correct the hosted mta-sts.txt so it contains a valid mode: directive and the required policy fields.',
      verification: [
        { order: 1, description: 'Fetch the hosted policy file', expectedOutcome: 'mode: testing or mode: enforce is present' },
      ],
    };
  }

  return null;
}

/**
 * Analyze TLSRPT data for transport security intelligence
 */
export async function analyzeTlsrptIntelligence(options: {
  domain?: string;
  startDate?: Date;
  endDate?: Date;
  daysBack?: number;
}): Promise<{
  processed: number;
  issues: number;
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
    runId = await startAnalysisRun('tlsrpt', startDate, endDate);
    const ctx: DetectionContext = {
      kind: 'tlsrpt',
      runId,
      windowStart: startDate,
      windowEnd: endDate,
      counters: emptyCounters(),
    };

    const postureChecks = await getReportingPostureChecks();

    // Get aggregated domain stats
    const domainStats = await aggregateTlsrptStats(client, options.domain, startDate, endDate);
    const monitoredDomains = options.domain
      ? [options.domain]
      : await getTlsrptDomains(options.daysBack || 30);

    for (const stats of domainStats) {
      // Update domain health with TLS metrics
      await updateDomainTlsHealth(stats);

      // Detect issues
      await detectTlsIssues(ctx, stats);
    }

    for (const domain of monitoredDomains) {
      const orgDomain = getOrgDomain(domain);
      try {
        const dns = await getDomainDnsRecords(domain).catch(() => null);
        await upsertDomainHealth(domain, new Date(), {
          mtaStsMode: dns?.mtaStsPolicyMode ?? null,
          mtaStsDnsRecordCurrent: dns?.mtaStsDnsRecord ?? null,
          mtaStsPolicyCurrent: dns?.mtaStsPolicyText ?? null,
          tlsRptRecordCurrent: dns?.tlsRptRecord ?? null,
          bimiRecordCurrent: dns?.bimiRecord ?? null,
          dnsCheckedAt: dns?.checkedAt ?? null,
          orgDomain,
        });

        const latestHealth = await pool.query(
          `SELECT COALESCE(dmarc_volume, 0) AS dmarc_volume
           FROM domain_health
           WHERE domain = $1
           ORDER BY snapshot_date DESC
           LIMIT 1`,
          [domain]
        );
        const observedVolume = parseInt(latestHealth.rows[0]?.dmarc_volume as string, 10) || 0;

        const mtaStsGap = describeMtaStsGap(domain, dns);
        if (postureChecks.mtaSts && mtaStsGap) {
          const severity: IssueSeverity = mtaStsGap.issueType === 'mta_sts_invalid' || observedVolume >= 1000 ? 'medium' : 'low';
          const { issue } = await raiseIssue(ctx, {
            domain,
            orgDomain,
            issueType: mtaStsGap.issueType,
            severity,
            title: mtaStsGap.title,
            description: mtaStsGap.description,
            evidence: {
              metrics: { observedVolume, problem: mtaStsGap.problem },
              current: {
                hasMtaStsTxt: dns?.mtaStsDnsRecord ? 1 : 0,
                hasPolicyFile: dns?.mtaStsPolicyText ? 1 : 0,
                hasValidMode: dns?.mtaStsPolicyMode ? 1 : 0,
              },
            },
          });
          if (issue) {
            await createRemediation({
              issueId: issue.id,
              domain,
              suggestionType: 'mta_sts_setup',
              priority: 2,
              title: mtaStsGap.remediationTitle,
              description: mtaStsGap.remediationDescription,
              actionSteps: [
                { order: 1, action: `Publish TXT at _mta-sts.${domain} with v=STSv1; id=<timestamp>` },
                { order: 2, action: `Host https://mta-sts.${domain}/.well-known/mta-sts.txt` },
                { order: 3, action: 'Start with mode: testing, validate, then move to enforce' },
              ],
              dnsChanges: [],
              verificationSteps: mtaStsGap.verification,
              estimatedImpact: 'Allows receiving MTAs to enforce TLS policy on inbound mail.',
            });
          }
        } else if (postureChecks.mtaSts && dns?.mtaStsPolicyMode === 'testing') {
          const { issue } = await raiseIssue(ctx, {
            domain,
            orgDomain,
            issueType: 'mta_sts_testing',
            severity: 'low',
            title: `MTA-STS still in testing mode for ${domain}`,
            description: 'The published MTA-STS policy is still in testing mode. Receivers will monitor but not enforce the TLS policy.',
            evidence: { metrics: { observedVolume, mtaStsMode: 'testing' } },
          });
          if (issue) {
            await createRemediation({
              issueId: issue.id,
              domain,
              suggestionType: 'mta_sts_enforce',
              priority: 3,
              title: 'Move MTA-STS from testing to enforce',
              description: 'Once the policy has been stable and reports are clean, switch mode to enforce.',
              actionSteps: [
                { order: 1, action: 'Confirm recent TLS telemetry is clean or acceptable' },
                { order: 2, action: 'Update the hosted policy file to mode: enforce' },
                { order: 3, action: 'Bump the id= value in the _mta-sts TXT record' },
              ],
              dnsChanges: [],
              verificationSteps: [
                { order: 1, description: 'Fetch the hosted policy', expectedOutcome: 'mode: enforce' },
              ],
              estimatedImpact: 'Receivers can reject inbound mail that violates your TLS transport policy.',
            });
          }
        }

        // MTA-STS findings are deterministic: once the record is right,
        // the finding must disappear on the next run rather than linger.
        if (postureChecks.mtaSts) {
          const cleared: IssueType[] = [];
          if (!mtaStsGap) {
            cleared.push('mta_sts_missing', 'mta_sts_invalid');
          }
          if (dns?.mtaStsPolicyMode === 'enforce') cleared.push('mta_sts_testing');
          if (cleared.length > 0) {
            await autoResolveClearedIssues(
              ctx, domain, cleared,
              'Auto-resolved: the published MTA-STS posture now satisfies this check.'
            );
          }
        }

        if (postureChecks.dane && dns?.mxHosts?.length) {
          const missingDaneHosts = dns.mxHosts.filter((mxHost) => !dns.daneRecords[mxHost]?.length);
          if (missingDaneHosts.length > 0) {
            const { issue } = await raiseIssue(ctx, {
              domain,
              orgDomain,
              issueType: 'dane_missing',
              severity: 'low',
              title: missingDaneHosts.length === dns.mxHosts.length
                ? `No DANE TLSA records are published for ${domain}`
                : `Some MX hosts for ${domain} are missing DANE TLSA records`,
              description: missingDaneHosts.length === dns.mxHosts.length
                ? `No TLSA records were found for the published MX hosts (${dns.mxHosts.join(', ')}). DANE cannot be used to authenticate inbound TLS for this domain.`
                : `TLSA records were not found for these MX hosts: ${missingDaneHosts.join(', ')}.`,
              evidence: {
                metrics: {
                  mxHostCount: dns.mxHosts.length,
                  tlsaHostCount: Object.keys(dns.daneRecords).length,
                  missingHostCount: missingDaneHosts.length,
                },
              },
            });
            if (issue) {
              await createRemediation({
                issueId: issue.id,
                domain,
                suggestionType: 'dane_setup',
                priority: 4,
                title: 'Publish TLSA records for inbound MX hosts',
                description: 'If you want DANE, publish TLSA records for each MX host and ensure the zone is DNSSEC-signed end to end.',
                actionSteps: [
                  { order: 1, action: 'Confirm each MX host that should support DANE on port 25' },
                  { order: 2, action: 'Publish TLSA records at _25._tcp.<mx-host> for the intended certificate policy' },
                  { order: 3, action: 'Verify DNSSEC is enabled for the relevant zones' },
                ],
                dnsChanges: [],
                verificationSteps: [
                  { order: 1, description: 'Resolve TLSA records for each MX host', expectedOutcome: 'TLSA answers are present for every intended DANE-enabled MX host' },
                ],
                estimatedImpact: 'Lets compatible senders authenticate your MX certificates through DNSSEC-backed TLSA records.',
              });
            }
          } else {
            await autoResolveClearedIssues(
              ctx, domain, ['dane_missing'],
              'Auto-resolved: TLSA records are now published for every MX host.'
            );
          }
        }
      } catch {
        // best-effort live posture refresh
      }
    }

    // Populate sender_inventory TLS failure counts. Each TLSRPT failure
    // names a `sending_mta_ip` — that's an IP that tried to deliver
    // mail to one of our MX hosts and the TLS handshake failed. We
    // surface those counts on the per-domain Sender Inventory page
    // alongside DMARC's pass/fail counts so operators can spot relays
    // that are simultaneously authentication-clean but transport-broken.
    const domains = options.domain
      ? [options.domain]
      : [...new Set(domainStats.map(s => s.policyDomain))];
    for (const d of domains) {
      try {
        await upsertTlsFailureCounts(client, d, startDate, endDate);
      } catch {
        // best-effort — never fail TLSRPT analysis on sender_inventory hiccups
      }
    }

    ctx.counters.domainsProcessed = Math.max(domainStats.length, monitoredDomains.length);
    await finishAnalysisRun(runId, ctx.counters);

    return {
      processed: Math.max(domainStats.length, monitoredDomains.length),
      issues: ctx.counters.issuesOpened + ctx.counters.issuesRefreshed,
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
 * Aggregate TLSRPT failure rows per (policy_domain, sending_mta_ip) and
 * upsert sender_inventory rows with the failure totals. Only the
 * tls_failure_count is touched — DMARC-derived counts and classification
 * are preserved via the COALESCE-based UPSERT.
 *
 * For TLSRPT-only senders (no DMARC data, so no row yet) we leave
 * classification at the schema default ('unknown') and add a notes line
 * naming the source. The DMARC analyzer will reclassify them later if
 * the same IP shows up in a DMARC report.
 */
async function upsertTlsFailureCounts(
  client: DbClient,
  domain: string,
  startDate: Date,
  endDate: Date
): Promise<void> {
  const result = await client.query(
    `SELECT
       tf.sending_mta_ip,
       SUM(tf.failed_session_count)::bigint AS total_failures,
       MIN(tr.date_begin) AS first_seen,
       MAX(tr.date_end)   AS last_seen
     FROM tlsrpt_failures tf
     JOIN tlsrpt_policies tp ON tf.policy_id = tp.id
     JOIN tlsrpt_reports  tr ON tp.report_id = tr.id
     WHERE tp.policy_domain = $1
       AND tr.date_begin >= $2
       AND tr.date_end   <= $3
       AND tf.sending_mta_ip IS NOT NULL
       AND tf.sending_mta_ip <> ''
     GROUP BY tf.sending_mta_ip`,
    [domain, startDate.toISOString(), endDate.toISOString()]
  );

  for (const row of result.rows) {
    const sourceIp = row.sending_mta_ip as string;
    const failures = parseInt(row.total_failures as string, 10) || 0;
    if (failures === 0) continue;
    await upsertSender(domain, sourceIp, {
      tlsFailureCount: failures,
      firstSeen: row.first_seen ? new Date(row.first_seen as string) : new Date(),
      lastSeen: row.last_seen ? new Date(row.last_seen as string) : new Date(),
      // No DMARC counts here — leave totalVolume/passCount/failCount
      // unset so existing values (if the IP was seen in a DMARC report
      // too) survive. Only set the classification if there's no row yet
      // (the SET clause on conflict keeps existing classification).
      classification: 'unknown',
    });
  }
}

/**
 * Aggregate TLSRPT statistics by domain
 */
async function aggregateTlsrptStats(
  client: DbClient,
  domain: string | undefined,
  startDate: Date,
  endDate: Date
): Promise<TlsrptDomainStats[]> {
  const domainFilter = domain ? 'AND tp.policy_domain = $3' : '';
  const params = domain 
    ? [startDate.toISOString(), endDate.toISOString(), domain]
    : [startDate.toISOString(), endDate.toISOString()];
  
  // Get policy-level stats
  const policyResult = await client.query(`
    SELECT 
      tp.policy_domain,
      tp.policy_type,
      SUM(tp.success_count) as total_success,
      SUM(tp.failure_count) as total_failure,
      array_agg(DISTINCT tp.mx_host) FILTER (WHERE tp.mx_host IS NOT NULL) as mx_hosts,
      MIN(tr.date_begin) as first_seen,
      MAX(tr.date_end) as last_seen
    FROM tlsrpt_policies tp
    JOIN tlsrpt_reports tr ON tp.report_id = tr.id
    WHERE tr.date_begin >= $1 AND tr.date_end <= $2 ${domainFilter}
    GROUP BY tp.policy_domain, tp.policy_type
  `, params);
  
  const results: TlsrptDomainStats[] = [];
  
  for (const row of policyResult.rows) {
    // Get failure breakdown for this domain
    const failureResult = await client.query(`
      SELECT 
        tf.result_type,
        SUM(tf.failed_session_count) as count
      FROM tlsrpt_failures tf
      JOIN tlsrpt_policies tp ON tf.policy_id = tp.id
      JOIN tlsrpt_reports tr ON tp.report_id = tr.id
      WHERE tp.policy_domain = $1 AND tr.date_begin >= $2 AND tr.date_end <= $3
      GROUP BY tf.result_type
      ORDER BY count DESC
    `, [row.policy_domain, startDate.toISOString(), endDate.toISOString()]);
    
    results.push({
      policyDomain: row.policy_domain as string,
      policyType: row.policy_type as string,
      totalSuccess: parseInt(row.total_success as string, 10) || 0,
      totalFailure: parseInt(row.total_failure as string, 10) || 0,
      failureTypes: failureResult.rows.map(f => ({
        resultType: f.result_type as string,
        count: parseInt(f.count as string, 10) || 0,
      })),
      affectedMxHosts: (row.mx_hosts as string[]) || [],
      firstSeen: new Date(row.first_seen as string),
      lastSeen: new Date(row.last_seen as string),
    });
  }
  
  return results;
}

/**
 * Update domain health with TLS metrics
 */
async function updateDomainTlsHealth(stats: TlsrptDomainStats): Promise<void> {
  const total = stats.totalSuccess + stats.totalFailure;
  const tlsSuccessRate = total > 0 ? stats.totalSuccess / total : 1;
  
  // RFC 8460 policy_type tells us which policy framework was evaluated
  // (`sts`, `tlsa`, `no-policy-found`), not the live MTA-STS mode. The
  // actual mode comes from the hosted mta-sts.txt policy and is populated
  // separately via live DNS/HTTP posture checks.
  let mtaStsMode: string | null = null;
  if (stats.policyType === 'no-policy-found') {
    mtaStsMode = 'none';
  }
  
  await upsertDomainHealth(stats.policyDomain, new Date(), {
    tlsSuccessRate,
    tlsVolume: total,
    mtaStsMode,
  });
}

/**
 * Detect TLS-related issues
 */
async function detectTlsIssues(ctx: DetectionContext, stats: TlsrptDomainStats): Promise<void> {
  const orgDomain = getOrgDomain(stats.policyDomain);
  const total = stats.totalSuccess + stats.totalFailure;
  const failureRate = total > 0 ? stats.totalFailure / total : 0;
  const successRate = 1 - failureRate;

  // Check for high failure rate
  if (
    failureRate > DETECTION_THRESHOLDS.tlsFailureRate &&
    stats.totalFailure > DETECTION_THRESHOLDS.tlsMinFailures
  ) {
    const severity: IssueSeverity = failureRate > 0.3 ? 'high' : 'medium';
    
    const evidence: IssueEvidence = {
      metrics: {
        failureRate,
        totalFailure: stats.totalFailure,
        totalSuccess: stats.totalSuccess,
      },
    };
    
    const { issue } = await raiseIssue(ctx, {
      domain: stats.policyDomain,
      orgDomain,
      issueType: 'tls_policy_failure',
      severity,
      title: `High TLS failure rate for ${stats.policyDomain}`,
      description: `${(failureRate * 100).toFixed(1)}% of TLS connections are failing. ${stats.totalFailure} failures out of ${total} total connections.`,
      evidence,
      trigger: {
        metric: 'tls_failure_rate',
        value: failureRate,
        threshold: DETECTION_THRESHOLDS.tlsFailureRate,
        comparator: '>',
      },
    });
    
    // Create remediation based on failure types
    const topFailure = stats.failureTypes[0];
    if (issue && topFailure) {
      const taxonomy = TLS_FAILURE_TAXONOMY[topFailure.resultType];
      
      await createRemediation({
        issueId: issue.id,
        domain: stats.policyDomain,
        suggestionType: 'tls_fix',
        priority: 1,
        title: `Fix ${taxonomy?.category || 'TLS'} issue: ${topFailure.resultType}`,
        description: taxonomy?.description || `Resolve ${topFailure.resultType} failures`,
        actionSteps: getTlsRemediationSteps(topFailure.resultType, taxonomy?.category),
        dnsChanges: [],
        verificationSteps: [
          { order: 1, description: 'Monitor next TLSRPT report', expectedOutcome: 'Failure count should decrease' },
          { order: 2, description: 'Test TLS connection manually', expectedOutcome: 'Successful TLS handshake' },
        ],
        estimatedImpact: 'Improved email delivery security and reliability',
      });
    }
  } else {
    await autoResolveClearedIssues(
      ctx, stats.policyDomain, ['tls_policy_failure'],
      'Auto-resolved: TLS failure rate is back within tolerance.'
    );
  }
  
  // Check for certificate issues
  const certIssues = stats.failureTypes.filter(f => 
    TLS_FAILURE_TAXONOMY[f.resultType]?.category === 'certificate'
  );
  
  const totalCertFailures = certIssues.reduce((sum, f) => sum + f.count, 0);
  if (totalCertFailures > 5) {
      const evidence: IssueEvidence = {
        metrics: {
          failureTypes: certIssues.map(c => `${c.resultType}: ${c.count}`).join(', '),
          totalCertFailures,
        },
      };
      
      const { issue } = await raiseIssue(ctx, {
        domain: stats.policyDomain,
        orgDomain,
        issueType: 'tls_certificate_error',
        severity: 'high',
        title: `Certificate issues for ${stats.policyDomain}`,
        description: `${totalCertFailures} certificate-related TLS failures detected. Issues: ${certIssues.map(c => c.resultType).join(', ')}`,
        evidence,
        trigger: {
          metric: 'certificate_failures',
          value: totalCertFailures,
          threshold: 5,
          comparator: '>',
        },
      });
      
      if (issue) {
        await createRemediation({
          issueId: issue.id,
          domain: stats.policyDomain,
          suggestionType: 'certificate_fix',
          priority: 1,
          title: 'Resolve certificate issues',
          description: 'Fix TLS certificate configuration on mail servers',
          actionSteps: [
            { order: 1, action: 'Check certificate expiration dates on all MX hosts' },
            { order: 2, action: 'Verify certificate chain is complete and trusted' },
            { order: 3, action: 'Ensure certificate hostname matches MX records' },
            { order: 4, action: 'Renew or replace problematic certificates' },
          ],
          dnsChanges: [],
          verificationSteps: [
            { order: 1, description: 'Test with openssl s_client', expectedOutcome: 'Valid certificate chain' },
            { order: 2, description: 'Monitor TLSRPT', expectedOutcome: 'Certificate errors eliminated' },
          ],
          estimatedImpact: 'Secure mail transport with valid certificates',
        });
      }
  } else {
    await autoResolveClearedIssues(
      ctx, stats.policyDomain, ['tls_certificate_error'],
      'Auto-resolved: certificate-related TLS failures are no longer being reported.'
    );
  }
  
  // MTA-STS still in test mode — operators often forget to flip the
  // policy from `testing` to `enforce`. Surfacing this as a low-severity
  // issue helps complete the rollout. The mode lives on domain_health
  // (populated by analyzeTlsrptIntelligence above).
  if (stats.policyType === 'sts' && total > 100) {
    const modeResult = await pool.query(
      `SELECT mta_sts_mode FROM domain_health
       WHERE domain = $1 ORDER BY snapshot_date DESC LIMIT 1`,
      [stats.policyDomain]
    );
    const mode = modeResult.rows[0]?.mta_sts_mode as string | undefined;
    if (mode === 'testing') {
      const { issue } = await raiseIssue(ctx, {
        domain: stats.policyDomain,
        orgDomain,
        issueType: 'mta_sts_testing',
        severity: 'low',
        title: `MTA-STS still in testing mode for ${stats.policyDomain}`,
        description: 'The MTA-STS policy is set to mode=testing. Receivers will report failures but not enforce TLS — finish the rollout by switching to mode=enforce once the report has been clean for 1–2 weeks.',
        evidence: { metrics: { totalVolume: total, mtaStsMode: 'testing' } },
      });
      if (issue) {
        await createRemediation({
          issueId: issue.id,
          domain: stats.policyDomain,
          suggestionType: 'mta_sts_enforce',
          priority: 3,
          title: 'Switch MTA-STS from testing to enforce',
          description: 'Once TLSRPT has been clean for 1–2 weeks, flip the policy mode to enforce so receivers reject mail that would have failed TLS.',
          actionSteps: [
            { order: 1, action: 'Confirm TLSRPT failure count for this domain is 0 over the last 14 days' },
            { order: 2, action: 'Update mta-sts.txt to set `mode: enforce`' },
            { order: 3, action: 'Bump the `id:` field so receivers refetch the policy' },
          ],
          dnsChanges: [],
          verificationSteps: [
            { order: 1, description: 'Recheck the policy via curl', expectedOutcome: 'mode: enforce' },
          ],
          estimatedImpact: 'Receivers will now reject (rather than just report) mail that fails TLS for this domain.',
        });
      }
    }
  }

  // Check for MTA-STS issues
  if (stats.policyType === 'no-policy-found' && total > 100) {
    const evidence: IssueEvidence = {
      metrics: { totalVolume: total },
    };
    
    const { issue } = await raiseIssue(ctx, {
      domain: stats.policyDomain,
      orgDomain,
      issueType: 'mta_sts_missing',
      severity: 'medium',
      title: `No MTA-STS policy for ${stats.policyDomain}`,
      description: `${stats.policyDomain} has significant email volume (${total}) but no MTA-STS policy. Consider implementing MTA-STS for improved security.`,
      evidence,
    });
    
    if (issue) {
      await createRemediation({
        issueId: issue.id,
        domain: stats.policyDomain,
        suggestionType: 'mta_sts_setup',
        priority: 2,
        title: 'Implement MTA-STS',
        description: 'Set up MTA-STS to enforce TLS for inbound mail',
        actionSteps: [
          { order: 1, action: 'Generate MTA-STS policy file' },
          { order: 2, action: 'Host policy at https://mta-sts.<domain>/.well-known/mta-sts.txt' },
          { order: 3, action: 'Add _mta-sts DNS TXT record' },
          { order: 4, action: 'Start with mode: testing to monitor impact' },
          { order: 5, action: 'Move to mode: enforce after validation period' },
        ],
        dnsChanges: [
          {
            recordType: 'TXT',
            name: `_mta-sts.${stats.policyDomain}`,
            suggestedValue: 'v=STSv1; id=<timestamp>',
            reason: 'Enables MTA-STS policy discovery',
          },
        ],
        verificationSteps: [
          { order: 1, description: 'Verify DNS record propagation', expectedOutcome: 'TXT record resolves correctly' },
          { order: 2, description: 'Test policy URL access', expectedOutcome: 'Policy file accessible via HTTPS' },
          { order: 3, description: 'Monitor TLSRPT', expectedOutcome: 'Policy type changes to sts/testing' },
        ],
        estimatedImpact: 'Prevents downgrade attacks on inbound mail',
      });
    }
  }
  
  // Check for hostname mismatch
  const hostnameMismatch = stats.failureTypes.find(f => 
    f.resultType === 'certificate-host-mismatch'
  );
  
  if (hostnameMismatch && hostnameMismatch.count > 5) {
    const evidence: IssueEvidence = {
      senderIps: stats.affectedMxHosts,
      metrics: { mismatchCount: hostnameMismatch.count },
    };
    
    const { issue } = await raiseIssue(ctx, {
      domain: stats.policyDomain,
      orgDomain,
      issueType: 'tls_hostname_mismatch',
      severity: 'high',
      title: `Certificate hostname mismatch for ${stats.policyDomain}`,
      description: `${hostnameMismatch.count} connections failed due to certificate hostname mismatch. Affected hosts: ${stats.affectedMxHosts.join(', ')}`,
      evidence,
      trigger: {
        metric: 'hostname_mismatch_count',
        value: hostnameMismatch.count,
        threshold: 5,
        comparator: '>',
      },
    });
    
    if (issue) {
      await createRemediation({
      issueId: issue.id,
      domain: stats.policyDomain,
      suggestionType: 'hostname_fix',
      priority: 1,
      title: 'Fix certificate hostname mismatch',
      description: 'Ensure certificates include the correct hostnames',
      actionSteps: [
        { order: 1, action: 'Identify affected MX hosts' },
        { order: 2, action: 'Check certificate Subject Alternative Names (SANs)' },
        { order: 3, action: 'Ensure each MX hostname is in the certificate' },
        { order: 4, action: 'Reissue certificates with correct hostnames if needed' },
      ],
      dnsChanges: [],
      verificationSteps: [
        { order: 1, description: 'Verify certificate SANs', expectedOutcome: 'All MX hostnames present' },
        { order: 2, description: 'Monitor TLSRPT', expectedOutcome: 'Hostname mismatch errors eliminated' },
      ],
        estimatedImpact: 'Proper TLS validation for all mail servers',
      });
    }
  } else {
    await autoResolveClearedIssues(
      ctx, stats.policyDomain, ['tls_hostname_mismatch'],
      'Auto-resolved: no further certificate hostname mismatches were reported.'
    );
  }
}

/**
 * Get remediation steps based on failure type
 */
function getTlsRemediationSteps(resultType: string, category?: string): { order: number; action: string }[] {
  switch (category) {
    case 'certificate':
      return [
        { order: 1, action: 'Check certificate validity and expiration' },
        { order: 2, action: 'Verify certificate chain is complete' },
        { order: 3, action: 'Renew or replace invalid certificates' },
      ];
    case 'hostname':
      return [
        { order: 1, action: 'Verify MX records point to correct hostnames' },
        { order: 2, action: 'Ensure certificates include all MX hostnames' },
        { order: 3, action: 'Update certificate SANs if needed' },
      ];
    case 'policy':
      return [
        { order: 1, action: 'Check MTA-STS policy file accessibility' },
        { order: 2, action: 'Validate policy file syntax' },
        { order: 3, action: 'Verify DNS TXT record for _mta-sts' },
      ];
    case 'negotiation':
      return [
        { order: 1, action: 'Check if STARTTLS is enabled on mail server' },
        { order: 2, action: 'Verify TLS configuration supports modern protocols' },
        { order: 3, action: 'Contact remote server admin if issue persists' },
      ];
    case 'dns':
      return [
        { order: 1, action: 'Verify DNSSEC configuration' },
        { order: 2, action: 'Check TLSA records if using DANE' },
        { order: 3, action: 'Validate DNS record syntax' },
      ];
    default:
      return [
        { order: 1, action: `Investigate ${resultType} failures` },
        { order: 2, action: 'Check mail server TLS configuration' },
        { order: 3, action: 'Review server logs for more details' },
      ];
  }
}

/**
 * Get TLS failure summary for a domain
 */
export async function getTlsFailureSummary(domain: string, daysBack: number = 30): Promise<{
  domain: string;
  reportCount: number;
  totalSuccess: number;
  totalFailure: number;
  successRate: number;
  failuresByCategory: Record<string, number>;
  topFailureTypes: { type: string; count: number; description: string }[];
  affectedHosts: string[];
  posture: {
    mxHosts: string[];
    daneRecords: Record<string, string[]>;
    mtaStsDnsRecord: string | null;
    mtaStsPolicyText: string | null;
    mtaStsMode: string | null;
    tlsRptRecord: string | null;
    bimiRecord: string | null;
  };
}> {
  const client = await pool.connect() as unknown as DbClient;
  
  try {
    const startDate = new Date(Date.now() - daysBack * 24 * 60 * 60 * 1000);
    
    const result = await client.query(`
      SELECT 
        COUNT(DISTINCT tr.id) as report_count,
        SUM(tp.success_count) as total_success,
        SUM(tp.failure_count) as total_failure,
        array_agg(DISTINCT tp.mx_host) FILTER (WHERE tp.mx_host IS NOT NULL) as mx_hosts
      FROM tlsrpt_policies tp
      JOIN tlsrpt_reports tr ON tp.report_id = tr.id
      WHERE tp.policy_domain = $1 AND tr.date_begin >= $2
    `, [domain, startDate.toISOString()]);
    
    const reportCount = parseInt(result.rows[0]?.report_count as string, 10) || 0;
    const totalSuccess = parseInt(result.rows[0]?.total_success as string, 10) || 0;
    const totalFailure = parseInt(result.rows[0]?.total_failure as string, 10) || 0;
    const affectedHosts = (result.rows[0]?.mx_hosts as string[]) || [];
    const dns = await getDomainDnsRecords(domain).catch(() => null);
    
    const failureResult = await client.query(`
      SELECT 
        tf.result_type,
        SUM(tf.failed_session_count) as count
      FROM tlsrpt_failures tf
      JOIN tlsrpt_policies tp ON tf.policy_id = tp.id
      JOIN tlsrpt_reports tr ON tp.report_id = tr.id
      WHERE tp.policy_domain = $1 AND tr.date_begin >= $2
      GROUP BY tf.result_type
      ORDER BY count DESC
      LIMIT 10
    `, [domain, startDate.toISOString()]);
    
    const failuresByCategory: Record<string, number> = {};
    const topFailureTypes: { type: string; count: number; description: string }[] = [];
    
    for (const row of failureResult.rows) {
      const resultType = row.result_type as string;
      const count = parseInt(row.count as string, 10) || 0;
      const taxonomy = TLS_FAILURE_TAXONOMY[resultType];
      
      // Aggregate by category
      const category = taxonomy?.category || 'other';
      failuresByCategory[category] = (failuresByCategory[category] || 0) + count;
      
      topFailureTypes.push({
        type: resultType,
        count,
        description: taxonomy?.description || resultType,
      });
    }
    
    const total = totalSuccess + totalFailure;
    
      return {
        domain,
        reportCount,
        totalSuccess,
        totalFailure,
        successRate: total > 0 ? totalSuccess / total : 1,
        failuresByCategory,
        topFailureTypes,
        affectedHosts,
        posture: {
          mxHosts: dns?.mxHosts ?? [],
          daneRecords: dns?.daneRecords ?? {},
          mtaStsDnsRecord: dns?.mtaStsDnsRecord ?? null,
          mtaStsPolicyText: dns?.mtaStsPolicyText ?? null,
          mtaStsMode: dns?.mtaStsPolicyMode ?? null,
          tlsRptRecord: dns?.tlsRptRecord ?? null,
          bimiRecord: dns?.bimiRecord ?? null,
        },
      };
  } finally {
    client.release();
  }
}
