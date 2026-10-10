import http from 'node:http';
import { Resolver } from 'node:dns/promises';
import type net from 'node:net';
import ipaddr from 'ipaddr.js';
import type { MonitoringCheck, MonitoringStatus } from '../../types/monitoring.js';
import { MONITORING_LIMITS, MonitoringInputError, parseMonitoringOptions, validateMonitoringProtocol } from './options.js';
import { connectProbe, permittedAddress, ProbeError, upgradeProbeTls } from './network.js';
import type { ProbeTiming } from './network.js';
import { evaluateAssertions } from './assertions.js';
import { evaluatePushCheck } from './push.js';

export interface MonitoringProbeResult {
  status: Exclude<MonitoringStatus, 'unknown'>;
  responseTimeMs: number;
  error: string | null;
  errorCode: string | null;
  details: Record<string, unknown>;
}

export function probeErrorCode(message: string, details: Record<string, unknown> = {}): string {
  if (details.certificateError === true || /TLS certificate|certificate verification/i.test(message)) return 'tls_certificate_error';
  if (/timed out|timeout/i.test(message)) return 'probe_timeout';
  if (/address is not permitted/i.test(message)) return 'target_not_permitted';
  if (/DNS resolution|DNS response|DNS resolver/i.test(message)) return 'dns_failed';
  if (/ECONNREFUSED/i.test(message)) return 'connect_refused';
  const assertion = /assertion (\d+) failed/i.exec(message);
  if (assertion) return `assertion_failed:${assertion[1]}`;
  if (/Unexpected HTTP status (\d+)/i.test(message)) return 'http_status';
  return 'probe_failed';
}

export async function runMonitoringProbe(check: MonitoringCheck, secrets: Record<string, string> = {}): Promise<MonitoringProbeResult> {
  if (check.checkType === 'push') return evaluatePushCheck(check, new Date());
  const started = Date.now();
  const deadline = started + check.timeoutSeconds * 1000;
  const timing = { connectionStartedAt: null as number | null, dnsTimeMs: 0 };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(0, deadline - Date.now()));
  let details: Record<string, unknown> = {};
  try {
    check = { ...check, options: parseMonitoringOptions(check.checkType, check.options, check.port) };
    validateMonitoringProtocol(check);
    if (Object.keys(secrets).length && (check.checkType !== 'http' || new URL(check.endpoint).protocol !== 'https:')) throw new ProbeError('Credential headers require HTTPS');
    const result = check.checkType === 'http' ? await probeHttp(check, secrets, controller.signal, deadline, timing)
      : check.checkType === 'dns' ? await probeDns(check, controller.signal)
      : await probeSocket(check, controller.signal, deadline, timing);
    details = { ...result.details, ...(check.checkType === 'dns' ? {} : { dnsTimeMs: timing.dnsTimeMs }) };
    const latency = Date.now() - (timing.connectionStartedAt ?? started);
    const maximum = check.options.http?.maxResponseTimeMs;
    if (maximum !== null && maximum !== undefined && latency > maximum) throw new ProbeError('Maximum HTTP response time exceeded', details);
    return { status: result.warning ? 'warning' : 'up', responseTimeMs: latency, error: result.warning, errorCode: null, details };
  } catch (error) {
    const failure = error instanceof MonitoringInputError ? new ProbeError(error.message) : error;
    const known = failure instanceof ProbeError;
    const code = failure instanceof Error ? (failure as NodeJS.ErrnoException).code : undefined;
    const message = controller.signal.aborted ? 'Probe timed out' : known ? failure.message : 'Probe failed' + (code && /^[A-Z_0-9]+$/.test(code) ? ' (' + code + ')' : '');
    const errorDetails = { ...(known ? failure.details : details), ...(check.checkType === 'dns' ? {} : { dnsTimeMs: timing.dnsTimeMs }) };
    return { status: known && failure.warning ? 'warning' : 'down', responseTimeMs: Date.now() - (timing.connectionStartedAt ?? started),
      error: message, errorCode: probeErrorCode(message, errorDetails), details: errorDetails };
  } finally { clearTimeout(timer); controller.abort(); }
}

