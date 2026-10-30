import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../connection.js';
import { mailPolicyAvailable, normalizeMailAddress, normalizeMailDomain, saveMailDomain, saveSenderGrant, revokeSenderGrant, MailPolicyInputError } from './mail-policy.js';

vi.mock('../connection.js', () => ({ query: vi.fn() }));
beforeEach(() => vi.clearAllMocks());

describe('canonical mail policy', () => {
  it('normalizes exact addresses and domains without accepting wildcard routing syntax', () => {
    expect(normalizeMailAddress(' Person+tag@Example.TEST ')).toBe('person+tag@example.test');
    expect(normalizeMailDomain('EXAMPLE.TEST')).toBe('example.test');
    for (const address of ['@example.test', 'a', 'a,b@example.test', 'a b@example.test', '.a@example.test', 'a..b@example.test', 'a@example.test\nBcc: other@example.test', null, ['a@example.test']]) {
      expect(() => normalizeMailAddress(address)).toThrow(MailPolicyInputError);
    }
    for (const domain of ['localhost', '*.example.test', '-invalid.test', 'a..test', 'a/test', 'a.'.repeat(130) + 'test']) {
      expect(() => normalizeMailDomain(domain)).toThrow(MailPolicyInputError);
    }
  });

  it('does not silently enable absent schemas', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ ready: false }] } as never);
    expect(await mailPolicyAvailable()).toBe(false);
  });

  it('requires explicit policy booleans and local catch-all targets', async () => {
    await expect(saveMailDomain({ domain: 'example.test', enabled: 'true', plus_addressing: false, catch_all: null })).rejects.toThrow(MailPolicyInputError);
    expect(query).not.toHaveBeenCalled();
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);
    await expect(saveMailDomain({ domain: 'example.test', enabled: true, plus_addressing: false, catch_all: 'unknown@example.test' })).rejects.toThrow('existing local mailbox');
  });

  it('rejects grants that mislabel delegated identities as primary', async () => {
    await expect(saveSenderGrant({ account: 'a@example.test', address: 'b@example.test', grant_type: 'primary' })).rejects.toThrow('must match');
    await expect(saveSenderGrant({ account: 'a@example.test', address: 'a@example.test', grant_type: 'alias' })).rejects.toThrow('Use a primary');
    await expect(saveSenderGrant({ account: 'a@example.test', address: 'b@example.test', grant_type: 'owner' })).rejects.toThrow('Unknown grant');
    expect(query).not.toHaveBeenCalled();
  });

  it('requires a current account, sender domain and corresponding routing identity atomically', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rows: [] } as never);
    await expect(saveSenderGrant({ account: 'A@Example.TEST', address: 'alias@example.test', grant_type: 'alias' })).rejects.toThrow('existing account');
    expect(query).toHaveBeenCalledWith(expect.stringContaining('FROM mail_domains'), ['a@example.test', 'alias@example.test', 'alias']);
    expect(vi.mocked(query).mock.calls[0][0]).toContain("FROM aliases WHERE source = $2");
  });

  it('revokes an exact identity rather than all account grants', async () => {
    vi.mocked(query).mockResolvedValueOnce({ rowCount: 1, rows: [] } as never);
    expect(await revokeSenderGrant('A@EXAMPLE.TEST', 'B@EXAMPLE.TEST')).toBe(true);
    expect(query).toHaveBeenCalledWith('DELETE FROM mail_sender_grants WHERE account = $1 AND address = $2', ['a@example.test', 'b@example.test']);
  });
});
