/**
 * Detection policy for reporting issues.
 *
 * Every detector in the reporting layer raises issues through this module
 * rather than calling `upsertIssue` directly, so the issue queue stays
 * trustworthy. It centralises three things:
 *
 *  - Named, tunable thresholds shared by every detector.
 *  - A persistence requirement, so a single window's blip (a forwarder
 *    retry storm) can't open an issue that looks like a real regression.
 *  - Auto-resolve grace, so an issue doesn't flap resolved, reopened,
 *    resolved as a condition clears and returns across consecutive runs.
 *
 * Persistence is measured in analysis runs (see db/queries/analysis-runs.ts):
 *
 *   STATISTICAL detectors (volume, rates, spikes) must be observed in
 *   `requiredRuns` consecutive runs before an issue is opened, and must be
 *   absent for `graceRuns` consecutive runs before being auto-resolved.
 *
 *   DETERMINISTIC detectors (p=none, pct<100, a missing DNS record) fire
 *   immediately. They are not statistical; a DMARC policy of `none` is
 *   not noise that might average out next window, and delaying it by a
 *   reporting cycle would simply be wrong.
 */

import {
  buildIssueFingerprint,
  upsertIssue,
  type UpsertIssueOptions,
} from '../db/queries/reporting.js';
import {
  countConsecutiveAbsences,
  countConsecutiveObservations,
  recordObservation,
  type RunCounters,
} from '../db/queries/analysis-runs.js';
import { query } from '../db/connection.js';
import type {
  AnalysisRunKind,
  IssueEvidence,
  IssueSeverity,
  IssueTrigger,
  IssueType,
  ReportingIssue,
} from '../types/reporting.js';

// ──────────────────────────────────────────────────────────────────────
// Tunables
// ──────────────────────────────────────────────────────────────────────

/**
 * Volume and rate gates for the statistical detectors.
 *
 * Defaults live here and persisted overrides are loaded from admin_config.
 */
export const DETECTION_THRESHOLDS = {
  /** Minimum volume from an unclassified sender before it is worth triage. */
  unknownSenderMinVolume: envInt('ROBIN_DETECT_UNKNOWN_MIN_VOLUME', 50),
  /** Minimum failed messages before a sender is treated as spoofing. */
  spoofingMinFailCount: envInt('ROBIN_DETECT_SPOOFING_MIN_FAILS', 100),
  /** Minimum volume before a failing sender counts as a misconfiguration. */
  misconfiguredMinVolume: envInt('ROBIN_DETECT_MISCONFIGURED_MIN_VOLUME', 1000),
  /** DMARC pass rate below which a domain is considered failing. */
  dmarcFailingPassRate: envFloat('ROBIN_DETECT_DMARC_FAIL_RATE', 0.95),
  /** TLS failure rate above which transport is considered degraded. */
  tlsFailureRate: envFloat('ROBIN_DETECT_TLS_FAILURE_RATE', 0.1),
  /** Minimum failed TLS connections before the failure rate is meaningful. */
  tlsMinFailures: envInt('ROBIN_DETECT_TLS_MIN_FAILURES', 10),
  /** Forensic reports in the recent half-window that constitute a spike. */
  forensicSpikeMultiplier: envFloat('ROBIN_DETECT_FORENSIC_SPIKE', 2),
  /** Minimum recent reports before a spike ratio is meaningful. */
  forensicSpikeMinRecent: envInt('ROBIN_DETECT_FORENSIC_SPIKE_MIN', 3),
  /** Occurrences before a forensic cluster is worth an issue. */
  forensicClusterMinOccurrences: envInt('ROBIN_DETECT_FORENSIC_CLUSTER_MIN', 2),
  /** Max forensic cluster issues raised per domain per run. */
  forensicClusterMaxIssues: envInt('ROBIN_DETECT_FORENSIC_CLUSTER_MAX', 10),
};

/** Consecutive runs a statistical condition must hold before opening. */
export let REQUIRED_RUNS = envInt('ROBIN_DETECT_REQUIRED_RUNS', 2);
/** Consecutive runs a condition must be absent before auto-resolving. */
export let GRACE_RUNS = envInt('ROBIN_DETECT_GRACE_RUNS', 2);

