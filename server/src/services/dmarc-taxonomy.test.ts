import { describe, it, expect } from 'vitest';
import {
  classifyRecord,
  normaliseFailureReason,
  buildBreakdown,
  mergeBreakdowns,
  emptyBreakdown,
  breakdownFromSqlRow,
  addSqlBreakdown,
  breakdownToColumnValues,
  complianceRate,
  taxonomySql,
  rollupTaxonomyColumnDdl,
  TAXONOMY_COLUMNS,
  TAXONOMY_PROJECTION,
} from './dmarc-taxonomy.js';

describe('classifyRecord', () => {
  it('treats either aligned axis as compliant, per the DMARC evaluation rule', () => {
    expect(classifyRecord({ dkim: 'pass', spf: 'pass' })).toMatchObject({
      class: 'compliant',
      detail: 'fully_aligned',
    });
    expect(classifyRecord({ dkim: 'pass', spf: 'fail' })).toMatchObject({
      class: 'compliant',
      detail: 'dkim_aligned',
    });
    expect(classifyRecord({ dkim: 'fail', spf: 'pass' })).toMatchObject({
      class: 'compliant',
      detail: 'spf_aligned',
    });
  });

  it('does not average the two axes: DKIM-only alignment is fully compliant', () => {
    // A domain whose mail is entirely forwarded keeps its DKIM signature and
    // loses SPF. It is 100% compliant, not 50%.
    const result = classifyRecord({ dkim: 'pass', spf: 'fail', spfResult: 'fail' });
    expect(result.class).toBe('compliant');
  });

  it('separates authenticated-but-unaligned from outright failure', () => {
    expect(classifyRecord({ dkim: 'fail', spf: 'fail', dkimResult: 'pass' })).toMatchObject({
      class: 'authenticated_unaligned',
      detail: 'dkim_authenticated',
    });
    expect(classifyRecord({ dkim: 'fail', spf: 'fail', spfResult: 'pass' })).toMatchObject({
      class: 'authenticated_unaligned',
      detail: 'spf_authenticated',
    });
    expect(classifyRecord({ dkim: 'fail', spf: 'fail' })).toMatchObject({
      class: 'failed',
      detail: 'unauthenticated',
    });
  });

  it('prefers DKIM when both raw results pass, as it survives relaying', () => {
    expect(
      classifyRecord({ dkim: 'fail', spf: 'fail', dkimResult: 'pass', spfResult: 'pass' }).detail
    ).toBe('dkim_authenticated');
  });

  it('marks receiver-declared forwarding as a benign relay, not a failure to chase', () => {
    for (const reason of ['forwarded', 'trusted_forwarder', 'mailing_list']) {
      expect(classifyRecord({ dkim: 'fail', spf: 'fail', reasonType: reason }).benignRelay).toBe(true);
    }
    for (const reason of ['local_policy', 'sampled_out', 'other', null, '']) {
      expect(classifyRecord({ dkim: 'fail', spf: 'fail', reasonType: reason }).benignRelay).toBe(false);
    }
  });

  it('is tolerant of casing, padding and nulls in report data', () => {
    expect(classifyRecord({ dkim: ' PASS ', spf: null }).class).toBe('compliant');
    expect(classifyRecord({ dkim: null, spf: undefined }).class).toBe('failed');
  });
});

describe('normaliseFailureReason', () => {
  it('maps the RFC 7489 override types and folds unknowns into other', () => {
    expect(normaliseFailureReason('forwarded')).toBe('forwarded');
    expect(normaliseFailureReason('Trusted-Forwarder')).toBe('trusted_forwarder');
    expect(normaliseFailureReason('mailing list')).toBe('mailing_list');
    expect(normaliseFailureReason('sampled_out')).toBe('sampled_out');
    expect(normaliseFailureReason('local_policy')).toBe('local_policy');
    expect(normaliseFailureReason('something_new')).toBe('other');
    expect(normaliseFailureReason(null)).toBe('none');
  });
});

