/**
 * Integration tests for rollup maintenance against a REAL Postgres.
 *
 * Skipped by default (the normal suite mocks the DB). To run:
 *   ROLLUP_IT_DB=1 DB_HOST=localhost DB_PORT=5433 DB_NAME=robin_test \
 *   DB_USER=test DB_PASSWORD=test SESSION_SECRET=x \
 *   npx vitest run src/db/queries/dmarc-rollup.integration.test.ts
 * Run one integration file at a time: they share and reset the same tables.
 *
 * These prove the properties the pure unit tests can't: the SQL upserts, ON
 * CONFLICT accumulation, partition routing, and rollup-vs-raw parity.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { initializeSchema } from '../schema.js';
import { query, closePool, getClient } from '../connection.js';
import { insertReport, type DmarcReportInput } from './dmarc.js';
import { rebuildDmarcRollups } from './dmarc-rollup.js';
import {
  breakdownFromSqlRow,
  taxonomySql,
  taxonomyResum,
  type TaxonomyBreakdown,
  type TaxonomySqlRow,
} from '../../services/dmarc-taxonomy.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

const DAY = Math.floor(Date.UTC(2026, 8, 15) / 1000); // 2026-09-15

function report(o: Partial<DmarcReportInput> & { reportId: string }): DmarcReportInput {
  return {
    orgName: 'google.com',
    email: 'x@google.com',
    domain: 'Example.com',
    dateBegin: DAY,
    dateEnd: DAY + 86399,
    policy: 'reject',
    subdomainPolicy: 'reject',
    dkimAlignment: 'r',
    spfAlignment: 'r',
    pct: '100',
    totalCount: 0,
    errorCount: 0,
    records: [],
    ...o,
  };
}

const rec = (sourceIp: string, count: number, kind: 'ok' | 'fwd' | 'fail') => ({
  sourceIp,
  count,
  disposition: 'none',
  dkim: kind === 'ok' ? 'pass' : 'fail',
  spf: kind === 'ok' ? 'pass' : 'fail',
  dkimResult: kind === 'fwd' ? 'pass' : 'fail',
  spfResult: 'fail',
  reasonType: kind === 'fwd' ? 'forwarded' : '',
});

// Overall breakdown straight from the RAW records (the source of truth).
async function rawBreakdown(): Promise<TaxonomyBreakdown> {
  const r = await query<TaxonomySqlRow>(
    `SELECT ${taxonomySql('tx')} FROM (
       SELECT COALESCE(r.count,0) AS tx_volume,
              LOWER(TRIM(COALESCE(r.dkim,'')))='pass' AS tx_dkim_aligned,
              LOWER(TRIM(COALESCE(r.spf,'')))='pass' AS tx_spf_aligned,
              LOWER(TRIM(COALESCE(r.dkim_result,'')))='pass' AS tx_dkim_auth,
              LOWER(TRIM(COALESCE(r.spf_result,'')))='pass' AS tx_spf_auth,
              LOWER(TRIM(COALESCE(r.reason_type,''))) AS tx_reason
       FROM dmarc_records r OFFSET 0
     ) tx`
  );
  return breakdownFromSqlRow(r.rows[0]);
}

// Overall breakdown from the ROLLUP.
async function rollupBreakdown(): Promise<TaxonomyBreakdown> {
  const r = await query<TaxonomySqlRow>(`SELECT ${taxonomyResum('d')} FROM dmarc_rollup_daily d`);
  return breakdownFromSqlRow(r.rows[0]);
}

describe.skipIf(!RUN)('rollup maintenance (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
  });
  afterAll(async () => {
    await closePool();
  });
  beforeEach(async () => {
    await query(
      `TRUNCATE dmarc_records, dmarc_reports, dmarc_rollup_daily, dmarc_rollup_source_daily RESTART IDENTITY CASCADE`
    );
  });

  it('rollup matches a raw recompute after initial ingest', async () => {
    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 100, 'ok'), rec('2.2.2.2', 10, 'fwd'), rec('2.2.2.2', 5, 'fail')] }));
    await insertReport(report({ reportId: 'r2', domain: 'other.com', orgName: 'yahoo.com', records: [rec('9.9.9.9', 50, 'ok')] }));
    expect(await rollupBreakdown()).toEqual(await rawBreakdown());
  });

  it('identical re-POST is a no-op', async () => {
    const recs = [rec('1.1.1.1', 100, 'ok'), rec('2.2.2.2', 10, 'fwd')];
    await insertReport(report({ reportId: 'r1', records: recs }));
    const before = await query(`SELECT * FROM dmarc_rollup_daily ORDER BY domain`);
    await insertReport(report({ reportId: 'r1', records: recs }));
    const after = await query(`SELECT * FROM dmarc_rollup_daily ORDER BY domain`);
    expect(after.rows).toEqual(before.rows);
    expect(await rollupBreakdown()).toEqual(await rawBreakdown());
  });

  it('changed re-POST keeps parity (add/remove/adjust sources)', async () => {
    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 100, 'ok'), rec('2.2.2.2', 5, 'fail')] }));
    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 80, 'ok'), rec('4.4.4.4', 8, 'fail')] }));
    expect(await rollupBreakdown()).toEqual(await rawBreakdown());
  });

  it('report_count equals the number of report rows', async () => {
    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 1, 'ok')] }));
    await insertReport(report({ reportId: 'r2', domain: 'b.com', records: [rec('1.1.1.1', 1, 'ok')] }));
    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 2, 'ok')] })); // re-POST, no new report
    const r = await query<{ rc: string; reports: string }>(
      `SELECT (SELECT COALESCE(SUM(report_count),0) FROM dmarc_rollup_daily) rc,
              (SELECT COUNT(*) FROM dmarc_reports) reports`
    );
    expect(r.rows[0].rc).toBe(r.rows[0].reports);
  });

  it('source rows route to month partitions, default stays empty', async () => {
    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 10, 'ok')] }));
    const def = await query<{ n: string }>(`SELECT COUNT(*) n FROM ONLY dmarc_rollup_source_daily_default`);
    expect(def.rows[0].n).toBe('0');
    const part = await query<{ n: string }>(`SELECT COUNT(*) n FROM dmarc_rollup_source_daily_202609`);
    expect(Number(part.rows[0].n)).toBeGreaterThan(0);
  });

  it('backfill reproduces the same reads as incremental maintenance', async () => {
    // Non-zero source totals: excludes the zeroed row incremental leaves when a
    // source is dropped on re-POST, which reads sum over harmlessly.
    const sourceTotals = async () =>
      (
        await query<{ domain: string; source_ip: string; v: string }>(
          `SELECT domain, source_ip, SUM(total_volume)::text v
           FROM dmarc_rollup_source_daily GROUP BY domain, source_ip
           HAVING SUM(total_volume) <> 0 ORDER BY domain, source_ip`
        )
      ).rows;

    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 100, 'ok'), rec('2.2.2.2', 5, 'fail')] }));
    await insertReport(report({ reportId: 'r2', domain: 'b.com', orgName: 'yahoo.com', records: [rec('9.9.9.9', 50, 'fwd')] }));
    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 80, 'ok'), rec('3.3.3.3', 8, 'fail')] })); // drops 2.2.2.2

    const incrOverall = await rollupBreakdown();
    const incrSources = await sourceTotals();

    await rebuildDmarcRollups();

    expect(await rollupBreakdown()).toEqual(incrOverall);
    expect(await sourceTotals()).toEqual(incrSources);
    expect(await rollupBreakdown()).toEqual(await rawBreakdown());
  });

  it('BIGINT rollup columns accumulate past 2^31 across reports', async () => {
    // A single dmarc_records.count is INTEGER (a real per-record count never
    // approaches 2^31). What overflows an INT is the SUM across many reports —
    // which is exactly why the rollup columns are BIGINT. 25 × 100M = 2.5e9 > 2^31.
    for (let i = 0; i < 25; i++) {
      await insertReport(report({ reportId: `big-${i}`, records: [rec('1.1.1.1', 100_000_000, 'ok')] }));
    }
    const r = await query<{ v: string }>(`SELECT total_volume::text v FROM dmarc_rollup_daily`);
    expect(r.rows[0].v).toBe('2500000000');
  });

  async function snapshot() {
    return {
      daily: (await query('SELECT * FROM dmarc_rollup_daily ORDER BY day, domain, org_name, policy')).rows,
      sources: (await query('SELECT * FROM dmarc_rollup_source_daily ORDER BY day, domain, source_ip')).rows,
    };
  }

  it('preserves retired days outside and inside the retained date range', async () => {
    for (let n = 0; n < 4; n++) {
      await insertReport(report({ reportId: `day-${n}`, dateBegin: DAY + n * 86400,
        dateEnd: DAY + n * 86400 + 3600, records: [rec('1.1.1.1', n + 1, 'ok')] }));
    }
    const before = await snapshot();
    await query("DELETE FROM dmarc_records WHERE report_day IN ('2026-09-15', '2026-09-17')");
    await query("DELETE FROM dmarc_reports WHERE date_begin::date IN ('2026-09-15', '2026-09-17')");
    const result = await rebuildDmarcRollups();
    expect(result.days).toBe(2);
    expect(await snapshot()).toEqual(before);
    await rebuildDmarcRollups();
    expect(await snapshot()).toEqual(before);
  });

  it('does not erase aggregates when all raw history is gone', async () => {
    await insertReport(report({ reportId: 'retired', records: [rec('1.1.1.1', 10, 'ok')] }));
    const before = await snapshot();
    await query('TRUNCATE dmarc_records, dmarc_reports');
    expect((await rebuildDmarcRollups()).days).toBe(0);
    expect(await snapshot()).toEqual(before);
  });

  it('refuses a partially missing retained day without changing either rollup', async () => {
    await insertReport(report({ reportId: 'one', records: [rec('1.1.1.1', 10, 'ok')] }));
    await insertReport(report({ reportId: 'two', domain: 'other.com', records: [rec('2.2.2.2', 20, 'ok')] }));
    const before = await snapshot();
    await query("DELETE FROM dmarc_records WHERE report_id IN (SELECT id FROM dmarc_reports WHERE report_id = 'two')");
    await query("DELETE FROM dmarc_reports WHERE report_id = 'two'");
    await expect(rebuildDmarcRollups()).rejects.toThrow('incomplete');
    expect(await snapshot()).toEqual(before);
  });

  it('refuses missing record evidence and missing original counts', async () => {
    await insertReport(report({ reportId: 'one', records: [rec('1.1.1.1', 10, 'ok')] }));
    const before = await snapshot();
    await query('DELETE FROM dmarc_records');
    await expect(rebuildDmarcRollups()).rejects.toThrow('incomplete');
    expect(await snapshot()).toEqual(before);
    await query('UPDATE dmarc_reports SET raw_payload = NULL');
    await expect(rebuildDmarcRollups()).rejects.toThrow('original record counts');
    expect(await snapshot()).toEqual(before);
  });

  it('rolls back all rebuilt days after a later-day write failure', async () => {
    await insertReport(report({ reportId: 'one', records: [rec('1.1.1.1', 10, 'ok')] }));
    await insertReport(report({ reportId: 'two', dateBegin: DAY + 86400, dateEnd: DAY + 90000,
      records: [rec('2.2.2.2', 20, 'ok')] }));
    const before = await snapshot();
    await query(`CREATE FUNCTION fail_rebuild_test() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.day = DATE '2026-09-16' THEN RAISE EXCEPTION 'injected rebuild failure'; END IF;
      RETURN NEW; END $$`);
    try {
      await query('CREATE TRIGGER fail_rebuild_test BEFORE INSERT ON dmarc_rollup_daily FOR EACH ROW EXECUTE FUNCTION fail_rebuild_test()');
      await expect(rebuildDmarcRollups()).rejects.toThrow('injected rebuild failure');
      expect(await snapshot()).toEqual(before);
    } finally {
      await query('DROP TRIGGER IF EXISTS fail_rebuild_test ON dmarc_rollup_daily');
      await query('DROP FUNCTION fail_rebuild_test()');
    }
  });

  it('rejects overlapping rebuilds without touching aggregates', async () => {
    const holder = await getClient();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT pg_advisory_xact_lock(hashtext('robin-admin:dmarc-rebuild'))");
      await expect(rebuildDmarcRollups()).rejects.toThrow('already running');
    } finally {
      await holder.query('ROLLBACK');
      holder.release();
    }
  });

  it('coordinates rebuild and real ingestion without losing or duplicating volume', async () => {
    await insertReport(report({ reportId: 'initial', records: [rec('1.1.1.1', 10, 'ok')] }));
    await Promise.all([
      rebuildDmarcRollups(),
      ...Array.from({ length: 8 }, (_, n) => insertReport(report({ reportId: `concurrent-${n}`,
        records: [rec('1.1.1.1', n + 1, 'ok')] }))),
    ]);
    expect(await rollupBreakdown()).toEqual(await rawBreakdown());
    expect((await query('SELECT SUM(report_count)::int AS n FROM dmarc_rollup_daily')).rows[0].n).toBe(9);
  });
});
