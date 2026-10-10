import { describe, it, expect } from 'vitest';
import {
  groupKeyFor,
  classifySource,
  NON_COMPLIANT_MIN_VOLUME,
  type SourceReviewState,
} from './reporting-sources.js';
import { emptyBreakdown, type TaxonomyBreakdown } from './dmarc-taxonomy.js';
import type { SourceIdentity } from './source-identity.js';

function identity(partial: Partial<SourceIdentity>): SourceIdentity {
  return {
    ip: '1.2.3.4',
    ptr: null,
    fcrdnsVerified: false,
    provider: null,
    providerCategory: null,
    providerVia: null,
    authDocsUrl: null,
    resolvedAt: null,
    ...partial,
  };
}

function breakdown(partial: Partial<TaxonomyBreakdown>): TaxonomyBreakdown {
  return { ...emptyBreakdown(), ...partial };
}

describe('groupKeyFor', () => {
  it('prefers the catalogue provider', () => {
    expect(groupKeyFor('209.85.220.41', identity({ provider: 'Google Workspace' }))).toEqual({
      key: 'provider:Google Workspace',
      displayName: 'Google Workspace',
      kind: 'provider',
    });
  });

  it('collapses a provider addresses under one row regardless of PTR', () => {
    const a = groupKeyFor('209.85.220.41', identity({ provider: 'Google Workspace', ptr: 'mail-sor-f41.google.com' }));
    const b = groupKeyFor('209.85.220.69', identity({ provider: 'Google Workspace', ptr: 'mail-sor-f69.google.com' }));
    expect(a.key).toBe(b.key);
  });

  it('names unknown infrastructure by the registrable domain of a verified PTR', () => {
    // Real shape from production: a37-8.craaza.com and a37-9.craaza.com are the
    // same sending platform and must not appear as two anonymous rows.
    const a = groupKeyFor('212.56.37.8', identity({ ptr: 'a37-8.craaza.com', fcrdnsVerified: true }));
    const b = groupKeyFor('212.56.37.9', identity({ ptr: 'a37-9.craaza.com', fcrdnsVerified: true }));
    expect(a).toEqual({ key: 'rdns:craaza.com', displayName: 'craaza.com', kind: 'rdns_domain' });
    expect(a.key).toBe(b.key);
  });

  it('refuses to name a source from an unverified PTR', () => {
    // A PTR is asserted by whoever controls the address block. Trusting one that
    // does not forward-confirm would let a sender name itself anything it liked.
    const result = groupKeyFor('212.56.37.8', identity({ ptr: 'a37-8.craaza.com', fcrdnsVerified: false }));
    expect(result.kind).toBe('network');
    expect(result.displayName).toBe('212.56.37.0/24');
  });

  it('groups PTR-less addresses by network so a block stays together', () => {
    // Production has a contiguous /24 of 104.234.123.x with no PTR at all;
    // ungrouped that is ~200 indistinguishable rows.
    const a = groupKeyFor('104.234.123.16', identity({}));
    const b = groupKeyFor('104.234.123.248', identity({}));
    expect(a.key).toBe('net:104.234.123.0/24');
    expect(a.key).toBe(b.key);
  });

  it('groups IPv6 addresses by /48', () => {
    const a = groupKeyFor('2a01:111:f403:c409::1', identity({}));
    const b = groupKeyFor('2a01:111:f403:c408::3', identity({}));
    expect(a.key).toBe('net:2a01:111:f403::/48');
    expect(a.key).toBe(b.key);
  });

  it('keeps distinct networks apart', () => {
    expect(groupKeyFor('104.234.123.16', identity({})).key).not.toBe(
      groupKeyFor('104.234.124.16', identity({})).key
    );
  });

  it('falls back to the bare address when nothing parses', () => {
    expect(groupKeyFor('not-an-ip', identity({}))).toMatchObject({ kind: 'address' });
  });

  it('handles a missing identity without throwing', () => {
    expect(groupKeyFor('1.2.3.4', null).kind).toBe('network');
  });
});

