import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './fleet-agent.js';
import * as fleetServices from '../db/queries/fleet-services.js';
import * as fleetAgents from '../db/queries/fleet-agents.js';
import * as monitoringProbes from '../db/queries/monitoring-probes.js';
import * as fleetAgentSync from '../db/queries/fleet-agent-sync.js';
import * as fleetAgentSyncService from '../services/fleet-agent-sync.js';
import * as metricsPoller from '../services/metrics-poller.js';
import * as fleetServiceObservations from '../db/queries/fleet-service-observations.js';
import * as serviceLogs from '../services/service-logs.js';
import { agentSupports, resetAgentCommandsForTests, runAgentCommand } from '../services/agent-commands.js';
import { resetAgentCommandQueryMock } from '../../tests/agent-command-query-mock.js';

vi.mock('../db/queries/fleet-services.js', () => ({
  getFleetServiceById: vi.fn(),
  getAgentServiceResponsibilities: vi.fn(async () => []),
}));

vi.mock('../db/queries/agent-commands.js', async () => (await import('../../tests/agent-command-query-mock.js')).agentCommandQueryMock);

vi.mock('../db/queries/fleet-agents.js', () => ({
  enrollFleetAgent: vi.fn(),
  fleetAgentCredentialMatches: vi.fn(),
  recordFleetAgentHeartbeat: vi.fn(),
}));

vi.mock('../db/queries/monitoring-probes.js', () => ({
  getMonitoringProbeManifest: vi.fn(),
  isProbeOnlyAgent: vi.fn(async () => false),
  ProbeRequestError: class ProbeRequestError extends Error {
    constructor(message: string, readonly status: number) { super(message); }
  },
  recordRemoteProbeObservations: vi.fn(),
  updateMonitoringProbeHeartbeat: vi.fn(),
}));

vi.mock('../services/metrics-poller.js', () => ({
  ingestAgentMetrics: vi.fn(),
  ingestPostfixLogLines: vi.fn(),
}));

vi.mock('../db/queries/fleet-service-observations.js', () => ({
  recordFleetServiceObservation: vi.fn(),
}));

vi.mock('../services/service-logs.js', () => ({
  ingestAgentLogs: vi.fn(),
}));

vi.mock('../db/queries/fleet-agent-sync.js', () => ({
  appendFleetServiceSyncLog: vi.fn(),
  getFleetServiceSyncStatus: vi.fn(async () => null),
  upsertFleetServiceSyncStatus: vi.fn(async () => ({})),
}));

