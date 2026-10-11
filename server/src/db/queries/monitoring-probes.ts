import { createHash } from 'node:crypto';
import { getClient, query } from '../connection.js';
import { decryptStoredSecret } from './secret-crypto.js';
import {
  evaluateMonitoringCheckLocations,
  listMonitoringChecks,
  refreshMonitoringLocationSilence,
} from './monitoring.js';
import { operationsPolicy } from '../../services/operations-settings.js';
import type { MonitoringCheck, MonitoringCheckType } from '../../types/monitoring.js';

const PREVIOUS_REVISION_GRACE_MS = 5 * 60_000;
const MAX_OBSERVATION_AGE_MS = 20 * 60_000;

export interface MonitoringProbeLocation {
  id: number;
  locationKey: string;
  name: string;
  region: string | null;
  locationType: 'local' | 'remote';
  agentId: string | null;
  agentName: string | null;
  agentStatus: 'pending' | 'online' | 'offline' | null;
  enabled: boolean;
  shadow: boolean;
  probeConcurrency: number;
  lastSeenAt: Date | null;
  agentVersion: string | null;
  protocolVersion: number | null;
  clockOffsetMs: number | null;
  manifestRevision: number;
  assignedCheckCount: number;
  probeDutyPerMinute: number;
  recentErrors: Array<{ checkName: string; errorCode: string | null; count: number; lastObservedAt: string; recovered: boolean }>;
  openIssue: { summary: string; openedAt: string } | null;
}

export interface ProbeManifestCheck {
  checkId: number;
  name: string;
  checkType: MonitoringCheckType;
  endpoint: string;
  port: number | null;
  intervalSeconds: number;
  timeoutSeconds: number;
  confirmationSeconds: number;
  recoverySeconds: number;
  certExpiryDays: number | null;
  tlsMode: string;
  certificateErrorMode: string;
  allowPrivate: boolean;
  options: MonitoringCheck['options'];
  secretHeaders?: Record<string, string>;
  enabled: boolean;
  jitterSeed: number;
}

export interface ProbeManifest {
  protocolVersion: 1;
  manifestRevision: number;
  generatedAt: string;
  locationId: number;
  concurrency: number;
  checks: ProbeManifestCheck[];
}

export interface RemoteProbeObservation {
  checkId: number;
  manifestRevision: number;
  startedAt: Date;
  finishedAt: Date;
  status: 'up' | 'down' | 'warning';
  errorCode: string | null;
  warning: string | null;
  responseTimeMs: number;
  dnsTimeMs: number;
  details: Record<string, unknown>;
}

