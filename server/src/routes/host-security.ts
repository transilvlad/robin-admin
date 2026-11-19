import { isIP } from 'node:net';
import { Router, type Request, type Response, type NextFunction } from 'express';
import type { HostSecurityCounter, HostSecurityDiffItem, HostSecurityEventInput, HostSecurityHeartbeat, HostSecuritySections } from '../types/host-security.js';
import { config } from '../config.js';
import { query } from '../db/connection.js';
import { getConfig } from '../db/queries/config.js';
import { fleetAgentCredentialMatches } from '../db/queries/fleet-agents.js';
import { enqueueLogsBatch } from '../db/queries/logs-spool.js';
import { getCurrentAdmin, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { getTrustedClientIp } from '../middleware/security.js';
import { fleetLogRows } from '../services/logs-store.js';
import {
  acceptHostSecuritySnapshot, applyHostSecurityApproval, diffHostSecurity, getHostSecurityState, HostSecurityError,
  hostSecuritySections, hostSecuritySnapshotColumns, hostSecurityTransaction, serializeHostSnapshot, undoHostSecurityApprovals,
} from '../services/host-security.js';

export const hostSecurityAgentRoutes = Router();
export const hostSecurityRoutes = Router();

function fail(message: string): never {
  throw new HostSecurityError(400, message);
}

function record(input: unknown): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return fail('Expected an object');
  return input as Record<string, unknown>;
}

function text(input: unknown, max = 512): string {
  if (typeof input !== 'string' || input.length > max || /[\u0000-\u001f\u007f]/u.test(input)) {
    return fail('Invalid text field');
  }
  return input;
}

function masked(input: unknown): string {
  const value = text(input);
  if (/-----BEGIN|\b(?:ssh-rsa|ssh-ed25519|ecdsa-\S+)\s+[A-Za-z0-9+/]{24,}/i.test(value)) return '[REDACTED]';
  return value.replace(/\b(password|passwd|token|secret|authorization)\s*[:=]\s*\S+/gi, '$1=[REDACTED]');
}

function timestamp(input: unknown): string {
  const value = text(input, 40);
  const ms = Date.parse(value);
  if (!/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,9})?Z$/.test(value) || !Number.isFinite(ms)) return fail('Value must be a UTC timestamp');
  return new Date(ms).toISOString();
}

function integer(input: unknown, min = 0, max = 2_147_483_647): number {
  if (typeof input !== 'number' || !Number.isSafeInteger(input) || input < min || input > max) return fail('Integer out of range');
  return input;
}

function bool(input: unknown): boolean {
  if (typeof input !== 'boolean') return fail('Invalid boolean field');
  return input;
}

function list(input: unknown, max: number): unknown[] {
  if (!Array.isArray(input) || input.length > max) return fail('Invalid list or list limit exceeded');
  return input;
}

function digest(input: unknown): string {
  const value = text(input, 64);
  if (!/^[a-f0-9]{64}$/.test(value)) return fail('Invalid SHA256 digest');
  return value;
}

const enums = <T extends string>(input: unknown, values: readonly T[]): T => {
  if (!values.includes(input as T)) return fail('Unsupported field value');
  return input as T;
};

const optional = <T>(value: unknown, parse: (input: unknown) => T) => value === undefined ? undefined : parse(value);
const nullable = <T>(value: unknown, parse: (input: unknown) => T) => value === null ? null : parse(value);

const allowedSetting = [
  'port', 'permitrootlogin', 'passwordauthentication', 'kbdinteractiveauthentication',
  'pubkeyauthentication', 'allowusers', 'allowgroups', 'authorizedkeysfile', 'maxauthtries',
] as const;
const fieldValidators = {
  sshKeys: {
    user: text, file: text, fingerprint: (v: unknown) => {
      const value = text(v, 50);
      if (!/^SHA256:[A-Za-z0-9+/]{43}$/.test(value)) return fail('Invalid key fingerprint');
      return value;
    },
    type: text, bits: (v: unknown) => nullable(v, integer), comment: masked,
    options: (v: unknown) => list(v, 16).map(option => {
      const value = masked(option);
      if (value.startsWith('command=')) return 'command=[REDACTED]';
      if (value === 'restrict' || value.startsWith('from=')) return value;
      return fail('Unsupported key option');
    }),
  },
  sshd: { name: (v: unknown) => enums(v, allowedSetting), value: masked },
  accounts: { user: text, uid: integer, home: text, shell: text },
  privilegedGroups: { group: text, members: (v: unknown) => list(v, 1_000).map(member => text(member)) },
  sudoers: { file: text, rule: masked, nopasswd: bool },
  cron: { file: text, sha256: digest, lines: integer },
  systemd: { unit: text, state: text },
  listeners: {
    protocol: (v: unknown) => enums(v, ['tcp', 'udp']), address: text,
    port: (v: unknown) => integer(v, 1, 65_535), process: (v: unknown) => nullable(v, masked),
  },
  firewall: {
    backend: (v: unknown) => enums(v, ['nftables', 'iptables', 'ufw', 'unknown']),
    inbound: (v: unknown) => enums(v, ['accept', 'drop', 'unknown']),
  },
  patching: {
    pending: (v: unknown) => nullable(v, integer), security: (v: unknown) => nullable(v, integer),
    rebootRequired: (v: unknown) => nullable(v, bool), rebootSince: (v: unknown) => nullable(v, timestamp),
    kernel: masked, os: masked,
  },
  integrity: { path: text, sha256: digest },
};

