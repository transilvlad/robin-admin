import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../schema.js';
import { closePool, getClient, query } from '../connection.js';
import { getConfig, resetConfigCacheForTests, updateConfig } from './config.js';
import { createTelemetryDashboard, deleteTelemetryDashboard, getTelemetryDashboard } from './telemetry-dashboards.js';
import { getStatusPageSettings, upsertStatusPageSection, upsertStatusPageComponent, deleteStatusPageComponent, updateStatusPageSettings } from './status-page.js';
import { createMonitoringTarget, createMonitoringCheck, updateMonitoringCheck, deleteMonitoringCheck, deleteMonitoringTarget, getMonitoringCheckLocationHistory, recordMonitoringObservation, refreshMonitoringLocationSilence, listDueMonitoringChecks, getMonitoringCheck } from './monitoring.js';
import { createFleetService, getFleetServiceById, updateFleetService } from './fleet-services.js';
import { decryptStoredSecret } from './secret-crypto.js';
import { OPERATIONS_KEYS } from '../../services/operations-settings.js';
import { deleteHeartbeatTarget, listHeartbeatTargets, saveHeartbeatTarget } from '../../services/monitoring/heartbeat.js';
import {
  grantMonitoringProbeLocation,
  getMonitoringProbeManifest,
  recordRemoteProbeObservations,
  ProbeRequestError,
  updateMonitoringProbeHeartbeat,
  updateMonitoringProbeLocation,
} from './monitoring-probes.js';

