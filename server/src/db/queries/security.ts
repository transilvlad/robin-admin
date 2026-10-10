/**
 * Security policy persistence: login attempts and scoped API keys.
 */

import crypto from 'crypto';
import ipaddr from 'ipaddr.js';
import { query } from '../connection.js';
import type { AdminRole } from '../../types/index.js';

export interface ApiKeyRecord {
  id: number;
  name: string;
  keyPrefix: string;
  role: AdminRole;
  scopes: string[];
  allowedCidrs: string[];
  createdBy: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  lastUsedIp: string | null;
}

export interface ApiKeyWithHash extends ApiKeyRecord {
  keyHash: string;
}

export interface IpJailEntry {
  id: number;
  cidr: string;
  reason: string | null;
  createdBy: number | null;
  createdAt: Date;
  expiresAt: Date | null;
  liftedAt: Date | null;
  liftedBy: number | null;
}

interface ApiKeyRow {
  id: number;
  name: string;
  key_prefix: string;
  key_hash: string;
  role: AdminRole;
  scopes: string[];
  allowed_cidrs: string[];
  created_by: number | null;
  created_at: Date;
  expires_at: Date | null;
  revoked_at: Date | null;
  last_used_at: Date | null;
  last_used_ip: string | null;
}

interface IpJailRow {
  id: number;
  cidr: string;
  reason: string | null;
  created_by: number | null;
  created_at: Date;
  expires_at: Date | null;
  lifted_at: Date | null;
  lifted_by: number | null;
}

function mapApiKey(row: ApiKeyRow): ApiKeyWithHash {
  return {
    id: row.id,
    name: row.name,
    keyPrefix: row.key_prefix,
    keyHash: row.key_hash,
    role: row.role,
    scopes: row.scopes ?? [],
    allowedCidrs: row.allowed_cidrs ?? [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    lastUsedAt: row.last_used_at,
    lastUsedIp: row.last_used_ip,
  };
}

function mapIpJail(row: IpJailRow): IpJailEntry {
  return {
    id: row.id,
    cidr: row.cidr,
    reason: row.reason,
    createdBy: row.created_by,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    liftedAt: row.lifted_at,
    liftedBy: row.lifted_by,
  };
}

export function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret).digest('hex');
}

export function generateApiKey(): { plainText: string; prefix: string; hash: string } {
  const token = crypto.randomBytes(32).toString('base64url');
  const plainText = `ra_${token}`;
  return {
    plainText,
    prefix: plainText.slice(0, 12),
    hash: hashSecret(plainText),
  };
}

export async function listApiKeys(): Promise<ApiKeyRecord[]> {
  const result = await query<ApiKeyRow>(`
    SELECT id, name, key_prefix, key_hash, role, scopes, allowed_cidrs, created_by,
           created_at, expires_at, revoked_at, last_used_at, last_used_ip
    FROM admin_api_keys
    ORDER BY created_at DESC
  `);
  return result.rows.map((row) => {
    const { keyHash: _keyHash, ...safe } = mapApiKey(row);
    return safe;
  });
}

export async function createApiKey(data: {
  name: string;
  role: AdminRole;
  scopes: string[];
  allowedCidrs: string[];
  createdBy: number | null;
  expiresAt: Date | null;
}): Promise<{ key: ApiKeyRecord; plainText: string }> {
  const generated = generateApiKey();
  const result = await query<ApiKeyRow>(
    `INSERT INTO admin_api_keys
       (name, key_prefix, key_hash, role, scopes, allowed_cidrs, created_by, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING id, name, key_prefix, key_hash, role, scopes, allowed_cidrs, created_by,
               created_at, expires_at, revoked_at, last_used_at, last_used_ip`,
    [
      data.name,
      generated.prefix,
      generated.hash,
      data.role,
      data.scopes,
      data.allowedCidrs,
      data.createdBy,
      data.expiresAt,
    ]
  );
  const { keyHash: _keyHash, ...safe } = mapApiKey(result.rows[0]);
  return { key: safe, plainText: generated.plainText };
}

export async function getApiKeyByToken(token: string): Promise<ApiKeyWithHash | null> {
  const result = await query<ApiKeyRow>(
    `SELECT id, name, key_prefix, key_hash, role, scopes, allowed_cidrs, created_by,
            created_at, expires_at, revoked_at, last_used_at, last_used_ip
     FROM admin_api_keys
     WHERE key_hash = $1`,
    [hashSecret(token)]
  );
  return result.rows[0] ? mapApiKey(result.rows[0]) : null;
}

export async function touchApiKey(id: number, ipAddress: string): Promise<void> {
  await query(
    `UPDATE admin_api_keys
     SET last_used_at = CURRENT_TIMESTAMP, last_used_ip = $2
     WHERE id = $1`,
    [id, ipAddress]
  );
}