export function parseHostSecurityHeartbeat(raw: unknown): HostSecurityHeartbeat {
  const input = record(raw);
  if (input.version !== 1) return fail('Unsupported host security version');
  const observedAt = timestamp(input.observedAt);
  if (Date.parse(observedAt) > Date.now() + 300_000) return fail('Snapshot time is too far in the future');
  const sections = optional(input.sections, value => {
    const all = record(value);
    return Object.fromEntries(hostSecuritySections.map(name => {
      const section = record(all[name]);
      const ids = new Set<string>();
      const status = enums(section.status, ['ok', 'not_permitted', 'not_available']);
      const complete = bool(section.complete);
      if (status !== 'ok' && complete) return fail('Unavailable sections cannot be complete');
      const items = list(section.items, name === 'integrity' ? 20_000 : 5_000).map(item => {
        const entry = record(item);
        const id = text(entry.id, 1024);
        if (!id || ids.has(id)) return fail('Invalid or duplicate snapshot item ID');
        ids.add(id);
        const rawValues = record(entry.value);
        const value = Object.fromEntries(Object.entries(fieldValidators[name]).map(([field, validate]) => [field, validate(rawValues[field])]));
        return { id, value };
      });
      return [name, { status, complete, items, rootHash: optional(section.rootHash, digest) }];
    })) as unknown as HostSecuritySections;
  });
  return { version: 1, hash: digest(input.hash), observedAt, intervalSeconds: integer(input.intervalSeconds, 60, 86400), sections };
}

function parseSecurityEvent(raw: unknown): HostSecurityEventInput {
  const input = record(raw);
  const type = enums(input.type, [
    'login', 'sudo', 'su', 'user_change', 'group_change', 'password_change',
    'sshd_reload', 'fail2ban_ban', 'fail2ban_unban', 'auditd',
  ] as const);
  const observedAt = timestamp(input.observedAt);
  if (Date.parse(observedAt) > Date.now() + 300_000) return fail('Event time is too far in the future');
  const sourceIp = optional(input.sourceIp, value => {
    const ip = text(value, 64);
    if (!isIP(ip)) return fail('Invalid source IP');
    return ip;
  });
  const keyFingerprint = optional(input.keyFingerprint, fieldValidators.sshKeys.fingerprint);
  return {
    id: digest(input.id), observedAt, type, sourceIp, keyFingerprint,
    user: optional(input.user, masked), authMethod: optional(input.authMethod, masked),
    process: text(input.process, 64), line: masked(input.line),
  };
}

function parseCounter(raw: unknown): HostSecurityCounter {
  const item = record(raw);
  const minute = timestamp(item.minute);
  if (Date.parse(minute) % 60000 !== 0 || Date.parse(minute) > Date.now()) return fail('Invalid minute bucket');
  return {
    minute, invalidUser: integer(item.invalidUser), failedKey: integer(item.failedKey),
    failedPassword: integer(item.failedPassword), successful: integer(item.successful),
    distinctFailedSources: integer(item.distinctFailedSources, 0, 65536),
  };
}

async function handle(action: () => Promise<unknown>, res: Response, next: NextFunction) {
  try {
    res.json({ success: true, data: await action() });
  } catch (error) {
    if (error instanceof HostSecurityError) res.status(error.status).json({ success: false, error: error.message });
    else next(error);
  }
}