describe('buildBreakdown', () => {
  it('reproduces the live production distribution', () => {
    // Shape taken from the running database on 2026-08-19:
    //   940,095 total / 937,926 compliant / 1,110 authenticated-unaligned
    //   1,059 failed / 1,938 forwarded / 114 local_policy
    const breakdown = buildBreakdown([
      { dkim: 'pass', spf: 'pass', count: 854492 },
      { dkim: 'pass', spf: 'fail', count: 83329 },
      { dkim: 'fail', spf: 'pass', count: 105 },
      { dkim: 'fail', spf: 'fail', dkimResult: 'pass', reasonType: 'forwarded', count: 32 },
      { dkim: 'fail', spf: 'fail', spfResult: 'pass', reasonType: 'forwarded', count: 1078 },
      { dkim: 'fail', spf: 'fail', reasonType: 'forwarded', count: 828 },
      { dkim: 'fail', spf: 'fail', reasonType: 'local_policy', count: 114 },
      { dkim: 'fail', spf: 'fail', count: 117 },
    ]);

    expect(breakdown.totalVolume).toBe(940095);
    expect(breakdown.compliantVolume).toBe(937926);
    expect(breakdown.authenticatedUnalignedVolume).toBe(1110);
    expect(breakdown.failedVolume).toBe(1059);
    expect(breakdown.byReason.forwarded).toBe(1938);
    expect(breakdown.byReason.local_policy).toBe(114);
    expect(breakdown.benignRelayVolume).toBe(1938);
    expect(breakdown.actionableFailureVolume).toBe(231);
    expect(complianceRate(breakdown)).toBeCloseTo(0.9977, 4);
  });

  it('keeps every non-compliant message in exactly one bucket', () => {
    const breakdown = buildBreakdown([
      { dkim: 'pass', spf: 'fail', count: 10 },
      { dkim: 'fail', spf: 'fail', dkimResult: 'pass', count: 5 },
      { dkim: 'fail', spf: 'fail', reasonType: 'forwarded', count: 7 },
      { dkim: 'fail', spf: 'fail', count: 3 },
    ]);
    expect(breakdown.compliantVolume + breakdown.authenticatedUnalignedVolume + breakdown.failedVolume)
      .toBe(breakdown.totalVolume);
    expect(breakdown.benignRelayVolume + breakdown.actionableFailureVolume)
      .toBe(breakdown.totalVolume - breakdown.compliantVolume);
  });

  it('ignores negative and non-numeric counts rather than corrupting totals', () => {
    const breakdown = buildBreakdown([
      { dkim: 'pass', spf: 'pass', count: 10 },
      { dkim: 'pass', spf: 'pass', count: -5 },
      { dkim: 'pass', spf: 'pass', count: null },
    ]);
    expect(breakdown.totalVolume).toBe(10);
  });

  it('reports a domain with no mail as compliant rather than 0%', () => {
    expect(complianceRate(emptyBreakdown())).toBe(1);
  });
});

describe('mergeBreakdowns', () => {
  it('sums to the same figures as classifying the union of the rows', () => {
    const rows = [
      { dkim: 'pass', spf: 'pass', count: 100 },
      { dkim: 'fail', spf: 'fail', dkimResult: 'pass', count: 20 },
      { dkim: 'fail', spf: 'fail', reasonType: 'forwarded', count: 9 },
    ];
    const merged = mergeBreakdowns(rows.map((row) => buildBreakdown([row])));
    expect(merged).toEqual(buildBreakdown(rows));
  });
});

describe('TAXONOMY_PROJECTION', () => {
  it('is null-safe on every nullable column it reads', () => {
    for (const column of ['dkim', 'spf', 'dkim_result', 'spf_result', 'reason_type', 'count']) {
      expect(TAXONOMY_PROJECTION).toContain(`COALESCE(r.${column}`);
    }
  });

  it('normalises each verdict column exactly once', () => {
    // The whole point of the projection: if a normalisation is duplicated here
    // the aggregate re-derives it per reference and the scan slows by an order
    // of magnitude.
    const occurrences = (needle: string) =>
      TAXONOMY_PROJECTION.split(needle).length - 1;
    for (const column of ['r.dkim', 'r.spf', 'r.dkim_result', 'r.spf_result', 'r.reason_type']) {
      expect(occurrences(`COALESCE(${column},`)).toBe(1);
    }
  });
});

