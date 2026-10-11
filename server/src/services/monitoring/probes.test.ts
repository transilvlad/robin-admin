import http from 'node:http';
import net from 'node:net';
import dgram from 'node:dgram';
import https from 'node:https';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { Resolver } from 'node:dns/promises';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runMonitoringProbe } from './probes.js';
import { permittedAddress } from './network.js';
import { parseMonitoringOptions } from './options.js';
import type { MonitoringCheck } from '../../types/monitoring.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks(); });

function check(overrides: Partial<MonitoringCheck> = {}): MonitoringCheck {
  return { id: 1, targetId: 1, targetName: 'Test', targetEnvironment: 'test', name: 'Test check', checkType: 'http', endpoint: '', port: null, intervalSeconds: 60, timeoutSeconds: 1, confirmationSeconds: 0, recoverySeconds: 0, certExpiryDays: null, tlsMode: 'strict', certificateErrorMode: 'down', allowPrivate: true, options: {}, secretHeaderNames: [], enabled: true, pausedAt: null, pauseReason: null, currentStatus: 'unknown', statusSince: null, lastRunAt: null, nextRunAt: null, lastResponseTimeMs: null, lastError: null, consecutiveFailures: 0, consecutiveSuccesses: 0, createdAt: new Date(), updatedAt: new Date(), ...overrides };
}
async function httpFixture(handler: http.RequestListener): Promise<string> {
  const server = http.createServer(handler);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return 'http://127.0.0.1:' + (server.address() as net.AddressInfo).port;
}
async function tcpFixture(handler: (socket: net.Socket) => void): Promise<number> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer(socket => { sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => sockets.delete(socket)); handler(socket); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => { for (const socket of sockets) socket.destroy(); server.close(() => resolve()); }));
  return (server.address() as net.AddressInfo).port;
}
async function mailStartTlsFixture(protocol: 'smtp' | 'imap', options: { missingCapability?: boolean; expiredCertificate?: boolean; holdAt?: string; multilineGreeting?: boolean; bareFinalGreetingCode?: boolean; unexpectedPreTlsData?: boolean } = {}): Promise<number> {
  const sockets = new Set<net.Socket>();
  const key = readFileSync(new URL('./fixtures/tls.key', import.meta.url));
  const cert = readFileSync(new URL(options.expiredCertificate ? './fixtures/tls-expired.crt' : './fixtures/tls.crt', import.meta.url));
  const secureContext = tls.createSecureContext({ key, cert });
  const server = net.createServer(raw => {
    sockets.add(raw);
    raw.on('error', () => {});
    raw.once('close', () => sockets.delete(raw));
    let active: net.Socket = raw;
    let buffer = '';
    let encrypted = false;
    const data = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '');
        buffer = buffer.slice(newline + 1);
        if (options.holdAt === 'ehlo' && line === 'EHLO robin-admin.local' && !encrypted) return;
        if (options.holdAt === 'capability' && line === 'A001 CAPABILITY') return;
        if (options.holdAt === 'starttls' && (line === 'STARTTLS' || line === 'A002 STARTTLS')) return;
        if (protocol === 'smtp' && line === 'EHLO robin-admin.local') {
          if (encrypted && options.holdAt === 'post-ehlo') return;
          active.write(options.missingCapability && !encrypted ? '250 test server\r\n' : '250-test server\r\n250-STARTTLS\r\n250 HELP\r\n');
        } else if (protocol === 'smtp' && line === 'STARTTLS') {
          active.write(`220 begin TLS\r\n${options.unexpectedPreTlsData ? 'unexpected plaintext\r\n' : ''}`, () => {
            active.removeListener('data', data);
            if (options.holdAt === 'tls') return;
            const secure = new tls.TLSSocket(raw, { isServer: true, secureContext });
            active = secure;
            encrypted = true;
            secure.on('error', () => {});
            secure.on('data', data);
          });
        } else if (protocol === 'imap' && line === 'A001 CAPABILITY') {
          active.write(options.missingCapability
            ? '* CAPABILITY IMAP4rev1\r\nA001 OK capability complete\r\n'
            : '* CAPABILITY IMAP4rev1 STARTTLS\r\nA001 OK capability complete\r\n');
        } else if (protocol === 'imap' && line === 'A002 STARTTLS') {
          active.write(`A002 OK begin TLS\r\n${options.unexpectedPreTlsData ? 'unexpected plaintext\r\n' : ''}`, () => {
            active.removeListener('data', data);
            if (options.holdAt === 'tls') return;
            const secure = new tls.TLSSocket(raw, { isServer: true, secureContext });
            active = secure;
            encrypted = true;
            secure.on('error', () => {});
            secure.on('data', data);
          });
        }
      }
    };
    if (options.holdAt !== 'greeting') {
      raw.write(protocol === 'smtp'
        ? options.multilineGreeting ? `220-test mail service\r\n${options.bareFinalGreetingCode ? '220\r\n' : '220 ready\r\n'}` : '220 test mail service\r\n'
        : '* OK test mail service\r\n');
      raw.on('data', data);
    }
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>(resolve => {
    for (const socket of sockets) socket.destroy();
    server.close(() => resolve());
  }));
  return (server.address() as net.AddressInfo).port;
}

