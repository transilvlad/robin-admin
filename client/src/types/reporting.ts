/**
 * Reporting v2 types — mirrors the server's taxonomy exactly.
 *
 * These deliberately duplicate the server shapes rather than deriving looser
 * client-side ones. The whole point of the rebuild is that a number on screen
 * is the same number the server computed, so the client never re-derives a
 * compliance figure or re-classifies a record.
 */

export type ComplianceClass = 'compliant' | 'authenticated_unaligned' | 'failed';

export type ComplianceDetail =
  | 'fully_aligned'
  | 'dkim_aligned'
  | 'spf_aligned'
  | 'dkim_authenticated'
  | 'spf_authenticated'
  | 'unauthenticated';

export type FailureReason =
  | 'forwarded'
  | 'trusted_forwarder'
  | 'mailing_list'
  | 'sampled_out'
  | 'local_policy'
  | 'other'
  | 'none';

export interface TaxonomyBreakdown {
  totalVolume: number;
  compliantVolume: number;
  fullyAlignedVolume: number;
  dkimAlignedVolume: number;
  spfAlignedVolume: number;
  authenticatedUnalignedVolume: number;
  dkimAuthenticatedVolume: number;
  spfAuthenticatedVolume: number;
  failedVolume: number;
  benignRelayVolume: number;
  actionableFailureVolume: number;
  byReason: Record<FailureReason, number>;
}

/**
 * The window the figures describe, plus the true extent of the data.
 *
 * `dataAgeDays` and `stale` let the UI distinguish stale report data from a
 * genuinely clean current window.
 */
export interface TimeframeInfo {
  from: string;
  to: string;
  dataFrom: string | null;
  dataTo: string | null;
  dataAgeDays: number | null;
  empty: boolean;
  stale: boolean;
  defaulted: boolean;
}

export type SourceBucket = 'capable' | 'non_compliant' | 'forwarder' | 'threat_unknown';
export type SourceReviewState = 'pending' | 'authorized' | 'forwarder' | 'threat';
export type SourceIdentityKind = 'provider' | 'rdns_domain' | 'network' | 'address';

export interface SourceAggregate {
  key: string;
  displayName: string;
  identityKind: SourceIdentityKind;
  provider: string | null;
  providerCategory: string | null;
  ips: string[];
  ipCount: number;
  ptr: string | null;
  fcrdnsVerified: boolean;
  authDocsUrl: string | null;
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
  dkimRate: number;
  spfRate: number;
  domains: string[];
  domainCount: number;
  reviewState: SourceReviewState;
  reviewNote: string | null;
  bucket: SourceBucket;
  firstSeen: string | null;
  lastSeen: string | null;
}

export interface DomainAggregate {
  domain: string;
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
  sourceCount: number;
  reportCount: number;
  policy: string | null;
  lastReportAt: string | null;
}

export interface ReporterAggregate {
  reporter: string;
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
  reportCount: number;
}

export interface TrendPoint {
  date: string;
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
}

export interface AggregateTotals {
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
  domainCount: number;
  sourceCount: number;
  reportCount: number;
  reporterCount: number;
}

export type SourceBucketCounts = Record<SourceBucket | 'all', number>;

export interface ReportingOverview {
  timeframe: TimeframeInfo;
  totals: AggregateTotals;
  sourceBuckets: SourceBucketCounts;
  topSources: SourceAggregate[];
  topDomains: DomainAggregate[];
  trend: TrendPoint[];
  reporters: ReporterAggregate[];
}

export interface DomainWorkspace {
  timeframe: TimeframeInfo;
  domain: DomainAggregate;
  sources: SourceAggregate[];
  trend: TrendPoint[];
  reporters: ReporterAggregate[];
}

export interface RecordClassification {
  class: ComplianceClass;
  detail: ComplianceDetail;
  reason: FailureReason;
  benignRelay: boolean;
}

export interface RecordRow {
  id: number;
  domain: string;
  sourceIp: string;
  count: number;
  disposition: string | null;
  dkim: string | null;
  spf: string | null;
  dkimResult: string | null;
  spfResult: string | null;
  dkimDomain: string | null;
  dkimSelector: string | null;
  spfDomain: string | null;
  headerFrom: string | null;
  envelopeFrom: string | null;
  reasonType: string | null;
  reporter: string | null;
  reportId: number;
  dateBegin: string | null;
  dateEnd: string | null;
  classification: RecordClassification;
}

export type DomainSort = 'volume' | 'compliance' | 'actionable' | 'domain';
export type SourceSort = 'volume' | 'compliance' | 'actionable' | 'domains' | 'name';
export type RecordSort = 'volume' | 'date' | 'domain' | 'source';
export type SortDirection = 'asc' | 'desc';

/** Query parameters shared by every v2 endpoint. */
export interface TimeframeQuery {
  from?: string;
  to?: string;
  days?: number;
  domain?: string;
  sourceIp?: string;
  reporter?: string;
}

export const SOURCE_BUCKET_LABELS: Record<SourceBucket, string> = {
  capable: 'DMARC capable',
  non_compliant: 'Non-compliant',
  forwarder: 'Forwarders',
  threat_unknown: 'Threat / Unknown',
};

export const SOURCE_BUCKET_HINTS: Record<SourceBucket, string> = {
  capable: 'Sending compliant mail. Nothing to do.',
  non_compliant: 'Recognised senders failing DMARC. This is the work.',
  forwarder: 'Failing only because the receiver forwarded the message. Benign.',
  threat_unknown: 'Failing, unrecognised and unapproved. Investigate.',
};

