import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../db/connection.js';
import { getConfig } from '../db/queries/config.js';
import { getSourceWindowIdentities } from './source-identity.js';
import { invalidateReportingCache } from './reporting-cache.js';
import { TAXONOMY_COLUMNS } from './dmarc-taxonomy.js';
import {
  getBreakdown, getDomainAggregates, getRecords, getReporterAggregates,
  getSourceCountsByDomain, getTotals, getTrend,
} from './reporting-aggregate.js';
import { getSourceAggregates } from './reporting-sources.js';

vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('./source-identity.js', async importOriginal => ({
  ...await importOriginal<typeof import('./source-identity.js')>(),
  getSourceWindowIdentities: vi.fn().mockResolvedValue(new Map()),
}));

const morning = { from: new Date('2026-09-01T01:00:00Z'), to: new Date('2026-09-30T01:00:00Z'), defaulted: true };
const evening = { from: new Date('2026-09-01T22:00:00Z'), to: new Date('2026-09-30T22:00:00Z'), defaulted: false };

describe('reporting window cache boundaries', () => {
  beforeEach(() => {
    invalidateReportingCache();
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
    vi.mocked(getConfig).mockResolvedValue({
      reportingNonCompliantRateThreshold: .02,
      reportingNonCompliantMinVolume: 10,
      reportingNonCompliantAbsoluteFloor: 100,
    } as Awaited<ReturnType<typeof getConfig>>);
  });

  it.each([
    ['breakdown', getBreakdown], ['totals', getTotals], ['domains', getDomainAggregates],
    ['reporters', getReporterAggregates], ['trend', getTrend],
    ['source counts', getSourceCountsByDomain],
  ] as const)('%s shares equivalent day windows, but separates scopes and days', async (_name, read) => {
    await read(morning);
    const coldQueries = vi.mocked(query).mock.calls.length;
    expect(coldQueries).toBeGreaterThan(0);
    await read(evening, { domain: null, sourceIp: null, reporter: null });
    expect(query).toHaveBeenCalledTimes(coldQueries);
    await read(evening, { domain: 'other.test' });
    expect(query).toHaveBeenCalledTimes(coldQueries * 2);
    await read({ ...morning, from: new Date('2026-08-31') }, {});
    expect(query).toHaveBeenCalledTimes(coldQueries * 3);
  });

  it('retains nonempty domain-count maps', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ domain: 'mail.test', source_count: '12' }] } as never);
    const first = await getSourceCountsByDomain(morning);
    expect(first.get('mail.test')).toBe(12);
    expect(await getSourceCountsByDomain(evening)).toBe(first);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('shares source SQL while reading identities, reviews and policy live', async () => {
    await getSourceAggregates(morning);
    await getSourceAggregates(evening, { domain: null, sourceIp: null, reporter: null }, { search: 'changed', limit: 1 });
    const calls = vi.mocked(query).mock.calls;
    expect(calls.filter(([sql]) => sql.includes('FROM dmarc_rollup_source_daily'))).toHaveLength(1);
    expect(calls.filter(([sql]) => sql.includes('FROM source_review'))).toHaveLength(2);
    expect(getSourceWindowIdentities).toHaveBeenCalledTimes(2);
    expect(getConfig).toHaveBeenCalledTimes(2);
  });

  it('keeps raw-record timestamps, filters and pagination exact', async () => {
    await getRecords(morning);
    expect(query).toHaveBeenCalledTimes(2);
    await getRecords(evening);
    expect(query).toHaveBeenCalledTimes(4);
    expect(vi.mocked(query).mock.calls[0][1]?.slice(0, 2)).toEqual([morning.from, morning.to]);
    expect(vi.mocked(query).mock.calls[2][1]?.slice(0, 2)).toEqual([evening.from, evening.to]);
    await getRecords(evening, {}, { search: 'other', limit: 1, offset: 1 });
    expect(query).toHaveBeenCalledTimes(6);
  });

  it('yields large source-processing chunks and preserves their totals', async () => {
    const rows = Array.from({ length: 2049 }, (_, index) => ({
      ...Object.fromEntries(TAXONOMY_COLUMNS.map(column => [column, column === 'total_volume' || column === 'compliant_volume' ? 1 : 0])),
      source_ip: `198.18.${Math.floor(index / 256)}.${index % 256}`,
      ips: [`198.18.${Math.floor(index / 256)}.${index % 256}`], ip_count: '1',
      domains: ['one.test'], first_seen: '2026-09-01', last_seen: '2026-09-30',
      dkim_ok_volume: 1, spf_ok_volume: 1,
    }));
    vi.mocked(query).mockImplementation(async sql => ({ rows: sql.includes('FROM dmarc_rollup_source_daily') ? rows : [] }) as never);
    let yielded = false;
    const immediate = setImmediate(() => { yielded = true; });
    try {
      const result = await getSourceAggregates(morning);
      expect(yielded).toBe(true);
      expect(result.total).toBe(9);
      expect(result.items.reduce((sum, source) => sum + source.breakdown.totalVolume, 0)).toBe(2049);
      expect(result.items[0].breakdown.totalVolume).toBe(256);
      expect(result.items[0].domainCount).toBe(1);
      expect(result.items[0].ipCount).toBe(256);
    } finally { clearImmediate(immediate); }
  });
});
