import { once } from 'node:events';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { closePool, query } from '../db/connection.js';
import { initializeSchema } from '../db/schema.js';
import { createAlertWebhook, listAlertWebhooks } from '../db/queries/alerts.js';
import { createApiKey } from '../db/queries/security.js';
import { provisionFleetAgent } from '../db/queries/fleet-agents.js';
import { attachApiKey } from '../middleware/security.js';
import { hostSecurityAgentRoutes, hostSecurityRoutes } from './host-security.js';
import { hostSecuritySections } from '../services/host-security.js';
import { evaluateHostSecurity } from '../services/alerts/host-security.js';
import type { HostSecuritySections } from '../types/host-security.js';

describe.skipIf(process.env.HOST_SECURITY_IT_DB !== '1')('host security with disposable PostgreSQL', () => {
  const hostId = 'fixture-host';
  const agentToken = 'host-security-only-fixture-agent';
  let base: string;
  let listener: Server;
  let readToken: string;
  let manageToken: string;
  let otherToken: string;

  beforeAll(async () => {
    if (!/^robin_test_host_security(?:_[a-z0-9]+)?$/.test(process.env.DB_NAME ?? '') || process.env.DB_HOST !== '127.0.0.1') {
      throw new Error('The disposable loopback fixture database is required');
    }
    await initializeSchema();
    await provisionFleetAgent({ agentId: hostId, name: 'Fixture host', credential: agentToken });
    const key = (name: string, scope: string) => createApiKey({
      name, role: 'admin', scopes: [scope], allowedCidrs: [], createdBy: null, expiresAt: null,
    });
    readToken = (await key('fixture-read', 'security:read')).plainText;
    manageToken = (await key('fixture-manage', 'security:manage')).plainText;
    otherToken = (await key('fixture-other', 'logs:read')).plainText;
    await createAlertWebhook({
      name: 'Fixture alert destination', adapter: 'generic', webhookUrl: 'https://alerts.example.test/security',
      enabled: true, notifyRecovery: true,
      subscriptions: [
        { alertType: 'host_ssh_keys', enabled: true },
        { alertType: 'host_sshd', enabled: true },
        { alertType: 'host_network', enabled: true },
        { alertType: 'host_privilege', enabled: true },
        { alertType: 'host_integrity', enabled: true },
        { alertType: 'host_unknown_login', enabled: true },
        { alertType: 'host_password_login', enabled: true },
        { alertType: 'host_failed_auth_rate', enabled: true },
        { alertType: 'host_patching', enabled: true },
        { alertType: 'host_security_stale', enabled: true },
      ],
    });
    const app = express();
    app.use(express.json({ limit: '4mb' }), attachApiKey);
    app.use('/api/fleet/agent/host-security', hostSecurityAgentRoutes);
    app.use('/api/security', hostSecurityRoutes);
    listener = app.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}/api`;
  }, 30000);

  afterAll(async () => {
    if (listener) await new Promise<void>((resolve, reject) => listener.close(error => error ? reject(error) : resolve()));
    await closePool();
  });

  async function send(path: string, token: string, method = 'GET', body?: unknown) {
    const response = await fetch(base + path, {
      method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', 'X-Robin-Agent-Id': hostId },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, ...await response.json() };
  }

  it('authenticates telemetry, links events, approves drift and records firing and recovery', async () => {
    const sections = Object.fromEntries(hostSecuritySections.map(name => [name, {
      status: 'ok', complete: true, items: [],
    }])) as HostSecuritySections;
    sections.sshd.items.push({ id: 'passwordauthentication', value: { name: 'passwordauthentication', value: 'no' } });
    const snapshot = (hash: string) => ({
      version: 1, hash: hash.repeat(64), observedAt: new Date(Date.now() - 2000).toISOString(), intervalSeconds: 60, sections,
    });
    const agent = '/fleet/agent/host-security';
    const host = `/security/hosts/${hostId}`;
    expect((await send(agent + '/snapshot', readToken, 'POST', snapshot('1'))).status).toBe(401);
    const initial = await send(agent + '/snapshot', agentToken, 'POST', snapshot('1'));
    expect(initial.status).toBe(200);
    const heartbeat = { ...snapshot('1'), sections: undefined };
    expect((await send(agent + '/snapshot', agentToken, 'POST', heartbeat)).data.snapshotId).toBe(initial.data.snapshotId);
    expect((await send(host + '/diff', otherToken)).status).toBe(403);
    expect((await send(host + '/diff', readToken)).data.baselinePending).toBe(true);
    const firstApproval = { snapshotId: initial.data.snapshotId, baselineRevision: 0, reason: 'Fixture baseline' };
    expect((await send(host + '/approve', readToken, 'POST', firstApproval)).status).toBe(403);
    expect((await send(host + '/approve', manageToken, 'POST', firstApproval)).status).toBe(200);
    expect((await send(host + '/approve', manageToken, 'POST', firstApproval)).status).toBe(409);

    sections.sshKeys.items.push({
      id: 'key', value: { user: 'fixture', file: '/fixture/authorized_keys', fingerprint: 'SHA256:' + 'A'.repeat(43),
        type: 'ssh-ed25519', bits: 256, options: [], comment: 'Fixture' },
    });
    sections.sshd.items[0].value.value = 'yes';
    sections.listeners.items.push({ id: 'listener', value: { protocol: 'tcp', address: '0.0.0.0', port: 8080, process: null } });
    sections.accounts.items.push({ id: 'fixture', value: { user: 'fixture', uid: 1000, shell: '/bin/bash', home: '/home/fixture' } });
    sections.integrity.items.push({ id: '/fixture', value: { path: '/fixture', sha256: '1'.repeat(64) } });
    sections.patching.items.push({ id: 'system', value: {
      os: 'Fixture Linux', kernel: 'fixture', rebootRequired: true,
      rebootSince: new Date(Date.now() - 8 * 86400000).toISOString(), pending: 1, security: 1,
    } });
    expect((await send(agent + '/snapshot', agentToken, 'POST', snapshot('2'))).status).toBe(200);
    const current = (await send(host + '/diff', readToken)).data;
    expect(current.items.length).toBeGreaterThanOrEqual(5);
    expect((await send('/security/known-addresses', manageToken, 'POST', { network: '192.0.2.0/24', label: 'Fixture' })).status).toBe(200);
    const observedAt = new Date().toISOString();
    const login = { id: '3'.repeat(64), observedAt, type: 'login', process: 'sshd', user: 'fixture',
      sourceIp: '192.0.2.1', authMethod: 'publickey', line: 'Fixture known login' };
    const batch = { version: 1, batchId: '5'.repeat(64), events: [
      login, { ...login, id: '4'.repeat(64), sourceIp: '198.51.100.2', authMethod: 'password', line: 'Fixture unknown login' },
    ], counters: [] };
    expect((await send(agent + '/events', agentToken, 'POST', batch)).status).toBe(200);
    expect((await send(agent + '/events', agentToken, 'POST', batch)).data.duplicate).toBe(true);
    const events = (await send(host + '/events', readToken)).data.items;
    expect(events).toHaveLength(2);
    expect(events.find((event: { id: string }) => event.id === login.id)).toMatchObject({ snapshotId: current.snapshotId, knownAddressId: expect.any(String) });
    expect(events.find((event: { id: string }) => event.id !== login.id)).toMatchObject({ knownAddressId: null });

    await query(`INSERT INTO host_security_counters
      SELECT $1, date_trunc('minute', NOW()) - make_interval(mins => n), 0, 0,
        CASE WHEN n <= 5 THEN 10 ELSE 1 END, 0, 1 FROM generate_series(1, 30) n`, [hostId]);
    await query("UPDATE host_security_hosts SET last_received_at = NOW() - interval '1 hour' WHERE agent_id = $1", [hostId]);
    const webhooks = await listAlertWebhooks();
    await evaluateHostSecurity(hostId, webhooks, true);
    const fired = await query<{ alert_type: string }>("SELECT DISTINCT alert_type FROM alert_deliveries WHERE event_kind = 'failure'");
    expect(fired.rows.map(row => row.alert_type).sort()).toEqual([
      'host_failed_auth_rate',
      'host_integrity',
      'host_network',
      'host_password_login',
      'host_patching',
      'host_privilege',
      'host_security_stale',
      'host_ssh_keys',
      'host_sshd',
      'host_unknown_login',
    ]);
    const approveDiff = { snapshotId: current.snapshotId, baselineRevision: current.baselineRevision, reason: 'Fixture verified' };
    expect((await send(host + '/approve', manageToken, 'POST', approveDiff)).status).toBe(200);
    expect((await send(host + '/diff', readToken)).data.items).toEqual([]);
    const historical = await send(host + '/diff?snapshotId=' + current.snapshotId + '&baselineRevision=' + current.baselineRevision, readToken);
    expect(historical.data.items).toEqual(current.items);
    await query("UPDATE host_security_events SET observed_at = NOW() - interval '25 hours' WHERE agent_id = $1", [hostId]);
    await query("UPDATE host_security_counters SET failed_password = 1 WHERE agent_id = $1", [hostId]);
    sections.patching.items[0].value.rebootRequired = false;
    sections.patching.items[0].value.rebootSince = null;
    sections.patching.items[0].value.security = 0;
    expect((await send(agent + '/snapshot', agentToken, 'POST', snapshot('6'))).status).toBe(200);
    await evaluateHostSecurity(hostId, webhooks, true);
    const recovered = await query<{ alert_type: string }>("SELECT DISTINCT alert_type FROM alert_deliveries WHERE event_kind = 'recovery'");
    expect(recovered.rows.map(row => row.alert_type).sort()).toEqual(fired.rows.map(row => row.alert_type).sort());
    const audit = await query<{ new_values: { reason: string } }>(
      "SELECT new_values FROM admin_audit_log WHERE action = 'host_security.baseline_approve' ORDER BY id DESC");
    expect(audit.rows.map(row => row.new_values.reason)).toEqual(['Fixture verified', 'Fixture baseline']);
  }, 30000);
});