export class ProbeRequestError extends Error {
  constructor(message: string, readonly status: 400 | 403 | 404 | 409) {
    super(message);
  }
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map(key => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function makeJitterSeed(locationId: number, checkId: number): number {
  const bytes = createHash('sha256').update(`${locationId}:${checkId}`).digest();
  return bytes.readUInt32BE(0) % 2_147_483_648;
}

function manifestCheck(check: MonitoringCheck, secretHeaders: Record<string, string>, locationId: number): ProbeManifestCheck {
  return {
    checkId: check.id,
    name: check.name,
    checkType: check.checkType,
    endpoint: check.endpoint,
    port: check.port,
    intervalSeconds: check.intervalSeconds,
    timeoutSeconds: check.timeoutSeconds,
    confirmationSeconds: check.confirmationSeconds,
    recoverySeconds: check.recoverySeconds,
    certExpiryDays: check.certExpiryDays,
    tlsMode: check.tlsMode,
    certificateErrorMode: check.certificateErrorMode,
    allowPrivate: check.allowPrivate,
    options: check.options,
    ...(Object.keys(secretHeaders).length ? { secretHeaders } : {}),
    enabled: true,
    jitterSeed: makeJitterSeed(locationId, check.id),
  };
}

export async function listMonitoringProbeLocations(): Promise<MonitoringProbeLocation[]> {
  const result = await query<{
    id: number; location_key: string; name: string; region: string | null; location_type: 'local' | 'remote';
    agent_id: string | null; agent_name: string | null; agent_status: 'pending' | 'online' | 'offline' | null;
    enabled: boolean; shadow: boolean; probe_concurrency: number; last_seen_at: Date | null; agent_version: string | null;
    protocol_version: number | null; clock_offset_ms: number | null; manifest_revision: number;
    assigned_check_count: number; probe_duty_per_minute: number;
    recent_errors: MonitoringProbeLocation['recentErrors'] | null;
    open_issue: { summary: string; openedAt: string } | null;
  }>(
    `SELECT l.id, l.location_key, l.name, l.region, l.location_type, l.agent_id,
            a.name AS agent_name,
            CASE WHEN l.agent_id IS NULL THEN NULL
                 WHEN a.enrolled_at IS NULL THEN 'pending'
                 WHEN a.last_seen_at > CURRENT_TIMESTAMP - ($1 * INTERVAL '1 millisecond') THEN 'online'
                 ELSE 'offline' END AS agent_status,
            l.enabled, l.shadow, l.probe_concurrency, l.last_seen_at, l.agent_version,
            l.protocol_version, l.clock_offset_ms, l.manifest_revision,
            stats.check_count AS assigned_check_count, stats.duty AS probe_duty_per_minute,
            errors.rows AS recent_errors, location_issue.open_issue
     FROM monitoring_locations l
     LEFT JOIN fleet_agents a ON a.agent_id = l.agent_id
     LEFT JOIN LATERAL (
       SELECT COUNT(*)::int AS check_count,
              COALESCE(SUM(60.0 / c.interval_seconds), 0)::float AS duty
       FROM monitoring_checks c
       JOIN monitoring_targets t ON t.id = c.target_id
       WHERE c.enabled AND c.paused_at IS NULL AND t.enabled
         AND (c.placement_mode = 'all'
           OR (l.location_type = 'local' AND l.id = ANY(c.location_ids))
           OR EXISTS (
           SELECT 1 FROM monitoring_probe_manifest_checks mc
           WHERE mc.location_id = l.id AND mc.manifest_revision = l.manifest_revision AND mc.check_id = c.id
         ))
     ) stats ON true
     LEFT JOIN LATERAL (
       -- Last 24 hours of failures from this location, one row per check and
       -- error, flagged as recovered when the check's latest result here is up.
       SELECT json_agg(json_build_object(
         'checkName', c.name, 'errorCode', grouped.error_code, 'count', grouped.count,
         'lastObservedAt', grouped.last_observed_at, 'recovered', COALESCE(latest.status = 'up', false)
       ) ORDER BY grouped.last_observed_at DESC) AS rows
       FROM (
         SELECT o.check_id, o.error_code, COUNT(*)::int AS count, MAX(o.observed_at) AS last_observed_at
         FROM monitoring_observations o
         WHERE o.location_id = l.id AND o.status IN ('down', 'warning')
           AND o.observed_at > NOW() - INTERVAL '24 hours'
         GROUP BY o.check_id, o.error_code
         ORDER BY last_observed_at DESC LIMIT 8
       ) grouped
       JOIN monitoring_checks c ON c.id = grouped.check_id
       LEFT JOIN LATERAL (
         SELECT lo.status FROM monitoring_observations lo
         WHERE lo.check_id = grouped.check_id AND lo.location_id = l.id
         ORDER BY lo.observed_at DESC, lo.id DESC LIMIT 1
       ) latest ON true
     ) errors ON true
     LEFT JOIN LATERAL (
       SELECT json_build_object('summary', i.summary, 'openedAt', i.opened_at) AS open_issue
       FROM monitoring_location_issues i WHERE i.location_id = l.id AND i.status = 'open'
       ORDER BY i.opened_at DESC LIMIT 1
     ) location_issue ON true
     ORDER BY CASE WHEN l.location_type = 'local' THEN 0 ELSE 1 END, l.name, l.id`,
    [operationsPolicy().fleetAgentOnlineThresholdMs]
  );
  return result.rows.map(row => ({
    id: row.id,
    locationKey: row.location_key,
    name: row.name,
    region: row.region,
    locationType: row.location_type,
    agentId: row.agent_id,
    agentName: row.agent_name,
    agentStatus: row.agent_status,
    enabled: row.enabled,
    shadow: row.shadow,
    probeConcurrency: row.probe_concurrency,
    lastSeenAt: row.last_seen_at,
    agentVersion: row.agent_version,
    protocolVersion: row.protocol_version,
    clockOffsetMs: row.clock_offset_ms,
    manifestRevision: row.manifest_revision,
    assignedCheckCount: row.assigned_check_count,
    probeDutyPerMinute: row.probe_duty_per_minute,
    recentErrors: row.recent_errors ?? [],
    openIssue: row.open_issue,
  }));
}

export async function grantMonitoringProbeLocation(input: {
  agentId: string;
  name: string;
  region: string | null;
  probeConcurrency: number;
}): Promise<number> {
  const agent = await query<{ agent_id: string }>(
    'SELECT agent_id FROM fleet_agents WHERE agent_id = $1 AND enrolled_at IS NOT NULL',
    [input.agentId]
  );
  if (!agent.rows[0]) throw new ProbeRequestError('An enrolled agent is required', 404);
  const result = await query<{ id: number }>(
    `INSERT INTO monitoring_locations
       (location_key, name, region, location_type, agent_id, enabled, shadow, probe_concurrency)
     VALUES ($1, $2, $3, 'remote', $4, true, true, $5)
     ON CONFLICT (agent_id) DO UPDATE SET
       name = EXCLUDED.name, region = EXCLUDED.region, enabled = true, shadow = true,
       probe_concurrency = EXCLUDED.probe_concurrency, updated_at = CURRENT_TIMESTAMP
     RETURNING id`,
    [`agent:${input.agentId}`, input.name, input.region, input.agentId, input.probeConcurrency]
  );
  return result.rows[0].id;
}

export async function updateMonitoringProbeLocation(id: number, input: {
  name?: string;
  region?: string | null;
  enabled?: boolean;
  shadow?: boolean;
  probeConcurrency?: number;
}): Promise<boolean> {
  const sets: string[] = [];
  const values: Array<string | boolean | number | null> = [];
  const add = (column: string, value: string | boolean | number | null) => {
    values.push(value);
    sets.push(`${column} = $${values.length}`);
  };
  if (input.name !== undefined) add('name', input.name);
  if (input.region !== undefined) add('region', input.region);
  if (input.enabled !== undefined) add('enabled', input.enabled);
  if (input.shadow !== undefined) add('shadow', input.shadow);
  if (input.probeConcurrency !== undefined) add('probe_concurrency', input.probeConcurrency);
  if (!sets.length) return true;
  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(id);
  const result = await query(
    `UPDATE monitoring_locations SET ${sets.join(', ')} WHERE id = $${values.length} RETURNING id`,
    values
  );
  return (result.rowCount ?? 0) > 0;
}

async function buildManifestChecks(locationId: number, shadow: boolean): Promise<ProbeManifestCheck[]> {
  const [allChecks, enabledTargets] = await Promise.all([
    listMonitoringChecks(),
    query<{ id: number }>('SELECT id FROM monitoring_targets WHERE enabled'),
  ]);
  const targetIds = new Set(enabledTargets.rows.map(row => row.id));
  // Push checks run only on the Robin Admin server: remote agents have nothing to probe.
  const checks = allChecks.filter(check => check.enabled && !check.pausedAt && targetIds.has(check.targetId)
    && check.checkType !== 'push'
    && (check.placementMode === 'all' || check.locationIds.includes(locationId)));
  if (checks.length > 5000) throw new ProbeRequestError('Probe manifest exceeds the check limit', 409);
  const encryptedRows = checks.length
    ? await query<{ id: number; encrypted_headers: string | null }>(
      'SELECT id, encrypted_headers FROM monitoring_checks WHERE id = ANY($1::int[])',
      [checks.map(check => check.id)]
    )
    : { rows: [] };
  const encryptedById = new Map(encryptedRows.rows.map(row => [row.id, row.encrypted_headers]));
  const output: ProbeManifestCheck[] = [];
  for (const check of checks) {
    const encrypted = encryptedById.get(check.id);
    const secrets = !shadow && encrypted && check.secretHeaderNames.length
      ? JSON.parse(decryptStoredSecret(encrypted)) as Record<string, string>
      : {};
    output.push(manifestCheck(check, secrets, locationId));
  }
  if (Buffer.byteLength(JSON.stringify(output)) > 4 * 1024 * 1024) {
    throw new ProbeRequestError('Probe manifest exceeds the response size limit', 409);
  }
  return output;
}

export async function getMonitoringProbeManifest(agentId: string): Promise<{ manifest: ProbeManifest; etag: string }> {
  const initial = await query<{ id: number; enabled: boolean; shadow: boolean; probe_concurrency: number; protocol_version: number | null }>(
    `SELECT id, enabled, shadow, probe_concurrency, protocol_version FROM monitoring_locations WHERE agent_id = $1`,
    [agentId]
  );
  const location = initial.rows[0];
  if (!location || !location.enabled) throw new ProbeRequestError('Probe capability is not enabled for this agent', 403);
  if (location.protocol_version !== 1) throw new ProbeRequestError('Agent does not report monitoring probe protocol v1 support', 403);

  const checks = await buildManifestChecks(location.id, location.shadow);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const locked = await client.query<{
      id: number; enabled: boolean; probe_concurrency: number; protocol_version: number | null; manifest_revision: number;
      previous_manifest_revision: number | null; manifest_sha256: string | null;
    }>(
      `SELECT id, enabled, probe_concurrency, protocol_version, manifest_revision, previous_manifest_revision, manifest_sha256
       FROM monitoring_locations WHERE agent_id = $1 FOR UPDATE`,
      [agentId]
    );
    const current = locked.rows[0];
    if (!current || !current.enabled) throw new ProbeRequestError('Probe capability is not enabled for this agent', 403);
    if (current.protocol_version !== 1) throw new ProbeRequestError('Agent does not report monitoring probe protocol v1 support', 403);
    const currentPayload = { concurrency: current.probe_concurrency, checks };
    const currentHash = createHash('sha256').update(stableJson(currentPayload)).digest('hex');
    let revision = current.manifest_revision;
    let previousRevision = current.previous_manifest_revision;
    if (current.manifest_sha256 !== currentHash) {
      previousRevision = revision > 0 ? revision : null;
      revision += 1;
      await client.query(
        `UPDATE monitoring_locations
         SET manifest_revision = $2, previous_manifest_revision = $3, manifest_sha256 = $4,
             manifest_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
         WHERE id = $1`,
        [current.id, revision, previousRevision, currentHash]
      );
      await client.query(
        `INSERT INTO monitoring_probe_manifest_checks (location_id, manifest_revision, check_id)
         SELECT $1, $2, unnest($3::int[])
         ON CONFLICT DO NOTHING`,
        [current.id, revision, checks.map(check => check.checkId)]
      );
      await client.query(
        'DELETE FROM monitoring_probe_manifest_checks WHERE location_id = $1 AND manifest_revision < $2',
        [current.id, Math.max(1, revision - 1)]
      );
    } else {
      revision = Math.max(1, revision);
      if (current.manifest_revision === 0) {
        await client.query('UPDATE monitoring_locations SET manifest_revision = $2 WHERE id = $1', [current.id, revision]);
      }
    }
    await client.query('COMMIT');
    const manifest: ProbeManifest = {
      protocolVersion: 1,
      manifestRevision: revision,
      generatedAt: new Date().toISOString(),
      locationId: current.id,
      concurrency: current.probe_concurrency,
      checks: checks.map(check => ({ ...check, jitterSeed: makeJitterSeed(current.id, check.checkId) })),
    };
    return { manifest, etag: `"${revision}-${currentHash}"` };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function updateMonitoringProbeHeartbeat(input: {
  agentId: string;
  agentVersion: string | null;
  protocolVersion: number | null;
  clientTime: Date | null;
}): Promise<boolean> {
  const offset = input.clientTime ? Date.now() - input.clientTime.getTime() : null;
  const result = await query(
    `UPDATE monitoring_locations
     SET last_seen_at = CURRENT_TIMESTAMP, agent_version = $2, protocol_version = $3,
         clock_offset_ms = $4, updated_at = CURRENT_TIMESTAMP
     WHERE agent_id = $1 AND enabled`,
    [input.agentId, input.agentVersion, input.protocolVersion, offset === null ? null : Math.max(-86_400_000, Math.min(86_400_000, offset))]
  );
  return (result.rowCount ?? 0) > 0 && input.protocolVersion === 1;
}

export async function isProbeOnlyAgent(agentId: string): Promise<boolean> {
  const result = await query<{ probe_only: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM monitoring_locations l
         WHERE l.agent_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM fleet_services s
           WHERE s.agent_id = $1 OR s.config_agent_id = $1 OR s.log_agent_id = $1
         )
     ) AS probe_only`,
    [agentId]
  );
  return result.rows[0]?.probe_only ?? false;
}

export async function recordRemoteProbeObservations(agentId: string, observations: RemoteProbeObservation[]): Promise<{ inserted: number; duplicates: number; ignored: number }> {
  const client = await getClient();
  let committed = false;
  let released = false;
  try {
    await client.query('BEGIN');
    const locationResult = await client.query<{
      id: number; enabled: boolean; manifest_revision: number; previous_manifest_revision: number | null;
      manifest_updated_at: Date | null; protocol_version: number | null; clock_offset_ms: number | null;
    }>(
      `SELECT id, enabled, manifest_revision, previous_manifest_revision, manifest_updated_at, protocol_version, clock_offset_ms
       FROM monitoring_locations WHERE agent_id = $1 FOR UPDATE`,
      [agentId]
    );
    const location = locationResult.rows[0];
    if (!location || !location.enabled) throw new ProbeRequestError('Probe capability is not enabled for this agent', 403);
    if (location.protocol_version !== 1) throw new ProbeRequestError('Agent does not report monitoring probe protocol v1 support', 403);

    const now = Date.now();
    const revisions = new Set(observations.map(observation => observation.manifestRevision));
    for (const revision of revisions) {
      const current = revision === location.manifest_revision;
      const previous = revision === location.previous_manifest_revision
        && location.manifest_updated_at !== null
        && now - new Date(location.manifest_updated_at).getTime() <= PREVIOUS_REVISION_GRACE_MS;
      if (!current && !previous) throw new ProbeRequestError('Observation manifest revision is stale', 409);
    }
    const assignments = await client.query<{ manifest_revision: number; check_id: number; interval_seconds: number }>(
      `SELECT mc.manifest_revision, mc.check_id, c.interval_seconds
       FROM monitoring_probe_manifest_checks mc
       JOIN monitoring_checks c ON c.id = mc.check_id
       WHERE mc.location_id = $1 AND mc.manifest_revision = ANY($2::int[]) AND mc.check_id = ANY($3::int[])`,
      [location.id, [...revisions], [...new Set(observations.map(observation => observation.checkId))]]
    );
    const assignedPairs = new Set(assignments.rows.map(row => `${row.manifest_revision}:${row.check_id}`));
    const intervalByAssignment = new Map(assignments.rows.map(row => [`${row.manifest_revision}:${row.check_id}`, row.interval_seconds]));
    const clockOffset = Number(location.clock_offset_ms ?? 0);
    for (const observation of observations) {
      if (observation.startedAt.getTime() + clockOffset > now + 120_000 || observation.finishedAt.getTime() + clockOffset > now + 120_000) {
        throw new ProbeRequestError('Observation timestamp is too far in the future', 400);
      }
      if (observation.startedAt > observation.finishedAt) throw new ProbeRequestError('Observation timestamps are invalid', 400);
    }
    // Observations for deleted or unassigned checks, and ones too old to be current, are dropped without failing the batch.
    // The agent clock is corrected by its last reported offset.
    const accepted = observations.filter(observation => assignedPairs.has(`${observation.manifestRevision}:${observation.checkId}`)
      && now - (observation.startedAt.getTime() + clockOffset) <= MAX_OBSERVATION_AGE_MS);
    const ignored = observations.length - accepted.length;
    let inserted = 0;
    const changedChecks = new Set<number>();
    for (const observation of accepted) {
      const result = await client.query(
        `INSERT INTO monitoring_observations
           (check_id, location_id, status, error_code, response_time_ms, error, details_json,
            manifest_revision, started_at, observed_at, received_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb, $8, $9, $10, CURRENT_TIMESTAMP)
         ON CONFLICT (location_id, check_id, manifest_revision, started_at, observed_at)
           WHERE location_id IS NOT NULL AND manifest_revision IS NOT NULL AND started_at IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          observation.checkId, location.id, observation.status, observation.errorCode,
          observation.responseTimeMs, observation.warning, JSON.stringify(observation.details),
          observation.manifestRevision, observation.startedAt, observation.finishedAt,
        ]
      );
      if (result.rowCount) {
        inserted += 1;
        const intervalSeconds = intervalByAssignment.get(`${observation.manifestRevision}:${observation.checkId}`) ?? 60;
        if (observation.finishedAt.getTime() >= now - Math.max(intervalSeconds * 2_000, 120_000)) {
          changedChecks.add(observation.checkId);
        }
        await client.query(
          `INSERT INTO monitoring_location_daily
             (check_id, location_id, day, up_count, warning_count, down_count, unavailable_warning_count,
              response_time_sum, response_time_count, response_time_max)
           VALUES ($1, $2, ($3::timestamptz AT TIME ZONE 'UTC')::date,
             ($4 = 'up')::int, ($4 = 'warning')::int, ($4 = 'down')::int,
             ($4 = 'warning' AND COALESCE($5::jsonb->>'certificateError' = 'true', false))::int,
             COALESCE($6, 0), ($6 IS NOT NULL)::int, $6)
           ON CONFLICT (check_id, location_id, day) DO UPDATE SET
             up_count = monitoring_location_daily.up_count + EXCLUDED.up_count,
             warning_count = monitoring_location_daily.warning_count + EXCLUDED.warning_count,
             down_count = monitoring_location_daily.down_count + EXCLUDED.down_count,
             unavailable_warning_count = monitoring_location_daily.unavailable_warning_count + EXCLUDED.unavailable_warning_count,
             response_time_sum = monitoring_location_daily.response_time_sum + EXCLUDED.response_time_sum,
             response_time_count = monitoring_location_daily.response_time_count + EXCLUDED.response_time_count,
             response_time_max = GREATEST(monitoring_location_daily.response_time_max, EXCLUDED.response_time_max)`,
          [
            observation.checkId, location.id, observation.finishedAt, observation.status,
            JSON.stringify(observation.details), observation.responseTimeMs,
          ],
        );
      }
    }
    await client.query('COMMIT');
    committed = true;
    client.release();
    released = true;
    for (const checkId of changedChecks) await evaluateMonitoringCheckLocations(checkId);
    if (changedChecks.size) await refreshMonitoringLocationSilence();
    return { inserted, duplicates: accepted.length - inserted, ignored };
  } catch (error) {
    if (!committed) await client.query('ROLLBACK');
    throw error;
  } finally {
    if (!released) client.release();
  }
}