describe('taxonomySql', () => {
  it('reads the projected columns rather than re-deriving them', () => {
    const sql = taxonomySql();
    expect(sql).not.toContain('LOWER(');
    for (const column of ['tx_volume', 'tx_dkim_aligned', 'tx_spf_aligned', 'tx_reason']) {
      expect(sql).toContain(`tx.${column}`);
    }
  });

  it('honours a caller-supplied alias', () => {
    expect(taxonomySql('q')).toContain('q.tx_volume');
  });

  it('emits every column breakdownFromSqlRow reads back', () => {
    const sql = taxonomySql();
    const columns = Object.keys(
      breakdownFromSqlRow({
        total_volume: 0,
        compliant_volume: 0,
        fully_aligned_volume: 0,
        dkim_aligned_volume: 0,
        spf_aligned_volume: 0,
        authenticated_unaligned_volume: 0,
        dkim_authenticated_volume: 0,
        spf_authenticated_volume: 0,
        failed_volume: 0,
        benign_relay_volume: 0,
        actionable_failure_volume: 0,
      })
    );
    expect(columns.length).toBeGreaterThan(0);
    for (const alias of [
      'total_volume',
      'compliant_volume',
      'fully_aligned_volume',
      'dkim_aligned_volume',
      'spf_aligned_volume',
      'authenticated_unaligned_volume',
      'dkim_authenticated_volume',
      'spf_authenticated_volume',
      'failed_volume',
      'benign_relay_volume',
      'actionable_failure_volume',
    ]) {
      expect(sql).toContain(`AS ${alias}`);
    }
  });
});

describe('breakdownFromSqlRow', () => {
  it('parses the bigint strings node-postgres returns for SUM()', () => {
    const breakdown = breakdownFromSqlRow({
      total_volume: '940095',
      compliant_volume: '937926',
      fully_aligned_volume: '854492',
      dkim_aligned_volume: '83329',
      spf_aligned_volume: '105',
      authenticated_unaligned_volume: '1110',
      dkim_authenticated_volume: '32',
      spf_authenticated_volume: '1078',
      failed_volume: '1059',
      benign_relay_volume: '1938',
      actionable_failure_volume: '231',
    });
    expect(breakdown.totalVolume).toBe(940095);
    expect(breakdown.actionableFailureVolume).toBe(231);
    expect(complianceRate(breakdown)).toBeCloseTo(0.9977, 4);
  });

  it('returns an empty breakdown when the query matched no rows', () => {
    expect(breakdownFromSqlRow(undefined)).toEqual(emptyBreakdown());
  });
});

describe('rollup column mapping', () => {
  const sample = buildBreakdown([
    { dkim: 'pass', spf: 'pass', count: 100 },
    { dkim: 'pass', spf: 'fail', count: 20 },
    { dkim: 'fail', spf: 'fail', dkimResult: 'pass', reasonType: 'forwarded', count: 7 },
    { dkim: 'fail', spf: 'fail', reasonType: 'mailing_list', count: 3 },
    { dkim: 'fail', spf: 'fail', reasonType: 'local_policy', count: 5 },
    { dkim: 'fail', spf: 'fail', count: 11 },
  ]);

  it('emits one value per rollup column, in column order', () => {
    expect(breakdownToColumnValues(sample)).toHaveLength(TAXONOMY_COLUMNS.length);
  });

  it('accumulates SQL rows without allocating intermediate breakdowns', () => {
    const row = Object.fromEntries(TAXONOMY_COLUMNS.map((column, index) => [column, String(index + 1)]));
    const total = emptyBreakdown();
    addSqlBreakdown(total, row as never);
    addSqlBreakdown(total, undefined);
    addSqlBreakdown(total, row as never);
    expect(total).toEqual(mergeBreakdowns([breakdownFromSqlRow(row as never), breakdownFromSqlRow(row as never)]));
  });

  it('round-trips breakdown → columns → breakdown without loss', () => {
    // This is the drift guard: breakdownToColumnValues (write path) and
    // breakdownFromSqlRow (read path) must agree on every TAXONOMY_COLUMNS entry,
    // or a rollup would store numbers the reader can't reconstruct.
    const values = breakdownToColumnValues(sample);
    const row = Object.fromEntries(TAXONOMY_COLUMNS.map((col, i) => [col, values[i]]));
    expect(breakdownFromSqlRow(row as never)).toEqual(sample);
  });

  it('generates one BIGINT DDL column per taxonomy column', () => {
    const ddl = rollupTaxonomyColumnDdl();
    for (const column of TAXONOMY_COLUMNS) {
      expect(ddl).toContain(`${column} BIGINT NOT NULL DEFAULT 0`);
    }
  });
});