describe('bounded monitoring probes', () => {
  it('verifies self-signed TLS before transmitting credentials and still checks hostname identity', async () => {
    const seen: string[] = [];
    const server = https.createServer({ key: readFileSync(new URL('./fixtures/tls.key', import.meta.url)), cert: readFileSync(new URL('./fixtures/tls.crt', import.meta.url)) }, (request, response) => { seen.push(String(request.headers.authorization)); response.end('ok'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const port = (server.address() as net.AddressInfo).port;
    const input = check({ endpoint: `https://127.0.0.1:${port}`, tlsMode: 'allow_self_signed' });
    expect(await runMonitoringProbe(input, { authorization: 'Bearer test-only' })).toMatchObject({ status: 'up', details: { tlsTrustedLocalCertificate: true } });
    expect(seen).toEqual(['Bearer test-only']);
    expect(await runMonitoringProbe({ ...input, tlsMode: 'strict' }, { authorization: 'blocked' })).toMatchObject({ status: 'down', error: 'TLS certificate verification failed', details: { certificateError: true } });
    expect(await runMonitoringProbe({ ...input, tlsMode: 'strict', certificateErrorMode: 'warning' }, { authorization: 'blocked' })).toMatchObject({ status: 'warning', error: 'TLS certificate verification failed', details: { certificateError: true } });
    vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['127.0.0.1']);
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    expect(await runMonitoringProbe({ ...input, endpoint: `https://wrong.example.test:${port}` }, { authorization: 'blocked' })).toMatchObject({ status: 'down', error: 'TLS certificate hostname does not match target' });
    expect(await runMonitoringProbe({ ...input, endpoint: `https://wrong.example.test:${port}`, certificateErrorMode: 'warning' }, { authorization: 'blocked' })).toMatchObject({ status: 'warning', error: 'TLS certificate hostname does not match target' });
    expect(seen).toEqual(['Bearer test-only']);
  });
  it('applies both certificate-error modes to expired certificates without sending requests', async () => {
    let requests = 0;
    const server = https.createServer({
      key: readFileSync(new URL('./fixtures/tls.key', import.meta.url)),
      cert: readFileSync(new URL('./fixtures/tls-expired.crt', import.meta.url)),
    }, (_request, response) => { requests++; response.end('unexpected'); });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
    const port = (server.address() as net.AddressInfo).port;
    vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['127.0.0.1']);
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const input = check({ endpoint: `https://localhost:${port}`, allowPrivate: true });
    expect(await runMonitoringProbe(input)).toMatchObject({ status: 'down', error: 'TLS certificate is expired or not yet valid', details: { certificateError: true } });
    expect(await runMonitoringProbe({ ...input, certificateErrorMode: 'warning' })).toMatchObject({ status: 'warning', error: 'TLS certificate is expired or not yet valid', details: { certificateError: true } });
    expect(requests).toBe(0);
  });
  it('rejects mixed public/private DNS answers and pins the validated answer', async () => {
    const url = await httpFixture((_req, res) => res.end('ok'));
    const resolve = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['93.184.216.34', '127.0.0.1']);
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    expect(await runMonitoringProbe(check({ endpoint: 'http://service.example.test', allowPrivate: false }))).toMatchObject({ error: 'Target address is not permitted' });
    resolve.mockResolvedValue(['127.0.0.1']);
    const pinned = url.replace('127.0.0.1', 'service.example.test');
    expect(await runMonitoringProbe(check({ endpoint: pinned }))).toMatchObject({ status: 'up' });
    expect(resolve).toHaveBeenCalledTimes(2);
  });
  it('returns on the first permitted address family and measures DNS separately', async () => {
    const url = await httpFixture((_req, res) => res.end('ok'));
    const resolve4 = vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 100));
      return ['127.0.0.1'];
    });
    const resolve6 = vi.spyOn(Resolver.prototype, 'resolve6').mockImplementation(() => new Promise(resolve => setTimeout(() => resolve([]), 500)));
    const started = Date.now();
    const result = await runMonitoringProbe(check({ endpoint: url.replace('127.0.0.1', 'service.example.test'), allowPrivate: true }));
    expect(result.status).toBe('up');
    expect(result.details.dnsTimeMs).toBeGreaterThanOrEqual(80);
    expect(result.responseTimeMs).toBeLessThan(80);
    expect(Date.now() - started).toBeLessThan(400);
    expect(resolve4).toHaveBeenCalled();
    expect(resolve6).toHaveBeenCalled();
  });
  it('prefers an IPv4 answer when AAAA resolves first within the short preference window', async () => {
    const url = await httpFixture((_req, res) => res.end('ok'));
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue(['::1']);
    vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      return ['127.0.0.1'];
    });
    expect(await runMonitoringProbe(check({ endpoint: url.replace('127.0.0.1', 'service.example.test'), allowPrivate: true }))).toMatchObject({ status: 'up' });
  });
  it('tries IPv4 after an early IPv6 answer cannot connect', async () => {
    const url = await httpFixture((_req, res) => res.end('ok'));
    let ipv4Lookups = 0;
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue(['::1']);
    vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation(async () => {
      ipv4Lookups++;
      if (ipv4Lookups === 1) await new Promise(resolve => setTimeout(resolve, 200));
      return ['127.0.0.1'];
    });
    const result = await runMonitoringProbe(check({ endpoint: url.replace('127.0.0.1', 'service.example.test'), allowPrivate: true }));
    expect(result.status).toBe('up');
    expect(ipv4Lookups).toBe(2);
  });
  it('tries IPv4 when the first address family connection hangs', async () => {
    const url = await httpFixture((_req, res) => res.end('ok'));
    const originalConnect = net.connect;
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue(['::1']);
    let ipv4Lookups = 0;
    vi.spyOn(Resolver.prototype, 'resolve4').mockImplementation(async () => {
      ipv4Lookups++;
      if (ipv4Lookups === 1) await new Promise(resolve => setTimeout(resolve, 100));
      return ['127.0.0.1'];
    });
    vi.spyOn(net, 'connect').mockImplementation((...args) => {
      const options = args[0];
      if (typeof options === 'object' && 'host' in options && options.host === '::1') return new net.Socket();
      return originalConnect(...args);
    });
    const started = Date.now();
    const result = await runMonitoringProbe(check({ endpoint: url.replace('127.0.0.1', 'service.example.test'), timeoutSeconds: 2 }));
    expect(result.status).toBe('up');
    expect(Date.now() - started).toBeLessThan(1800);
    expect(ipv4Lookups).toBe(2);
  });
  it('does not restrict the operating-system DNS resolver when private access is disabled', async () => {
    vi.spyOn(Resolver.prototype, 'getServers').mockReturnValue(['127.0.0.11']);
    const resolve4 = vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['93.184.216.34']);
    const setServers = vi.spyOn(Resolver.prototype, 'setServers');
    const result = await runMonitoringProbe(check({
      checkType: 'dns',
      endpoint: 'example.test',
      allowPrivate: false,
      options: parseMonitoringOptions('dns', { dns: { recordType: 'A' } }),
    }));
    expect(result.status).toBe('up');
    expect(result.details.dnsTimeMs).toEqual(expect.any(Number));
    expect(resolve4).toHaveBeenCalled();
    expect(setServers).not.toHaveBeenCalled();
  });
  it('keeps the private-resolver restriction for operator-supplied DNS servers', async () => {
    const result = await runMonitoringProbe(check({
      checkType: 'dns',
      endpoint: 'example.test',
      allowPrivate: false,
      options: parseMonitoringOptions('dns', { dns: { resolver: '127.0.0.1' } }),
    }));
    expect(result).toMatchObject({ status: 'down', error: 'DNS resolver address is not permitted' });
  });
  it('runs HTTP methods, body and typed assertions without retaining response values', async () => {
    const url = await httpFixture((request, response) => {
      expect(request.method).toBe('POST');
      let body = '';
      request.on('data', chunk => { body += chunk; });
      request.on('end', () => { expect(body).toBe('ping'); response.setHeader('x-state', 'ready'); response.end('{"ready":true,"count":3,"nil":null,"secret":"not-retained"}'); });
    });
    const result = await runMonitoringProbe(check({ endpoint: url, options: parseMonitoringOptions('http', { http: { method: 'POST', body: 'ping', assertions: [
      { kind: 'header', name: 'X-State', operator: 'equals', value: 'ready' }, { kind: 'body', operator: 'contains', value: 'not-retained' },
      { kind: 'json', pointer: '/ready', operator: 'equals', value: true }, { kind: 'json', pointer: '/count', operator: 'gt', value: 2 },
      { kind: 'json', pointer: '/nil', operator: 'equals', value: null },
    ] } }) }));
    expect(result.status).toBe('up');
    expect(result.details.assertions).toHaveLength(5);
    expect(JSON.stringify(result)).not.toContain('not-retained');
  });
  it('reports failed JSON assertion evidence instead of silently coercing values', async () => {
    const url = await httpFixture((_req, res) => res.end('{"ready":"true"}'));
    const result = await runMonitoringProbe(check({ endpoint: url, options: parseMonitoringOptions('http', { http: { assertions: [{ kind: 'json', pointer: '/ready', operator: 'equals', value: true }] } }) }));
    expect(result).toMatchObject({ status: 'down', error: 'HTTP json assertion 1 failed', details: { assertions: [{ index: 1, kind: 'json', passed: false }] } });
  });
  it('reports protocol validation errors as actionable probe failures', async () => {
    const result = await runMonitoringProbe(check({
      endpoint: 'http://example.test',
      certExpiryDays: 14,
      tlsMode: 'allow_self_signed',
    }));
    expect(result).toMatchObject({ status: 'down', error: 'Certificate settings require a TLS check' });
  });
  it('supports expected non-success statuses and disabled redirects', async () => {
    const url = await httpFixture((_req, res) => { res.writeHead(302, { location: '/another' }); res.end(); });
    const result = await runMonitoringProbe(check({ endpoint: url, options: parseMonitoringOptions('http', { http: { expectedStatuses: [302], followRedirects: false, maxRedirects: 0 } }) }));
    expect(result.status).toBe('up');
  });
  it('bounds redirect loops and validates each destination', async () => {
    const loop = await httpFixture((_req, res) => { res.writeHead(302, { location: '/loop' }); res.end(); });
    expect(await runMonitoringProbe(check({ endpoint: loop }))).toMatchObject({ status: 'down', error: 'HTTP redirect limit exceeded' });
    const unsafe = await httpFixture((_req, res) => { res.writeHead(302, { location: 'http://169.254.169.254/' }); res.end(); });
    expect(await runMonitoringProbe(check({ endpoint: unsafe }))).toMatchObject({ status: 'down', error: 'Target address is not permitted' });
  });
  it('never follows cross-origin redirects carrying custom headers or bodies', async () => {
    let reached = false;
    const destination = await httpFixture((_req, res) => { reached = true; res.end(); });
    const url = await httpFixture((_req, res) => { res.writeHead(302, { location: destination }); res.end(); });
    expect(await runMonitoringProbe(check({ endpoint: url, options: parseMonitoringOptions('http', { http: { headers: { 'x-client': 'private' } } }) }))).toMatchObject({ status: 'down', error: 'Cross-origin redirects with headers or body are not permitted' });
    expect(reached).toBe(false);
  });
  it('rejects private targets by default and forbids credentials on HTTP', async () => {
    const url = await httpFixture((_req, res) => res.end());
    expect(await runMonitoringProbe(check({ endpoint: url, allowPrivate: false }))).toMatchObject({ error: 'Target address is not permitted' });
    expect(await runMonitoringProbe(check({ endpoint: url }), { authorization: 'Bearer private-token' })).toMatchObject({ error: 'Credential headers require HTTPS' });
  });
  it('bounds response bytes', async () => {
    const url = await httpFixture((_req, res) => res.end(Buffer.alloc(1048577)));
    expect(await runMonitoringProbe(check({ endpoint: url }))).toMatchObject({ status: 'down', error: 'HTTP response exceeds 1 MiB' });
  });
  it('enforces one total deadline even while a response trickles', async () => {
    const url = await httpFixture((_req, res) => { const timer = setInterval(() => res.write('x'), 10); res.once('close', () => clearInterval(timer)); });
    const started = Date.now();
    expect(await runMonitoringProbe(check({ endpoint: url, timeoutSeconds: 0.1 }))).toMatchObject({ status: 'down', error: 'Probe timed out' });
    expect(Date.now() - started).toBeLessThan(800);
  });
  it('enforces the configured response-time threshold', async () => {
    const url = await httpFixture((_req, res) => setTimeout(() => res.end(), 40));
    expect(await runMonitoringProbe(check({ endpoint: url, options: parseMonitoringOptions('http', { http: { maxResponseTimeMs: 1 } }) }))).toMatchObject({ status: 'down', error: 'Maximum HTTP response time exceeded' });
  });
  it('supports TCP connectivity and bounded fragmented banner matching', async () => {
    const port = await tcpFixture(socket => { socket.write('HEL'); setTimeout(() => { if (!socket.destroyed) socket.end('LO\n'); }, 10); });
    expect(await runMonitoringProbe(check({ checkType: 'tcp', endpoint: '127.0.0.1', port }))).toMatchObject({ status: 'up' });
    expect(await runMonitoringProbe(check({ checkType: 'tcp', endpoint: '127.0.0.1', port, options: { tcp: { tls: false, bannerContains: 'HELLO' } } }))).toMatchObject({ status: 'up', details: { bannerMatched: true } });
  });
  it('fails missing or oversized banners and accepts SMTP service greetings', async () => {
    const port = await tcpFixture(socket => socket.end('220 test service ready\r\n'));
    expect(await runMonitoringProbe(check({ checkType: 'smtp', endpoint: '127.0.0.1', port }))).toMatchObject({ status: 'up' });
    expect(await runMonitoringProbe(check({ checkType: 'tcp', endpoint: '127.0.0.1', port, options: { tcp: { tls: false, bannerContains: 'missing' } } }))).toMatchObject({ status: 'down', error: 'Banner assertion failed' });
    const big = await tcpFixture(socket => socket.end(Buffer.alloc(8193)));
    expect(await runMonitoringProbe(check({ checkType: 'tcp', endpoint: '127.0.0.1', port: big, options: { tcp: { tls: false, bannerContains: 'missing' } } }))).toMatchObject({ error: 'Service banner exceeds 8 KiB' });
  });
  it('accepts multi-line and bare-code SMTP greetings', async () => {
    const port = await mailStartTlsFixture('smtp', { multilineGreeting: true, bareFinalGreetingCode: true });
    expect(await runMonitoringProbe(check({ checkType: 'smtp', endpoint: '127.0.0.1', port }))).toMatchObject({ status: 'up' });
    const bareCode = await tcpFixture(socket => socket.end('220\r\n'));
    expect(await runMonitoringProbe(check({ checkType: 'smtp', endpoint: '127.0.0.1', port: bareCode }))).toMatchObject({ status: 'up' });
  });
  it.each(['smtp', 'imap'] as const)('upgrades %s with STARTTLS and validates its certificate', async protocol => {
    const port = await mailStartTlsFixture(protocol);
    vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['127.0.0.1']);
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const options = parseMonitoringOptions(protocol, { [protocol]: { startTls: true } }, port);
    const result = await runMonitoringProbe(check({ checkType: protocol, endpoint: 'localhost', port, tlsMode: 'allow_self_signed', options }));
    expect(result).toMatchObject({ status: 'up', details: { connected: true, startTls: true, tlsTrustedLocalCertificate: true } });
  });
  it.each(['smtp', 'imap'] as const)('rejects unexpected plaintext data in the %s STARTTLS reply', async protocol => {
    const port = await mailStartTlsFixture(protocol, { unexpectedPreTlsData: true });
    vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['127.0.0.1']);
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const options = parseMonitoringOptions(protocol, { [protocol]: { startTls: true } }, port);
    expect(await runMonitoringProbe(check({ checkType: protocol, endpoint: 'localhost', port, tlsMode: 'allow_self_signed', options }))).toMatchObject({
      status: 'down',
      error: 'Unexpected plaintext data before STARTTLS',
    });
  });
  it('enforces the 8 KiB cap on mail-protocol replies', async () => {
    const port = await tcpFixture(socket => socket.write(Buffer.alloc(8193, 0x78)));
    expect(await runMonitoringProbe(check({ checkType: 'smtp', endpoint: '127.0.0.1', port }))).toMatchObject({
      status: 'down',
      error: 'Mail protocol response exceeds 8 KiB',
    });
  });
  it.each(['smtp', 'imap'] as const)('reports missing %s STARTTLS capability', async protocol => {
    const port = await mailStartTlsFixture(protocol, { missingCapability: true });
    vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['127.0.0.1']);
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const options = parseMonitoringOptions(protocol, { [protocol]: { startTls: true } }, port);
    expect(await runMonitoringProbe(check({ checkType: protocol, endpoint: 'localhost', port, options }))).toMatchObject({ status: 'down', error: `${protocol === 'smtp' ? 'SMTP' : 'IMAP'} server does not advertise STARTTLS` });
  });
  it.each(['smtp', 'imap'] as const)('rejects an expired %s STARTTLS certificate', async protocol => {
    const port = await mailStartTlsFixture(protocol, { expiredCertificate: true });
    vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['127.0.0.1']);
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const options = parseMonitoringOptions(protocol, { [protocol]: { startTls: true } }, port);
    expect(await runMonitoringProbe(check({ checkType: protocol, endpoint: 'localhost', port, tlsMode: 'allow_self_signed', options }))).toMatchObject({ status: 'down', error: 'TLS certificate is expired or not yet valid', details: { certificateError: true } });
  });
  it.each([
    ['smtp', 'greeting'], ['smtp', 'ehlo'], ['smtp', 'starttls'], ['smtp', 'tls'], ['smtp', 'post-ehlo'],
    ['imap', 'greeting'], ['imap', 'capability'], ['imap', 'starttls'], ['imap', 'tls'],
  ] as const)('times out during %s STARTTLS %s', async (protocol, holdAt) => {
    const port = await mailStartTlsFixture(protocol, { holdAt });
    vi.spyOn(Resolver.prototype, 'resolve4').mockResolvedValue(['127.0.0.1']);
    vi.spyOn(Resolver.prototype, 'resolve6').mockResolvedValue([]);
    const options = parseMonitoringOptions(protocol, { [protocol]: { startTls: true } }, port);
    expect(await runMonitoringProbe(check({ checkType: protocol, endpoint: 'localhost', port, timeoutSeconds: 0.1, tlsMode: 'allow_self_signed', options }))).toMatchObject({ status: 'down', error: 'Probe timed out' });
  });
  it('queries a configured DNS resolver and compares expected records', async () => {
    const socket = dgram.createSocket('udp4');
    socket.on('message', (query, remote) => {
      let end = 12;
      while (query[end] !== 0) end += query[end]! + 1;
      end += 5;
      const header = Buffer.from(query.subarray(0, 12));
      header.writeUInt16BE(0x8180, 2); header.writeUInt16BE(1, 6);
      const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 30, 0, 4, 192, 0, 2, 10]);
      socket.send(Buffer.concat([header, query.subarray(12, end), answer]), remote.port, remote.address);
    });
    await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => socket.close(resolve)));
    const input = check({ checkType: 'dns', endpoint: 'service.example.test', port: socket.address().port, options: { dns: { recordType: 'A', resolver: '127.0.0.1', expectedValues: ['192.0.2.10'] } } });
    expect(await runMonitoringProbe(input)).toMatchObject({ status: 'up', details: { recordType: 'A', recordCount: 1 } });
    expect(await runMonitoringProbe({ ...input, options: { dns: { ...input.options.dns!, expectedValues: ['192.0.2.11'] } } })).toMatchObject({ status: 'down', error: 'Expected DNS record is missing' });
    expect(await runMonitoringProbe({ ...input, allowPrivate: false })).toMatchObject({ error: 'DNS resolver address is not permitted' });
  });
  it('cancels unresponsive DNS queries at the total deadline', async () => {
    const socket = dgram.createSocket('udp4');
    await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
    cleanup.push(() => new Promise<void>(resolve => socket.close(resolve)));
    expect(await runMonitoringProbe(check({ checkType: 'dns', endpoint: 'example.test', timeoutSeconds: 0.1, port: socket.address().port, options: { dns: { recordType: 'A', resolver: '127.0.0.1', expectedValues: [] } } }))).toMatchObject({ status: 'down', error: 'Probe timed out' });
  });
  it.each(['169.254.169.254', '0.0.0.0', '224.0.0.1', '::', 'fe80::1', 'fd00:ec2::254', '::ffff:169.254.169.254'])('never permits reserved address %s', address => {
    expect(permittedAddress(address, true)).toBe(false);
  });
});