vi.mock('../services/fleet-agent-sync.js', () => ({
  buildManagedServiceManifest: vi.fn(),
  etagMatches: vi.fn(() => false),
  getManagedServiceConfigFile: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockGetFleetServiceById = vi.mocked(fleetServices.getFleetServiceById);
const mockCredentialMatches = vi.mocked(fleetAgents.fleetAgentCredentialMatches);
const mockBuildManifest = vi.mocked(fleetAgentSyncService.buildManagedServiceManifest);
const mockIngestMetrics = vi.mocked(metricsPoller.ingestAgentMetrics);
const mockRecordObservation = vi.mocked(fleetServiceObservations.recordFleetServiceObservation);
const mockIngestLogs = vi.mocked(serviceLogs.ingestAgentLogs);
const mockIngestPostfixLines = vi.mocked(metricsPoller.ingestPostfixLogLines);
const mockUpsertSyncStatus = vi.mocked(fleetAgentSync.upsertFleetServiceSyncStatus);
const mockGetProbeManifest = vi.mocked(monitoringProbes.getMonitoringProbeManifest);
const mockIsProbeOnlyAgent = vi.mocked(monitoringProbes.isProbeOnlyAgent);
const mockUpdateProbeHeartbeat = vi.mocked(monitoringProbes.updateMonitoringProbeHeartbeat);
const mockRecordProbeObservations = vi.mocked(monitoringProbes.recordRemoteProbeObservations);

let server: Server;
let baseUrl: string;

function buildService(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    serviceId: 'svc-1',
    serviceType: 'postfix',
    name: 'Postfix',
    description: null,
    apiUrl: null,
    healthUrl: null,
    metricsUrl: null,
    controllerUrl: null,
    normalUrl: null,
    enabled: true,
    agentId: null,
    collectionMode: 'direct',
    logAgentId: null,
    configAgentId: null,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

async function requestJson(path: string, init?: RequestInit) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: {
      ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const body = await response.json().catch(() => null);
  return { response, body };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/fleet/agent', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/fleet/agent`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  resetAgentCommandQueryMock();
  mockCredentialMatches.mockResolvedValue(true); // token itself checks out; axis ownership gates access
  mockBuildManifest.mockResolvedValue({ sha256: 'a'.repeat(64), etag: '"abc"', files: [] } as never);
  mockIngestMetrics.mockResolvedValue({ timestamp: new Date('2024-01-01T00:00:00Z') } as never);
  mockRecordObservation.mockResolvedValue(undefined as never);
  mockIngestLogs.mockResolvedValue(1 as never);
  mockUpsertSyncStatus.mockResolvedValue({} as never);
  mockGetProbeManifest.mockResolvedValue({
    manifest: {
      protocolVersion: 1,
      manifestRevision: 3,
      generatedAt: new Date().toISOString(),
      locationId: 9,
      concurrency: 4,
      checks: [{ checkId: 1, secretHeaders: { authorization: 'private-secret' } }],
    } as never,
    etag: '"3-hash"',
  });
  mockIsProbeOnlyAgent.mockResolvedValue(false);
  mockUpdateProbeHeartbeat.mockResolvedValue(false);
  mockRecordProbeObservations.mockResolvedValue({ inserted: 1, duplicates: 0 });
});

describe('fleet agent per-axis authorization', () => {
  it('a logs-only agent can push logs but not read config or push metrics', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({ logAgentId: 'logs-agent' }) as never);
    const headers = { Authorization: 'Bearer token', 'x-robin-agent-id': 'logs-agent' };

    const logsResult = await requestJson('/services/svc-1/logs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ lines: ['hello'] }),
    });
    expect(logsResult.response.status).toBe(200);

    const manifestResult = await requestJson('/services/svc-1/manifest', { headers });
    expect(manifestResult.response.status).toBe(401);

    const metricsResult = await requestJson('/services/svc-1/metrics', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reachable: true }),
    });
    expect(metricsResult.response.status).toBe(401);
  });

  it('a config-only agent can read config but not push metrics or logs', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({ configAgentId: 'config-agent' }) as never);
    const headers = { Authorization: 'Bearer token', 'x-robin-agent-id': 'config-agent' };

    const manifestResult = await requestJson('/services/svc-1/manifest', { headers });
    expect(manifestResult.response.status).toBe(200);

    const statusResult = await requestJson('/services/svc-1/status', {
      method: 'POST',
      headers,
      body: JSON.stringify({}),
    });
    expect(statusResult.response.status).toBe(200);

    const logsResult = await requestJson('/services/svc-1/logs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ lines: ['hello'] }),
    });
    expect(logsResult.response.status).toBe(401);

    const metricsResult = await requestJson('/services/svc-1/metrics', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reachable: true }),
    });
    expect(metricsResult.response.status).toBe(401);
  });

  it('a full metrics-mode agent (no separate config/log agent) owns every axis', async () => {
    mockGetFleetServiceById.mockResolvedValue(
      buildService({ agentId: 'full-agent', collectionMode: 'agent' }) as never
    );
    const headers = { Authorization: 'Bearer token', 'x-robin-agent-id': 'full-agent' };

    const manifestResult = await requestJson('/services/svc-1/manifest', { headers });
    expect(manifestResult.response.status).toBe(200);

    const metricsResult = await requestJson('/services/svc-1/metrics', {
      method: 'POST',
      headers,
      body: JSON.stringify({ reachable: true }),
    });
    expect(metricsResult.response.status).toBe(200);

    const logsResult = await requestJson('/services/svc-1/logs', {
      method: 'POST',
      headers,
      body: JSON.stringify({ lines: ['hello'] }),
    });
    expect(logsResult.response.status).toBe(200);
  });

  it('rejects a bearer token that names no agent', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService() as never);
    mockCredentialMatches.mockResolvedValue(true);
    const headers = { Authorization: 'Bearer token' };

    const manifestResult = await requestJson('/services/svc-1/manifest', { headers });
    expect(manifestResult.response.status).toBe(401);
    expect(mockCredentialMatches).not.toHaveBeenCalled();
  });

  it('rejects an agent with no assignment on the required axis at all', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService() as never);
    const headers = { Authorization: 'Bearer token', 'x-robin-agent-id': 'stranger-agent' };

    const manifestResult = await requestJson('/services/svc-1/manifest', { headers });
    expect(manifestResult.response.status).toBe(401);
    expect(mockCredentialMatches).not.toHaveBeenCalled();
  });
});

