/**
 * Reporting Intelligence Database Queries
 * 
 * This module provides database access for the reporting intelligence layer:
 * - Sender inventory management
 * - Domain health snapshots
 * - Issue detection and tracking
 * - Remediation suggestions
 * - External deliverability signals
 */

import { query } from '../connection.js';
import { createHash } from 'node:crypto';
import type {
  SenderInventoryItem,
  SenderClassification,
  SenderReviewState,
  DomainHealth,
  DomainSummary,
  RiskFactor,
  ReportingIssue,
  IssueType,
  IssueSeverity,
  IssueStatus,
  IssueEvidence,
  RemediationSuggestion,
  ActionStep,
  DnsChange,
  VerificationStep,
  ReportingFilters,
} from '../../types/reporting.js';

// Generic database row type for mapping
type DbRow = Record<string, unknown>;

// =============================================================================
// SENDER INVENTORY
// =============================================================================

/**
 * Get or create a sender inventory entry.
 */
export async function upsertSender(
  domain: string,
  sourceIp: string,
  data: Partial<SenderInventoryItem>
): Promise<SenderInventoryItem> {
  // Counts are passed as `null` when not provided so the SET clause's
  // COALESCE($N, existing) preserves whatever's already there. The
  // INSERT side wraps each in COALESCE(..., 0) so first-time inserts
  // still default to zero. This lets the DMARC analyzer and the TLSRPT
  // analyzer each upsert independently without overwriting each other's
  // contributions to the same (domain, source_ip) row.
  const totalVolume = data.totalVolume ?? null;
  const passCount = data.passCount ?? null;
  const failCount = data.failCount ?? null;
  const spfAligned = data.spfAligned ?? null;
  const dkimAligned = data.dkimAligned ?? null;
  const tlsFailureCount = data.tlsFailureCount ?? null;

  const result = await query<DbRow>(
    `INSERT INTO sender_inventory (
      domain, source_ip, source_host, classification, confidence,
      first_seen, last_seen, total_volume, pass_count, fail_count,
      spf_aligned, dkim_aligned, tls_failure_count, notes, provider, org_domain
    ) VALUES (
      $1, $2, $3, $4, $5, $6, $7,
      COALESCE($8, 0), COALESCE($9, 0), COALESCE($10, 0),
      COALESCE($11, 0), COALESCE($12, 0), COALESCE($13, 0), $14, $15, $16
    )
    ON CONFLICT (domain, source_ip) DO UPDATE SET
      source_host = COALESCE($3, sender_inventory.source_host),
      classification = COALESCE($4, sender_inventory.classification),
      confidence = COALESCE($5, sender_inventory.confidence),
      first_seen = LEAST($6, sender_inventory.first_seen),
      last_seen = GREATEST($7, sender_inventory.last_seen),
      -- Counts SET to the freshly aggregated value when one is provided,
      -- otherwise keep the existing value (so TLSRPT-only updates don't
      -- wipe DMARC counts and vice-versa).
      total_volume = COALESCE($8, sender_inventory.total_volume),
      pass_count = COALESCE($9, sender_inventory.pass_count),
      fail_count = COALESCE($10, sender_inventory.fail_count),
      spf_aligned = COALESCE($11, sender_inventory.spf_aligned),
      dkim_aligned = COALESCE($12, sender_inventory.dkim_aligned),
      tls_failure_count = COALESCE($13, sender_inventory.tls_failure_count),
      notes = COALESCE($14, sender_inventory.notes),
      provider = COALESCE($15, sender_inventory.provider),
      org_domain = COALESCE($16, sender_inventory.org_domain),
      updated_at = CURRENT_TIMESTAMP
    RETURNING *`,
    [
      domain,
      sourceIp,
      data.sourceHost ?? null,
      data.classification ?? 'unknown',
      data.confidence ?? 0,
      data.firstSeen ?? new Date(),
      data.lastSeen ?? new Date(),
      totalVolume,
      passCount,
      failCount,
      spfAligned,
      dkimAligned,
      tlsFailureCount,
      data.notes ?? null,
      data.provider ?? null,
      data.orgDomain ?? null,
    ]
  );
  return mapSenderRow(result.rows[0]);
}

