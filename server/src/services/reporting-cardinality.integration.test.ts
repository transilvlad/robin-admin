import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../db/schema.js';
import { query, closePool } from '../db/connection.js';
import { invalidateReportingCache } from './reporting-cache.js';
import { getSourceAggregates, groupKeyFor } from './reporting-sources.js';
import { getSourceWindowIdentities } from './source-identity.js';

const run = process.env.ROLLUP_IT_DB === '1';
const timeframe = { from: new Date('2026-09-01'), to: new Date('2026-09-30') };
describe.skipIf(!run)('dense source cardinality (integration)', () => {
  beforeAll(async () => {
    if (!/^(robin_test($|_)|robin_release_reporting_)/.test(process.env.DB_NAME ?? '')
      || !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
      throw new Error('A fresh disposable loopback reporting database is required');
    }
    await initializeSchema();
    await query('TRUNCATE dmarc_rollup_source_daily, source_identity, source_review');
    await query(`INSERT INTO dmarc_rollup_source_daily
      (day,domain,source_ip,total_volume,compliant_volume,fully_aligned_volume,dkim_pass_volume,spf_pass_volume)
      SELECT '2026-09-01'::date+day.n,'dense-'||(ip.n%200)||'.example.test',
        '10.1.'||(ip.n/256)||'.'||(ip.n%256),10,10,10,10,10
      FROM generate_series(1,1000) ip(n),generate_series(0,2) day(n)`);
    await query(`INSERT INTO source_identity(ip,provider,provider_via)
      SELECT DISTINCT source_ip,'Fixture '||source_ip,'cidr' FROM dmarc_rollup_source_daily`);
    invalidateReportingCache();
  }, 120000);
  afterAll(async () => { await closePool(); });

  it('keeps every dense identity as an independent paginated group', async () => {
    const pages = await Promise.all([0, 500].map(offset => getSourceAggregates(timeframe, {}, { offset, limit: 500 })));
    for (const page of pages) {
      expect(page.total).toBe(1000);
      expect(page.bucketCounts).toMatchObject({ all: 1000, capable: 1000 });
      expect(page.items).toHaveLength(500);
      expect(page.items.every(source => source.ipCount === 1 && source.domainCount === 1 && source.breakdown.totalVolume === 30)).toBe(true);
    }
    expect(new Set(pages.flatMap(page => page.items.map(source => source.key))).size).toBe(1000);
  });
  it('reflects dense regrouping live and preserves full domain and address unions', async () => {
    await query("UPDATE source_identity SET provider='Shared fixture'");
    const result = await getSourceAggregates(timeframe);
    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ ipCount: 1000, domainCount: 200, breakdown: { totalVolume: 30000, compliantVolume: 30000 } });
    expect(result.items[0].ips).toHaveLength(20);
    expect(result.items[0].domains).toHaveLength(25);
    // Equal domain sets must not be mutated while folding or sampling.
    const scoped = await getSourceAggregates(timeframe, { domain: 'dense-1.example.test' });
    expect(scoped.items[0]).toMatchObject({ ipCount: 5, domainCount: 1, breakdown: { totalVolume: 150 } });
  });

  it('applies IPv6 aliases, verified PTR edits, removal and scope live', async () => {
    const domain = 'grouping-extra.example.test';
    const canonical = '2001:db8::1';
    const alias = '2001:0db8:0:0:0:0:0:1';
    try {
      await query(`INSERT INTO dmarc_rollup_source_daily
        (day, domain, source_ip, total_volume, compliant_volume)
        VALUES ('2026-09-01', $1, $2, 10, 10), ('2026-09-02', $1, $3, 20, 20)`, [domain, canonical, alias]);
      await query(`INSERT INTO source_identity(ip, provider, provider_via) VALUES ($1, 'Alias fixture', 'cidr')`, [canonical]);
      invalidateReportingCache();
      const read = () => getSourceAggregates(timeframe, { domain });
      expect((await read()).items[0]).toMatchObject({ key: 'provider:Alias fixture', ipCount: 2,
        domainCount: 1, breakdown: { totalVolume: 30 } });
      // The canonical cache address is outside this IP scope, just as with the
      // original exact-address identity lookup; do not invent a new identity.
      expect((await getSourceAggregates(timeframe, { domain, sourceIp: alias })).items[0].key).toBe(groupKeyFor(alias, null).key);
      await query(`UPDATE source_identity SET provider=NULL, ptr='mail.example.test', fcrdns_verified=TRUE WHERE ip=$1`, [canonical]);
      expect((await read()).items[0]).toMatchObject({ key: 'rdns:example.test', ipCount: 2 });
      await query(`UPDATE source_identity SET fcrdns_verified=FALSE WHERE ip=$1`, [canonical]);
      expect((await read()).total).toBe(2);
      await query('DELETE FROM source_identity WHERE ip=$1', [canonical]);
      expect((await read()).items.every(source => source.ptr === null && source.provider === null)).toBe(true);
    } finally {
      await query('DELETE FROM source_identity WHERE ip=$1', [canonical]);
      await query('DELETE FROM dmarc_rollup_source_daily WHERE domain=$1', [domain]);
      invalidateReportingCache();
    }
  });

  it('counts complete unknown networks while separating an identified address in the same block', async () => {
    const known = '10.200.0.0';
    try {
      await query(`INSERT INTO dmarc_rollup_source_daily(day,domain,source_ip,total_volume,compliant_volume)
        SELECT '2026-09-01'::date+day.n,'network-'||(ip.n%200)||'.example.test',
          '10.200.'||(ip.n/256)||'.'||(ip.n%256),10,10
        FROM generate_series(0,299) ip(n),generate_series(0,2) day(n)`);
      await query(`INSERT INTO source_identity(ip,provider,provider_via) VALUES ($1,'Network exception','cidr')`, [known]);
      await query(`INSERT INTO source_identity(ip,ptr,fcrdns_verified)
        SELECT DISTINCT source_ip,'unverified.example.test',FALSE FROM dmarc_rollup_source_daily
        WHERE domain LIKE 'network-%.example.test' AND source_ip <> $1`, [known]);
      invalidateReportingCache();
      const result = await getSourceAggregates(timeframe, {}, { limit: 500 });
      expect(result.items.find(source => source.key === 'net:10.200.0.0/24')).toMatchObject({ ipCount: 255, domainCount: 200,
        breakdown: { totalVolume: 7650, compliantVolume: 7650 }, firstSeen: '2026-09-01', lastSeen: '2026-09-03' });
      expect(result.items.find(source => source.key === 'provider:Network exception')).toMatchObject({ ipCount: 1, domainCount: 1, breakdown: { totalVolume: 30 } });
      expect(result.items.find(source => source.key === 'net:10.200.1.0/24')).toMatchObject({ ipCount: 44, domainCount: 44, breakdown: { totalVolume: 1320 } });
      const network = result.items.find(source => source.key === 'net:10.200.0.0/24')!;
      expect(network.ips).toHaveLength(20); expect(network.ips).not.toContain(known); expect(network.domains).toHaveLength(25);
      expect(network).toMatchObject({ ptr: 'unverified.example.test', fcrdnsVerified: false });
      await query(`UPDATE source_identity SET provider='Shared network fixture',provider_via='cidr'
        WHERE ip IN (SELECT source_ip FROM dmarc_rollup_source_daily WHERE domain LIKE 'network-%.example.test')`);
      const regrouped = await getSourceAggregates(timeframe, {}, { limit: 500 });
      expect(regrouped.items.find(source => source.key === 'provider:Shared network fixture')).toMatchObject({
        ipCount: 300, domainCount: 200, breakdown: { totalVolume: 9000, compliantVolume: 9000 },
        firstSeen: '2026-09-01', lastSeen: '2026-09-03'
      });
      expect(regrouped.items.some(source => source.key.startsWith('net:10.200.'))).toBe(false);
      const scoped = await getSourceAggregates(timeframe, { domain: 'network-1.example.test' });
      expect(scoped.items).toHaveLength(1);
      expect(scoped.items[0]).toMatchObject({ ipCount: 2, domainCount: 1, breakdown: { totalVolume: 60 } });
    } finally {
      await query(`DELETE FROM source_identity WHERE ip IN
        (SELECT source_ip FROM dmarc_rollup_source_daily WHERE domain LIKE 'network-%.example.test')`);
      await query("DELETE FROM dmarc_rollup_source_daily WHERE domain LIKE 'network-%.example.test'");
      invalidateReportingCache();
    }
  });

  it('selects sparse negative-cache metadata without replacing uncached representatives or losing aliases', async () => {
    const domain = 'sparse-identities.example.test';
    const ips = ['10.201.0.1', '10.201.0.2', '10.201.0.3', ' 10.201.0.3'];
    const uncachedAlias = ' 10.201.0.1';
    try {
      await query(`INSERT INTO dmarc_rollup_source_daily(day,domain,source_ip,total_volume,compliant_volume)
        SELECT '2026-09-01', $1, ip, 10, 10 FROM unnest($2::text[]) a(ip)`, [domain, ips]);
      await query(`INSERT INTO source_identity(ip,ptr,fcrdns_verified)
        VALUES ($1,'second.unverified.test',FALSE),($2,'alias.unverified.test',FALSE)`, [ips[1], ips[2]]);
      invalidateReportingCache();
      const read = () => getSourceAggregates(timeframe, { domain });
      // The whitespace alias sorts first and must still pick its canonical cache metadata.
      expect((await read()).items[0]).toMatchObject({ ipCount: 4, ptr: 'alias.unverified.test', breakdown: { totalVolume: 40 } });
      const canonicalScope = { domain, sourceIp: ips[0] };
      expect((await getSourceAggregates(timeframe, canonicalScope)).items[0].ptr).toBeNull();
      expect((await getSourceWindowIdentities(timeframe, { domain })).size).toBe(1);
      // A higher cached address cannot lend its PTR to an uncached minimum address.
      const noAliasWindow = { from: new Date('2026-09-02'), to: timeframe.to };
      await query(`INSERT INTO dmarc_rollup_source_daily(day,domain,source_ip,total_volume,compliant_volume)
        SELECT '2026-09-02', $1, ip, 10, 10 FROM unnest($2::text[]) a(ip)`, [domain, ips.slice(0,3)]);
      const noAliasRead = () => getSourceAggregates(noAliasWindow, { domain });
      expect((await getSourceWindowIdentities(noAliasWindow, { domain })).size).toBe(0);
      expect((await noAliasRead()).items[0]).toMatchObject({ ptr: null, ipCount: 3 });
      await query(`INSERT INTO source_identity(ip,ptr,fcrdns_verified) VALUES ($1,'first.unverified.test',FALSE)`, [ips[0]]);
      expect((await noAliasRead()).items[0]).toMatchObject({ ptr: 'first.unverified.test', ipCount: 3 });
      await query(`UPDATE source_identity SET ptr='changed.unverified.test' WHERE ip=$1`, [ips[0]]);
      expect((await noAliasRead()).items[0].ptr).toBe('changed.unverified.test');
      await query(`UPDATE source_identity SET provider='Live sparse fixture',provider_via='cidr' WHERE ip=$1`, [ips[1]]);
      const named = await noAliasRead();
      expect(named.items.find(source => source.key === 'provider:Live sparse fixture')).toMatchObject({ ipCount: 1, breakdown: { totalVolume: 10 } });
      expect(named.items.find(source => source.key.startsWith('net:'))).toMatchObject({ ipCount: 2, breakdown: { totalVolume: 20 } });
      await query('DELETE FROM source_identity WHERE ip=$1', [ips[0]]);
      expect((await noAliasRead()).items.find(source => source.key.startsWith('net:'))?.ptr).toBeNull();
      await query(`INSERT INTO dmarc_rollup_source_daily(day,domain,source_ip,total_volume,compliant_volume)
        VALUES ('2026-09-01',$1,$2,10,10)`, [domain, uncachedAlias]);
      await query(`INSERT INTO source_identity(ip,provider,provider_via) VALUES ($1,'Uncached alias fixture','cidr')`, [uncachedAlias]);
      invalidateReportingCache();
      const aliasNamed = await read();
      expect(aliasNamed.items.find(source => source.key === 'provider:Uncached alias fixture')).toMatchObject({ ipCount: 2, breakdown: { totalVolume: 30 } });
      expect(aliasNamed.items.find(source => source.key.startsWith('net:'))).toMatchObject({ ptr: 'alias.unverified.test', ipCount: 2 });
    } finally {
      await query('DELETE FROM source_identity WHERE ip=ANY($1::text[])', [[...ips, uncachedAlias]]);
      await query('DELETE FROM dmarc_rollup_source_daily WHERE domain=$1', [domain]);
      invalidateReportingCache();
    }
  });
});
