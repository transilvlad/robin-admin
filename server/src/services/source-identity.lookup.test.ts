import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
const { query } = await import('../db/connection.js');
const { getIdentities, getSourceWindowIdentities, pickIdentity } = await import('./source-identity.js');

beforeEach(() => vi.clearAllMocks());

describe('cached identity lookup', () => {
  it('does not query for an empty address list', async () => {
    expect(await getIdentities([''])).toEqual(new Map());
    expect(query).not.toHaveBeenCalled();
  });

  it('joins unique addresses and retains normalized IPv6 lookup and metadata', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [{ ip: '2001:db8::1', ptr: 'mail.example.test', fcrdns_verified: true,
      provider: 'Fixture', provider_category: 'mail', provider_via: 'cidr', auth_docs_url: 'https://example.test/auth', resolved_at: null }] } as never);
    const identities = await getIdentities(['2001:db8::1', '', '2001:db8::1', '192.0.2.1']);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('JOIN unnest($1::text[])'), [['2001:db8::1', '192.0.2.1']]);
    expect(identities.size).toBe(1);
    expect(pickIdentity(identities, '2001:0db8:0:0:0:0:0:1')).toMatchObject({ provider: 'Fixture', fcrdnsVerified: true, authDocsUrl: 'https://example.test/auth' });
    expect(pickIdentity(identities, '192.0.2.1')).toBeNull();
  });

  it('selects the latest IPv6 alias independently of query ordering', async () => {
    const row = (ip: string, provider: string, day: string) => ({ ip, provider, ptr: null,
      fcrdns_verified: false, provider_category: null, provider_via: 'cidr', auth_docs_url: null,
      resolved_at: new Date(day) });
    const older = row('2001:db8::1', 'Older', '2026-09-01');
    const newer = row('2001:0db8:0:0:0:0:0:1', 'Newer', '2026-09-02');
    for (const rows of [[older, newer], [newer, older]]) {
      vi.mocked(query).mockResolvedValue({ rows } as never);
      const identities = await getSourceWindowIdentities({ from: new Date('2026-09-01'), to: new Date('2026-09-30') });
      expect(pickIdentity(identities, older.ip)).toMatchObject({ provider: 'Newer' });
    }
    older.resolved_at = newer.resolved_at;
    for (const rows of [[older, newer], [newer, older]]) {
      vi.mocked(query).mockResolvedValue({ rows } as never);
      expect(pickIdentity(await getIdentities([older.ip, newer.ip]), older.ip)).toMatchObject({ provider: 'Older' });
    }
  });

  it('binds the reporting window and dimensions while requiring an exact cache address in scope', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ present: true }] } as never).mockResolvedValue({ rows: [] } as never);
    await getSourceWindowIdentities({ from: new Date('2026-09-01'), to: new Date('2026-09-30') },
      { domain: 'EXAMPLE.TEST', sourceIp: '2001:db8::1', reporter: 'ignored' });
    const [sql, params] = vi.mocked(query).mock.calls[1];
    expect(sql).toContain('a.source_ip = si.ip');
    expect(sql).toContain('ORDER BY group_key, source_ip');
    expect(sql).toContain('WHERE ip IS NOT NULL');
    expect(sql).toContain('s.domain = $3');
    expect(sql).toContain('s.source_ip = $4');
    expect(params).toEqual(['2026-09-01', '2026-09-30', 'example.test', '2001:db8::1']);
  });

  it('skips source representative scans when the scoped negative cache is empty', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ present: false }] } as never).mockResolvedValue({ rows: [] } as never);
    await getSourceWindowIdentities({ from: new Date('2026-09-01'), to: new Date('2026-09-30') });
    expect(query).toHaveBeenCalledTimes(2);
    expect(vi.mocked(query).mock.calls[0][0]).toContain('SELECT EXISTS');
    expect(vi.mocked(query).mock.calls[1][0]).not.toContain('WITH addresses');
    expect(vi.mocked(query).mock.calls[1][0]).toContain('s.source_ip = si.ip');
  });
});