export const COMPLIANCE_CLASS_LABELS: Record<ComplianceClass, string> = {
  compliant: 'DMARC compliant',
  authenticated_unaligned: 'Authenticated, not aligned',
  failed: 'Failed',
};

export const FAILURE_REASON_LABELS: Record<FailureReason, string> = {
  forwarded: 'Forwarded',
  trusted_forwarder: 'Trusted forwarder',
  mailing_list: 'Mailing list',
  sampled_out: 'Sampled out',
  local_policy: 'Local policy',
  other: 'Other',
  none: 'No reason given',
};

// =============================================================================
// ISSUE TAXONOMY
// =============================================================================

export type IssueSeverity = 'critical' | 'high' | 'medium' | 'low' | 'info';

// 'suppressed' — the condition still holds, but every contributing sender
// has been approved by an operator. Deliberately distinct from 'resolved'
// so approved-sender suppressions stay visible instead of showing a green
// tick over a live problem.
export type IssueStatus =
  | 'open'
  | 'acknowledged'
  | 'in_progress'
  | 'resolved'
  | 'ignored'
  | 'suppressed';

// Operator decision about a sender, durable across analysis runs.
// Distinct from the mute timer, which is temporary noise suppression.
export type SenderReviewState = 'pending' | 'approved' | 'rejected';

export type IssueType =
  | 'dmarc_none_policy'
  | 'dmarc_low_pct'
  | 'dmarc_subdomain_policy_gap'
  | 'spf_alignment_failure'
  | 'dkim_alignment_failure'
  | 'unknown_sender'
  | 'spoofing_detected'
  | 'vendor_misconfigured'
  | 'misconfigured_sender'
  | 'volume_anomaly'
  | 'tls_certificate_error'
  | 'tls_hostname_mismatch'
  | 'tls_policy_failure'
  | 'mta_sts_missing'
  | 'mta_sts_invalid'
  | 'mta_sts_testing'
  | 'dane_missing'
  | 'forensic_spike'
  | 'repeated_auth_failure'
  | 'bimi_missing'
  | 'reports_missing'
  | 'blocklist_detected'
  | 'reputation_degraded';

export interface IssueEvidence {
  // Source data references — the path back to the raw report rows that
  // produced this issue. Populated by every detector that derives from
  // report data so the UI can offer "View source report".
  reportIds?: number[];
  sourceReports?: SourceReportRef[];
  senderIps?: string[];
  // Sample data
  samples?: Record<string, unknown>[];
  // Metrics that triggered the issue
  metrics?: Record<string, number | string>;
  // The threshold and window that made this issue fire.
  trigger?: IssueTrigger;
  // Comparison data for anomalies
  baseline?: Record<string, number>;
  current?: Record<string, number>;
  // Live DNS state at detection time — rendered by IssueDetailModal.
  spfRecord?: string | null;
  spfAuthorized?: { ipv4: string[]; ipv6: string[] };
  spfPermerror?: boolean;
  dmarcRecord?: string | null;
  dkimRecords?: Record<string, string>;
  dnsCheckedAt?: string;
  // Per-IP context joined from sender_inventory at detection time.
  unauthorizedIps?: Array<{
    ip: string;
    sourceHost: string | null;
    classification: string;
    provider?: string | null;
    reviewState?: SenderReviewState;
    totalVolume: number;
    failCount: number;
    passRate: number;
    mutedAt?: string | null;
    mutedUntil?: string | null;
    mutedReason?: string | null;
    reportIds?: number[];
  }>;
}

/**
 * A pointer back to the raw report row that produced a piece of evidence.
 * `id` is the database id used by the raw browsers' deep links
 * (`/dmarc?reportId=<id>`); `reportId` is the reporter's own identifier.
 */
export interface SourceReportRef {
  kind: 'dmarc' | 'tlsrpt' | 'forensic';
  id: number;
  reportId?: string | null;
  orgName?: string | null;
  dateBegin?: string | null;
  dateEnd?: string | null;
  sourceIp?: string | null;
  count?: number;
}

/**
 * Why this issue fired: the metric, the threshold it crossed, the window
 * examined, and how many consecutive analysis runs have observed it.
 */
export interface IssueTrigger {
  metric: string;
  value: number;
  threshold: number;
  comparator: '<' | '<=' | '>' | '>=' | '==' | '!=';
  windowStart?: string;
  windowEnd?: string;
  consecutiveRuns?: number;
  requiredRuns?: number;
}

export interface ReportingIssue {
  id: number;
  domain: string;
  orgDomain?: string | null;
  issueType: IssueType;
  severity: IssueSeverity;
  title: string;
  description: string | null;
  evidence: IssueEvidence;
  affectedSenders: string[];
  affectedVolume: number;
  firstDetected: string;
  lastDetected: string;
  status: IssueStatus;
  resolvedAt: string | null;
  resolutionNotes: string | null;
  // Snooze: ISO8601 in the future = currently snoozed.
  mutedUntil: string | null;
  // Contributing senders (FK array into sender_inventory).
  senderIds: number[];
  // Issues for the same (domain, sourceIp) seen by another report type.
  relatedIssueIds?: number[];
  // How many consecutive analysis runs have observed this condition.
  observationStreak?: number;
  createdAt: string;
}
