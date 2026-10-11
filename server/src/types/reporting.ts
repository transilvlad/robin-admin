/**
 * Reporting Intelligence Types
 * 
 * Type definitions for the unified reporting and deliverability intelligence layer.
 * These types correspond to the reporting_* and sender_inventory tables in schema.ts.
 */

// =============================================================================
// SENDER CLASSIFICATION
// =============================================================================

// Sender classification taxonomy. Derived at analysis time from a mix of
// FCrDNS-verified rDNS, live SPF expansion, and the report's own
// auth_results. See services/sender-enrichment.ts for the algorithm.
//
// Order matters in classifySender() — earlier categories take precedence
// over later ones when multiple signals match.
export type SenderClassification =
  | 'own_server'           // FCrDNS-verified hostname shares an organizational domain with the report domain (PSL-based match)
  | 'authorized'           // Source IP appears in the report domain's SPF record (pass or softfail)
  | 'forwarder'            // DKIM-aligned pass + SPF doesn't authorize this IP — typical compliant forwarder
  | 'suspicious_forwarder' // Forwarder pattern (DKIM signed for the report domain) but DKIM failed — broken or spoofing-as-forwarder
  | 'misconfigured'        // High-volume sender for the domain that fails alignment
  | 'unknown'              // None of the above — potential spoofer, manual review needed
  | 'trusted'              // Operator-promoted authorized sender (never auto-assigned)
  | 'suspicious'           // Operator-flagged for investigation (never auto-assigned)
  | 'spoofing';            // Operator-confirmed spoofing attempt (never auto-assigned)

export interface SenderInventoryItem {
  id: number;
  domain: string;
  sourceIp: string;
  sourceHost: string | null;
  classification: SenderClassification;
  confidence: number;  // 0-1 confidence in classification
  firstSeen: Date;
  lastSeen: Date;
  totalVolume: number;
  passCount: number;
  failCount: number;
  spfAligned: number;
  dkimAligned: number;
  // TLS failure count from TLSRPT — failed inbound TLS sessions where
  // this IP was the sending MTA delivering to our MX. Distinct from
  // DMARC failCount (which is auth failures, not transport).
  tlsFailureCount: number;
  notes: string | null;
  // Mute state — when mutedAt is set, detectIssues() ignores this sender
  // for the (domain, sourceIp) pair. mutedUntil null = permanent.
  // Prefer reviewState for durable decisions; mute is a snooze timer.
  mutedAt: Date | null;
  mutedBy: string | null;
  mutedReason: string | null;
  mutedUntil: Date | null;
  // Durable operator decision. Drives detector behaviour: approved
  // senders suppress class issues and get remediation instead; rejected
  // senders escalate.
  reviewState: SenderReviewState;
  reviewStateBy: string | null;
  reviewStateAt: Date | null;
  reviewStateReason: string | null;
  // Resolved ESP/provider name from the curated catalogue, e.g.
  // "Google Workspace". Null when the source is unrecognised.
  provider: string | null;
  // Registered organizational domain of the report domain.
  orgDomain: string | null;
  updatedAt: Date;
}

export interface SenderStats {
  classification: SenderClassification;
  count: number;
  volume: number;
}

// =============================================================================
// DOMAIN HEALTH
// =============================================================================

export interface DomainHealth {
  id: number;
  domain: string;
  // Registered organizational domain — subdomains roll up to this.
  orgDomain: string | null;
  snapshotDate: Date;
  // DMARC metrics
  dmarcPolicy: string | null;
  dmarcPct: number | null;
  // Subdomain policy (sp=) from the DMARC record. A domain at p=reject
  // with sp=none leaves every subdomain unprotected.
  subdomainPolicy: string | null;
  dmarcPassRate: number;
  dmarcVolume: number;
  spfPassRate: number;
  dkimPassRate: number;
  alignmentRate: number;
  // The headline KPI: aligned-pass volume / total reported volume.
  // Computed by a single shared helper so every surface agrees.
  complianceRate: number;
  // Volume from senders still classified unknown and pending review —
  // measures how much triage work is outstanding.
  unidentifiedVolume: number;
  // Transport security
  tlsSuccessRate: number;
  tlsVolume: number;
  mtaStsMode: string | null;
  mtaStsDnsRecordCurrent: string | null;
  mtaStsPolicyCurrent: string | null;
  tlsRptRecordCurrent: string | null;
  bimiRecordCurrent: string | null;
  // Forensic summary
  forensicCount: number;
  // Risk scoring
  riskScore: number;  // 0-100, higher = worse
  riskFactors: RiskFactor[];
  // Change tracking
  volumeChangePct: number;
  passRateChange: number;
  // Live DNS state captured by analyzeDmarcIntelligence at snapshot time.
  // Lets the issue detail UI render the *real* current SPF/DKIM/DMARC
  // records instead of a templated example.
  spfRecordCurrent: string | null;
  dmarcRecordCurrent: string | null;
  dkimRecordsCurrent: Record<string, string>;
  spfAuthorizedIps: { ipv4?: string[]; ipv6?: string[] };
  spfPermerror: boolean;
  dnsCheckedAt: Date | null;
  createdAt: Date;
}

