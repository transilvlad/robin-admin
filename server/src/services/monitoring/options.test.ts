import { describe, expect, it } from 'vitest';
import { evaluateAssertions } from './assertions.js';
import { parseMonitoringOptions, validateMonitoringEndpoint, validateMonitoringHeaders, validateMonitoringProtocol } from './options.js';

describe('monitoring configuration contract', () => {
  it.each([null, [], { http: null }, { http: { method: null } }, { http: { headers: { Host: 'other' } } }, { http: { headers: { Authorization: 'secret' } } }, { http: { headers: { 'X-Test': 'one', 'x-test': 'two' } } }, { http: { body: 'not allowed on GET' } }, { http: { body: 'x'.repeat(65537), method: 'POST' } }, { http: { maxRedirects: 6 } }, { http: { followRedirects: false } }, { http: { assertions: [{ kind: 'body', operator: 'regex', value: '.*' }] } }, { http: { assertions: [{ kind: 'json', operator: 'exists', pointer: '/bad~2key' }] } }, { http: { assertions: Array.from({ length: 21 }, () => ({ kind: 'body', operator: 'contains', value: '' })) } }])('rejects malformed HTTP options %j', options => {
    expect(() => parseMonitoringOptions('http', options)).toThrow();
  });
  it.each([{ tcp: { tls: null } }, { tcp: { bannerContains: null } }, { dns: { expectedValues: null } }, { dns: { recordType: null } }, { dns: { resolver: 'resolver.example.test' } }, { smtp: { startTls: 'yes' } }])('rejects malformed protocol options %j', options => {
    expect(() => parseMonitoringOptions('tcp' in options ? 'tcp' : 'dns' in options ? 'dns' : 'smtp', options)).toThrow();
  });
  it('supports canonical protocol defaults', () => {
    expect(parseMonitoringOptions('http').http?.expectedStatuses).toHaveLength(100);
    expect(parseMonitoringOptions('tcp')).toEqual({ tcp: { tls: false, bannerContains: '' } });
    expect(parseMonitoringOptions('dns')).toEqual({ dns: { recordType: 'A', resolver: null, expectedValues: [] } });
    expect(parseMonitoringOptions('smtp', undefined, 587)).toEqual({ smtp: { startTls: true } });
    expect(parseMonitoringOptions('smtp', undefined, 25)).toEqual({ smtp: { startTls: false } });
    expect(parseMonitoringOptions('imap', undefined, 143)).toEqual({ imap: { startTls: true } });
    expect(parseMonitoringOptions('imap', undefined, 993)).toEqual({ imap: { startTls: false } });
  });
  it('validates protocol-specific ports and TLS settings', () => {
    expect(() => validateMonitoringProtocol({ checkType: 'tcp', endpoint: 'service.example.test', port: null, options: {}, tlsMode: 'strict', certExpiryDays: null })).toThrow('TCP port');
    expect(() => validateMonitoringProtocol({ checkType: 'http', endpoint: 'http://example.test', port: null, options: {}, tlsMode: 'strict', certExpiryDays: 14 })).toThrow('TLS');
    expect(() => validateMonitoringEndpoint('https://user:pass@example.test', 'http')).toThrow();
    expect(() => validateMonitoringEndpoint('https://example.test', 'tcp')).toThrow();
    expect(() => validateMonitoringProtocol({ checkType: 'smtp', endpoint: 'mail.example.test', port: 465, options: { smtp: { startTls: true } }, tlsMode: 'strict', certExpiryDays: null })).toThrow('implicit TLS');
    expect(() => validateMonitoringProtocol({ checkType: 'imap', endpoint: 'mail.example.test', port: 143, options: { imap: { startTls: true } }, tlsMode: 'strict', certExpiryDays: null })).not.toThrow();
    expect(() => validateMonitoringProtocol({ checkType: 'imap', endpoint: 'mail.example.test', port: 143, options: { imap: { startTls: false } }, tlsMode: 'strict', certExpiryDays: null })).not.toThrow();
    expect(() => validateMonitoringProtocol({ checkType: 'imap', endpoint: 'mail.example.test', port: 993, options: { imap: { startTls: true } }, tlsMode: 'strict', certExpiryDays: null })).toThrow('implicit TLS');
    expect(() => validateMonitoringProtocol({ checkType: 'imap', endpoint: 'mail.example.test', port: 993, options: {}, tlsMode: 'strict', certExpiryDays: null })).not.toThrow();
    expect(() => validateMonitoringProtocol({ checkType: 'imap', endpoint: 'mail.example.test', port: 1993, options: {}, tlsMode: 'strict', certExpiryDays: null })).not.toThrow();
    expect(() => validateMonitoringHeaders(JSON.parse('{"__proto__":"bad"}'))).toThrow();
  });
  it('evaluates own JSON fields, escaped pointers and typed scalars without code execution', () => {
    const results = evaluateAssertions([
      { kind: 'json', pointer: '/a~1b/~0key', operator: 'equals', value: null },
      { kind: 'json', pointer: '/constructor', operator: 'exists' },
      { kind: 'json', pointer: '/count', operator: 'equals', value: '3' },
      { kind: 'header', name: 'missing', operator: 'not_contains', value: 'secret' },
      { kind: 'header', name: 'constructor', operator: 'exists' },
    ], '{"a/b":{"~key":null},"count":3}', {});
    expect(results.map(result => result.passed)).toEqual([true, false, false, false, false]);
    expect(evaluateAssertions([{ kind: 'json', pointer: '', operator: 'exists' }], 'not json', {})[0]?.passed).toBe(false);
  });
});