function mapSenderRow(row: DbRow): SenderInventoryItem {
  return {
    id: row.id as number,
    domain: row.domain as string,
    sourceIp: row.source_ip as string,
    sourceHost: row.source_host as string | null,
    classification: row.classification as SenderClassification,
    confidence: row.confidence as number,
    firstSeen: new Date(row.first_seen as string),
    lastSeen: new Date(row.last_seen as string),
    totalVolume: parseInt(row.total_volume as string, 10),
    passCount: parseInt(row.pass_count as string, 10),
    failCount: parseInt(row.fail_count as string, 10),
    spfAligned: parseInt(row.spf_aligned as string, 10),
    dkimAligned: parseInt(row.dkim_aligned as string, 10),
    tlsFailureCount: parseInt((row.tls_failure_count as string) ?? '0', 10),
    notes: row.notes as string | null,
    mutedAt: row.muted_at ? new Date(row.muted_at as string) : null,
    mutedBy: (row.muted_by as string | null) ?? null,
    mutedReason: (row.muted_reason as string | null) ?? null,
    mutedUntil: row.muted_until ? new Date(row.muted_until as string) : null,
    reviewState: ((row.review_state as SenderReviewState) ?? 'pending'),
    reviewStateBy: (row.review_state_by as string | null) ?? null,
    reviewStateAt: row.review_state_at ? new Date(row.review_state_at as string) : null,
    reviewStateReason: (row.review_state_reason as string | null) ?? null,
    provider: (row.provider as string | null) ?? null,
    orgDomain: (row.org_domain as string | null) ?? null,
    updatedAt: new Date(row.updated_at as string),
  };
}

// =============================================================================
// SENDER MUTE
// =============================================================================

/**
 * Source IPs for a domain grouped by review state, so a detector can do
 * one round-trip per domain instead of one per sender.
 */
export async function getSenderReviewStates(
  domain: string
): Promise<Map<string, SenderReviewState>> {
  const result = await query<{ source_ip: string; review_state: SenderReviewState }>(
    `SELECT source_ip, review_state FROM sender_inventory WHERE domain = $1`,
    [domain]
  );
  return new Map(result.rows.map((r) => [r.source_ip, r.review_state]));
}

/**
 * Returns the set of (domain, source_ip) pairs that are currently muted
 * for a given domain. Lets detectIssues() do one round-trip per domain
 * instead of per-sender.
 */
export async function getMutedSenderIps(domain: string): Promise<Set<string>> {
  const result = await query<{ source_ip: string }>(
    `SELECT source_ip FROM sender_inventory
     WHERE domain = $1
       AND muted_at IS NOT NULL
       AND (muted_until IS NULL OR muted_until > NOW())`,
    [domain]
  );
  return new Set(result.rows.map((r) => r.source_ip));
}

// =============================================================================
// DOMAIN HEALTH
// =============================================================================

/**
 * Create or update a domain health snapshot.
 */