async function hostAgent(req: Request): Promise<string> {
  const id = req.get('x-robin-agent-id')?.trim();
  const token = req.get('authorization')?.match(/^Bearer (.+)$/)?.[1];
  if (!id || id.length > 64 || !token || !await fleetAgentCredentialMatches(id, token)) {
    throw new HostSecurityError(401, 'Invalid fleet agent credential');
  }
  return id;
}

hostSecurityAgentRoutes.post('/snapshot', (req, res, next) => handle(async () => ({
  snapshotId: await acceptHostSecuritySnapshot(await hostAgent(req), parseHostSecurityHeartbeat(req.body)),
}), res, next));

hostSecurityAgentRoutes.post('/events', (req, res, next) => handle(async () => {
  const id = await hostAgent(req);
  const input = record(req.body);
  if (input.version !== 1) return fail('Unsupported host security version');
  const batchId = digest(input.batchId);
  const events = list(input.events, 500).map(parseSecurityEvent);
  const counters = list(input.counters, 1_000).map(parseCounter);
  const historyEnabled = Boolean(config.logs.storeUrl) && (await getConfig()).logsEnabled;
  return hostSecurityTransaction(async client => {
    const receipt = await client.query(`
      INSERT INTO host_security_event_batches (agent_id, batch_id) VALUES ($1, $2)
      ON CONFLICT DO NOTHING`, [id, batchId]);
    if (!receipt.rowCount) return { duplicate: true };
    const saved = await client.query<{ event: HostSecurityEventInput }>(`
      INSERT INTO host_security_events (agent_id, event_id, observed_at, event, snapshot_id, baseline_revision, known_address_id)
      SELECT $1, e.value->>'id', (e.value->>'observedAt')::timestamptz, e.value,
        snapshot.id, approval.revision, known.id
      FROM jsonb_array_elements($2::jsonb) e
      LEFT JOIN LATERAL (
        SELECT s.id FROM host_security_snapshots s
        WHERE s.agent_id = $1 AND s.observed_at <= (e.value->>'observedAt')::timestamptz
        ORDER BY s.observed_at DESC, s.id DESC LIMIT 1
      ) snapshot ON true
      LEFT JOIN LATERAL (
        SELECT a.revision FROM host_security_approvals a
        WHERE a.agent_id = $1 AND a.approved_at <= (e.value->>'observedAt')::timestamptz
        ORDER BY a.revision DESC LIMIT 1
      ) approval ON true
      LEFT JOIN LATERAL (
        SELECT k.id FROM host_security_known_addresses k
        WHERE (e.value->>'sourceIp')::inet <<= k.network
          AND (k.expires_at IS NULL OR k.expires_at > (e.value->>'observedAt')::timestamptz)
        ORDER BY masklen(k.network) DESC, k.id LIMIT 1
      ) known ON e.value->>'type' = 'login'
      WHERE (e.value->>'observedAt')::timestamptz >= CURRENT_TIMESTAMP - make_interval(days => $3)
      ON CONFLICT DO NOTHING RETURNING event`, [id, JSON.stringify(events), config.logs.retentionDays]);
    if (historyEnabled && saved.rows.length) {
      const outcome = await enqueueLogsBatch({
        origin: 'fleet', idempotencyKey: `host-security:${id}:${batchId}`,
        rows: fleetLogRows(
          { serviceType: 'host', serviceId: id, source: 'host-security', agentId: id },
          saved.rows.map(row => row.event.line), saved.rows.map(row => row.event.observedAt)),
        maxBytes: config.logs.spoolMaxBytes,
      }, client);
      if (outcome === 'full' || outcome === 'too_large') throw new HostSecurityError(503, 'Host security log queue is full');
    }
    for (const bucket of counters) {
      await client.query(`
        INSERT INTO host_security_counters (agent_id, minute, invalid_user, failed_key, failed_password, successful, distinct_sources)
        SELECT $1,$2,$3,$4,$5,$6,$7 WHERE $2::timestamptz >= CURRENT_TIMESTAMP - make_interval(days => $8)
        ON CONFLICT (agent_id, minute) DO UPDATE SET
          invalid_user = host_security_counters.invalid_user + EXCLUDED.invalid_user,
          failed_key = host_security_counters.failed_key + EXCLUDED.failed_key,
          failed_password = host_security_counters.failed_password + EXCLUDED.failed_password,
          successful = host_security_counters.successful + EXCLUDED.successful,
          distinct_sources = GREATEST(host_security_counters.distinct_sources, EXCLUDED.distinct_sources)`,
      [id, bucket.minute, bucket.invalidUser, bucket.failedKey, bucket.failedPassword, bucket.successful, bucket.distinctFailedSources, config.logs.retentionDays]);
    }
    return { duplicate: false };
  });
}, res, next));

