/**
 * Report coverage and freshness.
 *
 * An empty issue list means one of two very different things: "nothing is
 * wrong" or "nobody has sent us data". Every serious DMARC product
 * distinguishes them, and conflating them is the fastest way to lose an
 * operator's trust in the derived views. These queries answer "who is
 * reporting on this domain, and when did we last hear from them?".
 */

import { query } from '../connection.js';
import { getConfig } from './config.js';
import type {
  AnalysisRunKind,
  DomainReportCoverage,
  ReportCoverageEntry,
} from '../../types/reporting.js';

export let COVERAGE_STALE_DAYS = 7;

export async function getCoverageStaleDays(): Promise<number> {
  const config = await getConfig();
  COVERAGE_STALE_DAYS = Math.max(1, Math.min(3650, config.reportingStaleAfterDays || COVERAGE_STALE_DAYS));
  return COVERAGE_STALE_DAYS;
}

type CoverageRow = Record<string, unknown> & {
  reporter: string | null;
  report_count: string;
  first_received: string | null;
  last_received: string | null;
  last_window_end: string | null;
};

function toEntry(kind: AnalysisRunKind, row: CoverageRow, now: Date, staleDays: number): ReportCoverageEntry {
  const lastReceived = row.last_received ? new Date(row.last_received) : null;
  const daysSinceLast = lastReceived
    ? Math.floor((now.getTime() - lastReceived.getTime()) / 86_400_000)
    : null;

  return {
    kind,
    reporter: row.reporter ?? 'unknown',
    reportCount: parseInt(row.report_count, 10) || 0,
    firstReceived: row.first_received ? new Date(row.first_received) : null,
    lastReceived,
    lastWindowEnd: row.last_window_end ? new Date(row.last_window_end) : null,
    daysSinceLast,
    stale: daysSinceLast === null || daysSinceLast > staleDays,
  };
}

/**
 * Per-reporter coverage for one domain across all three report kinds.
 */
export async function getDomainReportCoverage(
  domain: string,
  windowStart: Date,
  windowEnd: Date
): Promise<DomainReportCoverage> {
  const now = new Date();
  const staleDays = await getCoverageStaleDays();

  const dmarc = (await query<CoverageRow>(
    `SELECT org_name AS reporter,
            COUNT(*)::text AS report_count,
            MIN(COALESCE(created_at, date_begin))::text AS first_received,
            MAX(COALESCE(created_at, date_end))::text AS last_received,
            MAX(date_end)::text AS last_window_end
     FROM dmarc_reports
     WHERE domain = $1 AND date_end >= $2 AND date_begin <= $3
     GROUP BY org_name
     ORDER BY COUNT(*) DESC`,
    [domain, windowStart.toISOString(), windowEnd.toISOString()]
  )).rows;

  const tlsrpt = await query<CoverageRow>(
    `SELECT tr.organization_name AS reporter,
            COUNT(DISTINCT tr.id)::text AS report_count,
            MIN(COALESCE(tr.created_at, tr.date_begin))::text AS first_received,
            MAX(COALESCE(tr.created_at, tr.date_end))::text AS last_received,
            MAX(tr.date_end)::text AS last_window_end
     FROM tlsrpt_reports tr
     JOIN tlsrpt_policies tp ON tp.report_id = tr.id
     WHERE tp.policy_domain = $1 AND tr.date_end >= $2 AND tr.date_begin <= $3
     GROUP BY tr.organization_name
     ORDER BY COUNT(DISTINCT tr.id) DESC`,
    [domain, windowStart.toISOString(), windowEnd.toISOString()]
  ).then((r) => r.rows).catch(() => [] as CoverageRow[]);

  const forensic = await query<CoverageRow>(
    `SELECT COALESCE(user_agent, 'unknown') AS reporter,
            COUNT(*)::text AS report_count,
            MIN(COALESCE(arrival_date, received_date, created_at))::text AS first_received,
            MAX(COALESCE(arrival_date, received_date, created_at))::text AS last_received,
            MAX(COALESCE(arrival_date, received_date, created_at))::text AS last_window_end
     FROM forensic_reports
     WHERE reported_domain = $1
       AND COALESCE(arrival_date, received_date, created_at) BETWEEN $2 AND $3
     GROUP BY COALESCE(user_agent, 'unknown')
     ORDER BY COUNT(*) DESC`,
    [domain, windowStart.toISOString(), windowEnd.toISOString()]
  ).then((r) => r.rows).catch(() => [] as CoverageRow[]);

  const entries: ReportCoverageEntry[] = [
    ...dmarc.map((row) => toEntry('dmarc', row, now, staleDays)),
    ...tlsrpt.map((row) => toEntry('tlsrpt', row, now, staleDays)),
    ...forensic.map((row) => toEntry('forensic', row, now, staleDays)),
  ];

  // Deliberately unbounded by the analysis window. The whole point of this
  // detector is to catch a domain that has gone quiet, and a domain silent
  // for longer than the window has *zero* in-window rows — deriving
  // "have we ever heard from this domain" or "how long has it been" from
  // the windowed set would make the worst outages invisible.
  const history = (await query<Record<string, unknown> & {
    last_report: string | null;
    total_reports: string;
  }>(
    `SELECT MAX(COALESCE(created_at, date_end))::text AS last_report,
            COUNT(*)::text AS total_reports
     FROM dmarc_reports
     WHERE domain = $1`,
    [domain]
  )).rows[0];

  const lastReportAt = history?.last_report ? new Date(history.last_report) : null;
  const lifetimeReportCount = parseInt(history?.total_reports ?? '0', 10) || 0;
  const gapDays = lastReportAt
    ? Math.max(0, Math.floor((now.getTime() - lastReportAt.getTime()) / 86_400_000))
    : Number.MAX_SAFE_INTEGER;

  return {
    domain,
    windowStart,
    windowEnd,
    entries,
    // A domain that has ever produced aggregate reports should keep
    // producing them; that is what makes silence meaningful.
    expectedDailyReports: lifetimeReportCount > 0,
    gapDays,
    lastReportAt,
    lifetimeReportCount,
  };
}

/**
 * Domains whose aggregate reporting has gone quiet. Used both by the
 * `reports_missing` detector and by the staleness banner in the UI.
 */
export async function getStaleReportingDomains(
  staleDays?: number
): Promise<{ domain: string; lastReportAt: Date | null; daysSinceLast: number }[]> {
  const effectiveStaleDays = staleDays ?? await getCoverageStaleDays();
  const rows = (await query<Record<string, unknown> & { domain: string; last_report: string | null }>(
    `SELECT domain, MAX(COALESCE(created_at, date_end))::text AS last_report
     FROM dmarc_reports
     GROUP BY domain`
  )).rows;

  const now = Date.now();
  return rows
    .map((row) => {
      const lastReportAt = row.last_report ? new Date(row.last_report) : null;
      const daysSinceLast = lastReportAt
        ? Math.floor((now - lastReportAt.getTime()) / 86_400_000)
        : Number.MAX_SAFE_INTEGER;
      return { domain: row.domain, lastReportAt, daysSinceLast };
    })
    .filter((entry) => entry.daysSinceLast > effectiveStaleDays)
    .sort((a, b) => b.daysSinceLast - a.daysSinceLast);
}