describe('classifySource', () => {
  const classify = (
    partial: Partial<TaxonomyBreakdown>,
    reviewState: SourceReviewState = 'pending',
    identified = false
  ) => classifySource({ breakdown: breakdown(partial), reviewState, identified });

  it('calls a fully compliant source capable', () => {
    expect(classify({ totalVolume: 1000, compliantVolume: 1000 })).toBe('capable');
  });

  it('treats a source with no mail as capable rather than failing', () => {
    expect(classify({})).toBe('capable');
  });

  it('does not flag a source for a handful of failures in a large volume', () => {
    // The old detector fired on a single failing message, which is how one rule
    // produced 462 identical alerts across 582 domains.
    expect(
      classify({ totalVolume: 100000, compliantVolume: 99999, actionableFailureVolume: 1 })
    ).toBe('capable');
  });

  it('flags a source once failures are both material and proportionate', () => {
    expect(
      classify(
        { totalVolume: 1000, compliantVolume: 900, actionableFailureVolume: 100 },
        'pending',
        true
      )
    ).toBe('non_compliant');
  });

  it('requires an absolute volume, not just a rate', () => {
    // Five failures out of five is 100% failing, but five messages is not a
    // signal — it is noise, and treating it as one is what people mean when
    // they say a DMARC tool is "full of false positives".
    const belowMinimum = NON_COMPLIANT_MIN_VOLUME - 5;
    expect(
      classify(
        { totalVolume: belowMinimum, compliantVolume: 0, actionableFailureVolume: belowMinimum },
        'pending',
        true
      )
    ).toBe('capable');
  });

  it('flags a large provider on absolute failures even when the rate is tiny', () => {
    // 200 unexplained failures inside 800,000 messages is 0.025% — well under
    // the rate threshold — but it is still 200 messages nobody can account for.
    // A pure rate test buries exactly the sources that carry the most mail.
    expect(
      classify(
        { totalVolume: 800000, compliantVolume: 799800, actionableFailureVolume: 200 },
        'pending',
        true
      )
    ).toBe('non_compliant');
  });

  it('does not call a wholly unauthenticated unknown source capable', () => {
    // Below the volume floor, but nothing it sent authenticated and we have no
    // idea who it is. Calling that "DMARC capable" is the false reassurance
    // this model exists to remove.
    expect(
      classify({ totalVolume: 3, compliantVolume: 0, actionableFailureVolume: 3 }, 'pending', false)
    ).toBe('threat_unknown');
  });

  it('still trusts an operator who authorised a low-volume unknown source', () => {
    expect(
      classify({ totalVolume: 3, compliantVolume: 0, actionableFailureVolume: 3 }, 'authorized', false)
    ).toBe('capable');
  });

  it('routes receiver-declared forwarding to the forwarder bucket', () => {    // If Google tells us it forwarded the message, that is the answer.
    expect(
      classify({
        totalVolume: 1000,
        compliantVolume: 900,
        benignRelayVolume: 100,
        actionableFailureVolume: 0,
      })
    ).toBe('forwarder');
  });

  it('sends failing unknown sources to the investigation bucket', () => {
    expect(
      classify(
        { totalVolume: 1000, compliantVolume: 500, actionableFailureVolume: 500 },
        'pending',
        false
      )
    ).toBe('threat_unknown');
  });

  it('treats a failing but recognised source as work, not a threat', () => {
    expect(
      classify(
        { totalVolume: 1000, compliantVolume: 500, actionableFailureVolume: 500 },
        'pending',
        true
      )
    ).toBe('non_compliant');
  });

  it('lets an operator approval reclassify an unidentified source', () => {
    expect(
      classify(
        { totalVolume: 1000, compliantVolume: 500, actionableFailureVolume: 500 },
        'authorized',
        false
      )
    ).toBe('non_compliant');
  });

  it('lets operator decisions override inference entirely', () => {
    // A source the operator has marked must stay marked; otherwise the next
    // batch of reports silently undoes their triage.
    expect(classify({ totalVolume: 1000, compliantVolume: 1000 }, 'threat')).toBe('threat_unknown');
    expect(classify({ totalVolume: 1000, compliantVolume: 1000 }, 'forwarder')).toBe('forwarder');
  });
});
