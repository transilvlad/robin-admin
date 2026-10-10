/**
 * Mail user database queries (Dovecot virtual users).
 *
 * Designed to work against ANY schema for the `users` table that contains
 * at least `id`, `email`, and `password`. All other columns are detected
 * on access and passed through as an opaque `extra` map on read, and
 * accepted as pass-through values on create/update.
 *
 * Common variants observed in the wild:
 *   - id, email, password, uid, gid, home, maildir         ("full")
 *   - id, email, password, extra, privileges, sending_account_id
 *   - id, email, password, name, quota                     ("postfixadmin-style")
 *
 * Schema metadata is cached for five seconds so newly configured tables
 * become available without restarting the server. The writes that the UI exposes
 * (email + password + optional uid/gid) reject fields that the target schema
 * cannot store. Schema readiness does not determine workspace enablement.
 */

import { query } from '../connection.js';
import type { MailUser } from '../../types/index.js';

/**
 * Always-present columns. We require all three; if any is missing,
 * tableExists() reports backend readiness, independently of enablement.
 */
const REQUIRED_COLUMNS = ['id', 'email', 'password'] as const;

/**
 * Columns we recognize and project onto top-level MailUser fields.
 * Anything else returned by the table goes into `extra`.
 */
const KNOWN_OPTIONAL_COLUMNS = ['uid', 'gid', 'home', 'maildir'] as const;

interface SchemaInfo {
  /** All column names actually present in the table. */
  allColumns: string[];
  /** Subset of KNOWN_OPTIONAL_COLUMNS that exist. */
  knownOptional: Set<string>;
  /** Columns surfaced in `extra` (everything except id/email/password and known-optional). */
  extraColumns: string[];
  /** SELECT projection list: id, email, every existing optional column, and all extras. */
  selectList: string;
}

export class MailboxInputError extends Error {}

function validateFields(schema: SchemaInfo, input: { uid?: number; gid?: number; extra?: Record<string, unknown> }): void {
  for (const key of ['uid', 'gid'] as const) {
    if (input[key] === undefined) continue;
    if (!schema.knownOptional.has(key)) {
      throw new MailboxInputError(`${key} is not supported by the mailbox schema`);
    }
    if (!Number.isInteger(input[key]) || input[key]! < 0 || input[key]! > 2147483647) {
      throw new MailboxInputError(`${key} must be a non-negative database integer`);
    }
  }
  if (input.extra !== undefined && (!input.extra || typeof input.extra !== 'object' || Array.isArray(input.extra) || Object.keys(input.extra).some(key => !schema.extraColumns.includes(key)))) {
    throw new MailboxInputError('Unsupported mailbox extra fields');
  }
}

let schemaPromise: Promise<SchemaInfo | null> | null = null;
let schemaCheckedAt = 0;

export function resetUsersSchemaCacheForTests(): void {
  schemaPromise = null;
  schemaCheckedAt = 0;
}

