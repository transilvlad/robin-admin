import { describe, expect, it } from 'vitest';

import { lookupProvider, providerAuthDocs, PROVIDER_RULES } from './provider-catalog.js';

describe('lookupProvider', () => {
  it('identifies a provider from its rDNS suffix', () => {
    expect(lookupProvider('o1.ptr1234.example.sendgrid.net')?.name).toBe('SendGrid');
    expect(lookupProvider('a27-9.smtp-out.eu-west-1.amazonses.com')?.name).toBe('Amazon SES');
  });

  it('recognises Google infrastructure PTRs, which land on 1e100.net', () => {
    // Google's mail hosts do not reverse to google.com. Without this the
    // largest reporter on a typical fleet shows up as an opaque "1e100.net"
    // source sitting alongside a separate, half-sized "Google Workspace" one.
    expect(lookupProvider('x11-00.v6.unverified-forwarding.1e100.net')?.name).toBe(
      'Google Workspace'
    );
  });

  it('prefers the longest matching suffix', () => {
    // ".outbound.protection.outlook.com" must not lose to ".outlook.com",
    // and ".amazonses.com" must not lose to ".amazonaws.com".
    expect(lookupProvider('mail-am6eur05.outbound.protection.outlook.com')?.name).toBe(
      'Microsoft 365'
    );
    expect(lookupProvider('x.amazonses.com')?.name).toBe('Amazon SES');
  });

  it('is case- and trailing-dot-insensitive', () => {
    expect(lookupProvider('MAIL.SendGrid.NET.')?.name).toBe('SendGrid');
  });

  it('returns null for unrecognised hosts so the unknown bucket stays honest', () => {
    expect(lookupProvider('vps-12345.some-random-host.tld')).toBeNull();
    expect(lookupProvider(null)).toBeNull();
    expect(lookupProvider(undefined, undefined)).toBeNull();
  });

  it('ignores malformed IPs instead of throwing', () => {
    expect(() => lookupProvider(null, 'not-an-ip')).not.toThrow();
    expect(lookupProvider(null, 'not-an-ip')).toBeNull();
  });

  it('reports which signal produced the match', () => {
    expect(lookupProvider('x.sendgrid.net')?.via).toBe('rdns');
  });
});

describe('provider catalogue integrity', () => {
  it('has unique provider names', () => {
    const names = PROVIDER_RULES.map((rule) => rule.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('gives every rule at least one matching signal', () => {
    for (const rule of PROVIDER_RULES) {
      expect(
        (rule.hostSuffixes?.length ?? 0) + (rule.cidrs?.length ?? 0),
        `${rule.name} has no host suffixes or CIDRs`
      ).toBeGreaterThan(0);
    }
  });

  it('exposes remediation docs by provider name', () => {
    expect(providerAuthDocs('SendGrid')).toContain('sendgrid');
    expect(providerAuthDocs('Nonexistent Provider')).toBeNull();
    expect(providerAuthDocs(null)).toBeNull();
  });
});