export async function upsertDomainHealth(
  domain: string,
  snapshotDate: Date,
  data: Partial<DomainHealth>
): Promise<DomainHealth> {
  const result = await query<DbRow>(
    `INSERT INTO domain_health (
      domain, snapshot_date, dmarc_policy, dmarc_pct, dmarc_pass_rate, dmarc_volume,
      spf_pass_rate, dkim_pass_rate, alignment_rate, tls_success_rate, tls_volume,
      mta_sts_mode, mta_sts_dns_record_current, mta_sts_policy_current, tlsrpt_record_current, bimi_record_current,
      forensic_count, risk_score, risk_factors, volume_change_pct, pass_rate_change,
      spf_record_current, dmarc_record_current, dkim_records_current,
      spf_authorized_ips, spf_permerror, dns_checked_at,
      org_domain, subdomain_policy, compliance_rate, unidentified_volume
    ) VALUES (
      $1, $2, $3, $4::int,
      -- Explicit casts so pg-node binds the right type. Without casts,
      -- COALESCE($N, 0) makes Postgres infer int4 for $N (matching the
      -- 0 literal), and a float like 0.923 gets rejected as bad integer
      -- syntax even though dmarc_pass_rate is REAL.
      COALESCE($5::real, 0), COALESCE($6::bigint, 0),
      COALESCE($7::real, 0), COALESCE($8::real, 0), COALESCE($9::real, 0),
      COALESCE($10::real, 0), COALESCE($11::bigint, 0), $12, $13, $14, $15, $16,
      COALESCE($17::int, 0), COALESCE($18::real, 0), $19::jsonb,
      COALESCE($20::real, 0), COALESCE($21::real, 0),
      $22, $23,
      COALESCE($24::jsonb, '{}'::jsonb),
      COALESCE($25::jsonb, '{}'::jsonb),
      COALESCE($26::boolean, false),
      $27,
      $28, $29, COALESCE($30::real, 0), COALESCE($31::bigint, 0)
    )
    ON CONFLICT (domain, snapshot_date) DO UPDATE SET
      dmarc_policy = COALESCE($3, domain_health.dmarc_policy),
      dmarc_pct = COALESCE($4::int, domain_health.dmarc_pct),
      dmarc_pass_rate = COALESCE($5::real, domain_health.dmarc_pass_rate),
      dmarc_volume = COALESCE($6::bigint, domain_health.dmarc_volume),
      spf_pass_rate = COALESCE($7::real, domain_health.spf_pass_rate),
      dkim_pass_rate = COALESCE($8::real, domain_health.dkim_pass_rate),
      alignment_rate = COALESCE($9::real, domain_health.alignment_rate),
      tls_success_rate = COALESCE($10::real, domain_health.tls_success_rate),
      tls_volume = COALESCE($11::bigint, domain_health.tls_volume),
      mta_sts_mode = COALESCE($12, domain_health.mta_sts_mode),
      mta_sts_dns_record_current = COALESCE($13, domain_health.mta_sts_dns_record_current),
      mta_sts_policy_current     = COALESCE($14, domain_health.mta_sts_policy_current),
      tlsrpt_record_current      = COALESCE($15, domain_health.tlsrpt_record_current),
      bimi_record_current        = COALESCE($16, domain_health.bimi_record_current),
      forensic_count = COALESCE($17::int, domain_health.forensic_count),
      risk_score = COALESCE($18::real, domain_health.risk_score),
      risk_factors = COALESCE($19::jsonb, domain_health.risk_factors),
      volume_change_pct = COALESCE($20::real, domain_health.volume_change_pct),
      pass_rate_change = COALESCE($21::real, domain_health.pass_rate_change),
      spf_record_current   = COALESCE($22, domain_health.spf_record_current),
      dmarc_record_current = COALESCE($23, domain_health.dmarc_record_current),
      dkim_records_current = COALESCE($24::jsonb, domain_health.dkim_records_current),
      spf_authorized_ips   = COALESCE($25::jsonb, domain_health.spf_authorized_ips),
      spf_permerror        = COALESCE($26::boolean, domain_health.spf_permerror),
      dns_checked_at       = COALESCE($27, domain_health.dns_checked_at),
      org_domain           = COALESCE($28, domain_health.org_domain),
      subdomain_policy     = COALESCE($29, domain_health.subdomain_policy),
      compliance_rate      = COALESCE($30::real, domain_health.compliance_rate),
      unidentified_volume  = COALESCE($31::bigint, domain_health.unidentified_volume)
    RETURNING *`,
    // Unset numeric fields → null so the SET clause's COALESCE keeps
    // whatever's already there (a TLSRPT-only update mustn't wipe DMARC
    // fields, and vice versa). The INSERT side wraps each in
    // COALESCE($N, 0) so first-time inserts still default to zero.
    [
      domain,
      snapshotDate,
      data.dmarcPolicy ?? null,
      data.dmarcPct ?? null,
      data.dmarcPassRate ?? null,
      data.dmarcVolume ?? null,
      data.spfPassRate ?? null,
      data.dkimPassRate ?? null,
      data.alignmentRate ?? null,
      data.tlsSuccessRate ?? null,
      data.tlsVolume ?? null,
      data.mtaStsMode ?? null,
      data.mtaStsDnsRecordCurrent ?? null,
      data.mtaStsPolicyCurrent ?? null,
      data.tlsRptRecordCurrent ?? null,
      data.bimiRecordCurrent ?? null,
      data.forensicCount ?? null,
      data.riskScore ?? null,
      data.riskFactors !== undefined ? JSON.stringify(data.riskFactors) : null,
      data.volumeChangePct ?? null,
      data.passRateChange ?? null,
      data.spfRecordCurrent ?? null,
      data.dmarcRecordCurrent ?? null,
      data.dkimRecordsCurrent !== undefined ? JSON.stringify(data.dkimRecordsCurrent) : null,
      data.spfAuthorizedIps !== undefined ? JSON.stringify(data.spfAuthorizedIps) : null,
      data.spfPermerror ?? null,
      data.dnsCheckedAt ?? null,
      data.orgDomain ?? null,
      data.subdomainPolicy ?? null,
      data.complianceRate ?? null,
      data.unidentifiedVolume ?? null,
    ]
  );
  return mapDomainHealthRow(result.rows[0]);
}