async function probeHttp(check: MonitoringCheck, secrets: Record<string, string>, signal: AbortSignal, deadline: number, timing: ProbeTiming): Promise<{ details: Record<string, unknown>; warning: string | null }> {
  const options = check.options.http!;
  let url = new URL(check.endpoint);
  let method = options.method;
  let body = options.body;
  let warning: string | null = null;
  let certificateDetails: Record<string, unknown> = {};
  for (let redirects = 0; ; redirects++) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const connected = await connectProbe(check, host, Number(url.port || (url.protocol === 'https:' ? 443 : 80)), url.protocol === 'https:', signal, deadline, timing);
    certificateDetails = { ...certificateDetails, ...connected.details };
    warning ??= connected.warning;
    const response = await requestHttp(connected.socket, url, method, body, { ...options.headers, ...secrets }, signal);
    const details = { ...certificateDetails, statusCode: response.status, responseBytes: response.body.length, redirects };
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location && options.followRedirects) {
      if (redirects >= options.maxRedirects) throw new ProbeError('HTTP redirect limit exceeded', details);
      let next: URL;
      try { next = new URL(response.headers.location, url); } catch { throw new ProbeError('Invalid HTTP redirect', details); }
      if (!['http:', 'https:'].includes(next.protocol) || next.username || next.password || (url.protocol === 'https:' && next.protocol !== 'https:')) throw new ProbeError('HTTP redirect is not permitted', details);
      if (next.origin !== url.origin && (Object.keys(options.headers).length || Object.keys(secrets).length || body)) throw new ProbeError('Cross-origin redirects with headers or body are not permitted', details);
      if (response.status === 303 && method !== 'HEAD') { method = 'GET'; body = ''; }
      else if ([301, 302].includes(response.status) && !['GET', 'HEAD'].includes(method)) throw new ProbeError('HTTP redirect requires an explicit method-preserving response', details);
      next.hash = '';
      url = next;
      continue;
    }
    const assertions = evaluateAssertions(options.assertions, response.body.toString('utf8'), response.headers);
    const evidence = { ...details, assertions };
    if (!options.expectedStatuses.includes(response.status)) throw new ProbeError('Unexpected HTTP status ' + response.status, evidence);
    const failed = assertions.find(assertion => !assertion.passed);
    if (failed) throw new ProbeError('HTTP ' + failed.kind + ' assertion ' + failed.index + ' failed', evidence);
    return { details: evidence, warning };
  }
}

const PROBE_USER_AGENT = 'Robin-Admin-Monitor/1';

