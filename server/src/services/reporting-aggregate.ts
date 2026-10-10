/**
 * Reporting aggregation — the single source of truth for every reporting number.
 *
 *   1. Every figure on every screen comes from this module.
 *   2. Every figure is scoped to one explicit timeframe supplied by the caller.
 *   3. A headline count is always the size of the list rendered beneath it.
 *
 * Consequently there is no `now()` anywhere in this file. The default timeframe
 * is derived from the data itself (see `resolveTimeframe`), so a database full
 * of historical reports shows those reports rather than an empty dashboard.
 */

import { query } from '../db/connection.js';
import {
  breakdownFromSqlRow,
  classifyRecord,
  complianceRate,
  emptyBreakdown,
  taxonomyResum,
  type ComplianceClass,
  type TaxonomyBreakdown,
  type TaxonomySqlRow,
} from './dmarc-taxonomy.js';
import { cacheKey, rollupCacheKey, memo } from './reporting-cache.js';
import { getConfig } from '../db/queries/config.js';

/**
 * Wrap a pure aggregate so identical calls share one computation.
 *
 * Every function wrapped here is a deterministic function of its arguments over
 * report data that never changes after ingest, and ingest invalidates the cache
 * — see `reporting-cache.ts` for why that makes this safe rather than merely
 * convenient.
 */
function cached<A extends unknown[], R>(
  name: string,
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return (...args: A) => memo(cacheKey(name, ...args), () => fn(...args));
}

function cachedRollup<A extends [Timeframe, AggregateScope?, ...unknown[]], R>(
  name: string,
  fn: (...args: A) => Promise<R>
): (...args: A) => Promise<R> {
  return (...args: A) => memo(rollupCacheKey(name, args[0], args[1], ...args.slice(2)), () => fn(...args));
}

/** Default span used when the caller does not supply one. */
export const DEFAULT_WINDOW_DAYS = 30;
/** Beyond this, the newest report is old enough that we must say so out loud. */
export const STALE_AFTER_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

export interface Timeframe {
  from: Date;
  to: Date;
}

export interface TimeframeInfo extends Timeframe {
  /** Oldest report in the database, regardless of the selected timeframe. */
  dataFrom: Date | null;
  /** Newest report in the database, regardless of the selected timeframe. */
  dataTo: Date | null;
  /** Whole days between the newest report and now. Null when there is no data. */
  dataAgeDays: number | null;
  /** True when there is no report data at all. */
  empty: boolean;
  /** True when the newest report predates STALE_AFTER_DAYS. */
  stale: boolean;
  /** True when the caller did not pin a timeframe and we derived one. */
  defaulted: boolean;
}

export interface TimeframeRequest {
  from?: string | Date | null;
  to?: string | Date | null;
  days?: number | null;
}

function parseDate(value: string | Date | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 0, 0, 0, 0));
}

function endOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), 23, 59, 59, 999));
}

interface DataRangeRow {
  data_from: Date | null;
  data_to: Date | null;
}

/** The true extent of the report data, independent of any selected window. */
export const getDataRange = cached(
  'dataRange',
  async (): Promise<{ from: Date | null; to: Date | null }> => {
    const result = await query<DataRangeRow>(
      `SELECT MIN(date_begin) AS data_from, MAX(date_end) AS data_to FROM dmarc_reports`
    );
    const row = result.rows[0];
    return { from: row?.data_from ?? null, to: row?.data_to ?? null };
  }
);

/**
 * Resolve the timeframe a request should operate on.
 *
 * When the caller pins dates we honour them exactly. When they do not, we anchor
 * the window to the newest report rather than to the wall clock. This is the
 * behavior that keeps historical report stores visible instead of rendering an
 * empty, falsely reassuring dashboard.
 */
