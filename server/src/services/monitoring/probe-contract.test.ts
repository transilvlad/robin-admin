import http from 'node:http';
import https from 'node:https';
import dgram from 'node:dgram';
import net from 'node:net';
import tls from 'node:tls';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { runMonitoringProbe } from './probes.js';
import { parseMonitoringOptions } from './options.js';
import type { MonitoringCheck } from '../../types/monitoring.js';

interface ConformanceCase {
  id: string;
  fixture: {
    type: 'http' | 'https' | 'tcp' | 'smtp' | 'smtps' | 'imap' | 'imaps' | 'dns'; port?: number; records?: Record<string, string[]>; rcode?: number; status?: number; body?: string; hang?: boolean; banner?: string; closeAfterWrite?: boolean;
    replies?: string[]; cert?: 'expired' | 'wrong-host'; dripMs?: number; upgradeAfterReply?: number;
    routes?: Record<string, { status: number; headers?: Record<string, string>; body?: string; bodyBytes?: number; headerBytes?: number; method?: string; requestHeaders?: Record<string, string> }>;
  };
  check: { checkType: MonitoringCheck['checkType']; options?: unknown; timeoutSeconds?: number; allowPrivate?: boolean; endpoint?: string; port?: number; secretHeaders?: Record<string, string>; tlsMode?: MonitoringCheck['tlsMode']; certExpiryDays?: number; certificateErrorMode?: MonitoringCheck['certificateErrorMode'] };
  expected: { status: string; errorCode: string | null };
}

const contract = JSON.parse(readFileSync(new URL('../../../../contracts/monitoring-probe-v1/cases.json', import.meta.url), 'utf8')) as {
  protocolVersion: number;
  cases: ConformanceCase[];
};
const manifestSchema = JSON.parse(readFileSync(new URL('../../../../contracts/monitoring-probe-v1/manifest.schema.json', import.meta.url), 'utf8')) as {
  properties: { checks: { items: { allOf: Array<{ $ref?: string }> } } };
};
const errorCodeContract = JSON.parse(readFileSync(new URL('../../../../contracts/monitoring-probe-v1/error-codes.json', import.meta.url), 'utf8')) as {
  protocolVersion: number;
  codes: string[];
};
function tlsFixtureFor(variant?: string) {
  const prefix = variant ? `tls-${variant}` : 'tls';
  return {
    cert: readFileSync(new URL(`../../../../contracts/monitoring-probe-v1/fixtures/${prefix}-cert.pem`, import.meta.url)),
    key: readFileSync(new URL(`../../../../contracts/monitoring-probe-v1/fixtures/${prefix}-key.pem`, import.meta.url)),
  };
}
// Fixed-port fixtures (SMTP 465) need a bindable privileged port; CI lowers the floor, elsewhere they are skipped with a warning.
const canBindFixedPorts = await new Promise<boolean>(resolve => {
  const probe = net.createServer();
  probe.once('error', () => resolve(false));
  probe.listen(465, '127.0.0.1', () => probe.close(() => resolve(true)));
});
if (!canBindFixedPorts) console.warn('Skipping shared cases that need port 465: it cannot be bound here');
const runnableCases = contract.cases.filter(testCase => !testCase.fixture.port || canBindFixedPorts);
const FIXTURE_TYPES = ['http', 'https', 'tcp', 'smtp', 'smtps', 'imap', 'imaps', 'dns'];
const CHECK_TYPES = ['http', 'tcp', 'smtp', 'imap', 'dns'];
const RESULT_STATUSES = ['up', 'warning', 'down'];
const servers: Array<http.Server | net.Server> = [];
const dnsServers: dgram.Socket[] = [];
const DNS_TYPES: Record<string, number> = { A: 1, NS: 2, CNAME: 5, MX: 15, TXT: 16, AAAA: 28 };

function dnsName(name: string): Buffer {
  return Buffer.concat([...name.replace(/\.$/, '').split('.').map(label => Buffer.concat([Buffer.from([label.length]), Buffer.from(label)])), Buffer.from([0])]);
}

function dnsRecordData(type: string, value: string): Buffer {
  if (type === 'A') return Buffer.from(value.split('.').map(Number));
  if (type === 'AAAA') {
    const [head, tail = ''] = value.split('::');
    const left = head ? head.split(':') : [];
    const right = tail ? tail.split(':') : [];
    const groups = [...left, ...Array(8 - left.length - right.length).fill('0'), ...right];
    return Buffer.concat(groups.map(group => Buffer.from([parseInt(group, 16) >> 8, parseInt(group, 16) & 255])));
  }
  if (type === 'TXT') return Buffer.concat([Buffer.from([value.length]), Buffer.from(value)]);
  if (type === 'MX') { const [preference, host] = value.split(' '); return Buffer.concat([Buffer.from([Number(preference) >> 8, Number(preference) & 255]), dnsName(host)]); }
  return dnsName(value);
}