/**
 * Get domain summaries for overview.
 */
export async function getDomainSummaries(
  options: {
    orderBy?: 'risk' | 'volume' | 'issues';
    limit?: number;
  } = {}
): Promise<DomainSummary[]> {
  const { orderBy = 'risk', limit = 10 } = options;
  
  const orderColumn = {
    risk: 'dh.risk_score',
    volume: 'dh.dmarc_volume',
    issues: 'issue_count',
  }[orderBy];

  const result = await query<DbRow & {
    open_issues: string;
    critical_issues: string;
    prev_pass_rate: number | null;
  }>(
    `WITH latest_health AS (
      SELECT DISTINCT ON (domain) *
      FROM domain_health
      ORDER BY domain, snapshot_date DESC
    ),
     issue_counts AS (
       SELECT domain,
              COUNT(*) FILTER (
                WHERE status IN ('open', 'acknowledged', 'in_progress')
                  AND (muted_until IS NULL OR muted_until <= NOW())
              ) as open_issues,
              COUNT(*) FILTER (
                WHERE status IN ('open', 'acknowledged', 'in_progress')
                  AND severity = 'critical'
                  AND (muted_until IS NULL OR muted_until <= NOW())
              ) as critical_issues
       FROM reporting_issues
       GROUP BY domain
     ),
    prev_health AS (
      SELECT DISTINCT ON (domain) domain,
        dmarc_pass_rate as prev_pass_rate,
        tls_success_rate as prev_tls_rate,
        forensic_count as prev_forensic_count
      FROM domain_health
      WHERE snapshot_date < CURRENT_DATE
      ORDER BY domain, snapshot_date DESC
    )
    SELECT
      dh.*,
      COALESCE(ic.open_issues, 0) as open_issues,
      COALESCE(ic.critical_issues, 0) as critical_issues,
      ph.prev_pass_rate,
      ph.prev_tls_rate,
      ph.prev_forensic_count
    FROM latest_health dh
    LEFT JOIN issue_counts ic ON dh.domain = ic.domain
    LEFT JOIN prev_health ph ON dh.domain = ph.domain
    ORDER BY ${orderColumn} DESC NULLS LAST
    LIMIT $1`,
    [limit]
  );

  return result.rows.map((row) => {
    // Trend combines three signals: DMARC pass rate, TLS pass rate, and
    // forensic count. Any single axis getting clearly worse drags the
    // trend to 'degrading'; all three improving (or stable with at
    // least one improving) → 'improving'; everything close to baseline
    // → 'stable'. Missing prior data → 'unknown'.
    const dmarcCur = (row.dmarc_pass_rate as number) ?? 0;
    const dmarcPrev = row.prev_pass_rate;
    const tlsCur = (row.tls_success_rate as number) ?? 0;
    const tlsPrev = row.prev_tls_rate == null ? null : Number(row.prev_tls_rate);
    const forensicCur = parseInt((row.forensic_count as unknown as string) ?? '0', 10);
    const forensicPrev = row.prev_forensic_count == null ? null : Number(row.prev_forensic_count);

    let trend: DomainSummary['trend'] = 'unknown';
    if (dmarcPrev != null) {
      const dmarcDelta = dmarcCur - dmarcPrev;
      const tlsDelta = tlsPrev != null ? tlsCur - tlsPrev : 0;
      const forensicDelta = forensicPrev != null ? forensicCur - forensicPrev : 0;

      // Forensic spike (5+ new forensic reports vs. yesterday) or a
      // 2pp drop on either auth axis flips the trend to degrading.
      if (dmarcDelta < -0.02 || tlsDelta < -0.02 || forensicDelta >= 5) {
        trend = 'degrading';
      } else if (dmarcDelta > 0.02 || tlsDelta > 0.02) {
        trend = 'improving';
      } else {
        trend = 'stable';
      }
    }

    // Hydrate the latest_health row into a DomainHealth so the UI can
    // surface risk_score, dmarc_pass_rate, etc. on the top-domains list.
    const latestHealth: DomainHealth | null = row.id
      ? mapDomainHealthRow(row)
      : null;

    return {
      domain: row.domain as string,
      orgDomain: (row.org_domain as string | null) ?? null,
      latestHealth,
      openIssueCount: parseInt(row.open_issues as unknown as string, 10),
      criticalIssueCount: parseInt(row.critical_issues as unknown as string, 10),
      trend,
    };
  });
}