describe('managed config file fetch', () => {
  it('serves files in subdirectories whether the slash arrives encoded or decoded', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({ configAgentId: 'config-agent' }) as never);
    const mockGetFile = vi.mocked(fleetAgentSyncService.getManagedServiceConfigFile);
    mockGetFile.mockResolvedValue({ fileName: 'dkim/example.com.key', etag: '"k"', sha256: 'b'.repeat(64) } as never);
    const headers = { Authorization: 'Bearer token', 'x-robin-agent-id': 'config-agent' };

    for (const path of ['/services/svc-1/files/dkim%2Fexample.com.key', '/services/svc-1/files/dkim/example.com.key']) {
      const { response } = await requestJson(path, { headers });
      expect(response.status).toBe(200);
    }
    expect(mockGetFile.mock.calls.map((call) => call[1])).toEqual(['dkim/example.com.key', 'dkim/example.com.key']);
  });
});

describe('agent log batches', () => {
  it('feeds only incremental Postfix batches into message counters', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({ agentId: 'full-agent', collectionMode: 'agent' }) as never);
    const headers = { Authorization: 'Bearer token', 'x-robin-agent-id': 'full-agent' };
    const push = (body: unknown) => requestJson('/services/svc-1/logs', { method: 'POST', headers, body: JSON.stringify(body) });

    await push({ source: 'journalctl -u postfix@-', lines: ['old'], reset: true });
    expect(mockIngestLogs).toHaveBeenLastCalledWith('svc-1', 'journalctl -u postfix@-', ['old'], true);
    expect(mockIngestPostfixLines).not.toHaveBeenCalled();

    await push({ source: 'journalctl -u postfix@-', lines: ['new'], reset: false });
    expect(mockIngestLogs).toHaveBeenLastCalledWith('svc-1', 'journalctl -u postfix@-', ['new'], false);
    expect(mockIngestPostfixLines).toHaveBeenCalledWith(1, ['new']);
  });
});

describe('agent command channel', () => {
  const headers = { Authorization: 'Bearer token', 'x-robin-agent-id': 'full-agent' };

  beforeEach(() => resetAgentCommandsForTests());

  it('delivers a queued command over the long-poll and returns the agent result', async () => {
    const service = { serviceId: 'svc-1', serviceType: 'postfix' } as const;
    const poll = requestJson('/commands?actions=postfix.queue.flush,not.an.action', { headers });
    await vi.waitFor(() => expect(agentSupports('full-agent', 'postfix.queue.flush')).toBe(true));

    const result = runAgentCommand('full-agent', service, 'postfix.queue.flush');
    const { body } = await poll;
    expect(body.data).toEqual([expect.objectContaining({ serviceId: 'svc-1', action: 'postfix.queue.flush', args: {} })]);

    // Only the agent the command was queued for may answer it.
    const stranger = await requestJson(`/commands/${body.data[0].id}/result`, {
      method: 'POST',
      headers: { ...headers, 'x-robin-agent-id': 'other-agent' },
      body: JSON.stringify({ ok: true, output: 'nope' }),
    });
    expect(stranger.response.status).toBe(404);

    const answer = await requestJson(`/commands/${body.data[0].id}/result`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ ok: true, output: 'flushed' }),
    });
    expect(answer.response.status).toBe(200);
    await expect(result).resolves.toBe('flushed');
  });

  it('rejects commands for agents that are not polling', async () => {
    await expect(runAgentCommand('offline-agent', { serviceId: 'svc-1', serviceType: 'postfix' }, 'postfix.queue.flush'))
      .rejects.toThrow(/not connected/);
  });
});

