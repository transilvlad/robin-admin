/**
 * Analysis Run Tracking
 *
 * Every detector pass is recorded as a run with an explicit window. Two
 * things depend on this:
 *
 *  1. **Provenance.** Any derived number can be traced to "computed by
 *     run N over <window>", which is what the staleness indicators in the
 *     UI render.
 *  2. **Significance.** Statistical detectors must see a condition hold
 *     across consecutive runs before opening an issue, and must see it
 *     absent across consecutive runs before auto-resolving. Neither is
 *     expressible without a persisted notion of a run, which is why this
 *     module is the foundation the rest of the detection work sits on.
 *
 * Deterministic configuration findings (p=none, pct<100, missing records)
 * deliberately bypass the persistence gate — they are not statistical and
 * delaying them by a reporting cycle would be wrong.
 */

import { query } from '../connection.js';
import type {
  AnalysisRunKind,
  AnalysisRunSummary,
  IssueSeverity,
  IssueType,
} from '../../types/reporting.js';

type DbRow = Record<string, unknown>;

export interface RunCounters {
  domainsProcessed: number;
  issuesOpened: number;
  issuesRefreshed: number;
  issuesResolved: number;
  issuesPending: number;
}

export function emptyCounters(): RunCounters {
  return {
    domainsProcessed: 0,
    issuesOpened: 0,
    issuesRefreshed: 0,
    issuesResolved: 0,
    issuesPending: 0,
  };
}

function mapRun(row: DbRow): AnalysisRunSummary {
  return {
    id: row.id as number,
    kind: row.kind as AnalysisRunKind,
    windowStart: new Date(row.window_start as string),
    windowEnd: new Date(row.window_end as string),
    startedAt: new Date(row.started_at as string),
    finishedAt: row.finished_at ? new Date(row.finished_at as string) : null,
    domainsProcessed: Number(row.domains_processed ?? 0),
    issuesOpened: Number(row.issues_opened ?? 0),
    issuesRefreshed: Number(row.issues_refreshed ?? 0),
    issuesResolved: Number(row.issues_resolved ?? 0),
    issuesPending: Number(row.issues_pending ?? 0),
    status: row.status as AnalysisRunSummary['status'],
    error: (row.error as string | null) ?? null,
  };
}

export async function startAnalysisRun(
  kind: AnalysisRunKind,
  windowStart: Date,
  windowEnd: Date
): Promise<number> {
  const result = await query<DbRow>(
    `INSERT INTO reporting_analysis_runs (kind, window_start, window_end)
     VALUES ($1, $2, $3)
     RETURNING id`,
    [kind, windowStart.toISOString(), windowEnd.toISOString()]
  );
  return result.rows[0].id as number;
}

export async function finishAnalysisRun(
  runId: number,
  counters: RunCounters
): Promise<void> {
  await query(
    `UPDATE reporting_analysis_runs
     SET finished_at = CURRENT_TIMESTAMP,
         status = 'completed',
         domains_processed = $2,
         issues_opened = $3,
         issues_refreshed = $4,
         issues_resolved = $5,
         issues_pending = $6
     WHERE id = $1`,
    [
      runId,
      counters.domainsProcessed,
      counters.issuesOpened,
      counters.issuesRefreshed,
      counters.issuesResolved,
      counters.issuesPending,
    ]
  );
}

export async function failAnalysisRun(runId: number, error: string): Promise<void> {
  await query(
    `UPDATE reporting_analysis_runs
     SET finished_at = CURRENT_TIMESTAMP, status = 'failed', error = $2
     WHERE id = $1`,
    [runId, error.slice(0, 2000)]
  );
}

export async function getLatestRuns(): Promise<AnalysisRunSummary[]> {
  const result = await query<DbRow>(
    `SELECT DISTINCT ON (kind) *
     FROM reporting_analysis_runs
     ORDER BY kind, started_at DESC`
  );
  return result.rows.map(mapRun);
}

export async function getRecentRuns(
  kind?: AnalysisRunKind,
  limit = 20
): Promise<AnalysisRunSummary[]> {
  const result = await query<DbRow>(
    `SELECT * FROM reporting_analysis_runs
     ${kind ? 'WHERE kind = $2' : ''}
     ORDER BY started_at DESC
     LIMIT $1`,
    kind ? [limit, kind] : [limit]
  );
  return result.rows.map(mapRun);
}

/**
 * Record that a detector condition was observed during this run.
 *
 * Called on every firing, whether or not it results in an issue. The
 * accumulated rows are what `countConsecutiveObservations` reads.
 */
export async function recordObservation(params: {
  fingerprint: string;
  runId: number | null;
  domain: string;
  issueType: IssueType;
  severity: IssueSeverity;
  windowStart?: Date;
  windowEnd?: Date;
  metrics?: Record<string, number | string>;
}): Promise<void> {
  if (params.runId === null) return;
  await query(
    `INSERT INTO reporting_issue_observations (
       issue_fingerprint, run_id, domain, issue_type, severity,
       window_start, window_end, metrics
     ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     ON CONFLICT (issue_fingerprint, run_id) DO UPDATE SET
       severity = EXCLUDED.severity,
       metrics = EXCLUDED.metrics,
       observed_at = CURRENT_TIMESTAMP`,
    [
      params.fingerprint,
      params.runId,
      params.domain,
      params.issueType,
      params.severity,
      params.windowStart?.toISOString() ?? null,
      params.windowEnd?.toISOString() ?? null,
      JSON.stringify(params.metrics ?? {}),
    ]
  );
}

