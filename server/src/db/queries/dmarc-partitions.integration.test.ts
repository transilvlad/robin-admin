/**
 * Integration tests for the monthly partitioning of the raw DMARC tables,
 * against a REAL Postgres. Skipped by default. To run:
 *   ROLLUP_IT_DB=1 DB_HOST=localhost DB_PORT=5433 DB_NAME=robin_test \
 *   DB_USER=test DB_PASSWORD=test SESSION_SECRET=x \
 *   npx vitest run src/db/queries/dmarc-partitions.integration.test.ts
 * Run one integration file at a time: they share and reset the same tables.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { initializeSchema } from '../schema.js';
import { query, closePool } from '../connection.js';
import { insertReport, type DmarcReportInput } from './dmarc.js';
import { cleanupOldReportingReports, resetConfigCacheForTests, setConfigValue } from './config.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

// A report from March 2024: old enough that neither month partition exists
// until the ingest creates it, and past any 90-day retention window.
const MARCH_2024 = Math.floor(Date.UTC(2024, 2, 10) / 1000);

function report(o: Partial<DmarcReportInput> & { reportId: string }): DmarcReportInput {
  return {
    orgName: 'google.com',
    email: 'x@google.com',
    domain: 'example.com',
    dateBegin: MARCH_2024,
    dateEnd: MARCH_2024 + 86399,
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

const rec = (sourceIp: string, count: number) => ({
  sourceIp, count, disposition: 'none', dkim: 'pass', spf: 'pass', dkimResult: 'pass', spfResult: 'pass', reasonType: '',
});

/** Which partition each row of `table` lives in, with a row count. */
async function partitionsHolding(table: 'dmarc_reports' | 'dmarc_records'): Promise<Record<string, number>> {
  const result = await query<{ part: string; n: string }>(
    `SELECT tableoid::regclass::text AS part, COUNT(*) AS n FROM ${table} GROUP BY 1`
  );
  return Object.fromEntries(result.rows.map((r) => [r.part, Number(r.n)]));
}

async function partitionExists(name: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>('SELECT to_regclass($1) IS NOT NULL AS exists', [name]);
  return result.rows[0].exists;
}

describe.skipIf(!RUN)('DMARC raw table partitioning (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
  });
  afterAll(async () => {
    await closePool();
  });
  beforeEach(async () => {
    await query(`TRUNCATE dmarc_records, dmarc_reports, dmarc_rollup_daily, dmarc_rollup_source_daily RESTART IDENTITY CASCADE`);
    await query('DROP TABLE IF EXISTS dmarc_reports_202403, dmarc_records_202403');
  });

  it('creates the month partitions a report needs and routes it and its records there', async () => {
    expect(await partitionExists('dmarc_reports_202403')).toBe(false);

    await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 10), rec('2.2.2.2', 5)] }));

    expect(await partitionsHolding('dmarc_reports')).toEqual({ dmarc_reports_202403: 1 });
    expect(await partitionsHolding('dmarc_records')).toEqual({ dmarc_records_202403: 2 });
  });

  it('a retried report updates its row and replaces its records', async () => {
    const first = await insertReport(report({ reportId: 'r1', records: [rec('1.1.1.1', 10), rec('2.2.2.2', 5)] }));
    const again = await insertReport(report({ reportId: 'r1', records: [rec('3.3.3.3', 7)] }));

    expect(again).toBe(first);
    const records = await query<{ source_ip: string }>('SELECT source_ip FROM dmarc_records');
    expect(records.rows).toEqual([{ source_ip: '3.3.3.3' }]);
    expect(await partitionsHolding('dmarc_reports')).toEqual({ dmarc_reports_202403: 1 });
  });

  it('retention drops an expired month from both tables and keeps the current one', async () => {
    await insertReport(report({ reportId: 'old', records: [rec('1.1.1.1', 10)] }));
    const now = Math.floor(Date.now() / 1000);
    await insertReport(report({ reportId: 'new', dateBegin: now, dateEnd: now + 3600, records: [rec('9.9.9.9', 1)] }));

    await setConfigValue('reportingRetentionDays', '90');
    resetConfigCacheForTests();
    const result = await cleanupOldReportingReports();

    expect(result.dmarc).toBeGreaterThanOrEqual(0);
    expect(await partitionExists('dmarc_reports_202403')).toBe(false);
    expect(await partitionExists('dmarc_records_202403')).toBe(false);
    const left = await query<{ report_id: string }>('SELECT report_id FROM dmarc_reports');
    expect(left.rows).toEqual([{ report_id: 'new' }]);
    expect(Object.values(await partitionsHolding('dmarc_records'))).toEqual([1]);
    // Nothing ever routed to the safety-net partitions.
    const defaults = await query<{ n: string }>(
      'SELECT (SELECT COUNT(*) FROM dmarc_reports_default) + (SELECT COUNT(*) FROM dmarc_records_default) AS n'
    );
    expect(defaults.rows[0].n).toBe('0');
  });
});