hostSecurityRoutes.use(requireAuth);

function routeParam(req: Request, name: string): string {
  return text(req.params[name], 128);
}

function idParam(input: unknown): string {
  const value = text(input, 18);
  if (!/^[1-9]\d*$/.test(value)) return fail('Invalid record ID');
  return value;
}

function pageOptions(req: Request) {
  const limit = req.query.limit === undefined ? 50 : integer(Number(req.query.limit), 1, 100);
  let offset = 0;
  if (req.query.cursor !== undefined) {
    const value = Buffer.from(text(req.query.cursor, 20), 'base64url').toString();
    if (!/^\d{1,8}$/.test(value)) return fail('Invalid cursor');
    offset = Number(value);
  }
  return { limit, offset, sqlLimit: limit + 1 };
}

function page<T>(items: T[], { limit, offset }: ReturnType<typeof pageOptions>) {
  return {
    items: items.slice(0, limit),
    nextCursor: items.length > limit ? Buffer.from(String(offset + limit)).toString('base64url') : null,
  };
}

hostSecurityRoutes.get('/hosts', (req, res, next) => handle(async () => {
  const options = pageOptions(req);
  const { rows } = await query<{
    hostId: string; name: string; lastReceivedAt: Date; stale: boolean; unknownLogins24h: number; patchAgeDays: number | null;
  }>(`
    SELECT h.agent_id AS "hostId", a.name, h.last_received_at AS "lastReceivedAt",
      floor(EXTRACT(epoch FROM CURRENT_TIMESTAMP - h.security_upgrades_since) / 86400)::int AS "patchAgeDays",
      (h.last_received_at < CURRENT_TIMESTAMP - make_interval(secs => h.interval_seconds * 3)) AS stale,
      (SELECT count(*)::int FROM host_security_events e WHERE e.agent_id = h.agent_id
       AND e.observed_at > CURRENT_TIMESTAMP - interval '24 hours'
       AND e.event->>'type' = 'login' AND e.known_address_id IS NULL) AS "unknownLogins24h"
    FROM host_security_hosts h JOIN fleet_agents a ON a.agent_id = h.agent_id
    ORDER BY h.agent_id LIMIT $1 OFFSET $2`, [options.sqlLimit, options.offset]);
  return page(await Promise.all(rows.map(async row => {
    const { snapshot, diff } = await getHostSecurityState(row.hostId);
    return {
      ...row, snapshotId: snapshot.id, baselinePending: diff.baselinePending,
      unapprovedDrift: diff.baselinePending ? 0 : diff.items.length,
      passwordLoginEnabled: snapshot.sections.sshd.items.find(item => item.id === 'passwordauthentication')?.value.value === 'yes'
        || (snapshot.sections.sshd.status === 'ok' ? false : null),
    };
  })), options);
}, res, next));

hostSecurityRoutes.get('/hosts/:hostId/snapshots', (req, res, next) => handle(async () => {
  const options = pageOptions(req);
  const { rows } = await query<Parameters<typeof serializeHostSnapshot>[0]>(`
    SELECT ${hostSecuritySnapshotColumns} FROM host_security_snapshots
    WHERE agent_id = $1 ORDER BY observed_at DESC, id DESC LIMIT $2 OFFSET $3`,
  [routeParam(req, 'hostId'), options.sqlLimit, options.offset]);
  return page(rows.map(serializeHostSnapshot), options);
}, res, next));

hostSecurityRoutes.get('/hosts/:hostId/snapshots/:snapshotId', (req, res, next) => handle(async () => {
  const { rows } = await query<Parameters<typeof serializeHostSnapshot>[0]>(`
    SELECT ${hostSecuritySnapshotColumns} FROM host_security_snapshots WHERE agent_id = $1 AND id = $2`,
  [routeParam(req, 'hostId'), idParam(req.params.snapshotId)]);
  if (!rows[0]) throw new HostSecurityError(404, 'Snapshot not found');
  return serializeHostSnapshot(rows[0]);
}, res, next));