export async function revokeApiKey(id: number): Promise<boolean> {
  const result = await query(
    `UPDATE admin_api_keys
     SET revoked_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND revoked_at IS NULL`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function deleteApiKey(id: number): Promise<boolean> {
  const result = await query(`DELETE FROM admin_api_keys WHERE id = $1`, [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listIpJailEntries(includeInactive = false): Promise<IpJailEntry[]> {
  const result = await query<IpJailRow>(
    includeInactive
      ? `SELECT id, cidr, reason, created_by, created_at, expires_at, lifted_at, lifted_by
         FROM admin_ip_jail
         ORDER BY created_at DESC`
      : `SELECT id, cidr, reason, created_by, created_at, expires_at, lifted_at, lifted_by
         FROM admin_ip_jail
         WHERE lifted_at IS NULL
           AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
         ORDER BY created_at DESC`
  );
  return result.rows.map(mapIpJail);
}

export async function createIpJailEntry(data: {
  cidr: string;
  reason?: string;
  createdBy: number | null;
  expiresAt: Date | null;
}): Promise<IpJailEntry> {
  const result = await query<IpJailRow>(
    `INSERT INTO admin_ip_jail (cidr, reason, created_by, expires_at)
     VALUES ($1, $2, $3, $4)
     RETURNING id, cidr, reason, created_by, created_at, expires_at, lifted_at, lifted_by`,
    [data.cidr, data.reason ?? null, data.createdBy, data.expiresAt]
  );
  return mapIpJail(result.rows[0]);
}

export async function liftIpJailEntry(id: number, liftedBy: number | null): Promise<boolean> {
  const result = await query(
    `UPDATE admin_ip_jail
     SET lifted_at = CURRENT_TIMESTAMP, lifted_by = $2
     WHERE id = $1 AND lifted_at IS NULL`,
    [id, liftedBy]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function updateIpJailExpiry(id: number, expiresAt: Date | null): Promise<boolean> {
  const result = await query(
    `UPDATE admin_ip_jail
     SET expires_at = $2
     WHERE id = $1`,
    [id, expiresAt]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function findActiveIpJailMatch(ipAddress: string): Promise<IpJailEntry | null> {
  const result = await query<IpJailRow>(
    `SELECT id, cidr, reason, created_by, created_at, expires_at, lifted_at, lifted_by
     FROM admin_ip_jail
     WHERE lifted_at IS NULL
       AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
     ORDER BY created_at DESC`
  );
  for (const row of result.rows) {
    try {
      const parsedIp = ipaddr.parse(ipAddress.startsWith('::ffff:') ? ipAddress.slice(7) : ipAddress);
      if (row.cidr.includes('/')) {
        const [range, bits] = ipaddr.parseCIDR(row.cidr);
        if (parsedIp.kind() === range.kind() && parsedIp.match(range, bits)) {
          return mapIpJail(row);
        }
      } else {
        const parsedCidrIp = ipaddr.parse(row.cidr);
        if (parsedIp.toNormalizedString() === parsedCidrIp.toNormalizedString()) {
          return mapIpJail(row);
        }
      }
    } catch {
      continue;
    }
  }
  return null;
}

export async function recordLoginAttempt(data: {
  email?: string;
  ipAddress: string;
  userAgent?: string;
  success: boolean;
  failureReason?: string;
  lockedUntil?: Date | null;
}): Promise<void> {
  await query(
    `INSERT INTO admin_login_attempts
       (email, ip_address, user_agent, success, failure_reason, locked_until)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      data.email?.toLowerCase() ?? null,
      data.ipAddress,
      data.userAgent ?? null,
      data.success,
      data.failureReason ?? null,
      data.lockedUntil ?? null,
    ]
  );
}

export async function getActiveLoginLock(email: string, ipAddress: string): Promise<Date | null> {
  const result = await query<{ locked_until: Date }>(
    `SELECT locked_until
     FROM admin_login_attempts
     WHERE locked_until IS NOT NULL
       AND locked_until > CURRENT_TIMESTAMP
       AND (email = $1 OR ip_address = $2)
     ORDER BY locked_until DESC
     LIMIT 1`,
    [email.toLowerCase(), ipAddress]
  );
  return result.rows[0]?.locked_until ?? null;
}

export async function countRecentFailedLogins(data: {
  email: string;
  ipAddress: string;
  windowMinutes: number;
}): Promise<{ byEmail: number; byIp: number }> {
  const result = await query<{ by_email: string; by_ip: string }>(
    `SELECT
       COUNT(*) FILTER (WHERE email = $1) AS by_email,
       COUNT(*) FILTER (WHERE ip_address = $2) AS by_ip
     FROM admin_login_attempts
     WHERE success = false
       AND created_at >= CURRENT_TIMESTAMP - ($3::int * INTERVAL '1 minute')`,
    [data.email.toLowerCase(), data.ipAddress, data.windowMinutes]
  );
  return {
    byEmail: parseInt(result.rows[0]?.by_email ?? '0', 10),
    byIp: parseInt(result.rows[0]?.by_ip ?? '0', 10),
  };
}

export async function clearLoginLocks(email?: string): Promise<number> {
  const result = await query(
    email
      ? `UPDATE admin_login_attempts SET locked_until = NULL WHERE email = $1 AND locked_until IS NOT NULL`
      : `UPDATE admin_login_attempts SET locked_until = NULL WHERE locked_until IS NOT NULL`,
    email ? [email.toLowerCase()] : []
  );
  return result.rowCount ?? 0;
}
