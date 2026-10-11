/**
 * Read-parity integration tests: the rollup-backed aggregate readers must return
 * the same numbers as a recompute straight from the raw records. Skipped unless
 * ROLLUP_IT_DB=1 (see dmarc-rollup.integration.test.ts for how to run).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { initializeSchema } from '../db/schema.js';
import { query, closePool } from '../db/connection.js';
import { insertReport, type DmarcReportInput } from '../db/queries/dmarc.js';
import { getConfig, updateConfig } from '../db/queries/config.js';
import { invalidateReportingCache } from './reporting-cache.js';
import { getSourceAggregates } from './reporting-sources.js';
import {
  getTotals,
  getBreakdown,
  getTrend,
  getDomainAggregates,
  getReporterAggregates,
  type Timeframe,
} from './reporting-aggregate.js';
import {
  breakdownFromSqlRow,
  type TaxonomyBreakdown,
  type TaxonomySqlRow,
} from './dmarc-taxonomy.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

const D = Date.UTC(2026, 8, 15) / 1000; // 2026-09-15
const DAY = 86400;

// A window comfortably covering the two test days.
const TF: Timeframe = { from: new Date((D - 3 * DAY) * 1000), to: new Date((D + DAY) * 1000) };

function report(o: Partial<DmarcReportInput> & { reportId: string }): DmarcReportInput {
  return {
    orgName: 'google.com',
    email: 'x@google.com',
    domain: 'a.com',
    dateBegin: D,
    dateEnd: D + 86399,
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

// Raw recompute of the taxonomy for an optional domain/reporter filter.
async function rawBreakdown(filter: { domain?: string; reporter?: string } = {}): Promise<TaxonomyBreakdown> {
  const conds: string[] = [];
  const params: unknown[] = [];
  if (filter.domain) {
    params.push(filter.domain.toLowerCase());
    conds.push(`LOWER(rep.domain) = $${params.length}`);
  }
  if (filter.reporter) {
    params.push(filter.reporter.toLowerCase());
    conds.push(`LOWER(rep.org_name) = $${params.length}`);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const r = await query<TaxonomySqlRow>(
    `SELECT
       SUM(COALESCE(rc.count,0)) AS total_volume,
       0 AS compliant_volume, 0 AS fully_aligned_volume, 0 AS dkim_aligned_volume,
       0 AS spf_aligned_volume, 0 AS authenticated_unaligned_volume,
       0 AS dkim_authenticated_volume, 0 AS spf_authenticated_volume, 0 AS failed_volume,
       0 AS benign_relay_volume, 0 AS actionable_failure_volume
     FROM dmarc_records rc JOIN dmarc_reports rep ON rep.id = rc.report_id ${where}`,
    params
  );
  // Only total_volume is compared here (enough to catch grouping/scoping errors);
  // full-taxonomy parity is covered in dmarc-rollup.integration.test.ts.
  return breakdownFromSqlRow(r.rows[0]);
}

describe.skipIf(!RUN)('reporting read parity (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
  });
  afterAll(async () => {
    await closePool();
  });
  beforeEach(async () => {
    await query(
      `TRUNCATE dmarc_records, dmarc_reports, dmarc_rollup_daily, dmarc_rollup_source_daily, source_identity, source_review RESTART IDENTITY CASCADE`
    );
    invalidateReportingCache(); // aggregates are memoized; clear between cases
    await insertReport(report({ reportId: 'r1', domain: 'a.com', orgName: 'google.com', records: [rec('1.1.1.1', 100, 'ok'), rec('2.2.2.2', 10, 'fwd'), rec('2.2.2.2', 5, 'fail')] }));
    await insertReport(report({ reportId: 'r2', domain: 'a.com', orgName: 'yahoo.com', records: [rec('3.3.3.3', 50, 'ok')] }));
    await insertReport(report({ reportId: 'r3', domain: 'b.com', orgName: 'google.com', dateBegin: D - DAY, dateEnd: D - DAY + 3600, records: [rec('1.1.1.1', 7, 'fail')] }));
    await insertReport(report({ reportId: 'r4', domain: 'a.com', orgName: 'google.com', dateBegin: D - DAY, dateEnd: D - DAY + 3600, records: [rec('1.1.1.1', 20, 'ok')] }));
    invalidateReportingCache();
  });

  it('getTotals matches raw counts and volume', async () => {
    const totals = await getTotals(TF);
    expect(totals.breakdown.totalVolume).toBe((await rawBreakdown()).totalVolume); // 192
    expect(totals.domainCount).toBe(2); // a.com, b.com
    expect(totals.reportCount).toBe(4);
    expect(totals.reporterCount).toBe(2); // google, yahoo
    expect(totals.sourceCount).toBe(3); // 1.1.1.1, 2.2.2.2, 3.3.3.3
  });

  it('getTotals scoped to a domain matches raw', async () => {
    const totals = await getTotals(TF, { domain: 'a.com' });
    expect(totals.breakdown.totalVolume).toBe((await rawBreakdown({ domain: 'a.com' })).totalVolume); // 185
    expect(totals.domainCount).toBe(1);
    expect(totals.reportCount).toBe(3); // r1, r2, r4
    expect(totals.sourceCount).toBe(3); // 1.1.1.1, 2.2.2.2, 3.3.3.3
  });

  it('getBreakdown scoped to a domain matches raw', async () => {
    expect((await getBreakdown(TF, { domain: 'b.com' })).totalVolume).toBe(
      (await rawBreakdown({ domain: 'b.com' })).totalVolume
    ); // 7
  });

  it('getTrend spans both days and sums to the overall total', async () => {
    const trend = await getTrend(TF);
    expect(trend.map((p) => p.date).sort()).toEqual(['2026-09-14', '2026-09-15']);
    const sum = trend.reduce((acc, p) => acc + p.breakdown.totalVolume, 0);
    expect(sum).toBe((await rawBreakdown()).totalVolume);
  });

  it('getDomainAggregates matches raw per-domain counts', async () => {
    const page = await getDomainAggregates(TF, {}, { limit: 50 });
    const byDomain = Object.fromEntries(page.items.map((d) => [d.domain, d]));
    expect(page.total).toBe(2);
    expect(byDomain['a.com'].reportCount).toBe(3);
    expect(byDomain['a.com'].sourceCount).toBe(3);
    expect(byDomain['b.com'].reportCount).toBe(1);
    expect(byDomain['b.com'].sourceCount).toBe(1);
    expect(byDomain['a.com'].breakdown.totalVolume).toBe((await rawBreakdown({ domain: 'a.com' })).totalVolume);
  });

  it('getReporterAggregates matches raw per-reporter report counts', async () => {
    const reporters = await getReporterAggregates(TF, {}, { limit: 20 });
    const byReporter = Object.fromEntries(reporters.map((r) => [r.reporter, r]));
    expect(byReporter['google.com'].reportCount).toBe(3); // r1, r3, r4
    expect(byReporter['yahoo.com'].reportCount).toBe(1); // r2
  });

  it('folds complete overlapping domain sets before sampling display names', async () => {
    for (let n = 0; n < 40; n++) {
      await insertReport(report({ reportId: `many-${n}`, domain: `many${n}.com`,
        records: [...(n < 30 ? [rec('10.0.0.1', 10, 'ok')] : []), ...(n >= 10 ? [rec('10.0.0.2', 5, 'fail')] : [])] }));
    }
    invalidateReportingCache();
    const page = await getSourceAggregates(TF, {}, { limit: 50 });
    const folded = page.items.find(source => source.key === 'net:10.0.0.0/24');
    expect(folded?.ipCount).toBe(2);
    expect(folded?.domainCount).toBe(40);
    expect(folded?.domains).toHaveLength(25);
    expect(folded?.breakdown.totalVolume).toBe(450);
    expect(folded?.breakdown.compliantVolume).toBe(300);
    expect(folded?.breakdown.actionableFailureVolume).toBe(150);
  });

  it('refreshes reviews and identity grouping without clearing cached rollup rows', async () => {
    const initial = await getSourceAggregates(TF, {}, { limit: 50 });
    expect(initial.items.find(source => source.key === 'net:1.1.1.0/24')?.reviewState).toBe('pending');
    await query("INSERT INTO source_review(source_key,review_state,note) VALUES ('net:1.1.1.0/24','threat','Live decision')");
    const reviewed = await getSourceAggregates(TF, {}, { limit: 50 });
    expect(reviewed.items.find(source => source.key === 'net:1.1.1.0/24')).toMatchObject({ reviewState: 'threat', reviewNote: 'Live decision', bucket: 'threat_unknown' });
    await query("INSERT INTO source_identity(ip,provider) VALUES ('1.1.1.1','Fixture provider'),('3.3.3.3','Fixture provider')");
    const identified = await getSourceAggregates(TF, {}, { limit: 50 });
    expect(identified.items.find(source => source.key === 'provider:Fixture provider')).toMatchObject({ ipCount: 2, domainCount: 2 });
    expect(identified.total).toBe(initial.total - 1);
    const config = await getConfig();
    try {
      await updateConfig({ reportingNonCompliantAbsoluteFloor: 1 });
      const reclassified = await getSourceAggregates(TF, {}, { limit: 50 });
      expect(reclassified.items.find(source => source.key === 'provider:Fixture provider')?.bucket).toBe('non_compliant');
    } finally {
      await updateConfig({ reportingNonCompliantAbsoluteFloor: config.reportingNonCompliantAbsoluteFloor });
    }
    await query("UPDATE source_identity SET provider = 'Changed provider' WHERE ip = '1.1.1.1'");
    const changed = await getSourceAggregates(TF, {}, { limit: 50 });
    expect(changed.items.find(source => source.key === 'provider:Changed provider')).toMatchObject({ ipCount: 1 });
    await query("DELETE FROM source_identity WHERE ip IN ('1.1.1.1', '3.3.3.3')");
    const removed = await getSourceAggregates(TF, {}, { limit: 50 });
    expect(removed.total).toBe(initial.total);
    expect(removed.items.some(source => source.key.startsWith('provider:'))).toBe(false);
  });
});