hostSecurityRoutes.get('/hosts/:hostId/snapshot', (req, res, next) => handle(async () => {
  if (req.query.at === undefined) return (await getHostSecurityState(routeParam(req, 'hostId'))).snapshot;
  const { rows } = await query<Parameters<typeof serializeHostSnapshot>[0]>(`
    SELECT ${hostSecuritySnapshotColumns} FROM host_security_snapshots
    WHERE agent_id = $1 AND observed_at <= $2 ORDER BY observed_at DESC, id DESC LIMIT 1`,
  [routeParam(req, 'hostId'), timestamp(req.query.at)]);
  if (!rows[0]) throw new HostSecurityError(404, 'Snapshot not found');
  return serializeHostSnapshot(rows[0]);
}, res, next));

hostSecurityRoutes.get('/hosts/:hostId/diff', (req, res, next) => handle(async () => {
  const hostId = routeParam(req, 'hostId');
  if (req.query.snapshotId === undefined && req.query.baselineRevision === undefined) return (await getHostSecurityState(hostId)).diff;
  const id = idParam(req.query.snapshotId);
  const revision = integer(Number(text(req.query.baselineRevision, 10)));
  return hostSecurityTransaction(async client => {
    const { row } = await getHostSecurityState(hostId, client);
    if (revision > row.baselineRevision) throw new HostSecurityError(404, 'Baseline revision not found');
    const snapshot = await client.query<Parameters<typeof serializeHostSnapshot>[0]>(`
      SELECT ${hostSecuritySnapshotColumns} FROM host_security_snapshots WHERE agent_id = $1 AND id = $2`, [hostId, id]);
    if (!snapshot.rows[0]) throw new HostSecurityError(404, 'Snapshot not found');
    const audit = await client.query<{ diff: HostSecurityDiffItem[] }>(`
      SELECT diff FROM host_security_approvals WHERE agent_id = $1 AND revision > $2 ORDER BY revision DESC`,
    [hostId, revision]);
    if (audit.rows.length !== row.baselineRevision - revision) throw new HostSecurityError(404, 'Baseline revision is outside retention');
    const baseline = undoHostSecurityApprovals(row.baseline, audit.rows.map(entry => entry.diff));
    return diffHostSecurity(serializeHostSnapshot(snapshot.rows[0]), baseline, revision);
  });
}, res, next));

hostSecurityRoutes.post('/hosts/:hostId/approve', requireAdmin, (req, res, next) => handle(async () => {
  const hostId = routeParam(req, 'hostId');
  const input = record(req.body);
  const snapshotId = idParam(input.snapshotId);
  const baselineRevision = integer(input.baselineRevision);
  const itemIds = optional(input.itemIds, value => list(value, 20_000).map(item => text(item, 1100)));
  if (itemIds?.length === 0) return fail('Select a change or approve the full snapshot');
  const reason = optional(input.reason, masked);
  const admin = getCurrentAdmin(req)!;
  const ip = await getTrustedClientIp(req);
  return hostSecurityTransaction(async client => {
    const { row, snapshot, diff } = await getHostSecurityState(hostId, client);
    if (snapshot.id !== snapshotId || diff.baselineRevision !== baselineRevision) {
      throw new HostSecurityError(409, 'Host snapshot or baseline changed. Reload before approving.');
    }
    const selected = itemIds && new Set(itemIds);
    const approved = diff.items.filter(item => snapshot.sections[item.section].status === 'ok' && (!selected || selected.has(item.id)));
    if (selected && approved.length !== selected.size) return fail('An item is unavailable or no longer eligible for approval');
    if (!Object.values(snapshot.sections).some(section => section.status === 'ok')) return fail('Snapshot has no readable sections to approve');
    const baseline = applyHostSecurityApproval(snapshot, row.baseline, diff, itemIds);
    const revision = baselineRevision + 1;
    await client.query('UPDATE host_security_hosts SET baseline = $2, baseline_revision = $3 WHERE agent_id = $1',
      [hostId, JSON.stringify(baseline), revision]);
    await client.query(`
      INSERT INTO host_security_approvals (agent_id, revision, snapshot_id, approver, reason, diff)
      VALUES ($1,$2,$3,$4,$5,$6)`, [hostId, revision, snapshotId, admin.email, reason ?? null, JSON.stringify(approved)]);
    await client.query(`
      INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, new_values, ip_address)
      VALUES ($1, 'host_security.baseline_approve', 'host_security', $2, $3, $4)`,
    [admin.adminId || null, hostId, JSON.stringify({ snapshotId, revision, itemCount: approved.length, reason, approver: admin.email }), ip]);
    return { baselineRevision: revision };
  });
}, res, next));

