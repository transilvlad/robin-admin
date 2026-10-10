import { isIP } from 'node:net';
import { validateHeaderName, validateHeaderValue } from 'node:http';
import type { MonitoringCertificateErrorMode, MonitoringCheckOptions, MonitoringCheckType, MonitoringHttpAssertion, MonitoringHttpOptions } from '../../types/monitoring.js';

export class MonitoringInputError extends Error {}
export const MONITORING_LIMITS = { requestBytes: 65536, responseBytes: 1048576, bannerBytes: 8192, assertions: 20, headers: 32, redirects: 5, dnsRecords: 128 } as const;
const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];
const DNS_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'];
const RESERVED_HEADERS = /^(host|connection|content-length|transfer-encoding|upgrade|proxy-.*|te|trailer|accept-encoding)$/i;
const CREDENTIAL_HEADERS = /authorization|cookie|token|api[-_]?key|secret/i;

export function defaultHttpOptions(): MonitoringHttpOptions {
  return { method: 'GET', headers: {}, body: '', expectedStatuses: Array.from({ length: 100 }, (_, i) => 200 + i), followRedirects: true, maxRedirects: 3, maxResponseTimeMs: null, assertions: [] };
}
function invalid(message: string): never { throw new MonitoringInputError(message); }
function object(value: unknown, keys: string[], field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${field} must be an object`);
  if (Object.keys(value).some(key => !keys.includes(key))) invalid(`${field} contains unsupported settings`);
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || Buffer.byteLength(value) > max) invalid(`${field} must be a string of at most ${max} bytes`);
  return value;
}
function integer(value: unknown, min: number, max: number, field: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) invalid(`${field} must be an integer between ${min} and ${max}`);
  return value;
}
function boolean(value: unknown, field: string): boolean {
  if (typeof value !== 'boolean') invalid(`${field} must be a boolean`);
  return value;
}

export function validateMonitoringHeaders(value: unknown, secret = false): Record<string, string | null> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length > MONITORING_LIMITS.headers) invalid('headers must be an object with at most 32 entries');
  const headers: Record<string, string | null> = Object.create(null);
  for (const [name, raw] of Object.entries(value)) {
    const key = name.toLowerCase();
    if (RESERVED_HEADERS.test(key) || ['__proto__', 'constructor', 'prototype'].includes(key) || Object.hasOwn(headers, key)) invalid('headers contain a reserved or duplicate name');
    if (!secret && CREDENTIAL_HEADERS.test(key)) invalid('Credential headers must use secretHeaders');
    try { validateHeaderName(name); } catch { invalid('headers contain an invalid name'); }
    if (secret && raw === null) { headers[key] = null; continue; }
    const header = text(raw, 4096, 'header value');
    try { validateHeaderValue(name, header); } catch { invalid('headers contain an invalid value'); }
    headers[key] = header;
  }
  if (Buffer.byteLength(JSON.stringify(headers)) > 16384) invalid('headers exceed 16384 bytes');
  return headers;
}

function assertion(value: unknown): MonitoringHttpAssertion {
  const base = object(value, ['kind', 'operator', 'value', 'name', 'pointer'], 'assertion');
  const kind = base.kind;
  const allowed = kind === 'body' ? ['kind', 'operator', 'value'] : kind === 'header' ? ['kind', 'operator', 'name', 'value'] : ['kind', 'operator', 'pointer', 'value'];
  object(base, allowed, 'assertion');
  const operations = kind === 'body' ? ['contains', 'not_contains', 'equals'] : kind === 'header' ? ['exists', 'equals', 'contains', 'not_contains'] : ['exists', 'equals', 'not_equals', 'gt', 'gte', 'lt', 'lte', 'contains'];
  if (!['body', 'header', 'json'].includes(String(kind)) || !operations.includes(String(base.operator))) invalid('assertion kind or operator is unsupported');
  if (kind === 'header') {
    const name = text(base.name, 128, 'header assertion name');
    try { validateHeaderName(name); } catch { invalid('Invalid header assertion name'); }
  }
  if (kind === 'json') {
    const pointer = text(base.pointer, 256, 'JSON pointer');
    if ((pointer !== '' && !pointer.startsWith('/')) || /~(?![01])/.test(pointer) || pointer.split('/').length > 17) invalid('JSON pointer is invalid or too deep');
  }
  if (base.operator === 'exists') {
    if (base.value !== undefined) invalid('exists assertions must omit value');
  } else if (kind !== 'json') text(base.value, 4096, 'assertion value');
  else {
    if (base.value !== null && !['string', 'number', 'boolean'].includes(typeof base.value)) invalid('JSON assertion value must be a scalar');
    if (typeof base.value === 'string') text(base.value, 4096, 'assertion value');
    if (typeof base.value === 'number' && !Number.isFinite(base.value)) invalid('JSON assertion value must be finite');
    if (['gt', 'gte', 'lt', 'lte'].includes(String(base.operator)) && typeof base.value !== 'number') invalid('Numeric JSON assertions require a number');
    if (base.operator === 'contains' && typeof base.value !== 'string') invalid('JSON contains assertions require a string');
  }
  return base as unknown as MonitoringHttpAssertion;
}

export function parseMonitoringOptions(type: MonitoringCheckType, raw?: unknown, port?: number | null): MonitoringCheckOptions {
  const section = type;
  const root = object(raw === undefined ? {} : raw, [section], 'options');
  if (section === 'http') {
    const defaults = defaultHttpOptions();
    const value = object(root.http === undefined ? {} : root.http, Object.keys(defaults), 'HTTP options');
    const next = { ...defaults, ...value };
    if (!METHODS.includes(String(next.method))) invalid('HTTP method is unsupported');
    next.headers = validateMonitoringHeaders(next.headers) as Record<string, string>;
    next.body = text(next.body, MONITORING_LIMITS.requestBytes, 'HTTP body');
    if (['GET', 'HEAD'].includes(next.method) && next.body) invalid('GET and HEAD must not have a request body');
    if (!Array.isArray(next.expectedStatuses) || !next.expectedStatuses.length || next.expectedStatuses.length > 500) invalid('expectedStatuses must contain 1-500 status codes');
    next.expectedStatuses = [...new Set(next.expectedStatuses.map(status => integer(status, 100, 599, 'expected status')))];
    next.followRedirects = boolean(next.followRedirects, 'followRedirects');
    next.maxRedirects = integer(next.maxRedirects, 0, MONITORING_LIMITS.redirects, 'maxRedirects');
    if (!next.followRedirects && next.maxRedirects !== 0) invalid('maxRedirects must be zero when redirects are disabled');
    next.maxResponseTimeMs = next.maxResponseTimeMs === null ? null : integer(next.maxResponseTimeMs, 1, 120000, 'maxResponseTimeMs');
    if (!Array.isArray(next.assertions) || next.assertions.length > MONITORING_LIMITS.assertions) invalid('assertions must be an array with at most 20 entries');
    next.assertions = next.assertions.map(assertion);
    return { http: next };
  }
  if (section === 'tcp') {
    const value = object(root.tcp === undefined ? {} : root.tcp, ['tls', 'bannerContains'], 'TCP options');
    return { tcp: { tls: boolean(value.tls === undefined ? false : value.tls, 'TCP tls'), bannerContains: text(value.bannerContains === undefined ? '' : value.bannerContains, 1024, 'TCP banner match') } };
  }
  if (section === 'push') return {};
  if (section === 'smtp' || section === 'imap') {
    const value = object(root[section] === undefined ? {} : root[section], ['startTls'], `${section.toUpperCase()} options`);
    const defaultStartTls = section === 'smtp' ? port === 587 : port === 143;
    return { [section]: { startTls: boolean(value.startTls === undefined ? defaultStartTls : value.startTls, `${section.toUpperCase()} STARTTLS`) } };
  }
  const value = object(root.dns === undefined ? {} : root.dns, ['recordType', 'resolver', 'expectedValues'], 'DNS options');
  const recordType = value.recordType === undefined ? 'A' : value.recordType;
  if (!DNS_TYPES.includes(String(recordType))) invalid('DNS record type is unsupported');
  const resolver = value.resolver ?? null;
  if (resolver !== null && (typeof resolver !== 'string' || !isIP(resolver))) invalid('DNS resolver must be an IP address');
  const values = value.expectedValues === undefined ? [] : value.expectedValues;
  if (!Array.isArray(values) || values.length > 128) invalid('DNS expectedValues must be an array with at most 128 records');
  return { dns: { recordType: recordType as NonNullable<MonitoringCheckOptions['dns']>['recordType'], resolver: resolver as string | null, expectedValues: values.map(record => text(record, 1024, 'DNS expected record')) } };
}

export function validateMonitoringEndpoint(endpoint: string, type: MonitoringCheckType): void {
  // A push check has no target to probe; the job calls Robin Admin instead.
  if (type === 'push') {
    if (endpoint !== 'push') invalid('Push checks have no endpoint');
    return;
  }
  if (!endpoint || endpoint.length > 500) invalid('endpoint is required and must be at most 500 characters');
  if (type === 'http') {
    let url: URL;
    try { url = new URL(endpoint); } catch { invalid('HTTP endpoint must be a valid URL'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) invalid('HTTP endpoint must use http:// or https:// without credentials or fragments');
    return;
  }
  if (!isIP(endpoint) && !/^(?=.{1,253}$)[a-z0-9_](?:[a-z0-9_.-]*[a-z0-9_])?\.?$/i.test(endpoint)) invalid('endpoint must be a hostname or IP address');
  if (type === 'dns' && isIP(endpoint)) invalid('DNS endpoint must be a record name');
}

export function validateMonitoringProtocol(input: { checkType: MonitoringCheckType; endpoint: string; port: number | null; certExpiryDays: number | null; tlsMode: string; certificateErrorMode?: MonitoringCertificateErrorMode; options: MonitoringCheckOptions }): void {
  validateMonitoringEndpoint(input.endpoint, input.checkType);
  if (input.checkType === 'push') {
    if (input.port !== null || input.certExpiryDays !== null) invalid('Push checks have no port or certificate');
    return;
  }
  if (input.checkType === 'http' && input.port !== null) invalid('HTTP port must be specified in the endpoint URL');
  if (input.checkType === 'tcp' && input.port === null) invalid('TCP port is required');
  if (input.checkType === 'smtp' && input.port === 465 && input.options.smtp?.startTls) invalid('SMTP port 465 uses implicit TLS; STARTTLS is not supported on this port');
  if (input.checkType === 'imap' && input.port === 993 && input.options.imap?.startTls) invalid('IMAP port 993 uses implicit TLS; STARTTLS is not supported on this port');
  if (input.checkType === 'dns' && !input.options.dns?.resolver && input.port !== null && input.port !== 53) invalid('A custom DNS port requires a resolver');
  if (input.certificateErrorMode !== undefined && !['down', 'warning'].includes(input.certificateErrorMode)) invalid('Certificate error mode must be down or warning');
  const usesTls = (input.checkType === 'imap' && input.port !== 143 && !input.options.imap?.startTls)
    || (input.checkType === 'smtp' && input.port === 465)
    || input.options.smtp?.startTls === true || input.options.imap?.startTls === true
    || (input.checkType === 'http' && new URL(input.endpoint).protocol === 'https:') || input.options.tcp?.tls;
  if (!usesTls && (input.certExpiryDays !== null || input.tlsMode !== 'strict')) invalid('Certificate settings require a TLS check');
}