function mapDomainHealthRow(row: DbRow): DomainHealth {
  return {
    id: row.id as number,
    domain: row.domain as string,
    orgDomain: (row.org_domain as string | null) ?? null,
    snapshotDate: new Date(row.snapshot_date as string),
    dmarcPolicy: row.dmarc_policy as string | null,
    dmarcPct: row.dmarc_pct as number | null,
    subdomainPolicy: (row.subdomain_policy as string | null) ?? null,
    dmarcPassRate: parseFloat(row.dmarc_pass_rate as string) || 0,
    dmarcVolume: parseInt(row.dmarc_volume as string, 10) || 0,
    spfPassRate: parseFloat(row.spf_pass_rate as string) || 0,
    dkimPassRate: parseFloat(row.dkim_pass_rate as string) || 0,
    alignmentRate: parseFloat(row.alignment_rate as string) || 0,
    complianceRate: parseFloat(row.compliance_rate as string) || 0,
    unidentifiedVolume: parseInt(row.unidentified_volume as string, 10) || 0,
    tlsSuccessRate: parseFloat(row.tls_success_rate as string) || 0,
    tlsVolume: parseInt(row.tls_volume as string, 10) || 0,
    mtaStsMode: row.mta_sts_mode as string | null,
    mtaStsDnsRecordCurrent: (row.mta_sts_dns_record_current as string | null) ?? null,
    mtaStsPolicyCurrent: (row.mta_sts_policy_current as string | null) ?? null,
    tlsRptRecordCurrent: (row.tlsrpt_record_current as string | null) ?? null,
    bimiRecordCurrent: (row.bimi_record_current as string | null) ?? null,
    forensicCount: parseInt(row.forensic_count as string, 10) || 0,
    riskScore: parseFloat(row.risk_score as string) || 0,
    riskFactors: (row.risk_factors as RiskFactor[]) || [],
    volumeChangePct: parseFloat(row.volume_change_pct as string) || 0,
    passRateChange: parseFloat(row.pass_rate_change as string) || 0,
    spfRecordCurrent: (row.spf_record_current as string | null) ?? null,
    dmarcRecordCurrent: (row.dmarc_record_current as string | null) ?? null,
    dkimRecordsCurrent: (row.dkim_records_current as Record<string, string>) ?? {},
    spfAuthorizedIps: (row.spf_authorized_ips as { ipv4?: string[]; ipv6?: string[] }) ?? {},
    spfPermerror: (row.spf_permerror as boolean | null) ?? false,
    dnsCheckedAt: row.dns_checked_at ? new Date(row.dns_checked_at as string) : null,
    createdAt: new Date(row.created_at as string),
  };
}

// =============================================================================
// REPORTING ISSUES
// =============================================================================

const ISSUE_TYPES_WITH_SENDER_SCOPE = new Set<IssueType>([
  'spoofing_detected',
  'repeated_auth_failure',
]);

const ISSUE_SEVERITY_ORDER_SQL = `CASE severity
  WHEN 'critical' THEN 1
  WHEN 'high' THEN 2
  WHEN 'medium' THEN 3
  WHEN 'low' THEN 4
  ELSE 5
END`;

function buildIssueWhereClause(
  filters: ReportingFilters & {
    includeSnoozed?: boolean;
    senderIds?: number[];
  } = {},
  alias = ''
): { whereClause: string; params: unknown[]; nextParamIndex: number } {
  const prefix = alias ? `${alias}.` : '';
  const conditions: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;

  if (filters.domains?.length) {
    conditions.push(`${prefix}domain = ANY($${paramIndex++})`);
    params.push(filters.domains);
  }
  if (filters.issueTypes?.length) {
    conditions.push(`${prefix}issue_type = ANY($${paramIndex++})`);
    params.push(filters.issueTypes);
  }
  if (filters.severities?.length) {
    conditions.push(`${prefix}severity = ANY($${paramIndex++})`);
    params.push(filters.severities);
  }
  if (filters.statuses?.length) {
    conditions.push(`${prefix}status = ANY($${paramIndex++})`);
    params.push(filters.statuses);
  }
  if (filters.dateStart) {
    conditions.push(`${prefix}last_detected >= $${paramIndex++}`);
    params.push(filters.dateStart);
  }
  if (filters.dateEnd) {
    conditions.push(`${prefix}last_detected <= $${paramIndex++}`);
    params.push(filters.dateEnd);
  }
  if (filters.senderIds?.length) {
    conditions.push(`${prefix}sender_ids && $${paramIndex++}::int[]`);
    params.push(filters.senderIds);
  }
  if (!filters.includeSnoozed) {
    conditions.push(`(${prefix}muted_until IS NULL OR ${prefix}muted_until <= NOW())`);
  }

  return {
    whereClause: conditions.length ? `WHERE ${conditions.join(' AND ')}` : '',
    params,
    nextParamIndex: paramIndex,
  };
}

