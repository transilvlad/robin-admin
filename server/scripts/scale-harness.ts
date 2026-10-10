/**
 * Reporting scale harness.
 *
 *   REPORTS=100000 RECS_PER_REPORT=5 tsx scripts/scale-harness.ts
 *
 * Seeds N synthetic DMARC reports directly in SQL (fast — generate_series, one
 * INSERT per table), rebuilds the rollups from raw, and prints:
 *
 *   - row counts (raw vs rollup collapse ratio)
 *   - EXPLAIN summary for each aggregate read, with a check that no plan
 *     touches dmarc_records
 *   - cold latency of every reporting-aggregate reader
 *
 * Run at 1M, 5M, 10M to demonstrate the read cost is FLAT as raw grows: rollup
 * rows and endpoint latency should stay in the same order of magnitude.
 *
 * A CI-facing gate at ~50k records lives in
 * src/services/reporting-scale.integration.test.ts. This script is for the
 * bigger interactive runs an operator does after a schema change or when
 * validating capacity headroom.
 */
import { initializeSchema } from '../src/db/schema.js';
import { config } from '../src/config.js';
import assert from 'node:assert/strict';
import { query, closePool } from '../src/db/connection.js';
import { rebuildDmarcRollups } from '../src/db/queries/dmarc-rollup.js';
import { invalidateReportingCache } from '../src/services/reporting-cache.js';
import {
  getTotals,
  getTrend,
  getDomainAggregates,
  getReporterAggregates,
  type Timeframe,
} from '../src/services/reporting-aggregate.js';
import { getSourceAggregates } from '../src/services/reporting-sources.js';

const REPORTS = Number(process.env.REPORTS ?? 100_000);
const RECS_PER_REPORT = Number(process.env.RECS_PER_REPORT ?? 5);
const DOMAINS = Number(process.env.DOMAINS ?? 200);
const REPORTERS = Number(process.env.REPORTERS ?? 5);
const DAYS = Number(process.env.DAYS ?? 30);
const SOURCES = process.env.SOURCES === undefined ? null : Number(process.env.SOURCES);

const NOW = new Date();
const TIMEFRAME: Timeframe = {
  from: new Date(NOW.getTime() - (DAYS + 1) * 86400_000),
  to: NOW,
};

function fmtMs(n: number): string {
  return `${n.toFixed(1)}ms`;
}

async function seed(): Promise<void> {
  const t0 = Date.now();
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
    [DOMAINS, REPORTERS, DAYS, Array.from({ length: RECS_PER_REPORT }, (_, index) => 10 + ((index + 1) % 50)).reduce((a, b) => a + b, 0), REPORTS, RECS_PER_REPORT]
  );

  await query(
    `INSERT INTO dmarc_records
       (report_id, source_ip, count, disposition, dkim, spf, dkim_result, spf_result, reason_type, report_day)
     SELECT rep.id,
            CASE WHEN $2::bigint IS NULL THEN
              '10.' || ((seq.n * 7 + rep.id) % 250)::text || '.' || ((seq.n * 13 + rep.id) % 250)::text || '.' || ((seq.n * 17) % 250)::text
            ELSE host('10.0.0.0'::inet + (((rep.id - 1) * $1 + seq.n - 1) % $2)::bigint) END,
            (10 + (seq.n % 50))::int,
            CASE seq.n % 3 WHEN 0 THEN 'none' ELSE '' END,
            CASE seq.n % 4 WHEN 0 THEN 'fail' ELSE 'pass' END,
            CASE seq.n % 3 WHEN 0 THEN 'fail' ELSE 'pass' END,
            'pass', 'pass',
            CASE seq.n % 5 WHEN 0 THEN 'forwarded' ELSE '' END,
            DATE_TRUNC('day', rep.date_begin)::date
     FROM dmarc_reports rep,
          generate_series(1, $1) seq(n)`,
    [RECS_PER_REPORT, SOURCES]
  );
  console.log(`seed: ${REPORTS.toLocaleString()} reports × ${RECS_PER_REPORT} records in ${fmtMs(Date.now() - t0)}`);
}

async function counts(): Promise<void> {
  const r = await query<{ reports: string; records: string; rollups: string; sources: string }>(
    `SELECT (SELECT COUNT(*) FROM dmarc_reports) reports,
            (SELECT COUNT(*) FROM dmarc_records) records,
            (SELECT COUNT(*) FROM dmarc_rollup_daily) rollups,
            (SELECT COUNT(*) FROM dmarc_rollup_source_daily) sources`
  );
  const row = r.rows[0];
  console.log(
    `counts: raw=${Number(row.records).toLocaleString()} records / ${Number(row.reports).toLocaleString()} reports · ` +
      `rollups=${Number(row.rollups).toLocaleString()} daily + ${Number(row.sources).toLocaleString()} source-daily · ` +
      `collapse=${(Number(row.records) / (Number(row.rollups) + Number(row.sources))).toFixed(1)}×`
  );
}

