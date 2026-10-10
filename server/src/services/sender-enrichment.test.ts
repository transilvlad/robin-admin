import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockResolveTxt,
  mockResolveMx,
  mockReverse,
  mockResolve4,
  mockResolve6,
  mockGetConfig,
} = vi.hoisted(() => ({
  mockResolveTxt: vi.fn(),
  mockResolveMx: vi.fn(),
  mockReverse: vi.fn(),
  mockResolve4: vi.fn(),
  mockResolve6: vi.fn(),
  mockGetConfig: vi.fn(),
}));

vi.mock('node:dns/promises', () => ({
  default: {
    resolveTxt: mockResolveTxt,
    resolveMx: mockResolveMx,
    reverse: mockReverse,
    resolve4: mockResolve4,
    resolve6: mockResolve6,
    Resolver: class MockResolver {
      setServers() {}
      reverse(ip: string) {
        return mockReverse(ip);
      }
    },
  },
}));

vi.mock('../db/queries/config.js', () => ({
  getConfig: mockGetConfig,
}));

import { enrichSender, resolvePtrHost } from './sender-enrichment.js';

describe('sender-enrichment', () => {
  beforeEach(() => {
    mockResolveTxt.mockReset();
    mockResolveMx.mockReset();
    mockReverse.mockReset();
    mockResolve4.mockReset();
    mockResolve6.mockReset();
    mockGetConfig.mockResolvedValue({
      senderEnrichmentDnsTimeoutMs: 3000,
      dnsResolvers: '1.1.1.1,8.8.8.8',
    });
  });

  it('classifies DKIM-pass/SPF-unauthorized sources as forwarders', async () => {
    mockReverse.mockRejectedValue(new Error('no ptr'));
    mockResolveTxt.mockResolvedValue([
      ['v=spf1 ip4:198.51.100.0/24 -all'],
    ]);

    const result = await enrichSender({
      sourceIp: '203.0.113.25',
      reportDomain: 'forwarded.example',
      counts: {
        total: 10,
        pass: 9,
        dkimPass: 9,
        spfPass: 0,
      },
    });

    expect(result.classification).toBe('forwarder');
    expect(result.spfAuthorized).toBe(false);
    expect(result.reason).toContain('DKIM-pass without SPF');
  });

  it('preserves PTR hosts for display when FCrDNS does not confirm them', async () => {
    mockReverse.mockResolvedValue(['mx1.vendor.example.']);
    mockResolve4.mockRejectedValue(new Error('forward mismatch'));
    mockResolveTxt.mockResolvedValue([
      ['v=spf1 ip4:198.51.100.0/24 -all'],
    ]);

    const ptrHost = await resolvePtrHost('203.0.113.26');
    const result = await enrichSender({
      sourceIp: '203.0.113.26',
      reportDomain: 'forwarded.example',
      counts: {
        total: 10,
        pass: 0,
        dkimPass: 0,
        spfPass: 0,
      },
    });

    expect(ptrHost).toBe('mx1.vendor.example');
    expect(result.ptrHost).toBe('mx1.vendor.example');
    expect(result.rdnsHost).toBeNull();
  });
});