function dnsResponse(query: Buffer, fixture: ConformanceCase['fixture']): Buffer {
  let end = 12;
  while (query[end] !== 0) end += query[end] + 1;
  const question = query.subarray(12, end + 5);
  const qtype = question.readUInt16BE(question.length - 4);
  const type = Object.keys(DNS_TYPES).find(name => DNS_TYPES[name] === qtype) ?? '';
  const answers = (fixture.records?.[type] ?? []).map(value => {
    const data = dnsRecordData(type, value);
    const header = Buffer.alloc(12);
    header.writeUInt16BE(0xc00c, 0); header.writeUInt16BE(qtype, 2); header.writeUInt16BE(1, 4); header.writeUInt32BE(60, 6); header.writeUInt16BE(data.length, 10);
    return Buffer.concat([header, data]);
  });
  const head = Buffer.alloc(12);
  query.copy(head, 0, 0, 2);
  head.writeUInt16BE(0x8180 | (fixture.rcode ?? 0), 2); head.writeUInt16BE(1, 4); head.writeUInt16BE(answers.length, 6);
  return Buffer.concat([head, question, ...answers]);
}


afterEach(async () => {
  for (const socket of dnsServers.splice(0)) socket.close();
  await Promise.all(servers.splice(0).map(server => new Promise<void>(resolve => {
    if (server instanceof http.Server) server.closeAllConnections();
    server.close(() => resolve());
  })));
});