function requestHttp(socket: net.Socket, url: URL, method: string, body: string, headers: Record<string, string>, signal: AbortSignal): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }> {
  return new Promise((resolve, reject) => {
    const request = http.request({ hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80), path: url.pathname + url.search, method,
      createConnection: () => socket, headers: { 'user-agent': PROBE_USER_AGENT, ...headers, host: url.host, 'accept-encoding': 'identity', connection: 'close', ...(body ? { 'content-length': Buffer.byteLength(body) } : {}) }, signal }, response => {
      const chunks: Buffer[] = [];
      let bytes = 0;
      response.on('data', (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MONITORING_LIMITS.responseBytes) { reject(new ProbeError('HTTP response exceeds 1 MiB')); request.destroy(); }
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.once('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers, body: Buffer.concat(chunks) }));
      response.once('aborted', () => reject(new ProbeError('HTTP response was interrupted')));
    });
    request.once('error', reject);
    request.once('close', () => socket.destroy());
    request.end(body);
  });
}

async function probeSocket(check: MonitoringCheck, signal: AbortSignal, deadline: number, timing: ProbeTiming): Promise<{ details: Record<string, unknown>; warning: string | null }> {
  const port = check.port ?? (check.checkType === 'imap' ? 993 : 25);
  const startTls = check.checkType === 'smtp' ? check.options.smtp?.startTls === true : check.checkType === 'imap' && check.options.imap?.startTls === true;
  const useTls = !startTls && ((check.checkType === 'imap' && port !== 143) || (check.checkType === 'smtp' && port === 465) || check.options.tcp?.tls === true);
  const connected = await connectProbe(check, check.endpoint, port, useTls, signal, deadline, timing);
  let socket = connected.socket;
  let reader: BoundedMailReader | null = null;
  let details = connected.details;
  let warning = connected.warning;
  try {
    const match = check.options.tcp?.bannerContains ?? '';
    const mail = check.checkType === 'smtp' || check.checkType === 'imap';
    if (mail) {
      const readBudget = { totalBytes: 0 };
      reader = new BoundedMailReader(socket, signal, readBudget);
      if (check.checkType === 'smtp') {
        if ((await readSmtpReply(reader)).code !== 220) throw new ProbeError('Unexpected mail service greeting');
        if (startTls) {
          reader.assertNoPendingData();
          await reader.sendLine('EHLO robin-admin.local');
          const hello = await readSmtpReply(reader);
          if (hello.code !== 250) throw new ProbeError('SMTP EHLO command failed');
          if (!hello.lines.some(line => /(?:^|\s)STARTTLS(?:\s|$)/i.test(line.replace(/^\d{3}[ -]/, '')))) throw new ProbeError('SMTP server does not advertise STARTTLS');
          reader.assertNoPendingData();
          await reader.sendLine('STARTTLS');
          if ((await readSmtpReply(reader)).code !== 220) throw new ProbeError('SMTP STARTTLS command failed');
          reader.assertNoPendingData();
          reader.dispose();
          reader = null;
          const upgraded = await upgradeProbeTls(check, check.endpoint, socket, signal);
          socket = upgraded.socket;
          details = upgraded.details;
          warning = warning ?? upgraded.warning;
          reader = new BoundedMailReader(socket, signal, readBudget);
          await reader.sendLine('EHLO robin-admin.local');
          if ((await readSmtpReply(reader)).code !== 250) throw new ProbeError('SMTP EHLO command failed after STARTTLS');
        }
      } else {
        const greeting = await reader.readLine();
        if (!/^\*\s+(?:OK|PREAUTH)\b/i.test(greeting)) throw new ProbeError('Unexpected mail service greeting');
        if (startTls) {
          reader.assertNoPendingData();
          await reader.sendLine('A001 CAPABILITY');
          const capabilityReply = await readImapReply(reader, 'A001');
          if (!capabilityReply.ok) throw new ProbeError('IMAP CAPABILITY command failed');
          if (!capabilityReply.lines.some(line => /^\*\s+CAPABILITY\b/i.test(line) && /(?:^|\s)STARTTLS(?:\s|$)/i.test(line))) throw new ProbeError('IMAP server does not advertise STARTTLS');
          reader.assertNoPendingData();
          await reader.sendLine('A002 STARTTLS');
          if (!(await readImapReply(reader, 'A002')).ok) throw new ProbeError('IMAP STARTTLS command failed');
          reader.assertNoPendingData();
          reader.dispose();
          reader = null;
          const upgraded = await upgradeProbeTls(check, check.endpoint, socket, signal);
          socket = upgraded.socket;
          details = upgraded.details;
          warning = warning ?? upgraded.warning;
        }
      }
    } else if (match) {
      await readBanner(socket, match, signal);
    }
    return { details: { ...details, connected: true, ...(match ? { bannerMatched: true } : {}), ...(startTls ? { startTls: true } : {}) }, warning };
  } finally {
    reader?.dispose();
    socket.destroy();
  }
}

class BoundedMailReader {
  private buffer = Buffer.alloc(0);
  private failure: Error | null = null;
  private waiting: (() => void) | null = null;
  private readonly onData = (chunk: Buffer) => {
    this.readBudget.totalBytes += chunk.length;
    if (this.readBudget.totalBytes > MONITORING_LIMITS.bannerBytes) this.failure = new ProbeError('Mail protocol response exceeds 8 KiB');
    else this.buffer = Buffer.concat([this.buffer, chunk]);
    this.wake();
  };
  private readonly onError = (error: Error) => { this.failure = error; this.wake(); };
  private readonly onEnd = () => { this.failure = new ProbeError('Mail protocol response was interrupted'); this.wake(); };
  private readonly onAbort = () => { this.failure = new ProbeError('Probe timed out'); this.wake(); };

  constructor(private readonly socket: net.Socket, private readonly signal: AbortSignal, private readonly readBudget: { totalBytes: number }) {
    signal.throwIfAborted();
    socket.on('data', this.onData);
    socket.once('error', this.onError);
    socket.once('end', this.onEnd);
    signal.addEventListener('abort', this.onAbort, { once: true });
  }

  async readLine(): Promise<string> {
    while (true) {
      this.signal.throwIfAborted();
      if (this.failure) throw this.failure;
      const newline = this.buffer.indexOf(10);
      if (newline >= 0) {
        const line = this.buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '');
        this.buffer = this.buffer.subarray(newline + 1);
        return line;
      }
      await new Promise<void>(resolve => { this.waiting = resolve; });
    }
  }

  async sendLine(line: string): Promise<void> {
    this.signal.throwIfAborted();
    await new Promise<void>((resolve, reject) => {
      this.socket.write(`${line}\r\n`, error => error ? reject(error) : resolve());
    });
  }

  assertNoPendingData(): void {
    if (this.failure) throw this.failure;
    if (this.buffer.length) throw new ProbeError('Unexpected plaintext data before STARTTLS');
  }

  dispose(): void {
    this.socket.removeListener('data', this.onData);
    this.socket.removeListener('error', this.onError);
    this.socket.removeListener('end', this.onEnd);
    this.signal.removeEventListener('abort', this.onAbort);
  }

  private wake(): void { this.waiting?.(); this.waiting = null; }
}

