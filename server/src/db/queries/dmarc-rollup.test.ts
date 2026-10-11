import { describe, it, expect } from 'vitest';
import { computeRollupDelta, type RollupInputRecord } from './dmarc-rollup.js';
import { buildBreakdown, breakdownToColumnValues, TAXONOMY_COLUMNS } from '../../services/dmarc-taxonomy.js';

const N = TAXONOMY_COLUMNS.length;

/** Expected daily (taxonomy-only) column values for a set of records. */
function expected(records: RollupInputRecord[]): number[] {
  return breakdownToColumnValues(buildBreakdown(records));
}

/** Expected source vector (taxonomy + dkim_pass/spf_pass) for a set of records. */
function expectedSource(records: RollupInputRecord[]): number[] {
  let dkim = 0;
  let spf = 0;
  for (const r of records) {
    const c = Number(r.count ?? 0);
    if (c > 0) {
      if ((r.dkimResult ?? '').trim().toLowerCase() === 'pass') dkim += c;
      if ((r.spfResult ?? '').trim().toLowerCase() === 'pass') spf += c;
    }
  }
  return [...expected(records), dkim, spf];
}

const compliant = (ip: string, count: number): RollupInputRecord => ({
  sourceIp: ip,
  count,
  dkim: 'pass',
  spf: 'pass',
});
const forwarded = (ip: string, count: number): RollupInputRecord => ({
  sourceIp: ip,
  count,
  dkim: 'fail',
  spf: 'fail',
  dkimResult: 'pass',
  reasonType: 'forwarded',
});
const failed = (ip: string, count: number): RollupInputRecord => ({
  sourceIp: ip,
  count,
  dkim: 'fail',
  spf: 'fail',
});

describe('computeRollupDelta', () => {
  it('first ingest: daily = full contribution, report_count +1, one row per source', () => {
    const records = [compliant('1.1.1.1', 100), forwarded('2.2.2.2', 10), failed('2.2.2.2', 5)];
    const delta = computeRollupDelta([], records, true);

    expect(delta.reportCountDelta).toBe(1);
    expect(delta.daily).toEqual(expected(records));
    expect(delta.daily).toHaveLength(N);

    const byIp = Object.fromEntries(delta.sources.map((s) => [s.sourceIp, s.values]));
    expect(Object.keys(byIp).sort()).toEqual(['1.1.1.1', '2.2.2.2']);
    expect(byIp['1.1.1.1']).toEqual(expectedSource([compliant('1.1.1.1', 100)]));
    expect(byIp['2.2.2.2']).toEqual(expectedSource([forwarded('2.2.2.2', 10), failed('2.2.2.2', 5)]));
  });

  it('identical re-POST is a total no-op', () => {
    const records = [compliant('1.1.1.1', 100), forwarded('2.2.2.2', 10)];
    const delta = computeRollupDelta(records, records, false);

    expect(delta.reportCountDelta).toBe(0);
    expect(delta.daily.every((v) => v === 0)).toBe(true);
    expect(delta.sources).toEqual([]);
  });

  it('changed re-POST: removed source goes fully negative, added source positive', () => {
    const oldRecords = [compliant('1.1.1.1', 100), failed('2.2.2.2', 5)];
    const newRecords = [compliant('1.1.1.1', 100), compliant('3.3.3.3', 42)];
    const delta = computeRollupDelta(oldRecords, newRecords, false);

    expect(delta.reportCountDelta).toBe(0);
    const byIp = Object.fromEntries(delta.sources.map((s) => [s.sourceIp, s.values]));
    // 1.1.1.1 unchanged -> omitted
    expect(byIp['1.1.1.1']).toBeUndefined();
    // 2.2.2.2 removed -> negative of its old contribution (avoid -0 on zero cols)
    expect(byIp['2.2.2.2']).toEqual(expectedSource([failed('2.2.2.2', 5)]).map((v) => (v === 0 ? 0 : -v)));
    // 3.3.3.3 added
    expect(byIp['3.3.3.3']).toEqual(expectedSource([compliant('3.3.3.3', 42)]));
  });

  it('daily delta equals the sum of the source deltas (composition)', () => {
    const oldRecords = [compliant('1.1.1.1', 100), failed('2.2.2.2', 5)];
    const newRecords = [compliant('1.1.1.1', 80), compliant('3.3.3.3', 42)];
    const delta = computeRollupDelta(oldRecords, newRecords, false);

    // Source vectors carry taxonomy + 2 extras; the daily grain is taxonomy-only,
    // so compare against the first N (taxonomy) columns of the summed sources.
    const summed = new Array(N).fill(0);
    for (const source of delta.sources) {
      for (let i = 0; i < N; i++) summed[i] += source.values[i];
    }
    expect(delta.daily).toEqual(summed);
  });

  it('accumulating deltas equals a fresh rebuild of the final records', () => {
    // Simulate the rollup accumulator across a first insert then a changed re-POST.
    const acc = new Array(N).fill(0);
    let reportCount = 0;

    const first = [compliant('1.1.1.1', 100), failed('2.2.2.2', 5)];
    let delta = computeRollupDelta([], first, true);
    for (let i = 0; i < N; i++) acc[i] += delta.daily[i];
    reportCount += delta.reportCountDelta;

    const second = [compliant('1.1.1.1', 100), forwarded('2.2.2.2', 5), compliant('3.3.3.3', 7)];
    delta = computeRollupDelta(first, second, false);
    for (let i = 0; i < N; i++) acc[i] += delta.daily[i];
    reportCount += delta.reportCountDelta;

    expect(acc).toEqual(expected(second));
    expect(reportCount).toBe(1);
  });
});