export async function resolveTimeframe(request: TimeframeRequest = {}): Promise<TimeframeInfo> {
  const config = await getConfig();
  const range = await getDataRange();
  const now = new Date();

  const requestedFrom = parseDate(request.from);
  const requestedTo = parseDate(request.to);
  const defaultDays = config.reportingDefaultWindowDays || DEFAULT_WINDOW_DAYS;
  const staleAfterDays = config.reportingStaleAfterDays || STALE_AFTER_DAYS;
  const days = request.days && request.days > 0 ? Math.min(request.days, 3650) : defaultDays;

  const anchor = requestedTo ?? range.to ?? now;
  const to = endOfDay(anchor);
  const from = requestedFrom ? startOfDay(requestedFrom) : startOfDay(new Date(to.getTime() - days * DAY_MS));

  const dataAgeDays = range.to ? Math.floor((now.getTime() - range.to.getTime()) / DAY_MS) : null;

  return {
    from: from > to ? startOfDay(to) : from,
    to,
    dataFrom: range.from,
    dataTo: range.to,
    dataAgeDays,
    empty: range.to === null,
    stale: dataAgeDays !== null && dataAgeDays > staleAfterDays,
    defaulted: !requestedFrom && !requestedTo,
  };
}

/** Additional filters every aggregation understands. */
export interface AggregateScope {
  domain?: string | null;
  sourceIp?: string | null;
  reporter?: string | null;
}

interface WhereClause {
  sql: string;
  params: unknown[];
}

/**
 * Build the shared WHERE clause for getRecords (raw drill-down over the records
 * table joined to reports). Filters on the record's `report_day` in addition to
 * the report window so the query hits idx_dmarc_records_report_day directly and
 * prunes to the months the window covers.
 * Report overlap on the report side stays deliberately inclusive.
 */
function buildWhere(timeframe: Timeframe, scope: AggregateScope = {}): WhereClause {
  // Correctness comes from the report-side range; report_day narrows to the
  // record's own indexed date column and prunes record partitions.
  const conditions = [
    'r.report_day >= $1::date AND r.report_day <= $2::date',
    'rep.date_end >= $1',
    'rep.date_begin <= $2',
  ];
  const params: unknown[] = [timeframe.from, timeframe.to];

  if (scope.domain) {
    params.push(scope.domain.toLowerCase());
    conditions.push(`LOWER(rep.domain) = $${params.length}`);
  }
  if (scope.sourceIp) {
    params.push(scope.sourceIp);
    conditions.push(`r.source_ip = $${params.length}`);
  }
  if (scope.reporter) {
    params.push(scope.reporter.toLowerCase());
    conditions.push(`LOWER(rep.org_name) = $${params.length}`);
  }

  return { sql: conditions.join(' AND '), params };
}

const FROM_CLAUSE = `FROM dmarc_records r JOIN dmarc_reports rep ON rep.id = r.report_id`;

// ── Rollup read helpers ──────────────────────────────────────────────────────
// Reporting aggregates read the pre-computed rollups (db/schema.ts,
// db/queries/dmarc-rollup.ts), not the raw records. Dimensions are stored
// lower-cased so a scope filter is a plain indexed equality. `buildWhere` /
// FROM_CLAUSE above stay for getRecords, the raw evidence layer.