async function readSmtpReply(reader: BoundedMailReader): Promise<{ code: number; lines: string[] }> {
  const first = await reader.readLine();
  const match = /^(\d{3})(?:([ -])|$)/.exec(first);
  if (!match) throw new ProbeError('Invalid SMTP response');
  const code = Number(match[1]);
  const lines = [first];
  while (match[2] === '-') {
    if (lines.length >= 128) throw new ProbeError('SMTP response contains too many lines');
    const line = await reader.readLine();
    if (!new RegExp(`^${code}(?:[ -]|$)`).test(line)) throw new ProbeError('Invalid SMTP response');
    lines.push(line);
    if (line === `${code}` || line.startsWith(`${code} `)) break;
  }
  return { code, lines };
}

async function readImapReply(reader: BoundedMailReader, tag: string): Promise<{ ok: boolean; lines: string[] }> {
  const lines: string[] = [];
  while (lines.length < 128) {
    const line = await reader.readLine();
    lines.push(line);
    if (new RegExp(`^${tag}\\s+`, 'i').test(line)) return { ok: new RegExp(`^${tag}\\s+OK(?:\\s|$)`, 'i').test(line), lines };
  }
  throw new ProbeError('IMAP response contains too many lines');
}

function readBanner(socket: net.Socket, match: string, signal: AbortSignal): Promise<string> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const cleanup = () => { socket.removeListener('data', data); socket.removeListener('end', ended); socket.removeListener('error', failed); signal.removeEventListener('abort', aborted); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const aborted = () => failed(new ProbeError('Probe timed out'));
    const ended = () => failed(new ProbeError('Banner assertion failed'));
    const data = (chunk: Buffer) => {
      if (buffer.length + chunk.length > MONITORING_LIMITS.bannerBytes) { failed(new ProbeError('Service banner exceeds 8 KiB')); return; }
      buffer = Buffer.concat([buffer, chunk]);
      const text = buffer.toString('utf8');
      if (match ? text.includes(match) : text.includes('\n')) { cleanup(); resolve(text); }
    };
    socket.on('data', data); socket.once('end', ended); socket.once('error', failed); signal.addEventListener('abort', aborted, { once: true });
  });
}

export function normalizeDnsRecord(type: string, value: string): string {
  if (type === 'TXT') return value;
  if (type === 'A' || type === 'AAAA') { try { return ipaddr.process(value).toNormalizedString(); } catch { return value; } }
  return value.trim().toLowerCase().replace(/\.$/, '');
}

async function probeDns(check: MonitoringCheck, signal: AbortSignal): Promise<{ details: Record<string, unknown>; warning: null }> {
  signal.throwIfAborted();
  const options = check.options.dns!;
  const resolver = new Resolver({ timeout: Math.max(1, check.timeoutSeconds * 1000), tries: 1 });
  if (options.resolver) {
    if (!permittedAddress(options.resolver, check.allowPrivate)) throw new ProbeError('DNS resolver address is not permitted');
    resolver.setServers([(options.resolver.includes(':') ? '[' + options.resolver + ']' : options.resolver) + ':' + (check.port ?? 53)]);
  }
  const cancel = () => resolver.cancel();
  signal.addEventListener('abort', cancel, { once: true });
  try {
    const dnsStarted = Date.now();
    let records: string[];
    try {
      switch (options.recordType) {
        case 'A': records = await resolver.resolve4(check.endpoint); break;
        case 'AAAA': records = await resolver.resolve6(check.endpoint); break;
        case 'CNAME': records = await resolver.resolveCname(check.endpoint); break;
        case 'NS': records = await resolver.resolveNs(check.endpoint); break;
        case 'MX': records = (await resolver.resolveMx(check.endpoint)).map(value => value.priority + ' ' + value.exchange); break;
        case 'TXT': records = (await resolver.resolveTxt(check.endpoint)).map(parts => parts.join('')); break;
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (signal.aborted || /TIMEOUT|CANCELLED/.test(code)) throw error;
      throw new ProbeError('DNS resolution failed', { dnsTimeMs: Date.now() - dnsStarted });
    }
    signal.throwIfAborted();
    if (!records.length || records.length > MONITORING_LIMITS.dnsRecords || records.some(value => Buffer.byteLength(value) > 1024)) throw new ProbeError('DNS response is empty or exceeds record limits');
    const actual = new Set(records.map(record => normalizeDnsRecord(options.recordType, record)));
    const details = { recordType: options.recordType, recordCount: records.length, expectedRecordCount: options.expectedValues.length, dnsTimeMs: Date.now() - dnsStarted };
    if (options.expectedValues.some(record => !actual.has(normalizeDnsRecord(options.recordType, record)))) throw new ProbeError('Expected DNS record is missing', details);
    return { details, warning: null };
  } finally { signal.removeEventListener('abort', cancel); resolver.cancel(); }
}
