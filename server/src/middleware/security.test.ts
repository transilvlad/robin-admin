import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_INGESTION_ALLOWED_CIDRS } from '../db/queries/config.js';
import {
  hasApiKeyScope,
  ipMatchesCidrs,
  parseList,
  safeFetch,
  validateOutboundUrl,
  validateOutboundUrlWithDns,
} from './security.js';

const { mockLookup } = vi.hoisted(() => ({ mockLookup: vi.fn() }));

vi.mock('node:dns/promises', () => ({
  default: {
    lookup: mockLookup,
  },
}));

describe('security middleware helpers', () => {
  it('parses comma and newline separated lists', () => {
    expect(parseList('10.0.0.0/8, 192.0.2.10\n\n2001:db8::/32')).toEqual([
      '10.0.0.0/8',
      '192.0.2.10',
      '2001:db8::/32',
    ]);
  });

  it('matches IPv4 and IPv6 CIDR allowlists', () => {
    expect(ipMatchesCidrs('10.1.2.3', ['10.0.0.0/8'])).toBe(true);
    expect(ipMatchesCidrs('203.0.113.8', ['10.0.0.0/8'])).toBe(false);
    expect(ipMatchesCidrs('2001:db8::1', ['2001:db8::/32'])).toBe(true);
  });

  it('defaults ingestion CIDRs to loopback and local container networks', () => {
    const defaults = parseList(DEFAULT_INGESTION_ALLOWED_CIDRS);

    expect(ipMatchesCidrs('127.0.0.1', defaults)).toBe(true);
    expect(ipMatchesCidrs('172.18.0.5', defaults)).toBe(true);
    expect(ipMatchesCidrs('10.5.0.10', defaults)).toBe(true);
    expect(ipMatchesCidrs('192.168.65.2', defaults)).toBe(true);
    expect(ipMatchesCidrs('203.0.113.10', defaults)).toBe(false);
  });

  it('supports wildcard and area API key scopes', () => {
    const req = {
      apiKey: {
        revokedAt: null,
        expiresAt: null,
        scopes: ['metrics:*', 'reports:ingest'],
      },
    } as any;

    expect(hasApiKeyScope(req, 'metrics:read')).toBe(true);
    expect(hasApiKeyScope(req, 'reports:ingest')).toBe(true);
    expect(hasApiKeyScope(req, 'users:read')).toBe(false);
  });

  it('blocks unsafe outbound URLs unless private URLs are explicitly allowed', () => {
    expect(validateOutboundUrl('ftp://example.com', false)).toBe('URL must use http or https');
    expect(validateOutboundUrl('http://127.0.0.1:8090', false)).toBe('Private, loopback, link-local, multicast, and reserved IP URLs are disabled');
    expect(validateOutboundUrl('http://[::1]:8090', false)).toBe('Private, loopback, link-local, multicast, and reserved IP URLs are disabled');
    expect(validateOutboundUrl('http://127.0.0.1:8090', true)).toBeNull();
    expect(validateOutboundUrl('http://[::1]:8090', true)).toBeNull();
    expect(validateOutboundUrl('https://mta.example.com', false)).toBeNull();
  });

  describe('validateOutboundUrlWithDns', () => {
    beforeEach(() => {
      mockLookup.mockReset();
    });

    it('rejects a hostname that resolves to a private address', async () => {
      mockLookup.mockResolvedValue([{ address: '10.1.2.3', family: 4 }]);
      const error = await validateOutboundUrlWithDns('https://internal.example', false);
      expect(error).toBe('Hostname resolves to a private, loopback, link-local, or reserved IP address');
    });

    it('rejects a hostname when any resolved address is disallowed', async () => {
      mockLookup.mockResolvedValue([
        { address: '8.8.8.8', family: 4 },
        { address: '169.254.169.254', family: 4 },
      ]);
      const error = await validateOutboundUrlWithDns('https://mixed.example', false);
      expect(error).toBe('Hostname resolves to a private, loopback, link-local, or reserved IP address');
    });

    it('allows a hostname that resolves only to public addresses', async () => {
      mockLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
      expect(await validateOutboundUrlWithDns('https://mta.example.com', false)).toBeNull();
    });

    it('fails closed when DNS resolution errors', async () => {
      mockLookup.mockRejectedValue(new Error('ENOTFOUND'));
      const error = await validateOutboundUrlWithDns('https://nowhere.example', false);
      expect(error).toBe('Hostname resolves to a private, loopback, link-local, or reserved IP address');
    });

    it('skips DNS resolution entirely when private URLs are allowed', async () => {
      expect(await validateOutboundUrlWithDns('https://internal.example', true)).toBeNull();
      expect(mockLookup).not.toHaveBeenCalled();
    });

    it('still rejects literal private IPs without needing a DNS lookup', async () => {
      const error = await validateOutboundUrlWithDns('http://127.0.0.1', false);
      expect(error).toBe('Private, loopback, link-local, multicast, and reserved IP URLs are disabled');
      expect(mockLookup).not.toHaveBeenCalled();
    });
  });

  describe('safeFetch', () => {
    const originalFetch = global.fetch;

    beforeEach(() => {
      mockLookup.mockReset();
      mockLookup.mockResolvedValue([{ address: '8.8.8.8', family: 4 }]);
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    it('returns null without fetching when the destination is disallowed', async () => {
      const fetchMock = vi.fn();
      global.fetch = fetchMock as unknown as typeof fetch;
      mockLookup.mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);

      const result = await safeFetch('https://internal.example/policy');
      expect(result).toBeNull();
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it('follows a redirect only after revalidating the new target', async () => {
      const redirectResponse = {
        status: 302,
        headers: new Headers({ location: 'https://still-public.example/final' }),
      };
      const finalResponse = { status: 200, headers: new Headers(), ok: true };
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(redirectResponse)
        .mockResolvedValueOnce(finalResponse);
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await safeFetch('https://public.example/policy');
      expect(result).toBe(finalResponse);
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][0]).toBe('https://still-public.example/final');
      // Each hop re-runs DNS validation, including the redirect target.
      expect(mockLookup).toHaveBeenCalledTimes(2);
    });

    it('refuses to follow a redirect into a private address', async () => {
      const redirectResponse = {
        status: 302,
        headers: new Headers({ location: 'http://169.254.169.254/latest/meta-data' }),
      };
      const fetchMock = vi.fn().mockResolvedValueOnce(redirectResponse);
      global.fetch = fetchMock as unknown as typeof fetch;
      mockLookup
        .mockResolvedValueOnce([{ address: '8.8.8.8', family: 4 }]);

      const result = await safeFetch('https://public.example/policy');
      expect(result).toBeNull();
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('gives up after too many redirects', async () => {
      const redirectResponse = {
        status: 302,
        headers: new Headers({ location: 'https://public.example/next' }),
      };
      const fetchMock = vi.fn().mockResolvedValue(redirectResponse);
      global.fetch = fetchMock as unknown as typeof fetch;

      const result = await safeFetch('https://public.example/start');
      expect(result).toBeNull();
      expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
    });
  });
});