const DETECTION_CONFIG_KEYS = [
  'detectionUnknownSenderMinVolume',
  'detectionSpoofingMinFailCount',
  'detectionMisconfiguredMinVolume',
  'detectionDmarcFailingPassRate',
  'detectionTlsFailureRate',
  'detectionTlsMinFailures',
  'detectionForensicSpikeMultiplier',
  'detectionForensicSpikeMinRecent',
  'detectionForensicClusterMinOccurrences',
  'detectionForensicClusterMaxIssues',
  'detectionRequiredRuns',
  'detectionGraceRuns',
];

export async function loadDetectionPolicy(): Promise<void> {
  const result = await query<{ key: string; value: string }>(
    'SELECT key, value FROM admin_config WHERE key = ANY($1::text[])',
    [DETECTION_CONFIG_KEYS]
  );
  for (const row of result.rows) {
    const number = Number(row.value);
    if (!Number.isFinite(number)) continue;
    switch (row.key) {
      case 'detectionUnknownSenderMinVolume':
        DETECTION_THRESHOLDS.unknownSenderMinVolume = number;
        break;
      case 'detectionSpoofingMinFailCount':
        DETECTION_THRESHOLDS.spoofingMinFailCount = number;
        break;
      case 'detectionMisconfiguredMinVolume':
        DETECTION_THRESHOLDS.misconfiguredMinVolume = number;
        break;
      case 'detectionDmarcFailingPassRate':
        DETECTION_THRESHOLDS.dmarcFailingPassRate = number;
        break;
      case 'detectionTlsFailureRate':
        DETECTION_THRESHOLDS.tlsFailureRate = number;
        break;
      case 'detectionTlsMinFailures':
        DETECTION_THRESHOLDS.tlsMinFailures = number;
        break;
      case 'detectionForensicSpikeMultiplier':
        DETECTION_THRESHOLDS.forensicSpikeMultiplier = number;
        break;
      case 'detectionForensicSpikeMinRecent':
        DETECTION_THRESHOLDS.forensicSpikeMinRecent = number;
        break;
      case 'detectionForensicClusterMinOccurrences':
        DETECTION_THRESHOLDS.forensicClusterMinOccurrences = number;
        break;
      case 'detectionForensicClusterMaxIssues':
        DETECTION_THRESHOLDS.forensicClusterMaxIssues = number;
        break;
      case 'detectionRequiredRuns':
        REQUIRED_RUNS = number;
        break;
      case 'detectionGraceRuns':
        GRACE_RUNS = number;
        break;
    }
  }
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Issue types whose condition is a direct reading of configuration rather
 * than a statistical aggregate. These bypass the persistence gate.
 *
 * If in doubt, ask: "could this condition be true this window and false
 * next window purely because of which reports happened to arrive?" If no,
 * it belongs here.
 */
export const DETERMINISTIC_ISSUE_TYPES = new Set<IssueType>([
  'dmarc_none_policy',
  'dmarc_low_pct',
  'dmarc_subdomain_policy_gap',
  'bimi_missing',
  'mta_sts_missing',
  'mta_sts_invalid',
  'mta_sts_testing',
  'dane_missing',
  'reports_missing',
]);

export function isDeterministic(issueType: IssueType): boolean {
  return DETERMINISTIC_ISSUE_TYPES.has(issueType);
}

// ──────────────────────────────────────────────────────────────────────
// Detection context
// ──────────────────────────────────────────────────────────────────────

export interface DetectionContext {
  kind: AnalysisRunKind;
  runId: number | null;
  windowStart: Date;
  windowEnd: Date;
  counters: RunCounters;
}

export interface RaiseIssueInput {
  domain: string;
  orgDomain?: string | null;
  issueType: IssueType;
  severity: IssueSeverity;
  title: string;
  description: string;
  evidence: IssueEvidence;
  senderIds?: number[];
  /**
   * The measurement that crossed a threshold. Stored on the issue so the
   * detail UI can explain "why am I seeing this" without the operator
   * having to read detector source.
   */
  trigger?: Omit<IssueTrigger, 'windowStart' | 'windowEnd' | 'consecutiveRuns' | 'requiredRuns'>;
  /** Override the default persistence requirement for this detector. */
  requiredRuns?: number;
}

export interface RaiseIssueResult {
  issue: ReportingIssue | null;
  /** True when the condition was recorded but is not yet persistent. */
  pending: boolean;
  created: boolean;
  streak: number;
}

/**
 * Record a detector firing and open/refresh the issue if it is
 * significant enough.
 *
 * Always records an observation, even when the issue is withheld — that
 * record is what allows the *next* run to see a streak of two.
 */
export async function raiseIssue(
  ctx: DetectionContext,
  input: RaiseIssueInput
): Promise<RaiseIssueResult> {
  const senderIds = input.senderIds ?? [];
  const fingerprint = buildIssueFingerprint(
    input.domain,
    input.issueType,
    input.evidence,
    senderIds
  );

  await recordObservation({
    fingerprint,
    runId: ctx.runId,
    domain: input.domain,
    issueType: input.issueType,
    severity: input.severity,
    windowStart: ctx.windowStart,
    windowEnd: ctx.windowEnd,
    metrics: input.evidence.metrics,
  });

  const deterministic = isDeterministic(input.issueType);
  const required = deterministic ? 1 : input.requiredRuns ?? REQUIRED_RUNS;
  const streak = deterministic
    ? 1
    : await countConsecutiveObservations(fingerprint, ctx.kind);

  // An already-open issue keeps being refreshed regardless of streak —
  // withholding a refresh would leave stale numbers on screen, which is
  // the opposite of what the persistence gate is for.
  const alreadyTracked = await issueExists(fingerprint);

  if (!alreadyTracked && streak < required) {
    ctx.counters.issuesPending++;
    return { issue: null, pending: true, created: false, streak };
  }

  const evidence: IssueEvidence = {
    ...input.evidence,
    trigger: input.trigger
      ? {
          ...input.trigger,
          windowStart: ctx.windowStart.toISOString(),
          windowEnd: ctx.windowEnd.toISOString(),
          consecutiveRuns: streak,
          requiredRuns: required,
        }
      : input.evidence.trigger,
  };

  const options: UpsertIssueOptions = {
    runId: ctx.runId,
    orgDomain: input.orgDomain ?? null,
  };

  const result = await upsertIssue(
    input.domain,
    input.issueType,
    input.severity,
    input.title,
    input.description,
    evidence,
    senderIds,
    options
  );

  if (result.created) ctx.counters.issuesOpened++;
  else ctx.counters.issuesRefreshed++;

  return { issue: result.issue, pending: false, created: result.created, streak };
}

async function issueExists(fingerprint: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM reporting_issues
       WHERE issue_fingerprint = $1
         AND status IN ('open', 'acknowledged', 'in_progress', 'suppressed')
     ) AS exists`,
    [fingerprint]
  );
  return result.rows[0]?.exists === true;
}

/**
 * Auto-resolve issues of the given types for a domain whose condition has
 * now been absent for `GRACE_RUNS` consecutive runs.
 *
 * The grace period is the whole point: resolving on the first clean run
 * caused issues to flap, which trained operators to ignore status
 * entirely. `resolutionNotes` records how many runs were checked so the
 * closure is auditable.
 */
export async function autoResolveClearedIssues(
  ctx: DetectionContext,
  domain: string,
  issueTypes: IssueType[],
  reason: string
): Promise<number> {
  if (issueTypes.length === 0) return 0;

  const open = await query<{ id: number; issue_fingerprint: string }>(
    `SELECT id, issue_fingerprint FROM reporting_issues
     WHERE domain = $1
       AND issue_type = ANY($2::text[])
       AND status IN ('open', 'acknowledged', 'in_progress')`,
    [domain, issueTypes]
  );
  if (open.rows.length === 0) return 0;

  const resolvable: number[] = [];
  for (const row of open.rows) {
    const absences = await countConsecutiveAbsences(row.issue_fingerprint, ctx.kind);
    if (absences >= GRACE_RUNS) resolvable.push(row.id);
  }
  if (resolvable.length === 0) return 0;

  const result = await query(
    `UPDATE reporting_issues
     SET status = 'resolved',
         resolved_at = NOW(),
         resolution_notes = $2::text,
         status_history = COALESCE(status_history, '[]'::jsonb) || jsonb_build_array(
           jsonb_build_object(
             'at', CURRENT_TIMESTAMP,
             'status', 'resolved',
             'source', 'detector',
             'note', $3::text
           )
         )
     WHERE id = ANY($1::int[])`,
    [
      resolvable,
      reason,
      `Auto-resolved after ${GRACE_RUNS} consecutive analysis runs without the condition.`,
    ]
  );

  const resolved = result.rowCount ?? 0;
  ctx.counters.issuesResolved += resolved;
  return resolved;
}