async function getSchema(): Promise<SchemaInfo | null> {
  if (schemaPromise && Date.now() - schemaCheckedAt < 5000) return schemaPromise;
  schemaCheckedAt = Date.now();
  schemaPromise = (async () => {
    const result = await query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'users'
       ORDER BY ordinal_position`
    );
    if (result.rows.length === 0) return null;

    const allColumns = result.rows.map((r) => r.column_name);
    const colSet = new Set(allColumns);

    // Refuse to operate on a table that doesn't have the required columns.
    for (const required of REQUIRED_COLUMNS) {
      if (!colSet.has(required)) return null;
    }

    const knownOptional: Set<string> = new Set(
      KNOWN_OPTIONAL_COLUMNS.filter((c) => colSet.has(c))
    );

    const extraColumns = allColumns.filter(
      (c) =>
        !(REQUIRED_COLUMNS as readonly string[]).includes(c) &&
        !knownOptional.has(c) &&
        c !== 'password' // password handled separately, never returned
    );

    // Build SELECT list. id+email always; every known-optional we got; null
    // fillers for known-optionals we didn't get; then every extra column
    // verbatim. Identifiers are always inside `information_schema.columns`
    // (i.e. real columns we just read), so quoting with double quotes is
    // safe — no SQL injection possible because they're system-provided.
    const project = ['id', 'email'];
    for (const col of KNOWN_OPTIONAL_COLUMNS) {
      project.push(knownOptional.has(col) ? quoteIdent(col) : `NULL AS ${quoteIdent(col)}`);
    }
    for (const col of extraColumns) {
      project.push(quoteIdent(col));
    }

    return {
      allColumns,
      knownOptional,
      extraColumns,
      selectList: project.join(', '),
    };
  })().catch((error: unknown) => {
    schemaPromise = null;
    throw error;
  });
  return schemaPromise;
}

/**
 * Quote an identifier for safe interpolation into SQL. Used only for
 * column names we just read out of information_schema.columns, never
 * for user-supplied input.
 */
function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

interface RawUserRow {
  id: number;
  email: string;
  uid: number | null;
  gid: number | null;
  home: string | null;
  maildir: string | null;
  [k: string]: unknown;
}

function rowToUser(row: RawUserRow, schema: SchemaInfo): MailUser {
  const extra: Record<string, unknown> = {};
  for (const col of schema.extraColumns) {
    extra[col] = row[col] ?? null;
  }
  return {
    id: row.id,
    email: row.email,
    uid: row.uid ?? 0,
    gid: row.gid ?? 0,
    home: row.home,
    maildir: row.maildir,
    ...(schema.extraColumns.length > 0 ? { extra } : {}),
  };
}

/**
 * Generate home and maildir paths from email — used only when the schema
 * actually has those columns. Schemas without them rely on dovecot's
 * global user_query in dovecot-sql.conf.
 */
function generatePaths(email: string): { home: string; maildir: string } {
  const [localPart, domain] = email.split('@');
  const home = `/var/mail/vhosts/${domain}/${localPart}`;
  const maildir = `maildir:/var/mail/vhosts/${domain}/${localPart}`;
  return { home, maildir };
}

async function requireSchema(): Promise<SchemaInfo> {
  const s = await getSchema();
  if (!s) {
    throw new Error(
      'users table is missing required columns (id, email, password)'
    );
  }
  return s;
}

/**
 * Get all users with pagination.
 */
export async function getAllUsers(
  page: number = 1,
  limit: number = 50,
  search?: string
): Promise<{ users: MailUser[]; total: number }> {
  const schema = await requireSchema();
  const offset = (page - 1) * limit;

  let whereClause = '';
  const params: unknown[] = [];

  if (search) {
    whereClause = 'WHERE email ILIKE $1';
    params.push(`%${search}%`);
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM users ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const usersResult = await query<RawUserRow>(
    `SELECT ${schema.selectList} FROM users
     ${whereClause}
     ORDER BY email
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    users: usersResult.rows.map((r) => rowToUser(r, schema)),
    total,
  };
}

/**
 * Get user by ID.
 */
export async function getUserById(id: number): Promise<MailUser | null> {
  const schema = await requireSchema();
  const result = await query<RawUserRow>(
    `SELECT ${schema.selectList} FROM users WHERE id = $1`,
    [id]
  );
  return result.rows[0] ? rowToUser(result.rows[0], schema) : null;
}

/**
 * Get user by email.
 */
export async function getUserByEmail(email: string): Promise<MailUser | null> {
  const schema = await requireSchema();
  const result = await query<RawUserRow>(
    `SELECT ${schema.selectList} FROM users WHERE email = $1`,
    [email.toLowerCase()]
  );
  return result.rows[0] ? rowToUser(result.rows[0], schema) : null;
}

/**
 * Create a new user with SHA512-CRYPT hashed password.
 *
 * `extra` accepts the schema's additional fields. Unsupported fields are errors.
 */
export async function createUser(
  email: string,
  passwordHash: string,
  uid?: number,
  gid?: number,
  extra?: Record<string, unknown>
): Promise<MailUser> {
  const schema = await requireSchema();
  validateFields(schema, { uid, gid, extra });
  const { home, maildir } = generatePaths(email.toLowerCase());

  const cols: string[] = ['email', 'password'];
  const vals: unknown[] = [email.toLowerCase(), passwordHash];

  if (schema.knownOptional.has('uid')) {
    cols.push('uid');
    vals.push(uid ?? 5000);
  }
  if (schema.knownOptional.has('gid')) {
    cols.push('gid');
    vals.push(gid ?? 5000);
  }
  if (schema.knownOptional.has('home')) {
    cols.push('home');
    vals.push(home);
  }
  if (schema.knownOptional.has('maildir')) {
    cols.push('maildir');
    vals.push(maildir);
  }

  if (extra) {
    for (const [k, v] of Object.entries(extra)) {
      cols.push(k);
      vals.push(v);
    }
  }

  const placeholders = vals.map((_, i) => `$${i + 1}`).join(', ');
  const colList = cols.map(quoteIdent).join(', ');
  const result = await query<RawUserRow>(
    `INSERT INTO users (${colList})
     VALUES (${placeholders})
     RETURNING ${schema.selectList}`,
    vals
  );
  return rowToUser(result.rows[0], schema);
}

/**
 * Update a user.
 *
 * The same schema validation as createUser applies before any writes.
 */
export async function updateUser(
  id: number,
  updates: {
    email?: string;
    passwordHash?: string;
    uid?: number;
    gid?: number;
    extra?: Record<string, unknown>;
  }
): Promise<MailUser | null> {
  const schema = await requireSchema();
  validateFields(schema, updates);
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.email !== undefined) {
    setClauses.push(`email = $${paramIndex++}`);
    values.push(updates.email.toLowerCase());
    if (schema.knownOptional.has('home') || schema.knownOptional.has('maildir')) {
      const { home, maildir } = generatePaths(updates.email.toLowerCase());
      if (schema.knownOptional.has('home')) {
        setClauses.push(`home = $${paramIndex++}`);
        values.push(home);
      }
      if (schema.knownOptional.has('maildir')) {
        setClauses.push(`maildir = $${paramIndex++}`);
        values.push(maildir);
      }
    }
  }
  if (updates.passwordHash !== undefined) {
    setClauses.push(`password = $${paramIndex++}`);
    values.push(updates.passwordHash);
  }
  if (updates.uid !== undefined && schema.knownOptional.has('uid')) {
    setClauses.push(`uid = $${paramIndex++}`);
    values.push(updates.uid);
  }
  if (updates.gid !== undefined && schema.knownOptional.has('gid')) {
    setClauses.push(`gid = $${paramIndex++}`);
    values.push(updates.gid);
  }

  if (updates.extra) {
    for (const [k, v] of Object.entries(updates.extra)) {
      setClauses.push(`${quoteIdent(k)} = $${paramIndex++}`);
      values.push(v);
    }
  }

  if (setClauses.length === 0) {
    return getUserById(id);
  }

  values.push(id);

  const result = await query<RawUserRow>(
    `UPDATE users SET ${setClauses.join(', ')}
     WHERE id = $${paramIndex}
     RETURNING ${schema.selectList}`,
    values
  );
  return result.rows[0] ? rowToUser(result.rows[0], schema) : null;
}

/**
 * Delete a user.
 */
export async function deleteUser(id: number): Promise<boolean> {
  const result = await query('DELETE FROM users WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Count total users.
 */
export async function countUsers(): Promise<number> {
  const result = await query<{ count: string }>('SELECT COUNT(*) as count FROM users');
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Get the column metadata for the users table — useful for the UI to
 * render dynamic forms / tables that adapt to whatever Dovecot schema
 * the host happens to use.
 */
export async function getUsersSchema(): Promise<{
  columns: string[];
  knownOptional: string[];
  extraColumns: string[];
} | null> {
  const s = await getSchema();
  if (!s) return null;
  return {
    columns: s.allColumns.filter((c) => c !== 'password'),
    knownOptional: Array.from(s.knownOptional),
    extraColumns: s.extraColumns,
  };
}

/**
 * Check if users table exists with at least the required columns.
 */
export async function tableExists(): Promise<boolean> {
  try {
    return (await getSchema()) !== null;
  } catch {
    return false;
  }
}
