/**
 * Admin-related database queries.
 */

import { getClient, query } from '../connection.js';
import type { Admin, AdminWithPassword, AdminRole } from '../../types/index.js';

interface AdminRow {
  id: number;
  uid: string;
  name: string;
  email: string;
  password_hash: string;
  role: AdminRole;
  allowed_cidrs: string | null;
  created_at: Date;
  updated_at: Date;
  last_login: Date | null;
  disabled: boolean;
}

function parseAllowedCidrs(value: string | null | undefined): string[] {
  return (value ?? '')
    .split(/[\n,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function serializeAllowedCidrs(value: string[] | undefined): string | null {
  if (!value || value.length === 0) {
    return null;
  }
  return value.join('\n');
}

function rowToAdmin(row: AdminRow): Admin {
  return {
    id: row.id,
    uid: row.uid,
    name: row.name,
    email: row.email,
    role: row.role,
    allowedCidrs: parseAllowedCidrs(row.allowed_cidrs),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLogin: row.last_login,
    disabled: row.disabled,
  };
}

function rowToAdminWithPassword(row: AdminRow): AdminWithPassword {
  return {
    ...rowToAdmin(row),
    passwordHash: row.password_hash,
  };
}

/**
 * Get all admins.
 */
export async function getAllAdmins(): Promise<Admin[]> {
  const result = await query<AdminRow>(
    'SELECT id, uid, name, email, role, allowed_cidrs, created_at, updated_at, last_login, disabled FROM admins ORDER BY id'
  );
  return result.rows.map(rowToAdmin);
}

/**
 * Get admin by ID.
 */
export async function getAdminById(id: number): Promise<Admin | null> {
  const result = await query<AdminRow>(
    'SELECT id, uid, name, email, role, allowed_cidrs, created_at, updated_at, last_login, disabled FROM admins WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToAdmin(result.rows[0]) : null;
}

/**
 * Get admin by ID with password hash (for password verification).
 */
export async function getAdminByIdWithPassword(id: number): Promise<AdminWithPassword | null> {
  const result = await query<AdminRow>(
    'SELECT id, uid, name, email, password_hash, role, allowed_cidrs, created_at, updated_at, last_login, disabled FROM admins WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToAdminWithPassword(result.rows[0]) : null;
}

/**
 * Get admin by email (includes password hash for authentication).
 */
export async function getAdminByEmail(email: string): Promise<AdminWithPassword | null> {
  const result = await query<AdminRow>(
    'SELECT id, uid, name, email, password_hash, role, allowed_cidrs, created_at, updated_at, last_login, disabled FROM admins WHERE email = $1',
    [email.toLowerCase()]
  );
  return result.rows[0] ? rowToAdminWithPassword(result.rows[0]) : null;
}

/**
 * Create a new admin.
 */
export async function createAdmin(
  name: string,
  email: string,
  passwordHash: string,
  role: AdminRole,
  allowedCidrs: string[] = [],
  disabled: boolean = false
): Promise<Admin> {
  const result = await query<AdminRow>(
    `INSERT INTO admins (name, email, password_hash, role, allowed_cidrs, disabled)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING id, uid, name, email, role, allowed_cidrs, created_at, updated_at, last_login, disabled`,
    [name.trim(), email.toLowerCase(), passwordHash, role, serializeAllowedCidrs(allowedCidrs), disabled]
  );
  return rowToAdmin(result.rows[0]);
}

/**
 * Update an admin.
 */
export async function updateAdmin(
  id: number,
  updates: {
    name?: string;
    email?: string;
    passwordHash?: string;
    role?: AdminRole;
    allowedCidrs?: string[];
    disabled?: boolean;
  }
): Promise<Admin | null> {
  const setClauses: string[] = ['updated_at = NOW()'];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.name !== undefined) {
    setClauses.push(`name = $${paramIndex++}`);
    values.push(updates.name.trim());
  }
  if (updates.email !== undefined) {
    setClauses.push(`email = $${paramIndex++}`);
    values.push(updates.email.toLowerCase());
  }
  if (updates.passwordHash !== undefined) {
    setClauses.push(`password_hash = $${paramIndex++}`);
    values.push(updates.passwordHash);
  }
  if (updates.role !== undefined) {
    setClauses.push(`role = $${paramIndex++}`);
    values.push(updates.role);
  }
  if (updates.allowedCidrs !== undefined) {
    setClauses.push(`allowed_cidrs = $${paramIndex++}`);
    values.push(serializeAllowedCidrs(updates.allowedCidrs));
  }
  if (updates.disabled !== undefined) {
    setClauses.push(`disabled = $${paramIndex++}`);
    values.push(updates.disabled);
  }

  values.push(id);

  const result = await query<AdminRow>(
    `UPDATE admins SET ${setClauses.join(', ')} 
     WHERE id = $${paramIndex} 
     RETURNING id, uid, name, email, role, allowed_cidrs, created_at, updated_at, last_login, disabled`,
    values
  );
  return result.rows[0] ? rowToAdmin(result.rows[0]) : null;
}

/**
 * Delete an admin.
 */
export async function deleteAdmin(id: number): Promise<boolean> {
  const result = await query('DELETE FROM admins WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function resetAdminPasswordWithRecoveryToken(
  tokenHash: string,
  passwordHash: string,
): Promise<{ id: number; email: string } | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Lock validation and consumption together so concurrent requests cannot reuse a token.
    const result = await client.query<{ id: number; admin_id: number; email: string }>(
      `SELECT t.id, t.admin_id, a.email
       FROM admin_password_recovery_tokens t JOIN admins a ON a.id = t.admin_id
       WHERE t.token_hash = $1 AND t.used_at IS NULL
         AND t.expires_at > CURRENT_TIMESTAMP AND NOT a.disabled
       FOR UPDATE OF t, a`, [tokenHash],
    );
    const row = result.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return null;
    }
    await client.query('UPDATE admins SET password_hash = $1, updated_at = NOW() WHERE id = $2', [passwordHash, row.admin_id]);
    await client.query('UPDATE admin_password_recovery_tokens SET used_at = CURRENT_TIMESTAMP WHERE id = $1', [row.id]);
    await client.query(`DELETE FROM session WHERE sess -> 'admin' ->> 'id' = $1`, [String(row.admin_id)]);
    await client.query('COMMIT');
    return { id: row.admin_id, email: row.email };
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Invalidate an admin's server-side sessions so a stolen or otherwise-stale
 * cookie stops working immediately, rather than remaining valid until it
 * naturally expires. Used when an account is disabled/deleted or its
 * password is changed. Pass exceptSid to keep the session making the
 * current request alive (e.g. an admin changing their own password).
 */
export async function invalidateAdminSessions(adminId: number, exceptSid?: string): Promise<number> {
  const result = exceptSid
    ? await query(`DELETE FROM session WHERE sess -> 'admin' ->> 'id' = $1 AND sid != $2`, [String(adminId), exceptSid])
    : await query(`DELETE FROM session WHERE sess -> 'admin' ->> 'id' = $1`, [String(adminId)]);
  return result.rowCount ?? 0;
}

/**
 * Update last login time.
 */
export async function updateLastLogin(id: number): Promise<void> {
  await query('UPDATE admins SET last_login = NOW() WHERE id = $1', [id]);
}

/**
 * Count admins by role.
 */
export async function countAdminsByRole(role: AdminRole): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM admins WHERE role = $1 AND disabled = false',
    [role]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Count total active admins.
 */
export async function countActiveAdmins(): Promise<number> {
  const result = await query<{ count: string }>(
    'SELECT COUNT(*) as count FROM admins WHERE disabled = false'
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}
