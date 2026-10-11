import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('./source-identity.js', async original => ({ ...await original<typeof import('./source-identity.js')>(), getSourceWindowIdentities: vi.fn() }));
vi.mock('./reporting-cache.js', async original => {
  const actual = await original<typeof import('./reporting-cache.js')>();
  return { ...actual, memo: vi.fn(actual.memo) };
});
const { query } = await import('../db/connection.js');
const { getConfig } = await import('../db/queries/config.js');
const { getSourceWindowIdentities } = await import('./source-identity.js');
const { invalidateReportingCache, memo, reportingCacheBytes } = await import('./reporting-cache.js');
const { getSourceAggregates } = await import('./reporting-sources.js');
import type { SourceIdentity } from './source-identity.js';
const timeframe = { from: new Date('2026-09-01'), to: new Date('2026-09-30') };
function identity(ip: string, provider: string): SourceIdentity {
  return { ip, provider, providerCategory: null, providerVia: 'cidr', ptr: null, fcrdnsVerified: false, authDocsUrl: null, resolvedAt: null };
}
const foldKeys = () => vi.mocked(memo).mock.calls.map(([key]) => key).filter(key => key.includes('sourceFold'));
beforeEach(() => {
  invalidateReportingCache(); vi.clearAllMocks();
  vi.mocked(query).mockImplementation(async sql => {
    if (String(sql).includes('source_review')) return { rows: [] } as never;
    return { rows: ['192.0.2.1', '192.0.2.2'].map((ip, index) => ({ source_ip: ip,
      ips: [ip], ip_count: '1', total_volume: String((index + 1) * 10),
      compliant_volume: String((index + 1) * 10), domains: ['example.test'],
      first_seen: '2026-09-01', last_seen: '2026-09-30',
    })) } as never;
  });
  vi.mocked(getConfig).mockResolvedValue({ reportingNonCompliantRateThreshold: 0.02, reportingNonCompliantMinVolume: 10, reportingNonCompliantAbsoluteFloor: 100 } as never);
  vi.mocked(getSourceWindowIdentities).mockResolvedValue(new Map());
});

describe('source fold identity fingerprint', () => {
  it('passes live IPv4 service keys but not negative cache or textual aliases to SQL', async () => {
    const provider = identity('192.0.2.1', 'Fixture');
    const ptr = { ...identity('192.0.2.2', ''), provider: null, ptr: 'mail.example.test', fcrdnsVerified: true };
    const negative = { ...identity('192.0.2.3', ''), provider: null, ptr: 'unverified.example.test' };
    const alias = identity('2001:db8::1', 'IPv6 fixture');
    vi.mocked(getSourceWindowIdentities).mockResolvedValue(new Map(
      [provider, ptr, negative, alias].map(value => [value.ip, value])
    ));
    await getSourceAggregates(timeframe);
    const [, params] = vi.mocked(query).mock.calls.find(([sql]) => String(sql).includes('dmarc_rollup_source_daily'))!;
    expect(params).toEqual(['2026-09-01', '2026-09-30',
      ['192.0.2.1', '192.0.2.2'], ['provider:Fixture', 'rdns:example.test']]);
  });

  it('reuses the fold when identity query order changes', async () => {
    const a = identity('192.0.2.1', 'Fixture'); const b = identity('192.0.2.2', 'Fixture');
    vi.mocked(getSourceWindowIdentities).mockResolvedValueOnce(new Map([[a.ip, a], [b.ip, b]])).mockResolvedValueOnce(new Map([[b.ip, b], [a.ip, a]]));
    const first = await getSourceAggregates(timeframe);
    expect(await getSourceAggregates(timeframe)).toEqual(first);
    expect(foldKeys()[0]).toBe(foldKeys()[1]);
    expect(vi.mocked(query).mock.calls.filter(([sql]) => String(sql).includes('dmarc_rollup_source_daily'))).toHaveLength(1);
  });

  it('reflects new, changed and removed identities without an explicit invalidation', async () => {
    expect((await getSourceAggregates(timeframe)).items[0]).toMatchObject({ key: 'net:192.0.2.0/24', ipCount: 2 });
    vi.mocked(getSourceWindowIdentities).mockResolvedValue(new Map([['192.0.2.1', identity('192.0.2.1', 'First')]]));
    expect((await getSourceAggregates(timeframe)).items.some(source => source.key === 'provider:First')).toBe(true);
    vi.mocked(getSourceWindowIdentities).mockResolvedValue(new Map([['192.0.2.1', identity('192.0.2.1', 'Second')]]));
    expect((await getSourceAggregates(timeframe)).items.some(source => source.key === 'provider:Second')).toBe(true);
    vi.mocked(getSourceWindowIdentities).mockResolvedValue(new Map());
    expect((await getSourceAggregates(timeframe)).items[0]).toMatchObject({ key: 'net:192.0.2.0/24', ipCount: 2 });
    expect(foldKeys()[0]).toBe(foldKeys()[3]);
    expect(new Set(foldKeys()).size).toBe(3);
    expect(vi.mocked(query).mock.calls.filter(([sql]) => String(sql).includes('dmarc_rollup_source_daily'))).toHaveLength(3);
  });

  it('retains sampled service folds rather than complete per-address counter rows', async () => {
    const domains = Array.from({ length: 200 }, (_, index) => `domain-${index}.example.test`);
    vi.mocked(query).mockImplementation(async sql => ({ rows: String(sql).includes('source_review') ? [] :
      ['192.0.2.1', '192.0.2.2'].map(source_ip => ({ source_ip, ips: [source_ip], ip_count: '1', domains,
        total_volume: '500000', compliant_volume: '500000' })) }) as never);
    const result = await getSourceAggregates(timeframe);
    expect(result.items[0]).toMatchObject({ ipCount: 2, domainCount: 200 });
    expect(result.items[0].domains).toHaveLength(25);
    expect(domains).toHaveLength(200);
    expect(reportingCacheBytes()).toBeLessThan(10 * 1024);
    expect(foldKeys()).toHaveLength(1);
  });

  it('shares concurrent folds, retains separate windows and reloads after invalidation', async () => {
    const reads = () => vi.mocked(query).mock.calls.filter(([sql]) => String(sql).includes('dmarc_rollup_source_daily')).length;
    const [first, second] = await Promise.all([getSourceAggregates(timeframe), getSourceAggregates(timeframe)]);
    expect(second).toEqual(first);
    expect(reads()).toBe(1);
    await getSourceAggregates({ ...timeframe, from: new Date('2026-09-02') });
    expect(reads()).toBe(2);
    expect(await getSourceAggregates(timeframe)).toEqual(first);
    expect(reads()).toBe(2);
    invalidateReportingCache();
    vi.mocked(query).mockImplementation(async sql => ({ rows: String(sql).includes('source_review') ? [] :
      [{ source_ip: '192.0.2.1', ips: ['192.0.2.1'], ip_count: '1', domains: ['new.test'], total_volume: '50', compliant_volume: '50' }] }) as never);
    expect((await getSourceAggregates(timeframe)).items[0]).toMatchObject({ ipCount: 1, domains: ['new.test'], breakdown: { totalVolume: 50 } });
    expect(reads()).toBe(3);
  });
});