async function explainCheck(label: string, sql: string, params: unknown[] = []): Promise<void> {
  const plan = await query<{ 'QUERY PLAN': unknown }>(`EXPLAIN (FORMAT JSON, ANALYZE, BUFFERS) ${sql}`, params);
  const planText = JSON.stringify(plan.rows);
  const touchesRaw = planText.includes('dmarc_records');
  console.log(`  ${touchesRaw ? '✗' : '✓'} ${label} — touchesRaw=${touchesRaw}`);
  assert.equal(touchesRaw, false, `${label} unexpectedly reads raw records`);
}

async function timeCold(label: string, fn: () => Promise<unknown>): Promise<void> {
  invalidateReportingCache();
  const start = process.hrtime.bigint();
  await fn();
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1_000_000;
  console.log(`  ${elapsedMs < 500 ? '✓' : '⚠'} ${label} — ${fmtMs(elapsedMs)}`);
  const warmStart = process.hrtime.bigint();
  await fn();
  console.log(`    warm: ${fmtMs(Number(process.hrtime.bigint() - warmStart) / 1_000_000)}`);
}

async function main(): Promise<void> {
  if (process.env.SCALE_HARNESS_DISPOSABLE !== '1' || !/^robin_release_scale(?:_[a-z0-9]+)?$/.test(config.postgres.database)) {
    throw new Error('Scale harness requires SCALE_HARNESS_DISPOSABLE=1 and a robin_release_scale disposable database');
  }
  for (const [name, value] of Object.entries({ REPORTS, RECS_PER_REPORT, DOMAINS, REPORTERS, DAYS })) {
    if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  }
  if (RECS_PER_REPORT > 10_000 || (SOURCES !== null && (!Number.isSafeInteger(SOURCES) || SOURCES < 1 || SOURCES > 16_777_216))) {
    throw new Error('RECS_PER_REPORT exceeds 10000 or SOURCES is outside the private IPv4 range');
  }
  console.log(
    `scale-harness: REPORTS=${REPORTS} RECS_PER_REPORT=${RECS_PER_REPORT} ` +
      `DOMAINS=${DOMAINS} REPORTERS=${REPORTERS} DAYS=${DAYS} SOURCES=${SOURCES ?? 'default'}`
  );
  await initializeSchema();
  await seed();

  const t0 = Date.now();
  await rebuildDmarcRollups();
  console.log(`backfill: ${fmtMs(Date.now() - t0)}`);
  await query('ANALYZE dmarc_rollup_daily');
  await query('ANALYZE dmarc_rollup_source_daily');
  await counts();
  const parity = (await query<{ raw: string; daily: string; source: string; reports: string }>(
    `SELECT (SELECT SUM(count) FROM dmarc_records) AS raw,
      (SELECT SUM(total_volume) FROM dmarc_rollup_daily) AS daily,
      (SELECT SUM(total_volume) FROM dmarc_rollup_source_daily) AS source,
      (SELECT SUM(total_count) FROM dmarc_reports) AS reports`
  )).rows[0];
  assert.equal(parity.daily, parity.raw, 'Daily rollup parity failed');
  assert.equal(parity.source, parity.raw, 'Source rollup parity failed');
  assert.equal(parity.reports, parity.raw, 'Seed report totals differ from raw counts');
  console.log(`parity: raw=daily=source=reports=${parity.raw}`);

  console.log('EXPLAIN plans (must NOT touch dmarc_records):');
  const from = TIMEFRAME.from.toISOString().slice(0, 10);
  const to = TIMEFRAME.to.toISOString().slice(0, 10);
  await explainCheck(
    'totals (daily)',
    `SELECT SUM(d.total_volume) FROM dmarc_rollup_daily d WHERE d.day >= $1::date AND d.day <= $2::date`,
    [from, to]
  );
  await explainCheck(
    'source count',
    `SELECT COUNT(DISTINCT s.source_ip) FROM dmarc_rollup_source_daily s WHERE s.day >= $1::date AND s.day <= $2::date`,
    [from, to]
  );
  await explainCheck(
    'per-domain grouped',
    `SELECT d.domain, SUM(d.total_volume) FROM dmarc_rollup_daily d WHERE d.day >= $1::date AND d.day <= $2::date GROUP BY d.domain`,
    [from, to]
  );

  console.log('application-cache-cold read latency (PostgreSQL/OS caches are not flushed):');
  await timeCold('getTotals', () => getTotals(TIMEFRAME));
  await timeCold('getTrend', () => getTrend(TIMEFRAME));
  await timeCold('getDomainAggregates(50)', () => getDomainAggregates(TIMEFRAME, {}, { limit: 50 }));
  await timeCold('getReporterAggregates(20)', () => getReporterAggregates(TIMEFRAME, {}, { limit: 20 }));
  await timeCold('getSourceAggregates(50)', () => getSourceAggregates(TIMEFRAME, {}, { limit: 50 }));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
