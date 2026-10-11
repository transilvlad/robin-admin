import { randomBytes } from 'node:crypto';
import { query } from '../connection.js';
import { logger } from '../../logger.js';
import {
  decryptStoredSecret,
  encryptStoredSecret,
  ENCRYPTION_KEY_VERSION,
  storedSecretMatches,
} from './secret-crypto.js';

export const AGENT_ENROLLMENT_TOKEN_SECRET = 'enrollment_token';
export const AGENT_CREDENTIAL_SECRET = 'agent_credential';

/** An agent is considered offline once its last heartbeat is older than this. */
import { operationsPolicy } from '../../services/operations-settings.js';
const DEFAULT_ENROLLMENT_TTL_HOURS = 24;

export type FleetAgentStatus = 'pending' | 'online' | 'offline';

export interface DiscoveredService {
  serviceType: string;
  name?: string;
  detail?: string;
  source?: string;
}

export interface FleetAgent {
  id: number;
  agentId: string;
  name: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agentVersion: string | null;
  status: FleetAgentStatus;
  labels: Record<string, unknown>;
  discovered: DiscoveredService[];
  /** How the agent reaches each service it works for, from its last heartbeat. */
  serviceReports: Record<string, AgentServiceReport>;
  metadata: Record<string, unknown>;
  enrolledAt: Date | null;
  lastSeenAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

interface FleetAgentRow {
  id: number;
  agent_id: string;
  name: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agent_version: string | null;
  status: string;
  labels_json: Record<string, unknown> | null;
  discovered_json: DiscoveredService[] | null;
  services_json: unknown;
  metadata_json: Record<string, unknown> | null;
  enrolled_at: Date | null;
  last_seen_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Derive live status from enrollment + last-seen age, so no background sweeper is needed. */
function deriveStatus(row: FleetAgentRow): FleetAgentStatus {
  if (!row.enrolled_at) {
    return 'pending';
  }
  if (row.last_seen_at && Date.now() - new Date(row.last_seen_at).getTime() <= operationsPolicy().fleetAgentOnlineThresholdMs) {
    return 'online';
  }
  return 'offline';
}

function mapRow(row: FleetAgentRow): FleetAgent {
  return {
    id: row.id,
    agentId: row.agent_id,
    name: row.name,
    hostname: row.hostname,
    os: row.os,
    arch: row.arch,
    agentVersion: row.agent_version,
    status: deriveStatus(row),
    labels: row.labels_json ?? {},
    discovered: Array.isArray(row.discovered_json) ? row.discovered_json : [],
    serviceReports: sanitizeServiceReports(row.services_json) ?? {},
    metadata: row.metadata_json ?? {},
    enrolledAt: row.enrolled_at,
    lastSeenAt: row.last_seen_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const AGENT_COLUMNS = `id, agent_id, name, hostname, os, arch, agent_version, status,
  labels_json, discovered_json, services_json, metadata_json, enrolled_at, last_seen_at, created_at, updated_at`;

export async function listFleetAgents(): Promise<FleetAgent[]> {
  const result = await query<FleetAgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM fleet_agents ORDER BY created_at DESC`
  );
  return result.rows.map(mapRow);
}

export async function getFleetAgentById(agentId: string): Promise<FleetAgent | null> {
  const result = await query<FleetAgentRow>(
    `SELECT ${AGENT_COLUMNS} FROM fleet_agents WHERE agent_id = $1`,
    [agentId]
  );
  return result.rows[0] ? mapRow(result.rows[0]) : null;
}

// ── Secrets (enrollment token + agent credential) ───────────────────────────

function generateToken(): string {
  return randomBytes(32).toString('base64url');
}

async function getAgentSecret(
  agentId: string,
  secretType: string
): Promise<{ secret: string; expiresAt: Date | null } | null> {
  const result = await query<{ encrypted_secret: string; expires_at: Date | null }>(
    `SELECT encrypted_secret, expires_at FROM fleet_agent_secrets WHERE agent_id = $1 AND secret_type = $2`,
    [agentId, secretType]
  );
  const row = result.rows[0];
  if (!row) return null;
  try {
    return { secret: decryptStoredSecret(row.encrypted_secret), expiresAt: row.expires_at };
  } catch (error) {
    // Unreadable (e.g. SESSION_SECRET changed): the agent must re-enroll; its
    // stored ciphertext never stands in for the credential.
    logger.error('Fleet agent secret could not be decrypted', { agentId, secretType, error: (error as Error).message });
    return null;
  }
}

async function upsertAgentSecret(input: {
  agentId: string;
  secretType: string;
  secret: string;
  expiresAt?: Date | null;
}): Promise<void> {
  await query(
    `INSERT INTO fleet_agent_secrets
       (agent_id, secret_type, encrypted_secret, key_version, last_rotated_at, expires_at)
     VALUES ($1, $2, $3, $4, CURRENT_TIMESTAMP, $5)
     ON CONFLICT (agent_id, secret_type)
     DO UPDATE SET encrypted_secret = $3,
                   key_version = $4,
                   updated_at = CURRENT_TIMESTAMP,
                   last_rotated_at = CURRENT_TIMESTAMP,
                   expires_at = $5`,
    [input.agentId, input.secretType, encryptStoredSecret(input.secret), ENCRYPTION_KEY_VERSION, input.expiresAt ?? null]
  );
}

async function deleteAgentSecret(agentId: string, secretType: string): Promise<boolean> {
  const result = await query(`DELETE FROM fleet_agent_secrets WHERE agent_id = $1 AND secret_type = $2`, [agentId, secretType]);
  return (result.rowCount ?? 0) > 0;
}

// ── Admin lifecycle ─────────────────────────────────────────────────────────

export interface CreatedFleetAgent {
  agent: FleetAgent;
  enrollmentToken: string;
  enrollmentExpiresAt: Date;
}

export async function createFleetAgent(input: {
  name: string;
  labels?: Record<string, unknown>;
  enrollmentTtlHours?: number;
}): Promise<CreatedFleetAgent> {
  const agentId = randomBytes(16).toString('hex');
  await query(
    `INSERT INTO fleet_agents (agent_id, name, labels_json, status)
     VALUES ($1, $2, $3::jsonb, 'pending')`,
    [agentId, input.name, JSON.stringify(input.labels ?? {})]
  );
  const enrollmentToken = generateToken();
  const ttlHours = input.enrollmentTtlHours ?? DEFAULT_ENROLLMENT_TTL_HOURS;
  const enrollmentExpiresAt = new Date(Date.now() + ttlHours * 3_600_000);
  await upsertAgentSecret({ agentId, secretType: AGENT_ENROLLMENT_TOKEN_SECRET, secret: enrollmentToken, expiresAt: enrollmentExpiresAt });
  const agent = await getFleetAgentById(agentId);
  return { agent: agent!, enrollmentToken, enrollmentExpiresAt };
}

/**
 * Provision an agent with a KNOWN agent id + credential — idempotently — for
 * reproducible/automated deployments (a bootstrap env, an ansible-rendered
 * agent) that skip the interactive one-time-token enrollment. The agent passes
 * the same credential via ROBIN_AGENT_CREDENTIAL and is online immediately.
 * Upserts the fleet_agents row and its agent_credential secret; never rotates a
 * credential that already matches, so restarts don't churn it.
 */
export async function provisionFleetAgent(input: {
  agentId: string;
  name: string;
  credential: string;
  os?: string | null;
  arch?: string | null;
  labels?: Record<string, unknown>;
}): Promise<FleetAgent> {
  await query(
    `INSERT INTO fleet_agents (agent_id, name, os, arch, labels_json, status, enrolled_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5::jsonb, 'online', CURRENT_TIMESTAMP, NULL)
     ON CONFLICT (agent_id) DO UPDATE
       SET name = EXCLUDED.name,
           os = COALESCE(EXCLUDED.os, fleet_agents.os),
           arch = COALESCE(EXCLUDED.arch, fleet_agents.arch),
           enrolled_at = COALESCE(fleet_agents.enrolled_at, CURRENT_TIMESTAMP),
           updated_at = CURRENT_TIMESTAMP`,
    [input.agentId, input.name, input.os ?? null, input.arch ?? null, JSON.stringify(input.labels ?? {})]
  );
  // Only (re)write the credential if it isn't already the same value.
  if (!(await fleetAgentCredentialMatches(input.agentId, input.credential))) {
    await upsertAgentSecret({ agentId: input.agentId, secretType: AGENT_CREDENTIAL_SECRET, secret: input.credential });
  }
  // A provisioned agent never needs the one-time enrollment token.
  await deleteAgentSecret(input.agentId, AGENT_ENROLLMENT_TOKEN_SECRET);
  return (await getFleetAgentById(input.agentId))!;
}

/** Issue a fresh enrollment token (e.g. the old one expired before the agent enrolled). */
export async function rotateFleetAgentEnrollmentToken(
  agentId: string,
  enrollmentTtlHours = DEFAULT_ENROLLMENT_TTL_HOURS
): Promise<{ enrollmentToken: string; enrollmentExpiresAt: Date } | null> {
  const agent = await getFleetAgentById(agentId);
  if (!agent) {
    return null;
  }
  const enrollmentToken = generateToken();
  const enrollmentExpiresAt = new Date(Date.now() + enrollmentTtlHours * 3_600_000);
  await upsertAgentSecret({ agentId, secretType: AGENT_ENROLLMENT_TOKEN_SECRET, secret: enrollmentToken, expiresAt: enrollmentExpiresAt });
  return { enrollmentToken, enrollmentExpiresAt };
}

export async function deleteFleetAgent(agentId: string): Promise<boolean> {
  const result = await query(`DELETE FROM fleet_agents WHERE agent_id = $1`, [agentId]);
  return (result.rowCount ?? 0) > 0;
}

// ── Agent-facing enrollment + heartbeat ─────────────────────────────────────

export type AgentAccess = 'local' | 'container' | 'ssh' | 'other';

export interface AgentServiceReport {
  access: AgentAccess;
  /** Whether rendered config files can be placed where the service reads them. */
  fileDelivery: boolean;
  /** Staging mode: files are written, the service is never reloaded. */
  applyOnly: boolean;
  /** Command-channel actions whose tools exist where the service runs. */
  actions: string[];
}

const AGENT_ACCESS = new Set<AgentAccess>(['local', 'container', 'ssh', 'other']);

export function sanitizeServiceReports(value: unknown): Record<string, AgentServiceReport> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const out: Record<string, AgentServiceReport> = {};
  for (const [serviceId, raw] of Object.entries(value as Record<string, unknown>)) {
    if (!raw || typeof raw !== 'object' || serviceId.length > 64) continue;
    const rec = raw as Record<string, unknown>;
    const access = AGENT_ACCESS.has(rec.access as AgentAccess) ? rec.access as AgentAccess : 'other';
    out[serviceId] = {
      access,
      fileDelivery: rec.fileDelivery === true && (access === 'local' || access === 'container'),
      applyOnly: rec.applyOnly === true,
      actions: Array.isArray(rec.actions)
        ? rec.actions.filter((a): a is string => typeof a === 'string' && /^[a-z]+(\.[a-z]+)+$/.test(a)).slice(0, 64)
        : [],
    };
  }
  return out;
}

function sanitizeDiscovered(value: unknown): DiscoveredService[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: DiscoveredService[] = [];
  for (const item of value) {
    if (item && typeof item === 'object' && typeof (item as Record<string, unknown>).serviceType === 'string') {
      const rec = item as Record<string, unknown>;
      out.push({
        serviceType: String(rec.serviceType),
        name: typeof rec.name === 'string' ? rec.name : undefined,
        detail: typeof rec.detail === 'string' ? rec.detail : undefined,
        source: typeof rec.source === 'string' ? rec.source : undefined,
      });
    }
  }
  return out;
}

export type EnrollFleetAgentResult =
  | { ok: true; agentId: string; credential: string }
  | { ok: false; reason: 'not_found' | 'no_enrollment' | 'expired' | 'invalid' };

export async function enrollFleetAgent(input: {
  agentId: string;
  enrollmentToken: string;
  hostname?: string | null;
  os?: string | null;
  arch?: string | null;
  agentVersion?: string | null;
  discovered?: unknown;
}): Promise<EnrollFleetAgentResult> {
  const agent = await getFleetAgentById(input.agentId);
  if (!agent) {
    return { ok: false, reason: 'not_found' };
  }
  const stored = await getAgentSecret(input.agentId, AGENT_ENROLLMENT_TOKEN_SECRET);
  if (!stored) {
    return { ok: false, reason: 'no_enrollment' };
  }
  if (stored.expiresAt && stored.expiresAt.getTime() < Date.now()) {
    return { ok: false, reason: 'expired' };
  }
  if (!storedSecretMatches(stored.secret, input.enrollmentToken)) {
    return { ok: false, reason: 'invalid' };
  }

  // The enrollment token is single-use: claim it before issuing a credential,
  // so of two concurrent enrollments only one gets a credential (otherwise the
  // later write would silently invalidate the earlier agent's credential).
  if (!(await deleteAgentSecret(input.agentId, AGENT_ENROLLMENT_TOKEN_SECRET))) {
    return { ok: false, reason: 'invalid' };
  }
  const credential = generateToken();
  await upsertAgentSecret({ agentId: input.agentId, secretType: AGENT_CREDENTIAL_SECRET, secret: credential });

  const discovered = sanitizeDiscovered(input.discovered);
  await query(
    `UPDATE fleet_agents
       SET hostname = COALESCE($2, hostname),
           os = COALESCE($3, os),
           arch = COALESCE($4, arch),
           agent_version = COALESCE($5, agent_version),
           discovered_json = COALESCE($6::jsonb, discovered_json),
           status = 'online',
           enrolled_at = CURRENT_TIMESTAMP,
           last_seen_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
     WHERE agent_id = $1`,
    [
      input.agentId,
      input.hostname ?? null,
      input.os ?? null,
      input.arch ?? null,
      input.agentVersion ?? null,
      discovered ? JSON.stringify(discovered) : null,
    ]
  );

  return { ok: true, agentId: input.agentId, credential };
}

export async function fleetAgentCredentialMatches(agentId: string, candidate: string): Promise<boolean> {
  const stored = await getAgentSecret(agentId, AGENT_CREDENTIAL_SECRET);
  return stored ? storedSecretMatches(stored.secret, candidate) : false;
}

export async function recordFleetAgentHeartbeat(
  agentId: string,
  input: { agentVersion?: string | null; hostname?: string | null; os?: string | null; arch?: string | null; discovered?: unknown; services?: unknown } = {}
): Promise<FleetAgent | null> {
  const discovered = sanitizeDiscovered(input.discovered);
  const services = sanitizeServiceReports(input.services);
  await query(
    `UPDATE fleet_agents
       SET status = 'online',
           last_seen_at = CURRENT_TIMESTAMP,
           agent_version = COALESCE($2, agent_version),
           hostname = COALESCE($3, hostname),
           os = COALESCE($4, os),
           arch = COALESCE($5, arch),
           discovered_json = COALESCE($6::jsonb, discovered_json),
           services_json = COALESCE($7::jsonb, services_json),
           updated_at = CURRENT_TIMESTAMP
     WHERE agent_id = $1`,
    [
      agentId,
      input.agentVersion ?? null,
      input.hostname ?? null,
      input.os ?? null,
      input.arch ?? null,
      discovered ? JSON.stringify(discovered) : null,
      services ? JSON.stringify(services) : null,
    ]
  );
  return getFleetAgentById(agentId);
}