function deriveAffectedVolume(evidence: IssueEvidence): number {
  const metrics = evidence.metrics ?? {};
  for (const key of ['rejectedVolume', 'failedVolume', 'totalFailure', 'totalReports', 'totalVolume', 'count', 'dmarcFailureCount']) {
    const value = metrics[key];
    if (typeof value === 'number' && Number.isFinite(value)) return value;
  }
  return 0;
}

export function buildIssueFingerprint(
  domain: string,
  issueType: IssueType,
  evidence: IssueEvidence,
  senderIds: number[]
): string {
  const parts = [domain.toLowerCase(), issueType];
  const stableSenderIds = [...new Set(senderIds)].sort((a, b) => a - b);

  if (ISSUE_TYPES_WITH_SENDER_SCOPE.has(issueType) && stableSenderIds.length > 0) {
    parts.push(`senders:${stableSenderIds.join(',')}`);
  } else if (ISSUE_TYPES_WITH_SENDER_SCOPE.has(issueType) && evidence.senderIps?.length) {
    parts.push(`ips:${[...new Set(evidence.senderIps)].sort().join(',')}`);
  }

  return createHash('sha1').update(parts.join('|')).digest('hex');
}

function nextIssueHistory(existing: unknown, status: IssueStatus, note: string): Array<Record<string, string>> {
  const history = Array.isArray(existing) ? [...(existing as Array<Record<string, string>>)] : [];
  history.push({
    at: new Date().toISOString(),
    status,
    source: 'detector',
    note,
  });
  return history;
}

export interface UpsertIssueOptions {
  // Run that produced this detection; stored so a stale issue can be
  // traced to the pass that last saw it.
  runId?: number | null;
  // Registered org domain for rollup views.
  orgDomain?: string | null;
}

export interface UpsertIssueResult {
  issue: ReportingIssue;
  // True only when a new row was inserted, false when an existing issue was
  // refreshed — so a run summary counts genuine new issues, not every upsert.
  created: boolean;
  // True when an existing resolved/ignored issue was brought back to open.
  reopened: boolean;
}

/**
 * Insert or refresh an issue, keyed on its fingerprint.
 *
 * A refresh always updates evidence, severity, title, description and
 * sender links, so list views never show numbers that are staler than the
 * last analysis run.
 */