export interface RiskFactor {
  type: string;
  severity: IssueSeverity;
  description: string;
  weight: number;
  // Concrete metric basis so the UI can show "< 95%, currently 89.5%"
  // instead of just the prose description. Present when a metric drives it.
  basis?: {
    metric: string;
    value: number;
    threshold: number;
    comparator: '<' | '<=' | '>' | '>=' | '==' | '!=';
  };
}

export interface DomainSummary {
  domain: string;
  orgDomain?: string | null;
  latestHealth: DomainHealth | null;
  openIssueCount: number;
  criticalIssueCount: number;
  trend: 'improving' | 'stable' | 'degrading' | 'unknown';
}

/**
 * A registered org domain plus the subdomains that reported under it.
 * DMARC aggregate reports arrive per header-from domain, so without this
 * rollup a single organizational domain fragments across many rows.
 */
export interface OrgDomainSummary {
  orgDomain: string;
  domains: DomainSummary[];
  totalVolume: number;
  complianceRate: number;
  unidentifiedVolume: number;
  openIssueCount: number;
  criticalIssueCount: number;
  worstRiskScore: number;
  lastAnalyzedAt: Date | null;
}

export type AnalysisRunKind = 'dmarc' | 'tlsrpt' | 'forensic';

export interface AnalysisRunSummary {
  id: number;
  kind: AnalysisRunKind;
  windowStart: Date;
  windowEnd: Date;
  startedAt: Date;
  finishedAt: Date | null;
  domainsProcessed: number;
  issuesOpened: number;
  issuesRefreshed: number;
  issuesResolved: number;
  // Conditions observed but not yet persistent enough to open an issue.
  issuesPending: number;
  status: 'running' | 'completed' | 'failed';
  error: string | null;
}

export interface ForensicClusterRecord {
  id: number;
  domain: string;
  sourceIp: string;
  authFailure: string;
  occurrenceCount: number;
  actionableCount: number;
  firstSeen: Date;
  lastSeen: Date;
  subjects: string[];
  senders: string[];
  reportIds: number[];
}

/**
 * Per-reporter coverage for a domain. A missing or stale reporter is
 * itself a finding — derived numbers are only as good as the reports
 * that arrived.
 */
export interface ReportCoverageEntry {
  kind: AnalysisRunKind;
  reporter: string;
  reportCount: number;
  firstReceived: Date | null;
  lastReceived: Date | null;
  lastWindowEnd: Date | null;
  daysSinceLast: number | null;
  stale: boolean;
}

export interface DomainReportCoverage {
  domain: string;
  windowStart: Date;
  windowEnd: Date;
  entries: ReportCoverageEntry[];
  expectedDailyReports: boolean;
  gapDays: number;
  /** Newest aggregate report ever received, ignoring the analysis window. */
  lastReportAt: Date | null;
  /** Total aggregate reports ever received for this domain. */
  lifetimeReportCount: number;
}

// =============================================================================
// ISSUES AND REMEDIATION
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
  // DMARC issues
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
  // TLSRPT issues
  | 'tls_certificate_error'
  | 'tls_hostname_mismatch'
  | 'tls_policy_failure'
  | 'mta_sts_missing'
  | 'mta_sts_invalid'
  | 'mta_sts_testing'
  | 'dane_missing'
  // Forensic issues
  | 'forensic_spike'
  | 'repeated_auth_failure'
  // External signals
  | 'bimi_missing'
  | 'reports_missing'
  | 'blocklist_detected'
  | 'reputation_degraded';

export interface IssueSenderGroup {
  senderId: number;
  sourceIp: string;
  sourceHost: string | null;
  orgName: string | null;
  primaryDomain: string;
  domains: string[];
  issueCount: number;
  issueIds: number[];
  issueTypes: IssueType[];
  highestSeverity: IssueSeverity;
  totalAffectedVolume: number;
  mutedAt: Date | null;
  mutedUntil: Date | null;
  mutedReason: string | null;
}