describe.skipIf(process.env.OBSERVABILITY_IT_DB !== '1')('generic observability (real PostgreSQL)', () => {
  const previousEncryptionKey = process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
  beforeAll(async () => {
    process.env.ROBIN_ADMIN_ENCRYPTION_KEY ??= 'isolated-observability-test-key-at-least-32-characters';
    await initializeSchema();
  }, 30000);
  afterAll(async () => {
    await closePool();
    if (previousEncryptionKey === undefined) delete process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
    else process.env.ROBIN_ADMIN_ENCRYPTION_KEY = previousEncryptionKey;
  });
  it('encrypts heartbeat URLs and never returns them in the management listing', async () => {
    const pingToken = `ping-secret-${Date.now()}`;
    const failureToken = `failure-secret-${Date.now()}`;
    const created = await saveHeartbeatTarget({
      name: 'Integration heartbeat',
      pingUrl: `https://hc-ping.com/${pingToken}`,
      failureUrl: `https://hc-ping.com/${failureToken}/fail`,
      intervalSeconds: 60,
    });
    try {
      expect(created).toMatchObject({ name: 'Integration heartbeat', pingUrlConfigured: true, failureUrlConfigured: true });
      const stored = (await query<{ encrypted_ping_url: string; encrypted_failure_url: string }>(
        'SELECT encrypted_ping_url, encrypted_failure_url FROM monitoring_heartbeats WHERE id = $1', [created.id],
      )).rows[0]!;
      expect(stored.encrypted_ping_url).not.toContain(pingToken);
      expect(stored.encrypted_failure_url).not.toContain(failureToken);
      const listed = await listHeartbeatTargets();
      const publicJson = JSON.stringify(listed.find(target => target.id === created.id));
      expect(publicJson).not.toContain(pingToken);
      expect(publicJson).not.toContain(failureToken);
      expect(await saveHeartbeatTarget({ id: created.id, name: 'Renamed heartbeat' })).toMatchObject({
        name: 'Renamed heartbeat', pingUrlConfigured: true, failureUrlConfigured: true, intervalSeconds: 60,
      });
    } finally {
      await deleteHeartbeatTarget(created.id);
    }
  });
  it('migrates and seals database DSNs without changing the connection or storing plaintext', async () => {
    const dsn = 'mysql://operator:isolated-password@database.example.test:3306/';
    await query(`INSERT INTO fleet_services (service_id,service_type,name,metrics_url) VALUES ('dsn-upgrade','mariadb','Database',$1)`, [dsn]);
    await initializeSchema();
    const encrypted = (await query("SELECT metrics_url FROM fleet_services WHERE service_id='dsn-upgrade'")).rows[0].metrics_url;
    expect(encrypted).not.toContain('isolated-password');
    expect(decryptStoredSecret(encrypted)).toBe(dsn);
    expect((await getFleetServiceById('dsn-upgrade'))?.metricsUrl).toBe(dsn);
    await initializeSchema();
    expect((await query("SELECT metrics_url FROM fleet_services WHERE service_id='dsn-upgrade'")).rows[0].metrics_url).toBe(encrypted);
    await createFleetService({ serviceId: 'dsn-create', serviceType: 'postgres', name: 'PostgreSQL', metricsUrl: 'postgresql://operator:isolated-password@database.example.test/' });
    await updateFleetService('dsn-create', { metricsUrl: 'postgresql://operator:replacement-password@database.example.test/' });
    const updated = (await query("SELECT metrics_url FROM fleet_services WHERE service_id='dsn-create'")).rows[0].metrics_url;
    expect(updated).not.toContain('replacement-password');
    expect(decryptStoredSecret(updated)).toContain('replacement-password');
    await query("DELETE FROM fleet_services WHERE service_id IN ('dsn-upgrade','dsn-create')");
  }, 30000);
  it('owns only Admin schema and preserves module data and active sessions', async () => {
    for (const table of ['admin_sessions', 'qa_environments', 'qa_mailboxes']) {
      expect((await query('SELECT to_regclass($1) AS relation', [`public.${table}`])).rows[0].relation).toBeNull();
    }
    await query('CREATE TABLE qa_environments (marker TEXT)');
    await query("INSERT INTO qa_environments VALUES ('module-owned')");
    await query("INSERT INTO session VALUES ('active-session', '{}', CURRENT_TIMESTAMP + INTERVAL '1 day')");
    await query('CREATE TABLE admin_sessions (obsolete TEXT)');
    await initializeSchema();
    expect((await query('SELECT marker FROM qa_environments')).rows).toEqual([{ marker: 'module-owned' }]);
    expect((await query('SELECT sid FROM session')).rows).toEqual([{ sid: 'active-session' }]);
    expect((await query("SELECT to_regclass('public.admin_sessions') AS relation")).rows[0].relation).toBeNull();
    await query('DROP TABLE qa_environments');
  });
  it('starts unpublished without any inventory or dashboards', async () => {
    for (const table of ['monitoring_targets', 'monitoring_checks', 'status_page_sections', 'status_page_components', 'telemetry_dashboards']) {
      expect((await query(`SELECT COUNT(*)::int AS count FROM ${table}`)).rows[0].count).toBe(0);
    }
    expect(await getStatusPageSettings()).toMatchObject({ companyName: 'Service Status', companyUrl: null, logoUrl: null, customDomain: null, published: false });
    expect((await query(`SELECT to_regclass('public.telemetry_seeded_templates') AS obsolete`)).rows[0].obsolete).toBeNull();
  });
  it('seeds the Local location and records local probe observations with their error code', async () => {
    const target = await createMonitoringTarget({ name: 'Local location integration', targetType: 'host', environment: 'test' });
    const check = await createMonitoringCheck({
      targetId: target.id,
      name: 'Local location check',
      checkType: 'tcp',
      endpoint: '127.0.0.1',
      port: 9,
      intervalSeconds: 60,
      timeoutSeconds: 5,
      confirmationSeconds: 30,
      recoverySeconds: 0,
    });
    try {
      const observation = await recordMonitoringObservation({
        check,
        status: 'down',
        responseTimeMs: 10,
        error: 'Connection refused',
        errorCode: 'connect_refused',
      });
      expect(observation.locationId).not.toBeNull();
      expect(observation.errorCode).toBe('connect_refused');
      expect((await query(
        `SELECT l.location_key, o.error_code FROM monitoring_observations o
         JOIN monitoring_locations l ON l.id = o.location_id WHERE o.id = $1`,
        [observation.id],
      )).rows[0]).toEqual({ location_key: 'local', error_code: 'connect_refused' });
    } finally {
      await deleteMonitoringCheck(check.id);
      await deleteMonitoringTarget(target.id);
    }
  });
  it('scopes probe manifests and stores authenticated remote observations in shadow mode', async () => {
    const suffix = Date.now();
    const agentId = `probe-it-${suffix}`;
    await query(
      'INSERT INTO fleet_agents (agent_id, name, enrolled_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
      [agentId, `Probe integration ${suffix}`]
    );
    const target = await createMonitoringTarget({ name: `Probe integration ${suffix}`, targetType: 'host', environment: 'test' });
    const check = await createMonitoringCheck({
      targetId: target.id,
      name: 'Remote authorized check',
      checkType: 'http',
      endpoint: 'https://probe.example.test/health',
      secretHeaders: { authorization: 'probe-manifest-secret' },
    });
    try {
      const locationId = await grantMonitoringProbeLocation({
        agentId, name: `Probe ${suffix}`, region: 'test-region', probeConcurrency: 3,
      });
      await updateMonitoringProbeLocation(locationId, { shadow: false });
      await expect(getMonitoringProbeManifest(agentId)).rejects.toMatchObject<Partial<ProbeRequestError>>({
        status: 403, message: 'Agent does not report monitoring probe protocol v1 support',
      });
      expect(await updateMonitoringProbeHeartbeat({
        agentId,
        agentVersion: '0.2.0-test',
        protocolVersion: 1,
        clientTime: new Date(Date.now() - 1500),
      })).toBe(true);
      expect((await query<{ agent_version: string; protocol_version: number; clock_offset_ms: number }>(
        'SELECT agent_version, protocol_version, clock_offset_ms FROM monitoring_locations WHERE id = $1',
        [locationId]
      )).rows[0]).toMatchObject({ agent_version: '0.2.0-test', protocol_version: 1 });
      const clockOffset = (await query<{ clock_offset_ms: number }>(
        'SELECT clock_offset_ms FROM monitoring_locations WHERE id = $1', [locationId]
      )).rows[0].clock_offset_ms;
      expect(clockOffset).toBeGreaterThan(100);
      expect(clockOffset).toBeLessThan(10_000);
      const first = await getMonitoringProbeManifest(agentId);
      expect(first.manifest).toMatchObject({
        protocolVersion: 1,
        manifestRevision: 1,
        locationId,
        concurrency: 3,
        checks: expect.arrayContaining([
          expect.objectContaining({ checkId: check.id, secretHeaders: { authorization: 'probe-manifest-secret' } }),
        ]),
      });
      expect((await getMonitoringProbeManifest(agentId)).etag).toBe(first.etag);

      const unassigned = await createMonitoringCheck({
        targetId: target.id, name: 'Not in revision one', checkType: 'tcp',
        endpoint: '127.0.0.1', port: 9,
      });
      const now = new Date();
      const observation = {
        checkId: check.id,
        manifestRevision: first.manifest.manifestRevision,
        startedAt: new Date(now.getTime() - 10_000),
        finishedAt: new Date(now.getTime() - 9_900),
        status: 'down' as const,
        errorCode: 'connect_refused',
        warning: null,
        responseTimeMs: 100,
        dnsTimeMs: 0,
        details: { source: 'remote' },
      };
      expect(await recordRemoteProbeObservations(agentId, [observation])).toEqual({ inserted: 1, duplicates: 0, ignored: 0 });
      expect(await recordRemoteProbeObservations(agentId, [observation])).toEqual({ inserted: 0, duplicates: 1, ignored: 0 });
      expect(await recordRemoteProbeObservations(agentId, [{ ...observation, checkId: unassigned.id }, { ...observation, checkId: 2_000_000_000 }]))
        .toEqual({ inserted: 0, duplicates: 0, ignored: 2 });
      expect((await query<{ current_status: string }>('SELECT current_status FROM monitoring_checks WHERE id = $1', [check.id])).rows[0].current_status).toBe('unknown');
      expect((await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM monitoring_check_daily WHERE check_id = $1', [check.id])).rows[0].count).toBe(0);

      const second = await getMonitoringProbeManifest(agentId);
      expect(second.manifest.manifestRevision).toBe(2);
      expect(await recordRemoteProbeObservations(agentId, [observation])).toEqual({ inserted: 0, duplicates: 1, ignored: 0 });

      const late = {
        ...observation,
        manifestRevision: second.manifest.manifestRevision,
        startedAt: new Date(Date.now() - 10 * 60_000),
        finishedAt: new Date(Date.now() - 10 * 60_000 + 100),
      };
      expect(await recordRemoteProbeObservations(agentId, [late])).toEqual({ inserted: 1, duplicates: 0, ignored: 0 });
      await query(
        'UPDATE monitoring_locations SET manifest_updated_at = CURRENT_TIMESTAMP - INTERVAL \'6 minutes\' WHERE agent_id = $1',
        [agentId]
      );
      await expect(recordRemoteProbeObservations(agentId, [observation]))
        .rejects.toMatchObject<Partial<ProbeRequestError>>({ status: 409, message: 'Observation manifest revision is stale' });
      await expect(recordRemoteProbeObservations(agentId, [{
        ...late, startedAt: new Date(Date.now() + 10 * 60_000), finishedAt: new Date(Date.now() + 10 * 60_000 + 100),
      }])).rejects.toMatchObject<Partial<ProbeRequestError>>({ status: 400, message: 'Observation timestamp is too far in the future' });
      await expect(recordRemoteProbeObservations(agentId, [{
        ...late, startedAt: new Date(Date.now() - 25 * 60_000), finishedAt: new Date(Date.now() - 25 * 60_000 + 100),
      }, late])).resolves.toEqual({ inserted: 0, duplicates: 1, ignored: 1 });
      await updateMonitoringProbeLocation(locationId, { enabled: false });
      await expect(getMonitoringProbeManifest(agentId)).rejects.toMatchObject<Partial<ProbeRequestError>>({
        status: 403, message: 'Probe capability is not enabled for this agent',
      });
      await expect(recordRemoteProbeObservations(agentId, [late])).rejects.toMatchObject<Partial<ProbeRequestError>>({
        status: 403, message: 'Probe capability is not enabled for this agent',
      });
    } finally {
      await deleteMonitoringTarget(target.id);
      await query('DELETE FROM fleet_agents WHERE agent_id = $1', [agentId]);
    }
  }, 30000);
  it('combines assigned probe results, retains per-location history, and closes a silent-location issue on recovery', async () => {
    const suffix = Date.now();
    const agentId = `probe-quorum-it-${suffix}`;
    await query(
      'INSERT INTO fleet_agents (agent_id, name, enrolled_at) VALUES ($1, $2, CURRENT_TIMESTAMP)',
      [agentId, `Probe quorum integration ${suffix}`],
    );
    const target = await createMonitoringTarget({ name: `Probe quorum integration ${suffix}`, targetType: 'host', environment: 'test' });
    let checkId: number | null = null;
    try {
      const locationId = await grantMonitoringProbeLocation({
        agentId, name: `Probe quorum ${suffix}`, region: 'quorum-test', probeConcurrency: 1,
      });
      await updateMonitoringProbeLocation(locationId, { shadow: false });
      const check = await createMonitoringCheck({
        targetId: target.id,
        name: 'Selected probe check',
        checkType: 'http',
        endpoint: 'https://probe.example.test/health',
        intervalSeconds: 60,
        confirmationSeconds: 0,
        recoverySeconds: 0,
        placementMode: 'selected',
        locationIds: [locationId],
        quorum: 1,
      });
      checkId = check.id;
      await updateMonitoringProbeHeartbeat({
        agentId, agentVersion: '0.2.0-test', protocolVersion: 1, clientTime: new Date(),
      });
      const manifest = await getMonitoringProbeManifest(agentId);
      const submit = (status: 'up' | 'down', offsetMs = 0) => {
        const startedAt = new Date(Date.now() - 10_000 - offsetMs);
        return recordRemoteProbeObservations(agentId, [{
          checkId: check.id,
          manifestRevision: manifest.manifest.manifestRevision,
          startedAt,
          finishedAt: new Date(startedAt.getTime() + 100),
          status,
          errorCode: status === 'down' ? 'connect_refused' : null,
          warning: status === 'down' ? 'Connection refused' : null,
          responseTimeMs: 100,
          dnsTimeMs: 0,
          details: { source: 'remote' },
        }]);
      };

      await submit('up');
      expect((await query<{ current_status: string }>(
        'SELECT current_status FROM monitoring_checks WHERE id = $1', [check.id],
      )).rows[0].current_status).toBe('up');
      await submit('down');
      expect((await query<{ current_status: string }>(
        'SELECT current_status FROM monitoring_checks WHERE id = $1', [check.id],
      )).rows[0].current_status).toBe('down');
      expect((await getMonitoringCheckLocationHistory(check.id, 7)).map(day => ({
        locationId: day.locationId, up: day.up, down: day.down,
      }))).toEqual([{ locationId, up: 1, down: 1 }]);

      await query(
        `UPDATE monitoring_observations SET observed_at = CURRENT_TIMESTAMP - INTERVAL '5 minutes', received_at = CURRENT_TIMESTAMP - INTERVAL '5 minutes'
         WHERE check_id = $1 AND location_id = $2`,
        [check.id, locationId],
      );
      await query(
        `UPDATE monitoring_locations SET created_at = CURRENT_TIMESTAMP - INTERVAL '5 minutes'
         WHERE id = $1`,
        [locationId],
      );
      await refreshMonitoringLocationSilence();
      expect((await query<{ status: string }>(
        'SELECT status FROM monitoring_location_issues WHERE location_id = $1 AND status = $2',
        [locationId, 'open'],
      )).rows).toEqual([{ status: 'open' }]);

      await submit('up', 1);
      expect((await query<{ status: string }>(
        'SELECT status FROM monitoring_location_issues WHERE location_id = $1 ORDER BY id DESC LIMIT 1',
        [locationId],
      )).rows[0].status).toBe('closed');
      const lateDown = {
        checkId: check.id,
        manifestRevision: manifest.manifest.manifestRevision,
        startedAt: new Date(Date.now() - 5 * 60_000),
        finishedAt: new Date(Date.now() - 5 * 60_000 + 100),
        status: 'down' as const,
        errorCode: 'connect_refused',
        warning: 'Connection refused',
        responseTimeMs: 100,
        dnsTimeMs: 0,
        details: { source: 'late' },
      };
      await recordRemoteProbeObservations(agentId, [lateDown]);
      expect((await query<{ current_status: string }>(
        'SELECT current_status FROM monitoring_checks WHERE id = $1', [check.id],
      )).rows[0].current_status).toBe('up');
    } finally {
      if (checkId !== null) await deleteMonitoringCheck(checkId);
      await deleteMonitoringTarget(target.id);
      await query('DELETE FROM fleet_agents WHERE agent_id = $1', [agentId]);
    }
  }, 30000);
  it('keeps shadow locations out of the vote and secrets, and keeps remote results from rescheduling Local', async () => {
    const suffix = Date.now();
    const agentId = `probe-shadow-it-${suffix}`;
    await query('INSERT INTO fleet_agents (agent_id, name, enrolled_at) VALUES ($1, $2, CURRENT_TIMESTAMP)', [agentId, `Probe shadow ${suffix}`]);
    const target = await createMonitoringTarget({ name: `Probe shadow ${suffix}`, targetType: 'host', environment: 'test' });
    let checkId: number | null = null;
    try {
      const locationId = await grantMonitoringProbeLocation({ agentId, name: `Shadow ${suffix}`, region: 'shadow-test', probeConcurrency: 1 });
      expect((await query<{ shadow: boolean }>('SELECT shadow FROM monitoring_locations WHERE id = $1', [locationId])).rows[0].shadow).toBe(true);
      const check = await createMonitoringCheck({
        targetId: target.id, name: 'Shadow check', checkType: 'http', endpoint: 'https://probe.example.test/health',
        intervalSeconds: 60, confirmationSeconds: 0, recoverySeconds: 0, secretHeaders: { authorization: 'shadow-secret' },
      });
      checkId = check.id;
      await updateMonitoringProbeHeartbeat({ agentId, agentVersion: '0.2.0-test', protocolVersion: 1, clientTime: new Date() });
      const manifest = await getMonitoringProbeManifest(agentId);
      const entry = manifest.manifest.checks.find(candidate => candidate.checkId === check.id)!;
      expect(entry.secretHeaders).toBeUndefined();

      const scheduledBefore = (await getMonitoringCheck(check.id))?.nextRunAt?.getTime();
      const startedAt = new Date(Date.now() - 5_000);
      const result = await recordRemoteProbeObservations(agentId, [{
        checkId: check.id, manifestRevision: manifest.manifest.manifestRevision, startedAt, finishedAt: new Date(startedAt.getTime() + 100),
        status: 'down', errorCode: 'connect_refused', warning: null, responseTimeMs: 100, dnsTimeMs: 0, details: {},
      }]);
      expect(result.inserted).toBe(1);
      const state = await getMonitoringCheck(check.id);
      expect(state?.currentStatus).not.toBe('down');
      expect(state?.nextRunAt?.getTime()).toBe(scheduledBefore);
      expect((await query('SELECT 1 FROM monitoring_issues WHERE check_id = $1', [check.id])).rowCount).toBe(0);
      expect((await getMonitoringCheckLocationHistory(check.id, 7)).some(day => day.locationId === locationId)).toBe(true);

      await query(`UPDATE monitoring_checks SET next_run_at = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE id = $1`, [check.id]);
      await query(`UPDATE monitoring_locations SET enabled = false WHERE location_key = 'local'`);
      try {
        expect((await listDueMonitoringChecks(500)).some(due => due.id === check.id)).toBe(false);
      } finally {
        await query(`UPDATE monitoring_locations SET enabled = true WHERE location_key = 'local'`);
      }
      expect((await listDueMonitoringChecks(500)).some(due => due.id === check.id)).toBe(true);
    } finally {
      if (checkId !== null) await deleteMonitoringCheck(checkId);
      await deleteMonitoringTarget(target.id);
      await query('DELETE FROM fleet_agents WHERE agent_id = $1', [agentId]);
    }
  }, 30000);
  it('does not page on a partial failure, reports an unmet quorum, and exposes per-location availability', async () => {
    const suffix = Date.now();
    const agents = [`probe-vote-a-${suffix}`, `probe-vote-b-${suffix}`, `probe-vote-shadow-${suffix}`];
    for (const agentId of agents) {
      await query('INSERT INTO fleet_agents (agent_id, name, enrolled_at) VALUES ($1, $2, CURRENT_TIMESTAMP)', [agentId, agentId]);
    }
    const target = await createMonitoringTarget({ name: `Probe vote ${suffix}`, targetType: 'host', environment: 'test' });
    const checkIds: number[] = [];
    try {
      const [a, b, shadow] = await Promise.all(agents.map((agentId, index) => grantMonitoringProbeLocation({
        agentId, name: `Vote ${index} ${suffix}`, region: 'vote-test', probeConcurrency: 1,
      })));
      await updateMonitoringProbeLocation(a, { shadow: false });
      await updateMonitoringProbeLocation(b, { shadow: false });
      const createCheck = async (name: string, locationIds: number[], quorum: number) => {
        const check = await createMonitoringCheck({
          targetId: target.id, name, checkType: 'http', endpoint: 'https://probe.example.test/health',
          intervalSeconds: 60, confirmationSeconds: 0, recoverySeconds: 0,
          placementMode: 'selected', locationIds, quorum,
        });
        checkIds.push(check.id);
        return check;
      };
      const submit = async (agentId: string, checkId: number, status: 'up' | 'down') => {
        await updateMonitoringProbeHeartbeat({ agentId, agentVersion: '0.2.0-test', protocolVersion: 1, clientTime: new Date() });
        const { manifest } = await getMonitoringProbeManifest(agentId);
        const startedAt = new Date(Date.now() - 5_000);
        await recordRemoteProbeObservations(agentId, [{
          checkId, manifestRevision: manifest.manifestRevision, startedAt, finishedAt: new Date(startedAt.getTime() + 100),
          status, errorCode: status === 'down' ? 'connect_refused' : null, warning: null, responseTimeMs: 100, dnsTimeMs: 0, details: {},
        }]);
      };

      const partial = await createCheck('Partial failure', [a, b], 2);
      await submit(agents[0], partial.id, 'up');
      await submit(agents[1], partial.id, 'down');
      const partialState = await getMonitoringCheck(partial.id);
      expect(partialState?.currentStatus).toBe('warning');
      expect((await query('SELECT 1 FROM monitoring_issues WHERE check_id = $1', [partial.id])).rowCount).toBe(0);
      const availability = new Map((await getMonitoringCheckLocationHistory(partial.id, 7)).map(day => [day.locationId, day.availability]));
      expect(availability.get(a)).toBe(1);
      expect(availability.get(b)).toBe(0);

      await expect(createCheck('Shadow only', [shadow], 1)).rejects.toThrow(/voting/);
      await expect(createCheck('Quorum over voting', [a, shadow], 2)).rejects.toThrow(/Quorum cannot exceed/);

      const unmet = await createCheck('Unmet quorum', [a, b], 2);
      await updateMonitoringProbeLocation(b, { shadow: true });
      await submit(agents[0], unmet.id, 'up');
      const unmetState = await getMonitoringCheck(unmet.id);
      expect(unmetState?.currentStatus).toBe('unknown');
      expect(unmetState?.lastError).toBe('Quorum of 2 cannot be met by 1 voting location');
      const unmetIssue = await query<{ severity: string; summary: string }>("SELECT severity, summary FROM monitoring_issues WHERE check_id = $1 AND status = 'open'", [unmet.id]);
      expect(unmetIssue.rowCount).toBe(1);
      expect(unmetIssue.rows[0].summary).toContain('cannot reach quorum');
      expect(unmetIssue.rows[0].severity).toBe('warning');
      await updateMonitoringProbeLocation(b, { shadow: false });

      const quorumOnly = await createCheck('Quorum only edit', [a, b], 1);
      await updateMonitoringProbeLocation(b, { shadow: true });
      await expect(updateMonitoringCheck(quorumOnly.id, { quorum: 2 })).rejects.toThrow(/Quorum cannot exceed/);
      await updateMonitoringProbeLocation(b, { shadow: false });
    } finally {
      for (const id of checkIds) await deleteMonitoringCheck(id);
      await deleteMonitoringTarget(target.id);
      for (const agentId of agents) await query('DELETE FROM fleet_agents WHERE agent_id = $1', [agentId]);
    }
  }, 30000);
  it('ingests remote warnings, ignores stale buffered results, and resets a re-granted location to shadow', async () => {
    const suffix = Date.now();
    const agentId = `probe-warn-it-${suffix}`;
    await query('INSERT INTO fleet_agents (agent_id, name, enrolled_at) VALUES ($1, $2, CURRENT_TIMESTAMP)', [agentId, agentId]);
    const target = await createMonitoringTarget({ name: `Probe warn ${suffix}`, targetType: 'host', environment: 'test' });
    let checkId: number | null = null;
    try {
      const locationId = await grantMonitoringProbeLocation({ agentId, name: `Warn ${suffix}`, region: 'warn-test', probeConcurrency: 1 });
      await updateMonitoringProbeLocation(locationId, { shadow: false });
      await grantMonitoringProbeLocation({ agentId, name: `Warn ${suffix}`, region: 'warn-test', probeConcurrency: 1 });
      expect((await query<{ shadow: boolean }>('SELECT shadow FROM monitoring_locations WHERE id = $1', [locationId])).rows[0].shadow).toBe(true);
      await updateMonitoringProbeLocation(locationId, { shadow: false });
      const check = await createMonitoringCheck({
        targetId: target.id, name: 'Warn check', checkType: 'http', endpoint: 'https://probe.example.test/health',
        intervalSeconds: 60, confirmationSeconds: 0, recoverySeconds: 0, placementMode: 'selected', locationIds: [locationId], quorum: 1,
      });
      checkId = check.id;
      await updateMonitoringProbeHeartbeat({ agentId, agentVersion: '0.2.0-test', protocolVersion: 1, clientTime: new Date() });
      const { manifest } = await getMonitoringProbeManifest(agentId);
      const observe = (startedAt: Date, status: 'up' | 'warning') => recordRemoteProbeObservations(agentId, [{
        checkId: check.id, manifestRevision: manifest.manifestRevision, startedAt, finishedAt: new Date(startedAt.getTime() + 100),
        status, errorCode: null, warning: status === 'warning' ? 'Certificate expires soon' : null, responseTimeMs: 100, dnsTimeMs: 0, details: {},
      }]);
      expect((await observe(new Date(Date.now() - 5_000), 'warning')).inserted).toBe(1);
      expect((await getMonitoringCheck(check.id))?.currentStatus).toBe('warning');
      const stale = await observe(new Date(Date.now() - 6 * 3_600_000), 'up').catch(error => error);
      if (!(stale instanceof Error)) expect(stale.inserted + stale.ignored + stale.duplicates).toBe(1);
      expect((await getMonitoringCheck(check.id))?.currentStatus).toBe('warning');
    } finally {
      if (checkId !== null) await deleteMonitoringCheck(checkId);
      await deleteMonitoringTarget(target.id);
      await query('DELETE FROM fleet_agents WHERE agent_id = $1', [agentId]);
    }
  }, 30000);
  it('preserves saved configuration and history across repeated initialization', async () => {    const content = { title: 'Custom metrics', description: '', variables: [], rows: [] };
    const dashboard = await createTelemetryDashboard(content, { actor: 'Operator', preferredUid: 'custom' });
    const section = await upsertStatusPageSection({ name: 'Applications', position: 8, enabled: true });
    const component = await upsertStatusPageComponent({ sectionId: section.id, publicName: 'App', description: 'Configured by operator', position: 3, enabled: false, showHistory: false, checkIds: [] });
    await updateStatusPageSettings({ companyName: 'Example Operator', published: true });
    await initializeSchema();
    expect(await getTelemetryDashboard(dashboard.uid)).toEqual(dashboard);
    expect((await query('SELECT COUNT(*)::int AS count FROM telemetry_dashboard_versions WHERE dashboard_id = (SELECT id FROM telemetry_dashboards WHERE uid = $1)', [dashboard.uid])).rows[0].count).toBe(1);
    expect(await getStatusPageSettings()).toMatchObject({ companyName: 'Example Operator', published: true });
    expect((await query('SELECT public_name,position,enabled FROM status_page_components WHERE id=$1',[component.id])).rows[0]).toEqual({ public_name: 'App', position: 3, enabled: false });
    await deleteTelemetryDashboard(dashboard.uid);
    await deleteStatusPageComponent(component.id);
    await initializeSchema();
    expect(await getTelemetryDashboard(dashboard.uid)).toBeNull();
    expect((await query('SELECT COUNT(*)::int AS count FROM status_page_components')).rows[0].count).toBe(0);
  });
  it('migrates legacy certificate checks to warning while defaulting new checks to down', async () => {
    const target = await createMonitoringTarget({ name: 'Certificate migration fixture', targetType: 'host', environment: 'test' });
    try {
      const legacy = await createMonitoringCheck({ targetId: target.id, name: 'Legacy TLS check', checkType: 'http', endpoint: 'https://legacy.example.test' });
      await query('ALTER TABLE monitoring_checks DROP CONSTRAINT IF EXISTS valid_monitoring_check_certificate_error_mode');
      await query('ALTER TABLE monitoring_checks DROP COLUMN certificate_error_mode');
      await initializeSchema();
      const migrated = (await query<{ certificate_error_mode: string }>(
        'SELECT certificate_error_mode FROM monitoring_checks WHERE id = $1', [legacy.id]
      )).rows[0];
      expect(migrated?.certificate_error_mode).toBe('warning');
      const created = await createMonitoringCheck({ targetId: target.id, name: 'New TLS check', checkType: 'http', endpoint: 'https://new.example.test' });
      expect(created.certificateErrorMode).toBe('down');
    } finally {
      await deleteMonitoringTarget(target.id);
    }
  });
  it('persists validated discovery settings atomically and rejects injection without writes', async () => {
    await updateConfig({ telemetrySourceLabel: 'host', telemetryGroupLabel: '', telemetrySourceSelector: '{job="metrics"}' });
    resetConfigCacheForTests();
    expect(await getConfig()).toMatchObject({ telemetrySourceLabel: 'host', telemetryGroupLabel: '', telemetrySourceSelector: '{job="metrics"}' });
    await expect(updateConfig({ telemetrySourceSelector: 'up or vector(1)' })).rejects.toThrow('selector');
    await expect(updateConfig({ telemetryGroupLabel: 'host' })).rejects.toThrow('distinct');
    resetConfigCacheForTests();
    expect((await getConfig()).telemetrySourceSelector).toBe('{job="metrics"}');
  });
  it('broadcasts a follower configuration save to other PostgreSQL listeners', async () => {
    const listener = await getClient();
    let previousInterval: number | undefined;
    try {
      await listener.query('LISTEN config_changed');
      const notification = new Promise<{ channel: string; payload: string }>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('Configuration notification timed out')), 5000);
        listener.once('notification', message => {
          clearTimeout(timer);
          resolve({ channel: message.channel ?? '', payload: message.payload ?? '' });
        });
      });
      previousInterval = (await getConfig()).metricsPollIntervalMs;
      await updateConfig({ metricsPollIntervalMs: previousInterval === 120000 ? 60000 : 120000 });
      const received = await notification;
      expect(received.channel).toBe('config_changed');
      expect(JSON.parse(received.payload)).toMatchObject({ keys: expect.arrayContaining(['metricsPollIntervalMs']) });
    } finally {
      if (previousInterval !== undefined) await updateConfig({ metricsPollIntervalMs: previousInterval });
      await listener.query('UNLISTEN config_changed');
      listener.release();
      resetConfigCacheForTests();
    }
  });
  it('imports legacy alert environment settings only when no policy has been saved', async () => {
    const previousRows = await query<{ key: string; value: string }>(
      'SELECT key, value FROM admin_config WHERE key = ANY($1::text[])',
      [OPERATIONS_KEYS]
    );
    const names = ['ALERTING_ENABLED', 'ALERT_EVALUATION_INTERVAL_MS', 'ALERT_DELIVERY_CONCURRENCY', 'ALERT_INSTANCE_NAME', 'REPORT_INGEST_BODY_LIMIT_BYTES'];
    const previousEnvironment = new Map(names.map(name => [name, process.env[name]]));
    try {
      await query('DELETE FROM admin_config WHERE key = ANY($1::text[])', [OPERATIONS_KEYS]);
      process.env.ALERTING_ENABLED = 'true';
      process.env.ALERT_EVALUATION_INTERVAL_MS = '15000';
      process.env.ALERT_DELIVERY_CONCURRENCY = '2';
      process.env.ALERT_INSTANCE_NAME = 'Upgrade fixture';
      process.env.REPORT_INGEST_BODY_LIMIT_BYTES = String(5 * 1024 * 1024);
      await initializeSchema();
      resetConfigCacheForTests();
      expect(await getConfig()).toMatchObject({
        alertsEnabled: true,
        alertEvaluationIntervalMs: 15000,
        alertDeliveryConcurrency: 2,
        alertInstanceName: 'Upgrade fixture',
        reportingIngestMaxMiB: 5,
      });
    } finally {
      await query('DELETE FROM admin_config WHERE key = ANY($1::text[])', [OPERATIONS_KEYS]);
      if (previousRows.rows.length) {
        await query(
          `INSERT INTO admin_config (key, value, updated_at)
           SELECT key, value, CURRENT_TIMESTAMP FROM UNNEST($1::text[], $2::text[]) AS settings(key, value)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = CURRENT_TIMESTAMP`,
          [previousRows.rows.map(row => row.key), previousRows.rows.map(row => row.value)]
        );
      }
      for (const [name, value] of previousEnvironment) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      resetConfigCacheForTests();
    }
  });
  it('keeps fresh telemetry discovery defaults when no prior telemetry state exists', async () => {
    await query(`DELETE FROM admin_config WHERE key IN (
      'telemetrySourceLabel', 'telemetryGroupLabel', 'telemetrySourceSelector',
      'migration:telemetry-discovery-defaults-v1'
    )`);
    await query('DELETE FROM telemetry_dashboards');
    await query('DROP TABLE IF EXISTS telemetry_seeded_templates');
    await initializeSchema();
    resetConfigCacheForTests();
    expect(await getConfig()).toMatchObject({ telemetrySourceLabel: 'instance', telemetryGroupLabel: 'job' });
  });
  it('migrates source bindings and detaches retired template metadata without losing content', async () => {
    await query(`DELETE FROM admin_config WHERE key IN (
      'telemetrySourceLabel', 'telemetryGroupLabel', 'telemetrySourceSelector',
      'migration:telemetry-discovery-defaults-v1'
    )`);
    await query('ALTER TABLE fleet_services RENAME COLUMN telemetry_source TO telemetry_host');
    await query(`INSERT INTO fleet_services (service_id,name,service_type,api_url,telemetry_host)
      VALUES ('migration-test','Migration test','robin','http://node.example.test','node.example.test')`);
    const dashboard = await createTelemetryDashboard({ title: 'Saved dashboard', description: '', variables: [], rows: [] }, { actor: 'Operator', preferredUid: 'saved' });
    await query('UPDATE telemetry_dashboards SET template_key=$1,template_hash=$2 WHERE uid=$3', ['retired-example','old',dashboard.uid]);
    await query('CREATE TABLE telemetry_seeded_templates (template_key TEXT PRIMARY KEY)');
    await initializeSchema();
    resetConfigCacheForTests();
    expect(await getConfig()).toMatchObject({ telemetrySourceLabel: 'host', telemetryGroupLabel: 'role' });
    expect((await query('SELECT telemetry_source FROM fleet_services WHERE service_id=$1', ['migration-test'])).rows[0].telemetry_source).toBe('node.example.test');
    expect((await query(`SELECT COUNT(*)::int AS count FROM information_schema.columns WHERE table_schema=current_schema() AND table_name='fleet_services' AND column_name='telemetry_host'`)).rows[0].count).toBe(0);
    expect(await getTelemetryDashboard(dashboard.uid)).toMatchObject({ title: dashboard.title, rows: dashboard.rows, templateKey: null, version: 1 });
    expect((await query('SELECT COUNT(*)::int AS count FROM telemetry_dashboard_versions WHERE dashboard_id=(SELECT id FROM telemetry_dashboards WHERE uid=$1)', [dashboard.uid])).rows[0].count).toBe(1);
    expect((await query(`SELECT to_regclass('public.telemetry_seeded_templates') AS obsolete`)).rows[0].obsolete).toBeNull();
  });
  it('migrates HTTPS checks without replacing settings or their observation history', async () => {
    const target = await createMonitoringTarget({ name: 'Configured application', targetType: 'endpoint' });
    const check = await createMonitoringCheck({ targetId: target.id, name: 'Application readiness', checkType: 'http', endpoint: 'https://app.example.test/ready', enabled: false,
      options: { http: { method: 'GET', expectedStatuses: [200], assertions: [{ kind: 'body', operator: 'contains', value: 'ready' }] } } });
    const original = (await query('SELECT options_json FROM monitoring_checks WHERE id=$1', [check.id])).rows[0].options_json;
    const plaintext = await createMonitoringCheck({ targetId: target.id, name: 'Legacy TCP', checkType: 'tcp', endpoint: 'service.example.test', port: 25 });
    await query(`UPDATE monitoring_checks SET tls_mode='allow_self_signed', cert_expiry_days=14, allow_private=false WHERE id=$1`, [plaintext.id]);
    await query(`DELETE FROM admin_config WHERE key='migration:monitoring-check-upgrade-v1'`);
    await query('ALTER TABLE monitoring_checks DROP COLUMN allow_private');
    await query(`ALTER TABLE monitoring_checks DROP CONSTRAINT valid_monitoring_check_type`);
    await query(`UPDATE monitoring_checks SET check_type='https' WHERE id=$1`, [check.id]);
    await query(`INSERT INTO monitoring_observations (check_id,status,response_time_ms) VALUES ($1,'up',12)`, [check.id]);
    await initializeSchema();
    expect((await query('SELECT check_type,enabled,allow_private,options_json FROM monitoring_checks WHERE id=$1', [check.id])).rows[0]).toEqual({ check_type: 'http', enabled: false, allow_private: true, options_json: original });
    expect((await query('SELECT allow_private,tls_mode,cert_expiry_days FROM monitoring_checks WHERE id=$1', [plaintext.id])).rows[0]).toEqual({ allow_private: true, tls_mode: 'strict', cert_expiry_days: null });
    expect((await query(`SELECT COUNT(*)::int AS count FROM admin_audit_log WHERE action='monitoring.legacy_checks_migrated'`)).rows[0].count).toBeGreaterThan(0);
    expect((await query('SELECT status,response_time_ms FROM monitoring_observations WHERE check_id=$1', [check.id])).rows).toEqual([{ status: 'up', response_time_ms: 12 }]);
    await expect(query(`UPDATE monitoring_checks SET check_type='https' WHERE id=$1`, [check.id])).rejects.toThrow();
    await query('UPDATE monitoring_checks SET allow_private=false WHERE id=$1', [check.id]);
    await query(`DELETE FROM admin_config WHERE key='migration:monitoring-check-upgrade-v1'`);
    await initializeSchema();
    expect((await query('SELECT allow_private FROM monitoring_checks WHERE id=$1', [check.id])).rows[0]).toEqual({ allow_private: false });
    await deleteMonitoringCheck(check.id);
    await deleteMonitoringCheck(plaintext.id);
    await query('DELETE FROM monitoring_targets WHERE id=$1', [target.id]);
  });
  it('rebuilds an invalid concurrently-built index on the next start', async () => {
    await query('DROP INDEX IF EXISTS idx_monitoring_observations_check_location_latest');
    await initializeSchema();
    const valid = async () => (await query<{ valid: boolean }>(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid WHERE c.relname = 'idx_monitoring_observations_check_location_latest'`,
    )).rows[0]?.valid;
    expect(await valid()).toBe(true);
    await query(`UPDATE pg_index SET indisvalid = false WHERE indexrelid = 'idx_monitoring_observations_check_location_latest'::regclass`);
    await initializeSchema();
    expect(await valid()).toBe(true);
  });
  it('attributes pre-location observations to Local once, when the location column is added', async () => {
    const target = await createMonitoringTarget({ name: 'Backfill target', targetType: 'endpoint' });
    const check = await createMonitoringCheck({ targetId: target.id, name: 'Backfill check', checkType: 'tcp', endpoint: 'service.example.test', port: 25 });
    try {
      await query('ALTER TABLE monitoring_observations DROP COLUMN location_id');
      await query(`INSERT INTO monitoring_observations (check_id,status) VALUES ($1,'up')`, [check.id]);
      await initializeSchema();
      const local = (await query<{ id: number }>(`SELECT id FROM monitoring_locations WHERE location_key = 'local'`)).rows[0].id;
      expect((await query('SELECT location_id FROM monitoring_observations WHERE check_id=$1', [check.id])).rows).toEqual([{ location_id: local }]);
      await query('UPDATE monitoring_observations SET location_id = NULL WHERE check_id=$1', [check.id]);
      await initializeSchema();
      expect((await query('SELECT location_id FROM monitoring_observations WHERE check_id=$1', [check.id])).rows).toEqual([{ location_id: null }]);
    } finally {
      await deleteMonitoringCheck(check.id);
      await query('DELETE FROM monitoring_targets WHERE id=$1', [target.id]);
    }
  });
});
