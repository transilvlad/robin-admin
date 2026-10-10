/**
 * Scale-regression tests. Seeds a meaningful volume (~50k records across many
 * domains/sources/days) directly in SQL, then asserts:
 *
 *   1. Every reporting aggregate's EXPLAIN plan touches ZERO rows in
 *      dmarc_records — reads must serve entirely from the rollups.
 *   2. Cold reads complete in millisecond budgets, so a regression that
 *      reintroduces a raw scan trips the timing gate.
 *
 * Skipped unless ROLLUP_IT_DB=1. For manual bigger runs use
 * `scripts/scale-harness.ts` — this test is a permanent CI-friendly gate.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeSchema } from '../db/schema.js';
import { query, closePool } from '../db/connection.js';
import { rebuildDmarcRollups } from '../db/queries/dmarc-rollup.js';
import { invalidateReportingCache } from './reporting-cache.js';
import {
  getTotals,
  getTrend,
  getDomainAggregates,
  getReporterAggregates,
  type Timeframe,
} from './reporting-aggregate.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

const REPORTS = 10_000;      // 10k reports × 5 records each = 50k dmarc_records
const RECS_PER_REPORT = 5;
const DOMAINS = 20;
const REPORTERS = 3;
const DAYS = 14;

const NOW = new Date();
const TIMEFRAME: Timeframe = {
  from: new Date(NOW.getTime() - (DAYS + 1) * 86400_000),
  to: NOW,
};

async function seed(): Promise<void> {
  await query(`TRUNCATE dmarc_records, dmarc_reports, dmarc_reporters, dmarc_rollup_daily, dmarc_rollup_source_daily RESTART IDENTITY CASCADE`);
  for (let i = 1; i <= REPORTERS; i++) {
    await query(`INSERT INTO dmarc_reporters (name, display_name) VALUES ($1, $1)`, [`seed${i}`]);
  }
  await query(
    `INSERT INTO dmarc_reports
       (report_id, reporter_id, org_name, email, domain, date_begin, date_end,
        policy, subdomain_policy, dkim_alignment, spf_alignment, pct,
        total_count, error_count, raw_payload)
     SELECT 'seed-' || gs::text,
            ((gs - 1) % $2) + 1,
            'seed' || (((gs - 1) % $2) + 1)::text,
            'x@example.com',
            'seed' || ((gs - 1) % $1)::text || '.example.com',
            (NOW() - (((gs - 1) % $3) || ' days')::interval)::timestamp,
            (NOW() - (((gs - 1) % $3) || ' days')::interval + INTERVAL '1 day')::timestamp,
            'reject', 'reject', 'r', 'r', 100, $4, 0,
            jsonb_build_object('records', (SELECT jsonb_agg(NULL::text) FROM generate_series(1, $6)))
     FROM generate_series(1, $5) gs`,
    [DOMAINS, REPORTERS, DAYS, RECS_PER_REPORT * 10, REPORTS, RECS_PER_REPORT]
  );
  await query(
    `INSERT INTO dmarc_records
       (report_id, source_ip, count, disposition, dkim, spf, dkim_result, spf_result, reason_type, report_day)
     SELECT rep.id,
            '10.0.' || ((seq.n * 7) % 200)::text || '.' || ((seq.n * 13) % 200)::text,
            (10 + (seq.n % 50))::int,
            CASE seq.n % 3 WHEN 0 THEN 'none' ELSE '' END,
            CASE seq.n % 4 WHEN 0 THEN 'fail' ELSE 'pass' END,
            CASE seq.n % 3 WHEN 0 THEN 'fail' ELSE 'pass' END,
            'pass', 'pass',
            CASE seq.n % 5 WHEN 0 THEN 'forwarded' ELSE '' END,
            DATE_TRUNC('day', rep.date_begin)::date
     FROM dmarc_reports rep,
          generate_series(1, $1) seq(n)`,
    [RECS_PER_REPORT]
  );
  await rebuildDmarcRollups();
}

async function planTouchesRaw(sql: string, params: unknown[] = []): Promise<boolean> {
  const plan = await query<{ 'QUERY PLAN': string }>(`EXPLAIN (FORMAT JSON) ${sql}`, params);
  return JSON.stringify(plan.rows).includes('dmarc_records');
}

describe.skipIf(!RUN)('reporting scale (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
    await seed();
  }, 120_000);
  afterAll(async () => {
    await closePool();
  });

  it('seeded roughly the expected volumes', async () => {
    const r = await query<{ reports: string; records: string; rollups: string; sources: string }>(
      `SELECT (SELECT COUNT(*) FROM dmarc_reports) reports,
              (SELECT COUNT(*) FROM dmarc_records) records,
              (SELECT COUNT(*) FROM dmarc_rollup_daily) rollups,
              (SELECT COUNT(*) FROM dmarc_rollup_source_daily) sources`
    );
    expect(Number(r.rows[0].reports)).toBe(REPORTS);
    expect(Number(r.rows[0].records)).toBe(REPORTS * RECS_PER_REPORT);
    // Rollups collapse many raw rows per (day, domain, ...) key — should be
    // orders of magnitude smaller than the raw record count.
    expect(Number(r.rows[0].rollups)).toBeLessThan(REPORTS);
    expect(Number(r.rows[0].sources)).toBeLessThan(REPORTS * RECS_PER_REPORT);
  });

  it('rollup reads never touch dmarc_records (EXPLAIN)', async () => {
    const from = TIMEFRAME.from.toISOString().slice(0, 10);
    const to = TIMEFRAME.to.toISOString().slice(0, 10);
    // Representative queries for each aggregate reader.
    const dailyRead = `SELECT SUM(d.total_volume) FROM dmarc_rollup_daily d
                       WHERE d.day >= $1::date AND d.day <= $2::date`;
    const sourceRead = `SELECT COUNT(DISTINCT s.source_ip) FROM dmarc_rollup_source_daily s
                        WHERE s.day >= $1::date AND s.day <= $2::date`;
    const domainGrouped = `SELECT d.domain, SUM(d.total_volume) FROM dmarc_rollup_daily d
                           WHERE d.day >= $1::date AND d.day <= $2::date GROUP BY d.domain`;
    for (const sql of [dailyRead, sourceRead, domainGrouped]) {
      expect(await planTouchesRaw(sql, [from, to])).toBe(false);
    }
  });

  it('cold reads finish in the ms budget (fresh cache)', async () => {
    const budgets: Array<[string, () => Promise<unknown>, number]> = [
      ['getTotals', () => getTotals(TIMEFRAME), 300],
      ['getTrend', () => getTrend(TIMEFRAME), 200],
      ['getDomainAggregates', () => getDomainAggregates(TIMEFRAME, {}, { limit: 50 }), 400],
      ['getReporterAggregates', () => getReporterAggregates(TIMEFRAME, {}, { limit: 20 }), 200],
    ];
    for (const [name, fn, budgetMs] of budgets) {
      invalidateReportingCache();
      const start = Date.now();
      await fn();
      const elapsed = Date.now() - start;
      if (elapsed >= budgetMs) {
        // Include the offending timing in the failure message.
        throw new Error(`${name} took ${elapsed}ms, budget ${budgetMs}ms`);
      }
    }
  });
});