/** A rollup day bound as 'YYYY-MM-DD' (rollups are keyed by DATE). */
function toDayString(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** WHERE against the coarse daily rollup (alias `d`): day + domain + reporter. */
function dailyWhere(timeframe: Timeframe, scope: AggregateScope = {}): WhereClause {
  const conditions = ['d.day >= $1', 'd.day <= $2'];
  const params: unknown[] = [toDayString(timeframe.from), toDayString(timeframe.to)];
  if (scope.domain) {
    params.push(scope.domain.toLowerCase());
    conditions.push(`d.domain = $${params.length}`);
  }
  if (scope.reporter) {
    params.push(scope.reporter.toLowerCase());
    conditions.push(`d.org_name = $${params.length}`);
  }
  return { sql: conditions.join(' AND '), params };
}

/** WHERE against the source rollup (alias `s`): day + domain + source_ip. */
export function sourceWhere(timeframe: Timeframe, scope: AggregateScope = {}): WhereClause {
  const conditions = ['s.day >= $1', 's.day <= $2'];
  const params: unknown[] = [toDayString(timeframe.from), toDayString(timeframe.to)];
  if (scope.domain) {
    params.push(scope.domain.toLowerCase());
    conditions.push(`s.domain = $${params.length}`);
  }
  if (scope.sourceIp) {
    params.push(scope.sourceIp);
    conditions.push(`s.source_ip = $${params.length}`);
  }
  return { sql: conditions.join(' AND '), params };
}

/**
 * Pick the rollup that can satisfy a taxonomy read for this scope. A source-IP
 * scope needs the source-grained rollup (the only one with source_ip); every
 * other scope reads the coarse daily rollup.
 */
function taxonomySource(
  timeframe: Timeframe,
  scope: AggregateScope = {}
): { from: string; alias: string; where: WhereClause } {
  if (scope.sourceIp) {
    return { from: 'dmarc_rollup_source_daily s', alias: 's', where: sourceWhere(timeframe, scope) };
  }
  return { from: 'dmarc_rollup_daily d', alias: 'd', where: dailyWhere(timeframe, scope) };
}

/** Distinct active sources per domain in the window. */
export const getSourceCountsByDomain = cachedRollup(
  'sourceCountsByDomain',
  async (timeframe: Timeframe, scope: AggregateScope = {}): Promise<Map<string, number>> => {
    const where = sourceWhere(timeframe, scope);
    const result = await query<{ domain: string; source_count: string }>(
      `SELECT pairs.domain, COUNT(*) AS source_count FROM (
         SELECT s.domain, s.source_ip FROM dmarc_rollup_source_daily s
         WHERE ${where.sql} GROUP BY s.domain, s.source_ip
       ) pairs GROUP BY pairs.domain`,
      where.params
    );
    return new Map(result.rows.map((row) => [row.domain, Number(row.source_count)]));
  }
);

/** Taxonomy breakdown for the whole scope. */
export const getBreakdown = cachedRollup(
  'breakdown',
  async (timeframe: Timeframe, scope: AggregateScope = {}): Promise<TaxonomyBreakdown> => {
    const { from, alias, where } = taxonomySource(timeframe, scope);
    const result = await query<TaxonomySqlRow>(
      `SELECT ${taxonomyResum(alias)} FROM ${from} WHERE ${where.sql}`,
      where.params
    );
    return breakdownFromSqlRow(result.rows[0]);
  }
);

export interface AggregateTotals {
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
  domainCount: number;
  sourceCount: number;
  reportCount: number;
  reporterCount: number;
}

interface CountsRow {
  domain_count: string | null;
  report_count: string | null;
  reporter_count: string | null;
}

/**
 * Headline totals.
 *
 * Separate taxonomy, report/domain and source aggregates avoid an expensive
 * COUNT(DISTINCT) across the joined evidence while keeping the same filtered set.
 */
export const getTotals = cachedRollup(
  'totals',
  async (timeframe: Timeframe, scope: AggregateScope = {}): Promise<AggregateTotals> => {
    const tax = taxonomySource(timeframe, scope);
    const daily = dailyWhere(timeframe, scope);
    const src = sourceWhere(timeframe, scope);

    const [taxonomy, counts, sources] = await Promise.all([
      query<TaxonomySqlRow>(
        `SELECT ${taxonomyResum(tax.alias)} FROM ${tax.from} WHERE ${tax.where.sql}`,
        tax.where.params
      ),
      query<CountsRow>(
        `SELECT COUNT(DISTINCT d.domain)      AS domain_count,
                COALESCE(SUM(d.report_count), 0) AS report_count,
                COUNT(DISTINCT d.org_name)    AS reporter_count
         FROM dmarc_rollup_daily d WHERE ${daily.sql}`,
        daily.params
      ),
      query<{ source_count: string }>(
        `SELECT COUNT(DISTINCT s.source_ip) AS source_count
         FROM dmarc_rollup_source_daily s WHERE ${src.sql}`,
        src.params
      ),
    ]);

    const breakdown = breakdownFromSqlRow(taxonomy.rows[0]);
    const row = counts.rows[0];
    return {
      breakdown,
      complianceRate: complianceRate(breakdown),
      domainCount: Number(row?.domain_count ?? 0),
      sourceCount: Number(sources.rows[0]?.source_count ?? 0),
      reportCount: Number(row?.report_count ?? 0),
      reporterCount: Number(row?.reporter_count ?? 0),
    };
  }
);

export type SortDirection = 'asc' | 'desc';

export interface PageRequest {
  limit?: number;
  offset?: number;
}

export interface Page<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

const MAX_LIMIT = 500;

function clampPage(page: PageRequest = {}): { limit: number; offset: number } {
  const limit = Math.min(MAX_LIMIT, Math.max(1, Math.floor(page.limit ?? 50)));
  const offset = Math.max(0, Math.floor(page.offset ?? 0));
  return { limit, offset };
}

export interface DomainAggregate {
  domain: string;
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
  sourceCount: number;
  reportCount: number;
  policy: string | null;
  lastReportAt: Date | null;
}

type DomainRow = TaxonomySqlRow & {
  domain: string;
  source_count: string | null;
  report_count: string | null;
  policy: string | null;
  last_report_at: Date | null;
};

export type DomainSort = 'volume' | 'compliance' | 'actionable' | 'domain';

const DOMAIN_SORTS: Record<DomainSort, (d: DomainAggregate) => number | string> = {
  volume: (d) => d.breakdown.totalVolume,
  // Ordering by rate alone floats single-message domains to the top, which is
  // noise. Weighting by volume surfaces the domains whose failures matter.
  compliance: (d) => d.complianceRate,
  actionable: (d) => d.breakdown.actionableFailureVolume,
  domain: (d) => d.domain,
};

/**
 * Load every domain in the window, unsorted and unpaged.
 *
 * Cached at this grain deliberately: sorting and paging are free once the rows
 * are in hand, so re-sorting or paging the table must not re-run three scans.
 *
 * Three parallel queries rather than one: the taxonomy over records, the
 * distinct source count per domain, and the report metadata straight from
 * `dmarc_reports`. Asking for `COUNT(DISTINCT source_ip)` and
 * `COUNT(DISTINCT report_id)` inside the taxonomy aggregate forced a per-group
 * sort and quadrupled the cost of the screen.
 */
const loadDomainAggregates = cachedRollup(
  'domainAggregates',
  async (
    timeframe: Timeframe,
    scope: AggregateScope = {},
    search?: string
  ): Promise<DomainAggregate[]> => {
    const daily = dailyWhere(timeframe, scope);
    const dailyParams = [...daily.params];
    let dailyFilter = daily.sql;
    if (search) {
      dailyParams.push(`%${search.toLowerCase()}%`);
      dailyFilter += ` AND d.domain LIKE $${dailyParams.length}`;
    }

    const src = sourceWhere(timeframe, scope);
    const srcParams = [...src.params];
    let srcFilter = src.sql;
    if (search) {
      srcParams.push(`%${search.toLowerCase()}%`);
      srcFilter += ` AND s.domain LIKE $${srcParams.length}`;
    }

    // Taxonomy + report meta come from the coarse rollup in one grouped read;
    // distinct source counts from the source rollup. last_report_at is the last
    // day with data (rollups are day-grained), which is what the table shows.
    const [main, sourceCounts] = await Promise.all([
      query<DomainRow>(
        `SELECT d.domain, ${taxonomyResum('d')},
                SUM(d.report_count) AS report_count,
                MAX(d.policy)       AS policy,
                MAX(d.day)          AS last_report_at
         FROM dmarc_rollup_daily d WHERE ${dailyFilter} GROUP BY d.domain`,
        dailyParams
      ),
      query<{ domain: string; source_count: string }>(
        `SELECT pairs.domain, COUNT(*) AS source_count FROM (
           SELECT s.domain, s.source_ip FROM dmarc_rollup_source_daily s
           WHERE ${srcFilter} GROUP BY s.domain, s.source_ip
         ) pairs GROUP BY pairs.domain`,
        srcParams
      ),
    ]);

    const sourcesByDomain = new Map(
      sourceCounts.rows.map((row) => [row.domain, Number(row.source_count)])
    );

    return main.rows.map((row) =>
      mapDomainRow({ ...row, source_count: String(sourcesByDomain.get(row.domain) ?? 0) })
    );
  }
);

/**
 * Fleet domain table.
 *
 * Sorting and paging happen in Node because the fleet is in the hundreds of
 * domains and every sort key is already materialised — and because the same
 * comparison then drives both this table and the Overview's top-offenders strip.
 */
export async function getDomainAggregates(
  timeframe: Timeframe,
  scope: AggregateScope = {},
  options: PageRequest & { sort?: DomainSort; direction?: SortDirection; search?: string } = {}
): Promise<Page<DomainAggregate>> {
  const loaded = await loadDomainAggregates(timeframe, scope, options.search);
  const items = [...loaded];

  const key = DOMAIN_SORTS[options.sort ?? 'volume'];
  const sign = options.direction === 'asc' ? 1 : -1;
  items.sort((a, b) => {
    const left = key(a);
    const right = key(b);
    if (typeof left === 'string' || typeof right === 'string') {
      return sign * String(left).localeCompare(String(right));
    }
    if (left === right) return a.domain.localeCompare(b.domain);
    return sign * (left - right);
  });

  const { limit, offset } = clampPage(options);
  return {
    items: items.slice(offset, offset + limit),
    total: items.length,
    limit,
    offset,
  };
}

function mapDomainRow(row: DomainRow): DomainAggregate {
  const breakdown = breakdownFromSqlRow(row);
  return {
    domain: row.domain,
    breakdown,
    complianceRate: complianceRate(breakdown),
    sourceCount: Number(row.source_count ?? 0),
    reportCount: Number(row.report_count ?? 0),
    policy: row.policy,
    lastReportAt: row.last_report_at,
  };
}

/** A single domain's aggregate, or an empty one when it sent nothing in range. */
export async function getDomainAggregate(
  timeframe: Timeframe,
  domain: string
): Promise<DomainAggregate> {
  const page = await getDomainAggregates(timeframe, { domain }, { limit: 1 });
  return (
    page.items[0] ?? {
      domain,
      breakdown: emptyBreakdown(),
      complianceRate: 1,
      sourceCount: 0,
      reportCount: 0,
      policy: null,
      lastReportAt: null,
    }
  );
}

export interface ReporterAggregate {
  reporter: string;
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
  reportCount: number;
}

type ReporterRow = TaxonomySqlRow & { reporter: string | null; report_count: string | null };

/**
 * Volume per reporting provider. Worth showing because a compliance figure
 * derived overwhelmingly from one provider deserves less confidence than one
 * corroborated across several.
 */
export const getReporterAggregates = cachedRollup(
  'reporterAggregates',
  async (
    timeframe: Timeframe,
    scope: AggregateScope = {},
    options: PageRequest = {}
  ): Promise<ReporterAggregate[]> => {
    const where = dailyWhere(timeframe, scope);
    const { limit } = clampPage({ limit: options.limit ?? 20 });

    // Taxonomy and report count both come from the coarse rollup in one grouped
    // read. Empty org_name is presented as 'unknown'.
    const taxonomy = await query<ReporterRow>(
      `SELECT CASE WHEN d.org_name = '' THEN 'unknown' ELSE d.org_name END AS reporter,
              ${taxonomyResum('d')},
              SUM(d.report_count) AS report_count
       FROM dmarc_rollup_daily d WHERE ${where.sql}
       GROUP BY d.org_name
       ORDER BY total_volume DESC
       LIMIT ${limit}`,
      where.params
    );

    return taxonomy.rows.map((row) => {
      const breakdown = breakdownFromSqlRow(row);
      return {
        reporter: row.reporter ?? 'unknown',
        breakdown,
        complianceRate: complianceRate(breakdown),
        reportCount: Number(row.report_count ?? 0),
      };
    });
  }
);

/**
 * A single aggregate-report row, joined to its report envelope.
 *
 * This is the evidence layer. Everything above it is a summary of these rows,
 * and the operator must always be able to inspect the records behind a number.
 */
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
  dateBegin: Date | null;
  dateEnd: Date | null;
  classification: ReturnType<typeof classifyRecord>;
}

