import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import http from 'node:http';
import https from 'node:https';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';
import { initializeSchema } from '../db/schema.js';
import { closePool, query } from '../db/connection.js';
import { provisionFleetAgent } from '../db/queries/fleet-agents.js';
import { createMonitoringCheck, createMonitoringTarget, deleteMonitoringCheck, deleteMonitoringTarget, getMonitoringCheck } from '../db/queries/monitoring.js';
import { grantMonitoringProbeLocation, updateMonitoringProbeLocation } from '../db/queries/monitoring-probes.js';
import fleetAgentRoutes from './fleet-agent.js';

// Runs the real Go agent (in Docker) against the real fleet-agent routes and PostgreSQL.
// Opt in with PROBE_E2E=1 plus OBSERVABILITY_IT_DB=1 and a throwaway database.
const enabled = process.env.PROBE_E2E === '1' && process.env.OBSERVABILITY_IT_DB === '1';

describe.skipIf(!enabled)('remote probe agent end to end', () => {
  const container = `robin-probe-e2e-${Date.now()}`;
  const servers: Array<http.Server | https.Server> = [];
  let targetId: number | null = null;
  const checkIds: number[] = [];
  let agentId = '';

  beforeAll(async () => {
    process.env.ROBIN_ADMIN_ENCRYPTION_KEY ??= 'isolated-probe-e2e-test-key-at-least-32-characters';
    await initializeSchema();
  }, 60000);

  afterAll(async () => {
    try { execFileSync('docker', ['rm', '-f', container], { stdio: 'ignore' }); } catch { /* not started */ }
    await Promise.all(servers.map(server => new Promise(resolve => server.close(resolve))));
    for (const id of checkIds) await deleteMonitoringCheck(id);
    if (targetId !== null) await deleteMonitoringTarget(targetId);
    if (agentId) await query('DELETE FROM fleet_agents WHERE agent_id = ANY($1::text[])', [[agentId, `${agentId}-other`]]);
    await closePool();
  }, 30000);

  const listen = (server: http.Server | https.Server) => new Promise<number>(resolve => {
    servers.push(server);
    server.listen(0, '0.0.0.0', () => resolve((server.address() as AddressInfo).port));
  });

  it('accepts the results of a real agent, including redirects, and applies them to check state', async () => {
    const app = express();
    app.use(express.json({ limit: '1mb' }));
    app.use('/api/fleet/agent', fleetAgentRoutes);
    const adminPort = await listen(http.createServer(app));
    const targetPort = await listen(http.createServer((req, res) => {
      if (req.url === '/redirect') { res.writeHead(303, { location: '/ok' }); res.end(); return; }
      if (req.url === '/broken') { res.writeHead(500); res.end('broken'); return; }
      res.writeHead(200, { 'content-type': 'text/plain' }); res.end('ok');
    }));

    // The shared certificate lasts decades; the warning path needs one that expires within the 365-day limit.
    const scratch = mkdtempSync(path.join(tmpdir(), 'robin-e2e-tls-'));
    writeFileSync(path.join(scratch, 'o.cnf'), '[req]\ndistinguished_name=dn\nx509_extensions=v3\nprompt=no\n[dn]\nCN=localhost\n[v3]\nsubjectAltName=DNS:localhost,DNS:host.docker.internal,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
    execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(scratch, 'k.pem'), '-out', path.join(scratch, 'c.pem'), '-days', '5', '-config', path.join(scratch, 'o.cnf')], { stdio: 'ignore' });
    const tlsPort = await listen(https.createServer({ cert: readFileSync(path.join(scratch, 'c.pem')), key: readFileSync(path.join(scratch, 'k.pem')) }, (req, res) => {
      const authorised = req.headers['x-e2e-secret'] === 'e2e-secret-value';
      res.writeHead(req.url === '/secure' && !authorised ? 401 : 200); res.end('secure');
    }));

    agentId = `probe-e2e-${Date.now()}`;
    const credential = `e2e-credential-${Date.now()}-abcdefghijklmnop`;
    await provisionFleetAgent({ agentId, name: 'Probe e2e agent', credential });
    const locationId = await grantMonitoringProbeLocation({ agentId, name: `E2E ${Date.now()}`, region: 'e2e', probeConcurrency: 2 });
    await updateMonitoringProbeLocation(locationId, { shadow: false });
    const target = await createMonitoringTarget({ name: `Probe e2e ${Date.now()}`, targetType: 'host', environment: 'test' });
    targetId = target.id;
    const makeCheck = async (name: string, route: string, extra: Record<string, unknown> = {}) => {
      const check = await createMonitoringCheck({
        targetId: target.id, name, checkType: 'http', endpoint: `${extra.tlsMode ? 'https' : 'http'}://host.docker.internal:${extra.tlsMode ? tlsPort : targetPort}${route}`,
        allowPrivate: true, intervalSeconds: 60, confirmationSeconds: 0, recoverySeconds: 0,
        placementMode: 'selected', locationIds: [locationId], quorum: 1, ...extra,
      });
      checkIds.push(check.id);
      return check;
    };
    const ok = await makeCheck('ok', '/ok');
    const redirect = await makeCheck('redirect', '/redirect');
    const broken = await makeCheck('broken', '/broken');
    const expiring = await makeCheck('expiring', '/ok', { tlsMode: 'allow_self_signed', certExpiryDays: 30 });
    const secret = await makeCheck('secret', '/secure', { tlsMode: 'allow_self_signed', secretHeaders: { 'X-E2E-Secret': 'e2e-secret-value' } });
    const otherAgent = `${agentId}-other`;
    await query('INSERT INTO fleet_agents (agent_id, name, enrolled_at) VALUES ($1, $1, CURRENT_TIMESTAMP)', [otherAgent]);
    const otherLocation = await grantMonitoringProbeLocation({ agentId: otherAgent, name: `E2E other ${Date.now()}`, region: 'e2e-other', probeConcurrency: 1 });
    await updateMonitoringProbeLocation(otherLocation, { shadow: false });
    const unassigned = await makeCheck('unassigned', '/ok', { locationIds: [otherLocation] });

    execFileSync('docker', [
      'run', '-d', '--name', container, '--add-host', 'host.docker.internal:host-gateway',
      '-v', `${path.resolve(process.cwd(), '..', 'agent')}:/src`, '-w', '/src',
      '-e', `ROBIN_ADMIN_URL=http://host.docker.internal:${adminPort}`,
      '-e', `ROBIN_AGENT_ID=${agentId}`,
      '-e', `ROBIN_AGENT_CREDENTIAL=${credential}`,
      '-e', 'ROBIN_AGENT_STATE=/tmp/state.json',
      'golang:1.27-alpine', 'sh', '-c', 'go build -o /tmp/agent . && exec /tmp/agent',
    ]);

    const statuses = async () => Object.fromEntries(await Promise.all(
      [ok, redirect, broken, expiring, secret, unassigned].map(async check => [check.name, (await getMonitoringCheck(check.id))?.currentStatus]),
    ));
    const deadline = Date.now() + 150_000;
    let current: Record<string, string | undefined> = {};
    while (Date.now() < deadline) {
      current = await statuses();
      if (current.ok === 'up' && current.redirect === 'up' && current.broken === 'down' && current.expiring === 'warning' && current.secret === 'up') break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    const logs = execFileSync('docker', ['logs', container], { encoding: 'utf8' });
    expect(current, logs).toEqual({ ok: 'up', redirect: 'up', broken: 'down', expiring: 'warning', secret: 'up', unassigned: 'unknown' });

    const stored = await query<{ status: string; error_code: string | null }>(
      'SELECT status, error_code FROM monitoring_observations WHERE location_id = $1 AND check_id = $2',
      [locationId, ok.id],
    );
    expect(stored.rows[0]).toEqual({ status: 'up', error_code: null });
    const warned = await query<{ status: string; error_code: string | null }>(
      'SELECT status, error_code FROM monitoring_observations WHERE location_id = $1 AND check_id = $2',
      [locationId, expiring.id],
    );
    expect(warned.rows[0]).toEqual({ status: 'warning', error_code: null });

    // A shadow location still reports, but its results must not move the check's state.
    await updateMonitoringProbeLocation(locationId, { shadow: true });
    const shadowed = await makeCheck('shadowed', '/broken', { locationIds: [locationId, otherLocation] });
    const shadowDeadline = Date.now() + 150_000;
    let shadowRows: Array<{ status: string }> = [];
    while (Date.now() < shadowDeadline) {
      shadowRows = (await query<{ status: string }>(
        'SELECT status FROM monitoring_observations WHERE location_id = $1 AND check_id = $2',
        [locationId, shadowed.id],
      )).rows;
      if (shadowRows.length) break;
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    expect(shadowRows[0]?.status, logs).toBe('down');
    expect((await getMonitoringCheck(shadowed.id))?.currentStatus).toBe('unknown');
  }, 240000);
});
