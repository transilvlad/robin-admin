import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { closePool, query } from '../connection.js';
import { mailPolicyAvailable, listMailDomains, saveMailDomain, listSenderGrants, saveSenderGrant, revokeSenderGrant } from './mail-policy.js';

const run = process.env.MAIL_POLICY_IT_DB === '1';

describe.skipIf(!run)('mail policy on migrated PostgreSQL', () => {
  beforeAll(() => {
    if (!/^robin_admin_policy_test_[a-f0-9]+$/.test(config.postgres.database)
        || config.postgres.host !== '127.0.0.1') {
      throw new Error('Integration tests require a uniquely named, isolated loopback fixture database');
    }
  });
  afterAll(closePool);

  it('uses the real migrated schema and explicit primary backfill', async () => {
    expect(await mailPolicyAvailable()).toBe(true);
    expect((await listMailDomains(1, 50)).rows).toEqual([{ domain: 'example.test', enabled: true, plus_addressing: false, catch_all: null }]);
    expect((await listSenderGrants(1, 50)).total).toBe(2);
  });

  it('persists policy and rejects external or nonexistent catch-all destinations', async () => {
    await expect(saveMailDomain({ domain: 'example.test', enabled: true, plus_addressing: false, catch_all: 'outside@external.test' })).rejects.toThrow('existing local mailbox');
    expect(await saveMailDomain({ domain: 'example.test', enabled: true, plus_addressing: true, catch_all: 'shared@example.test' })).toMatchObject({ catch_all: 'shared@example.test', plus_addressing: true });
    await saveMailDomain({ domain: 'example.test', enabled: true, plus_addressing: false, catch_all: null });
  });

  it('does not infer send permission from a multi-recipient alias', async () => {
    expect((await query("SELECT 1 FROM mail_sender_grants WHERE address = 'team@example.test'")).rowCount).toBe(0);
    const grant = { account: 'owner@example.test', address: 'team@example.test', grant_type: 'alias' as const };
    expect(await saveSenderGrant(grant)).toEqual(grant);
    expect((await query("SELECT count(*)::int AS targets FROM aliases WHERE source = 'team@example.test'")).rows[0].targets).toBe(2);
    expect(await revokeSenderGrant(grant.account, grant.address)).toBe(true);
    expect(await revokeSenderGrant(grant.account, grant.address)).toBe(false);
  });

  it('enforces explicit grants and domain disabling with the exact Java query', async () => {
    const senderQuery = `SELECT g.address FROM mail_sender_grants g
      JOIN users u ON lower(u.email)=g.account
      JOIN mail_domains d ON d.domain=split_part(g.address,'@',2)
      WHERE g.account=$1 AND g.address=$2 AND d.enabled=true`;
    const grant = { account: 'owner@example.test', address: 'shared@example.test', grant_type: 'delegated' as const };
    expect((await query(senderQuery, [grant.account, grant.address])).rowCount).toBe(0);
    await saveSenderGrant(grant);
    expect((await query(senderQuery, [grant.account, grant.address])).rowCount).toBe(1);
    await saveMailDomain({ domain: 'example.test', enabled: false, plus_addressing: false, catch_all: null });
    expect((await query(senderQuery, [grant.account, grant.address])).rowCount).toBe(0);
    await expect(saveSenderGrant(grant)).rejects.toThrow('enabled sender domain');
    await saveMailDomain({ domain: 'example.test', enabled: true, plus_addressing: false, catch_all: null });
  });

  it('rejects unknown accounts and arbitrary sender addresses', async () => {
    await expect(saveSenderGrant({ account: 'missing@example.test', address: 'shared@example.test', grant_type: 'delegated' })).rejects.toThrow('existing account');
    await expect(saveSenderGrant({ account: 'owner@example.test', address: 'unrouted@example.test', grant_type: 'alias' })).rejects.toThrow('matching mailbox or alias');
  });

  it('does not retain grants after the last alias target is removed', async () => {
    await saveSenderGrant({ account: 'owner@example.test', address: 'team@example.test', grant_type: 'alias' });
    await query("DELETE FROM aliases WHERE source='team@example.test' AND destination='owner@example.test'");
    expect((await query("SELECT 1 FROM mail_sender_grants WHERE address='team@example.test'")).rowCount).toBe(1);
    await query("DELETE FROM aliases WHERE source='team@example.test'");
    expect((await query("SELECT 1 FROM mail_sender_grants WHERE address='team@example.test'")).rowCount).toBe(0);
  });

  it('revokes primary and delegated identities on mailbox rename and deletion', async () => {
    await query("UPDATE users SET email='renamed@example.test' WHERE email='shared@example.test'");
    expect((await query("SELECT 1 FROM mail_sender_grants WHERE account='shared@example.test' OR address='shared@example.test'")).rowCount).toBe(0);
    await saveSenderGrant({ account: 'owner@example.test', address: 'renamed@example.test', grant_type: 'delegated' });
    await query("DELETE FROM users WHERE email='renamed@example.test'");
    expect((await query("SELECT 1 FROM mail_sender_grants WHERE address='renamed@example.test'")).rowCount).toBe(0);
  });
});