describe('monitoring probe v1 shared conformance cases', () => {
  it('uses protocol version 1 fixtures', () => expect(contract.protocolVersion).toBe(1));

  it('keeps every contract file parseable and links the manifest to the check schema', () => {
    for (const filename of ['check.schema.json', 'manifest.schema.json', 'observation.schema.json', 'error-codes.json', 'cases.json']) {
      expect(() => JSON.parse(readFileSync(new URL(`../../../../contracts/monitoring-probe-v1/${filename}`, import.meta.url), 'utf8'))).not.toThrow();
    }
    expect(manifestSchema.properties.checks.items.allOf).toContainEqual({ $ref: 'check.schema.json' });
    expect(errorCodeContract.protocolVersion).toBe(1);
    for (const testCase of contract.cases) {
      expect(testCase.expected.errorCode === null || errorCodeContract.codes.includes(testCase.expected.errorCode)).toBe(true);
    }
  });

  it('has well-formed, uniquely named cases', () => {
    const ids = new Set<string>();
    for (const testCase of contract.cases) {
      expect(ids.has(testCase.id), `duplicate id ${testCase.id}`).toBe(false);
      ids.add(testCase.id);
      expect(FIXTURE_TYPES, `${testCase.id}: fixture type`).toContain(testCase.fixture.type);
      expect(CHECK_TYPES, `${testCase.id}: check type`).toContain(testCase.check.checkType);
      expect(RESULT_STATUSES, `${testCase.id}: expected status`).toContain(testCase.expected.status);
      expect(testCase.expected.status === 'up' ? testCase.expected.errorCode === null : true, `${testCase.id}: up has no error code`).toBe(true);
    }
  });

  it.each(runnableCases)('$id', async testCase => {
    if (!FIXTURE_TYPES.includes(testCase.fixture.type)) throw new Error(`unsupported fixture type ${testCase.fixture.type}`);
    if (testCase.fixture.type === 'dns') {
      const socket = dgram.createSocket('udp4');
      dnsServers.push(socket);
      socket.on('message', (query, remote) => { if (!testCase.fixture.hang) socket.send(dnsResponse(query, testCase.fixture), remote.port, remote.address); });
      await new Promise<void>(resolve => socket.bind(0, '127.0.0.1', resolve));
      const port = socket.address().port;
      const options = parseMonitoringOptions('dns', testCase.check.options, port);
      const check = {
        id: 1, targetId: 1, targetName: 'Fixture', targetEnvironment: 'test', name: testCase.id,
        checkType: 'dns', endpoint: testCase.check.endpoint!, port, intervalSeconds: 60, timeoutSeconds: testCase.check.timeoutSeconds ?? 2,
        confirmationSeconds: 0, recoverySeconds: 0, certExpiryDays: null, tlsMode: 'strict', certificateErrorMode: 'down',
        allowPrivate: testCase.check.allowPrivate ?? true, options, secretHeaderNames: [], enabled: true, pausedAt: null, pauseReason: null,
        currentStatus: 'unknown', statusSince: null, lastRunAt: null, nextRunAt: null, lastResponseTimeMs: null, lastError: null,
        consecutiveFailures: 0, consecutiveSuccesses: 0, createdAt: new Date(), updatedAt: new Date(),
      } as MonitoringCheck;
      const result = await runMonitoringProbe(check);
      expect({ status: result.status, errorCode: result.errorCode }).toEqual(testCase.expected);
      return;
    }
    const isHttp = testCase.fixture.type === 'http' || testCase.fixture.type === 'https';
    const handler: http.RequestListener = (request, response) => {
        if (testCase.fixture.hang) return;
        const route = testCase.fixture.routes?.[new URL(request.url ?? '/', 'http://fixture').pathname];
        if (route) {
          if (route.method && route.method !== request.method) { response.statusCode = 400; response.end(); return; }
          for (const [name, value] of Object.entries(route.requestHeaders ?? {})) {
            if (request.headers[name.toLowerCase()] !== value) { response.statusCode = 401; response.end(); return; }
          }
          response.statusCode = route.status;
          for (const [name, value] of Object.entries(route.headers ?? {})) response.setHeader(name, value);
          if (route.headerBytes) response.setHeader('x-padding', 'a'.repeat(route.headerBytes));
          response.write(route.body ?? '');
          response.end(route.bodyBytes ? Buffer.alloc(route.bodyBytes, 'a') : undefined);
          return;
        }
        response.statusCode = testCase.fixture.status ?? 200;
        response.end(testCase.fixture.body ?? '');
    };
    const server = isHttp
      ? (testCase.fixture.type === 'https' ? https.createServer(tlsFixtureFor(testCase.fixture.cert), handler) : http.createServer(handler))
      : ((testCase.fixture.type === 'imaps' || testCase.fixture.type === 'smtps') ? (listener: (socket: net.Socket) => void) => tls.createServer(tlsFixtureFor(testCase.fixture.cert), listener) : net.createServer)(socket => {
        socket.on('error', () => undefined);
        const banner = testCase.fixture.banner ?? '';
        if (testCase.fixture.dripMs) {
          let sent = 0;
          const drip = setInterval(() => {
            if (socket.destroyed || sent >= banner.length) { clearInterval(drip); return; }
            socket.write(banner[sent++]);
          }, testCase.fixture.dripMs);
          socket.on('close', () => clearInterval(drip));
          return;
        }
        socket.write(banner);
        if (testCase.fixture.closeAfterWrite) { socket.end(); return; }
        const replies = [...(testCase.fixture.replies ?? [])];
        let written = 0;
        const serve = (stream: net.Socket): void => {
          let pending = '';
          stream.on('data', chunk => {
            pending += chunk.toString('latin1');
            let index: number;
            while ((index = pending.indexOf('\n')) >= 0 && replies.length) {
              pending = pending.slice(index + 1);
              stream.write(replies.shift()!);
              written += 1;
              if (written === testCase.fixture.upgradeAfterReply) {
                stream.removeAllListeners('data');
                const secure = new tls.TLSSocket(stream, { isServer: true, ...tlsFixtureFor(testCase.fixture.cert) });
                secure.on('error', () => undefined);
                serve(secure);
                return;
              }
            }
          });
        };
        serve(socket);
      });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(testCase.fixture.port ?? 0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Conformance fixture failed to bind');
    const checkType = testCase.check.checkType;
    const rawOptions = testCase.check.options ?? (checkType === 'http' ? { http: { expectedStatuses: [200] } } : {});
    const options = parseMonitoringOptions(checkType, rawOptions, address.port);
    const check: MonitoringCheck = {
      id: 1, targetId: 1, targetName: 'Fixture', targetEnvironment: 'test', name: testCase.id,
      checkType, endpoint: testCase.check.endpoint ?? (checkType === 'http' ? `${testCase.fixture.type === 'https' ? 'https' : 'http'}://127.0.0.1:${address.port}` : '127.0.0.1'),
      port: checkType === 'http' ? null : (testCase.check.endpoint ? testCase.check.port : undefined) ?? address.port,
      intervalSeconds: 60, timeoutSeconds: testCase.check.timeoutSeconds ?? 2,
      confirmationSeconds: 0, recoverySeconds: 0, certExpiryDays: testCase.check.certExpiryDays ?? null, tlsMode: testCase.check.tlsMode ?? 'strict',
      certificateErrorMode: testCase.check.certificateErrorMode ?? 'down', allowPrivate: testCase.check.allowPrivate ?? true, options, secretHeaderNames: [],
      enabled: true, pausedAt: null, pauseReason: null, currentStatus: 'unknown', statusSince: null,
      lastRunAt: null, nextRunAt: null, lastResponseTimeMs: null, lastError: null,
      consecutiveFailures: 0, consecutiveSuccesses: 0, createdAt: new Date(), updatedAt: new Date(),
    };
    const result = await runMonitoringProbe(check, testCase.check.secretHeaders);
    expect({ status: result.status, errorCode: result.errorCode }).toEqual(testCase.expected);
  });
});