export type RecordSort = 'volume' | 'date' | 'domain' | 'source';

const RECORD_SORTS_SQL: Record<RecordSort, string> = {
  volume: 'r.count',
  date: 'rep.date_begin',
  domain: 'rep.domain',
  source: 'r.source_ip',
};

export interface RecordQueryOptions extends PageRequest {
  complianceClass?: ComplianceClass;
  disposition?: string;
  reasonType?: string;
  spfAligned?: boolean;
  dkimAligned?: boolean;
  search?: string;
  sort?: RecordSort;
  direction?: SortDirection;
}

const ALIGNED_SQL = `(LOWER(TRIM(COALESCE(r.dkim, ''))) = 'pass' OR LOWER(TRIM(COALESCE(r.spf, ''))) = 'pass')`;
const AUTHENTICATED_SQL = `(LOWER(TRIM(COALESCE(r.dkim_result, ''))) = 'pass' OR LOWER(TRIM(COALESCE(r.spf_result, ''))) = 'pass')`;

export const getRecords = cached(
  'records',
  async (
    timeframe: Timeframe,
    scope: AggregateScope = {},
    options: RecordQueryOptions = {}
  ): Promise<Page<RecordRow>> => {
    const where = buildWhere(timeframe, scope);
    const params = [...where.params];
    let filter = where.sql;

  // Compliance class must be expressed in SQL rather than filtered in Node, so
  // that pagination totals stay honest for large result sets.
  if (options.complianceClass === 'compliant') {
    filter += ` AND ${ALIGNED_SQL}`;
  } else if (options.complianceClass === 'authenticated_unaligned') {
    filter += ` AND NOT ${ALIGNED_SQL} AND ${AUTHENTICATED_SQL}`;
  } else if (options.complianceClass === 'failed') {
    filter += ` AND NOT ${ALIGNED_SQL} AND NOT ${AUTHENTICATED_SQL}`;
  }

  if (options.disposition) {
    params.push(options.disposition.toLowerCase());
    filter += ` AND LOWER(COALESCE(r.disposition, '')) = $${params.length}`;
  }
  if (options.reasonType) {
    params.push(options.reasonType.toLowerCase());
    filter += ` AND LOWER(COALESCE(r.reason_type, '')) = $${params.length}`;
  }
  if (options.spfAligned !== undefined) {
    filter += options.spfAligned
      ? ` AND LOWER(TRIM(COALESCE(r.spf, ''))) = 'pass'`
      : ` AND LOWER(TRIM(COALESCE(r.spf, ''))) <> 'pass'`;
  }
  if (options.dkimAligned !== undefined) {
    filter += options.dkimAligned
      ? ` AND LOWER(TRIM(COALESCE(r.dkim, ''))) = 'pass'`
      : ` AND LOWER(TRIM(COALESCE(r.dkim, ''))) <> 'pass'`;
  }
  if (options.search) {
    params.push(`%${options.search.toLowerCase()}%`);
    const needle = `$${params.length}`;
    filter += ` AND (LOWER(rep.domain) LIKE ${needle}
                  OR LOWER(COALESCE(r.source_ip, '')) LIKE ${needle}
                  OR LOWER(COALESCE(r.header_from, '')) LIKE ${needle}
                  OR LOWER(COALESCE(r.dkim_domain, '')) LIKE ${needle}
                  OR LOWER(COALESCE(r.spf_domain, '')) LIKE ${needle})`;
  }

    const { limit, offset } = clampPage({ limit: options.limit ?? 100, offset: options.offset });
    const sort = RECORD_SORTS_SQL[options.sort ?? 'volume'];
    const dir = options.direction === 'asc' ? 'ASC' : 'DESC';

    // Both queries scan the same filtered set, so issue them together rather
    // than waiting for the count before fetching the page.
    const pageParams = [...params, limit, offset];
    const [totalResult, result] = await Promise.all([
      query<{ total: string }>(`SELECT COUNT(*) AS total ${FROM_CLAUSE} WHERE ${filter}`, params),
      query<RawRecordRow>(
        `SELECT r.id, rep.domain, r.source_ip, r.count, r.disposition,
                r.dkim, r.spf, r.dkim_result, r.spf_result,
                r.dkim_domain, r.dkim_selector, r.spf_domain,
                r.header_from, r.envelope_from, r.reason_type,
                rep.org_name AS reporter, rep.id AS report_id,
                rep.date_begin, rep.date_end
         ${FROM_CLAUSE}
         WHERE ${filter}
         ORDER BY ${sort} ${dir} NULLS LAST, r.id DESC
         LIMIT $${pageParams.length - 1} OFFSET $${pageParams.length}`,
        pageParams
      ),
    ]);

    return {
      items: result.rows.map(mapRecordRow),
      total: Number(totalResult.rows[0]?.total ?? 0),
      limit,
      offset,
    };
  }
);