export async function upsertIssue(
  domain: string,
  issueType: IssueType,
  severity: IssueSeverity,
  title: string,
  description: string,
  evidence: IssueEvidence,
  senderIds: number[] = [],
  options: UpsertIssueOptions = {}
): Promise<UpsertIssueResult> {
  const issueFingerprint = buildIssueFingerprint(domain, issueType, evidence, senderIds);
  const affectedSenders = evidence.senderIps ?? [];
  const affectedVolume = deriveAffectedVolume(evidence);
  const runId = options.runId ?? null;
  const orgDomain = options.orgDomain ?? null;
  const existing = await query<DbRow>(
    `SELECT * FROM reporting_issues
     WHERE issue_fingerprint = $1
     ORDER BY id DESC
     LIMIT 1`,
    [issueFingerprint]
  );

  if (existing.rows[0]) {
    const row = existing.rows[0];
    const snoozed = row.muted_until && new Date(row.muted_until as string) > new Date();
    const currentStatus = row.status as IssueStatus;
    // 'suppressed' is an operator-driven state (all contributing senders
    // approved). A detector re-firing must not silently flip it back to
    // open — only an explicit un-approval does that.
    const reopened =
      !snoozed && (currentStatus === 'resolved' || currentStatus === 'ignored');
    const nextStatus = reopened ? 'open' : currentStatus;
    const result = await query<DbRow>(
      `UPDATE reporting_issues
       SET severity = $2,
           title = $3,
           description = $4,
           evidence = $5::jsonb,
           sender_ids = $6::int[],
           affected_senders = $7::text[],
           affected_volume = $8::bigint,
           last_detected = CURRENT_TIMESTAMP,
            status = $9::varchar(20),
            resolved_at = CASE WHEN $9::text = 'open' THEN NULL ELSE resolved_at END,
            issue_fingerprint = $10,
            status_history = $11::jsonb,
            org_domain = COALESCE($12, org_domain),
            last_run_id = COALESCE($13, last_run_id)
        WHERE id = $1
        RETURNING *`,
      [
        row.id,
        severity,
        title,
        description,
        JSON.stringify(evidence),
        senderIds,
        affectedSenders,
        affectedVolume,
        nextStatus,
        issueFingerprint,
        JSON.stringify(
          nextIssueHistory(
            row.status_history,
            nextStatus,
            reopened ? 'reopened from detector evidence' : 'detector refreshed evidence'
          )
        ),
        orgDomain,
        runId,
      ]
    );
    return { issue: mapIssueRow(result.rows[0]), created: false, reopened };
  }

  const result = await query<DbRow>(
    `INSERT INTO reporting_issues (
       domain, issue_type, severity, title, description, evidence, issue_fingerprint,
       sender_ids, affected_senders, affected_volume, status_history,
       org_domain, first_run_id, last_run_id
     ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8::int[], $9::text[], $10::bigint, $11::jsonb,
       $12, $13, $13)
     RETURNING *`,
    [
      domain,
      issueType,
      severity,
      title,
      description,
      JSON.stringify(evidence),
      issueFingerprint,
      senderIds,
      affectedSenders,
      affectedVolume,
      JSON.stringify(nextIssueHistory([], 'open', 'detected')),
      orgDomain,
      runId,
    ]
  );
  return { issue: mapIssueRow(result.rows[0]), created: true, reopened: false };
}

/**
 * Get issues with optional filters.
 *
 * `includeSnoozed` defaults to false: snoozed issues (muted_until in the
 * future) are hidden from the default list so operators only see
 * actionable items. Set true for the snooze-management UI.
 *
 * `senderIds` filters to issues whose sender_ids overlaps the given set —
 * uses the GIN index, fast at any scale.
 */