describe('remote probe channel', () => {
  const headers = { Authorization: 'Bearer probe-test-credential', 'x-robin-agent-id': 'probe-agent' };

  it('returns only the granted manifest and supports conditional polling', async () => {
    const first = await requestJson('/probes/manifest', { headers });
    expect(first.response.status).toBe(200);
    expect(first.response.headers.get('etag')).toBe('"3-hash"');
    expect(first.body.data.checks[0].secretHeaders).toEqual({ authorization: 'private-secret' });

    const unchanged = await fetch(`${baseUrl}/probes/manifest`, { headers: { ...headers, 'If-None-Match': '"3-hash"' } });
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get('cache-control')).toContain('no-store');
  });

  it('authenticates observation uploads and validates bounded payloads before persistence', async () => {
    const now = new Date().toISOString();
    const valid = {
      observations: [{
        checkId: 1, manifestRevision: 3, startedAt: now, finishedAt: now,
        status: 'down', errorCode: 'connect_refused', warning: null,
        responseTimeMs: 12, dnsTimeMs: 0, details: {},
      }],
    };
    const accepted = await requestJson('/probes/observations', {
      method: 'POST', headers, body: JSON.stringify(valid),
    });
    expect(accepted.response.status).toBe(200);
    expect(mockRecordProbeObservations).toHaveBeenCalledWith('probe-agent', expect.arrayContaining([
      expect.objectContaining({ checkId: 1, manifestRevision: 3, errorCode: 'connect_refused' }),
    ]));

    const invalid = await requestJson('/probes/observations', {
      method: 'POST', headers, body: JSON.stringify({ observations: [{ ...valid.observations[0], details: { unsafe: 'x'.repeat(9000) } }] }),
    });
    expect(invalid.response.status).toBe(400);
    expect(mockRecordProbeObservations).toHaveBeenCalledTimes(1);

    mockCredentialMatches.mockResolvedValueOnce(false);
    const unauthorized = await requestJson('/probes/observations', { method: 'POST', headers, body: JSON.stringify(valid) });
    expect(unauthorized.response.status).toBe(401);
  });

  it('does not grant the command channel to probe-only agents', async () => {
    mockIsProbeOnlyAgent.mockResolvedValue(true);
    const response = await requestJson('/commands', { headers });
    expect(response.response.status).toBe(403);
    expect(response.body.error).toContain('Probe-only agents');
  });

  it('does not return a manifest when an authenticated agent has no probe grant', async () => {
    mockGetProbeManifest.mockRejectedValueOnce(new monitoringProbes.ProbeRequestError('Probe capability is not enabled for this agent', 403));
    const response = await requestJson('/probes/manifest', { headers });
    expect(response.response.status).toBe(403);
    expect(response.body).not.toHaveProperty('data');
  });

  it('advertises the granted capability at heartbeat and reports protocol support', async () => {
    mockUpdateProbeHeartbeat.mockResolvedValueOnce(true);
    const response = await requestJson('/heartbeat', {
      method: 'POST',
      headers,
      body: JSON.stringify({ agentVersion: '0.2.0', clientTime: new Date().toISOString(), probeProtocolVersion: 1 }),
    });
    expect(response.response.status).toBe(200);
    expect(response.body.data.probeEnabled).toBe(true);
    expect(mockUpdateProbeHeartbeat).toHaveBeenCalledWith(expect.objectContaining({
      agentId: 'probe-agent', protocolVersion: 1, agentVersion: '0.2.0',
    }));
  });
});