hostSecurityRoutes.get('/hosts/:hostId/events', (req, res, next) => handle(async () => {
  const options = pageOptions(req);
  const { rows } = await query<{
    event: HostSecurityEventInput; hostId: string; snapshotId: string | null; baselineRevision: number | null; knownAddressId: string | null;
  }>(`
    SELECT event, agent_id AS "hostId", snapshot_id::text AS "snapshotId",
      baseline_revision AS "baselineRevision", known_address_id::text AS "knownAddressId"
    FROM host_security_events
    WHERE agent_id = $1 AND ($2::text IS NULL OR event->>'type' = $2)
      AND ($3::text IS NULL OR event->>'user' = $3)
      AND ($4::text IS NULL OR event->>'sourceIp' = $4)
      AND ($5::timestamptz IS NULL OR observed_at >= $5)
      AND ($6::timestamptz IS NULL OR observed_at < $6)
    ORDER BY observed_at DESC, event_id DESC LIMIT $7 OFFSET $8`, [
    routeParam(req, 'hostId'), optional(req.query.type, text), optional(req.query.user, text),
    optional(req.query.sourceIp, text), optional(req.query.from, timestamp), optional(req.query.until, timestamp),
    options.sqlLimit, options.offset,
  ]);
  return page(rows.map(({ event, ...references }) => ({ ...event, ...references })), options);
}, res, next));

hostSecurityRoutes.get('/hosts/:hostId/counters', (req, res, next) => handle(async () => {
  const options = pageOptions(req);
  const { rows } = await query<HostSecurityCounter>(`
    SELECT minute, invalid_user::float8 AS "invalidUser", failed_key::float8 AS "failedKey",
      failed_password::float8 AS "failedPassword", successful::float8, distinct_sources::float8 AS "distinctFailedSources"
    FROM host_security_counters
    WHERE agent_id = $1 AND ($2::timestamptz IS NULL OR minute >= $2) AND ($3::timestamptz IS NULL OR minute < $3)
    ORDER BY minute DESC LIMIT $4 OFFSET $5`,
  [routeParam(req, 'hostId'), optional(req.query.from, timestamp), optional(req.query.until, timestamp), options.sqlLimit, options.offset]);
  return page(rows, options);
}, res, next));

const addressColumns = 'id::text, network::text, label, expires_at AS "expiresAt"';

function addressInput(raw: unknown) {
  const input = record(raw);
  const value = text(input.network, 64);
  const [address, prefix, extra] = value.split('/');
  const family = isIP(address);
  const max = family === 4 ? 32 : 128;
  if (!family || extra !== undefined || (prefix !== undefined && (!/^\d{1,3}$/.test(prefix) || Number(prefix) > max))) {
    return fail('Known address must be an IP address or CIDR');
  }
  const label = masked(input.label).trim();
  if (!label || label.length > 128) return fail('An address label is required');
  return [`${address}/${prefix ?? max}`, label, input.expiresAt == null ? null : timestamp(input.expiresAt)];
}

hostSecurityRoutes.get('/known-addresses', (req, res, next) => handle(async () => {
  const options = pageOptions(req);
  const { rows } = await query(`
    SELECT ${addressColumns} FROM host_security_known_addresses ORDER BY id LIMIT $1 OFFSET $2`,
  [options.sqlLimit, options.offset]);
  return page(rows, options);
}, res, next));

hostSecurityRoutes.post('/known-addresses', requireAdmin, (req, res, next) => handle(async () => {
  const { rows } = await query(`
    INSERT INTO host_security_known_addresses (network, label, expires_at)
    VALUES (network($1::inet), $2, $3) ON CONFLICT DO NOTHING RETURNING ${addressColumns}`, addressInput(req.body));
  if (!rows[0]) throw new HostSecurityError(409, 'Address already exists');
  return rows[0];
}, res, next));

hostSecurityRoutes.patch('/known-addresses/:id', requireAdmin, (req, res, next) => handle(async () => {
  const { rows } = await query(`
    UPDATE host_security_known_addresses SET network = network($1::inet), label = $2, expires_at = $3
    WHERE id = $4 RETURNING ${addressColumns}`, [...addressInput(req.body), idParam(req.params.id)]);
  if (!rows[0]) throw new HostSecurityError(404, 'Known address not found');
  return rows[0];
}, res, next));

hostSecurityRoutes.delete('/known-addresses/:id', requireAdmin, (req, res, next) => handle(async () => {
  const result = await query('DELETE FROM host_security_known_addresses WHERE id = $1', [idParam(req.params.id)]);
  if (!result.rowCount) throw new HostSecurityError(404, 'Known address not found');
  return null;
}, res, next));