export interface IssueDomainGroup {
  domain: string;
  issueCount: number;
  criticalIssueCount: number;
  issueIds: number[];
  issueTypes: IssueType[];
  highestSeverity: IssueSeverity;
  totalAffectedVolume: number;
}

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
  // The threshold and window that made this issue fire, so the detail UI
  // can answer "why am I seeing this?" without reading the detector code.
  trigger?: IssueTrigger;
  // Comparison data for anomalies
  baseline?: Record<string, number>;
  current?: Record<string, number>;
  // Live DNS state at the moment the issue was detected/refreshed.
  // Populated for SPF/DKIM/DMARC issue types so the detail UI can show
  // the *real* current configuration instead of a templated example.
  spfRecord?: string | null;
  spfAuthorized?: { ipv4: string[]; ipv6: string[] };
  spfPermerror?: boolean;
  dmarcRecord?: string | null;
  dkimRecords?: Record<string, string>;  // selector → TXT
  dnsCheckedAt?: string;  // ISO8601
  // Per-IP context joined from sender_inventory at detection time.
  // Lets the detail UI render rDNS/classification/volume without a
  // second round-trip and without re-doing FCrDNS lookups.
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
 * Rendered verbatim in the issue detail UI so a detection is explainable
 * without reading detector source.
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
  // Registered organizational domain for `domain`, so subdomain issues
  // roll up to the parent in list views.
  orgDomain?: string | null;
  issueType: IssueType;
  severity: IssueSeverity;
  title: string;
  description: string | null;
  evidence: IssueEvidence;
  affectedSenders: string[];
  affectedVolume: number;
  firstDetected: Date;
  lastDetected: Date;
  status: IssueStatus;
  resolvedAt: Date | null;
  resolutionNotes: string | null;
  // Snooze: when set and in the future, hidden from default lists and
  // the detector won't re-open. NULL = not snoozed.
  mutedUntil: Date | null;
  // FK array into sender_inventory.id — contributing senders so the
  // detail UI can render real IPs/rDNS/classifications.
  senderIds: number[];
  // Issues for the same (domain, sourceIp) raised by another report type.
  relatedIssueIds?: number[];
  // Consecutive analysis runs in which this condition was observed.
  observationStreak?: number;
  createdAt: Date;
}

export interface RemediationSuggestion {
  id: number;
  issueId: number | null;
  domain: string;
  suggestionType: string;
  priority: number;
  title: string;
  description: string;
  actionSteps: ActionStep[];
  dnsChanges: DnsChange[];
  verificationSteps: VerificationStep[];
  estimatedImpact: string | null;
  createdAt: Date;
}

export interface ActionStep {
  order: number;
  action: string;
  details?: string;
}

export interface DnsChange {
  recordType: string;
  name: string;
  currentValue?: string;
  suggestedValue: string;
  reason: string;
}

export interface VerificationStep {
  order: number;
  description: string;
  expectedOutcome: string;
  waitDays?: number;
}

// =============================================================================
// EXTERNAL DELIVERABILITY SIGNALS
// =============================================================================

export type SignalType = 
  | 'blocklist'
  | 'reputation'
  | 'postmaster'
  | 'inbox_placement';

export type SignalStatus = 'clean' | 'warning' | 'listed' | 'error' | 'unknown';

export interface DeliverabilitySignal {
  id: number;
  domain: string;
  signalType: SignalType;
  source: string;
  checkTime: Date;
  status: SignalStatus;
  details: Record<string, unknown>;
  rawResponse?: Record<string, unknown>;
  createdAt: Date;
}

// =============================================================================
// REPORTING OVERVIEW
// =============================================================================

export interface ReportingOverview {
  // Time range
  dateRange: {
    start: Date;
    end: Date;
  };
  // Summary counts
  totalDomains: number;
  totalVolume: number;
  // Issue summary
  issuesBySeverity: Record<IssueSeverity, number>;
  openIssueCount: number;
  resolvedIssueCount: number;
  // Health summary
  avgPassRate: number;
  avgTlsSuccessRate: number;
  // Top items
  topDomainsByVolume: DomainSummary[];
  topDomainsByRisk: DomainSummary[];
  recentIssues: ReportingIssue[];
  // Sender breakdown
  senderStats: SenderStats[];
}

export interface ReportingFilters {
  domains?: string[];
  dateStart?: Date;
  dateEnd?: Date;
  issueTypes?: IssueType[];
  severities?: IssueSeverity[];
  statuses?: IssueStatus[];
  classifications?: SenderClassification[];
}