interface RawRecordRow {
  id: number;
  domain: string;
  source_ip: string;
  count: string | number | null;
  disposition: string | null;
  dkim: string | null;
  spf: string | null;
  dkim_result: string | null;
  spf_result: string | null;
  dkim_domain: string | null;
  dkim_selector: string | null;
  spf_domain: string | null;
  header_from: string | null;
  envelope_from: string | null;
  reason_type: string | null;
  reporter: string | null;
  report_id: number;
  date_begin: Date | null;
  date_end: Date | null;
}

function mapRecordRow(row: RawRecordRow): RecordRow {
  return {
    id: row.id,
    domain: row.domain,
    sourceIp: row.source_ip,
    count: Number(row.count ?? 0),
    disposition: row.disposition,
    dkim: row.dkim,
    spf: row.spf,
    dkimResult: row.dkim_result,
    spfResult: row.spf_result,
    dkimDomain: row.dkim_domain,
    dkimSelector: row.dkim_selector,
    spfDomain: row.spf_domain,
    headerFrom: row.header_from,
    envelopeFrom: row.envelope_from,
    reasonType: row.reason_type,
    reporter: row.reporter,
    reportId: row.report_id,
    dateBegin: row.date_begin,
    dateEnd: row.date_end,
    // Classify here so the client never re-implements the taxonomy and drifts
    // from the summaries above it.
    classification: classifyRecord({
      dkim: row.dkim,
      spf: row.spf,
      dkimResult: row.dkim_result,
      spfResult: row.spf_result,
      reasonType: row.reason_type,
    }),
  };
}

export interface TrendPoint {
  date: string;
  breakdown: TaxonomyBreakdown;
  complianceRate: number;
}

type TrendRow = TaxonomySqlRow & { bucket: string };

/** Daily volume/compliance trend across the selected timeframe. */
export const getTrend = cachedRollup(
  'trend',
  async (timeframe: Timeframe, scope: AggregateScope = {}): Promise<TrendPoint[]> => {
    const { from, alias, where } = taxonomySource(timeframe, scope);
    const result = await query<TrendRow>(
      `SELECT ${alias}.day::text AS bucket, ${taxonomyResum(alias)}
       FROM ${from} WHERE ${where.sql}
       GROUP BY ${alias}.day
       ORDER BY ${alias}.day ASC`,
      where.params
    );

    return result.rows.map((row) => {
      const breakdown = breakdownFromSqlRow(row);
      return {
        date: row.bucket.slice(0, 10),
        breakdown,
        complianceRate: complianceRate(breakdown),
      };
    });
  }
);