export async function getIssues(
  filters: ReportingFilters & {
    includeSnoozed?: boolean;
    senderIds?: number[];
  } = {},
  options: { limit?: number; offset?: number } = {}
): Promise<{ issues: ReportingIssue[]; total: number }> {
  const { limit = 50, offset = 0 } = options;
  const { whereClause, params, nextParamIndex } = buildIssueWhereClause(filters);

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM reporting_issues ${whereClause}`,
    params
  );

  const dataParams = [...params, limit, offset];
  const result = await query<DbRow>(
    `SELECT * FROM reporting_issues ${whereClause}
     ORDER BY 
       ${ISSUE_SEVERITY_ORDER_SQL},
       last_detected DESC
     LIMIT $${nextParamIndex} OFFSET $${nextParamIndex + 1}`,
    dataParams
  );

  return {
    issues: result.rows.map(mapIssueRow),
    total: parseInt(countResult.rows[0]?.count ?? '0', 10),
  };
}

/**
 * Domains that have at least one TLSRPT report in the last N days.
 * Scopes the TlsIntelligence page's left-nav to domains with transport-security
 * data instead of every domain in the system.
 */
export async function getTlsrptDomains(days: number = 30): Promise<string[]> {
  const result = await query<{ domain: string }>(
    `SELECT DISTINCT domain FROM (
       SELECT p.policy_domain AS domain
       FROM tlsrpt_policies p
       JOIN tlsrpt_reports r ON p.report_id = r.id
       WHERE r.date_begin >= CURRENT_DATE - INTERVAL '1 day' * $1
       UNION
       SELECT d.domain
       FROM domain_health d
       WHERE d.snapshot_date >= CURRENT_DATE - INTERVAL '1 day' * $1
       UNION
       SELECT r.domain
       FROM dmarc_reports r
       WHERE r.date_begin >= CURRENT_DATE - INTERVAL '1 day' * $1
     ) domains
     WHERE domain IS NOT NULL AND domain <> ''
     ORDER BY domain`,
    [days]
  );
  return result.rows.map((r) => r.domain);
}

/**
 * Get issue counts by severity.
 */
export async function getIssueCounts(): Promise<Record<IssueSeverity, number>> {
  const result = await query<{ severity: IssueSeverity; count: string }>(
    `SELECT severity, COUNT(*) as count 
     FROM reporting_issues 
     WHERE status IN ('open', 'acknowledged', 'in_progress')
       AND (muted_until IS NULL OR muted_until <= NOW())
     GROUP BY severity`
  );

  const counts: Record<IssueSeverity, number> = {
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
  };

  for (const row of result.rows) {
    counts[row.severity] = parseInt(row.count, 10);
  }

  return counts;
}

function mapIssueRow(row: DbRow): ReportingIssue {
  return {
    id: row.id as number,
    domain: row.domain as string,
    orgDomain: (row.org_domain as string | null) ?? null,
    issueType: row.issue_type as IssueType,
    severity: row.severity as IssueSeverity,
    title: row.title as string,
    description: row.description as string | null,
    evidence: (row.evidence as IssueEvidence) || {},
    affectedSenders: (row.affected_senders as string[]) || [],
    affectedVolume: parseInt(row.affected_volume as string, 10) || 0,
    firstDetected: new Date(row.first_detected as string),
    lastDetected: new Date(row.last_detected as string),
    status: row.status as IssueStatus,
    resolvedAt: row.resolved_at ? new Date(row.resolved_at as string) : null,
    resolutionNotes: row.resolution_notes as string | null,
    mutedUntil: row.muted_until ? new Date(row.muted_until as string) : null,
    senderIds: (row.sender_ids as number[]) ?? [],
    relatedIssueIds: (row.related_issue_ids as number[]) ?? [],
    createdAt: new Date(row.created_at as string),
  };
}

// =============================================================================
// REMEDIATION SUGGESTIONS
// =============================================================================

/**
 * Create a remediation suggestion.
 */
export async function createRemediation(
  suggestion: Omit<RemediationSuggestion, 'id' | 'createdAt'>
): Promise<RemediationSuggestion> {
  if (suggestion.issueId != null) {
    const existing = await query<DbRow>(
      `SELECT * FROM remediation_suggestions
       WHERE issue_id = $1 AND suggestion_type = $2
       ORDER BY id DESC
       LIMIT 1`,
      [suggestion.issueId, suggestion.suggestionType]
    );

    if (existing.rows[0]) {
      const result = await query<DbRow>(
        `UPDATE remediation_suggestions
         SET domain = $2,
             priority = $3,
             title = $4,
             description = $5,
             action_steps = $6::jsonb,
             dns_changes = $7::jsonb,
             verification_steps = $8::jsonb,
             estimated_impact = $9
         WHERE id = $1
         RETURNING *`,
        [
          existing.rows[0].id,
          suggestion.domain,
          suggestion.priority,
          suggestion.title,
          suggestion.description,
          JSON.stringify(suggestion.actionSteps),
          JSON.stringify(suggestion.dnsChanges),
          JSON.stringify(suggestion.verificationSteps),
          suggestion.estimatedImpact ?? null,
        ]
      );
      return mapRemediationRow(result.rows[0]);
    }
  }

  const result = await query<DbRow>(
    `INSERT INTO remediation_suggestions (
      issue_id, domain, suggestion_type, priority, title, description,
      action_steps, dns_changes, verification_steps, estimated_impact
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
    RETURNING *`,
    [
      suggestion.issueId ?? null,
      suggestion.domain,
      suggestion.suggestionType,
      suggestion.priority,
      suggestion.title,
      suggestion.description,
      JSON.stringify(suggestion.actionSteps),
      JSON.stringify(suggestion.dnsChanges),
      JSON.stringify(suggestion.verificationSteps),
      suggestion.estimatedImpact ?? null,
    ]
  );
  return mapRemediationRow(result.rows[0]);
}

function mapRemediationRow(row: DbRow): RemediationSuggestion {
  return {
    id: row.id as number,
    issueId: row.issue_id as number | null,
    domain: row.domain as string,
    suggestionType: row.suggestion_type as string,
    priority: row.priority as number,
    title: row.title as string,
    description: row.description as string,
    actionSteps: (row.action_steps as ActionStep[]) || [],
    dnsChanges: (row.dns_changes as DnsChange[]) || [],
    verificationSteps: (row.verification_steps as VerificationStep[]) || [],
    estimatedImpact: row.estimated_impact as string | null,
    createdAt: new Date(row.created_at as string),
  };
}