/**
 * How many of the most recent completed runs of this kind observed the
 * condition, counting back from the newest run and stopping at the first
 * run that did not.
 *
 * The current run is included, so a first-ever firing returns 1.
 */
export async function countConsecutiveObservations(
  fingerprint: string,
  kind: AnalysisRunKind,
  lookback = 10
): Promise<number> {
  const result = await query<DbRow>(
    `SELECT r.id, (o.id IS NOT NULL) AS observed
     FROM (
       SELECT id FROM reporting_analysis_runs
       WHERE kind = $2 AND status IN ('running', 'completed')
       ORDER BY started_at DESC
       LIMIT $3
     ) r
     LEFT JOIN reporting_issue_observations o
       ON o.run_id = r.id AND o.issue_fingerprint = $1
     ORDER BY r.id DESC`,
    [fingerprint, kind, lookback]
  );

  let streak = 0;
  for (const row of result.rows) {
    if (row.observed) streak++;
    else break;
  }
  return streak;
}

/**
 * How many of the most recent runs did NOT observe the condition.
 * Drives the auto-resolve grace period: an issue only closes once the
 * condition has been absent for the required number of consecutive runs,
 * which is what stops resolve→reopen flapping.
 */
export async function countConsecutiveAbsences(
  fingerprint: string,
  kind: AnalysisRunKind,
  lookback = 10
): Promise<number> {
  const result = await query<DbRow>(
    `SELECT r.id, (o.id IS NOT NULL) AS observed
     FROM (
       SELECT id FROM reporting_analysis_runs
       WHERE kind = $2 AND status IN ('running', 'completed')
       ORDER BY started_at DESC
       LIMIT $3
     ) r
     LEFT JOIN reporting_issue_observations o
       ON o.run_id = r.id AND o.issue_fingerprint = $1
     ORDER BY r.id DESC`,
    [fingerprint, kind, lookback]
  );

  let streak = 0;
  for (const row of result.rows) {
    if (!row.observed) streak++;
    else break;
  }
  return streak;
}

/**
 * Observation streaks for a batch of fingerprints, for list views that
 * want to show "seen in 4 of the last 4 runs" without N round-trips.
 */
export async function getObservationStreaks(
  fingerprints: string[],
  kind: AnalysisRunKind,
  lookback = 10
): Promise<Map<string, number>> {
  const streaks = new Map<string, number>();
  if (fingerprints.length === 0) return streaks;

  const result = await query<DbRow>(
    `SELECT o.issue_fingerprint, r.id AS run_id
     FROM (
       SELECT id FROM reporting_analysis_runs
       WHERE kind = $2 AND status IN ('running', 'completed')
       ORDER BY started_at DESC
       LIMIT $3
     ) r
     JOIN reporting_issue_observations o ON o.run_id = r.id
     WHERE o.issue_fingerprint = ANY($1::text[])
     ORDER BY r.id DESC`,
    [fingerprints, kind, lookback]
  );

  const runOrder = await query<DbRow>(
    `SELECT id FROM reporting_analysis_runs
     WHERE kind = $1 AND status IN ('running', 'completed')
     ORDER BY started_at DESC
     LIMIT $2`,
    [kind, lookback]
  );
  const orderedRunIds = runOrder.rows.map((r) => r.id as number);

  const byFingerprint = new Map<string, Set<number>>();
  for (const row of result.rows) {
    const fp = row.issue_fingerprint as string;
    if (!byFingerprint.has(fp)) byFingerprint.set(fp, new Set());
    byFingerprint.get(fp)!.add(row.run_id as number);
  }

  for (const fp of fingerprints) {
    const seen = byFingerprint.get(fp);
    if (!seen) {
      streaks.set(fp, 0);
      continue;
    }
    let streak = 0;
    for (const runId of orderedRunIds) {
      if (seen.has(runId)) streak++;
      else break;
    }
    streaks.set(fp, streak);
  }

  return streaks;
}

/**
 * Trim observation history. Runs are cheap rows but observations grow
 * with (domains × detectors × runs), so keep a bounded window.
 */
export async function pruneAnalysisHistory(keepRuns = 200): Promise<number> {
  const result = await query(
    `DELETE FROM reporting_analysis_runs
     WHERE id NOT IN (
       SELECT id FROM (
         SELECT id, ROW_NUMBER() OVER (PARTITION BY kind ORDER BY started_at DESC) AS rn
         FROM reporting_analysis_runs
       ) ranked
       WHERE rn <= $1
     )`,
    [keepRuns]
  );
  return result.rowCount ?? 0;
}
