/**
 * Telemetry dashboards stored in Postgres. Every save bumps `version` (the
 * caller must send the version it edited, so concurrent edits are refused)
 * and records a snapshot; the last MAX_VERSIONS snapshots are kept.
 */

import crypto from 'node:crypto';
import type { PoolClient } from 'pg';
import { getClient, query } from '../connection.js';
import type {
  DashboardContent,
  DashboardVersion,
  TelemetryDashboard,
} from '../../services/telemetry/dashboards/types.js';
import { getTemplate, templateContent, templateHash } from '../../services/telemetry/dashboards/templates/index.js';

export const MAX_VERSIONS = 20;

interface DashboardRow {
  id: number;
  uid: string;
  title: string;
  description: string;
  content: Pick<DashboardContent, 'defaults' | 'variables' | 'rows'>;
  template_key: string | null;
  template_hash: string | null;
  position: number;
  version: number;
  updated_at: Date;
  updated_by: string | null;
}

export interface DashboardSummary {
  uid: string;
  title: string;
  description: string;
  templateKey: string | null;
  templateUpdated: boolean;
  version: number;
  updatedAt: string;
}

/** Another save landed first; the client must reload before saving again. */
export class TelemetryConflictError extends Error {
  constructor(public readonly currentVersion: number) {
    super('This dashboard was changed by someone else. Reload it to see their changes before saving.');
    this.name = 'TelemetryConflictError';
  }
}

/** JSON with sorted keys and no undefined values, so equal content compares equal whatever its key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map((item) => (item === undefined ? 'null' : canonical(item))).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort()
      .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function layoutOf(content: Pick<DashboardContent, 'defaults' | 'variables' | 'rows'>): string {
  return canonical({ defaults: content.defaults, variables: content.variables ?? [], rows: content.rows ?? [] });
}

const templateLayouts = new Map<string, { hash: string; layout: string }>();

/** The current hash and comparable content of a template, computed once per process. */
function currentTemplate(key: string): { hash: string; layout: string } | undefined {
  const cached = templateLayouts.get(key);
  if (cached) return cached;
  const template = getTemplate(key);
  if (!template) return undefined;
  const entry = { hash: templateHash(template), layout: layoutOf(templateContent(template)) };
  templateLayouts.set(key, entry);
  return entry;
}

/**
 * True when the default the dashboard came from has changed since it was set
 * or last acknowledged. Content that already matches the current default has
 * nothing new to offer, which also covers dashboards stored before hashes
 * were recorded.
 */
function templateUpdated(row: Pick<DashboardRow, 'template_key' | 'template_hash' | 'content'>): boolean {
  const current = row.template_key ? currentTemplate(row.template_key) : undefined;
  if (!current || row.template_hash === current.hash) return false;
  return layoutOf(row.content) !== current.layout;
}

function mapDashboard(row: DashboardRow): TelemetryDashboard {
  return {
    uid: row.uid,
    title: row.title,
    description: row.description,
    ...(row.content.defaults ? { defaults: row.content.defaults } : {}),
    variables: row.content.variables ?? [],
    rows: row.content.rows ?? [],
    templateKey: row.template_key,
    templateUpdated: templateUpdated(row),
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
    updatedBy: row.updated_by,
  };
}

function storedContent(content: DashboardContent): string {
  return JSON.stringify({ defaults: content.defaults, variables: content.variables, rows: content.rows });
}

function randomUid(): string {
  return crypto.randomBytes(8).toString('base64url').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10).toLowerCase() || crypto.randomUUID().slice(0, 10);
}

const COLUMNS = 'id, uid, title, description, content, template_key, template_hash, position, version, updated_at, updated_by';

export async function listTelemetryDashboards(): Promise<DashboardSummary[]> {
  const result = await query<DashboardRow>(`SELECT ${COLUMNS} FROM telemetry_dashboards ORDER BY position, id`);
  return result.rows.map((row) => ({
    uid: row.uid,
    title: row.title,
    description: row.description,
    templateKey: row.template_key,
    templateUpdated: templateUpdated(row),
    version: row.version,
    updatedAt: row.updated_at.toISOString(),
  }));
}

export async function getTelemetryDashboard(uid: string): Promise<TelemetryDashboard | null> {
  const result = await query<DashboardRow>(`SELECT ${COLUMNS} FROM telemetry_dashboards WHERE uid = $1`, [uid]);
  return result.rows[0] ? mapDashboard(result.rows[0]) : null;
}

interface CreateOptions {
  actor: string | null;
  templateKey?: string | null;
  preferredUid?: string;
}

/** The hash to record for content set from a template. */
function hashFor(templateKey: string | null | undefined): string | null {
  const template = templateKey ? getTemplate(templateKey) : undefined;
  return template ? templateHash(template) : null;
}

async function insertDashboard(client: PoolClient, content: DashboardContent, options: CreateOptions): Promise<TelemetryDashboard> {
  let uid = options.preferredUid ?? randomUid();
  for (let attempt = 0; ; attempt++) {
    const taken = await client.query('SELECT 1 FROM telemetry_dashboards WHERE uid = $1', [uid]);
    if (taken.rowCount === 0) break;
    if (attempt >= 5) throw new Error('Could not allocate a dashboard id');
    uid = randomUid();
  }
  const result = await client.query<DashboardRow>(
    `INSERT INTO telemetry_dashboards (uid, title, description, content, template_key, template_hash, position, updated_by)
     VALUES ($1, $2, $3, $4::jsonb, $5, $6, (SELECT COALESCE(MAX(position), -1) + 1 FROM telemetry_dashboards), $7)
     RETURNING ${COLUMNS}`,
    [uid, content.title, content.description, storedContent(content), options.templateKey ?? null, hashFor(options.templateKey), options.actor]
  );
  const row = result.rows[0];
  await client.query(
    `INSERT INTO telemetry_dashboard_versions (dashboard_id, version, title, description, content, saved_by)
     VALUES ($1, 1, $2, $3, $4::jsonb, $5)`,
    [row.id, content.title, content.description, storedContent(content), options.actor]
  );
  return mapDashboard(row);
}

async function inTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Store a new dashboard at the end of the list. `preferredUid` (a template
 * key) is used when free so default dashboards keep readable URLs.
 */
export async function createTelemetryDashboard(content: DashboardContent, options: CreateOptions): Promise<TelemetryDashboard> {
  return inTransaction((client) => insertDashboard(client, content, options));
}

/**
 * Replace a dashboard's content if it is still at `expectedVersion`. Null when
 * missing. `fromTemplate` records that the content is the current template
 * (Restore default), which clears the "newer default" notice.
 */
export async function updateTelemetryDashboard(
  uid: string,
  content: DashboardContent,
  expectedVersion: number,
  actor: string | null,
  fromTemplate?: string,
): Promise<TelemetryDashboard | null> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await client.query<DashboardRow>(
      `UPDATE telemetry_dashboards
       SET title = $3, description = $4, content = $5::jsonb, version = version + 1,
           updated_at = CURRENT_TIMESTAMP, updated_by = $6,
           template_hash = COALESCE($7, template_hash)
       WHERE uid = $1 AND version = $2
       RETURNING ${COLUMNS}`,
      [uid, expectedVersion, content.title, content.description, storedContent(content), actor, fromTemplate ? hashFor(fromTemplate) : null]
    );
    const row = result.rows[0];
    if (!row) {
      const current = await client.query<{ version: number }>('SELECT version FROM telemetry_dashboards WHERE uid = $1', [uid]);
      await client.query('ROLLBACK');
      if (!current.rows[0]) return null;
      throw new TelemetryConflictError(current.rows[0].version);
    }
    await client.query(
      `INSERT INTO telemetry_dashboard_versions (dashboard_id, version, title, description, content, saved_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6)`,
      [row.id, row.version, content.title, content.description, storedContent(content), actor]
    );
    await client.query(
      `DELETE FROM telemetry_dashboard_versions WHERE dashboard_id = $1 AND version <= $2`,
      [row.id, row.version - MAX_VERSIONS]
    );
    await client.query('COMMIT');
    return mapDashboard(row);
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export async function deleteTelemetryDashboard(uid: string): Promise<boolean> {
  const result = await query('DELETE FROM telemetry_dashboards WHERE uid = $1', [uid]);
  return (result.rowCount ?? 0) > 0;
}

/** Set the navigation order; dashboards not listed keep their relative order after the listed ones. */
export async function reorderTelemetryDashboards(uids: string[]): Promise<void> {
  await inTransaction(async (client) => {
    await client.query(
      `UPDATE telemetry_dashboards SET position = $2::int + position WHERE NOT (uid = ANY($1::text[]))`,
      [uids, uids.length]
    );
    await client.query(
      `UPDATE telemetry_dashboards d SET position = o.ordinality - 1
       FROM UNNEST($1::text[]) WITH ORDINALITY AS o(uid, ordinality)
       WHERE d.uid = o.uid`,
      [uids]
    );
  });
}

export async function listTelemetryDashboardVersions(uid: string): Promise<DashboardVersion[] | null> {
  const dashboard = await query<{ id: number }>('SELECT id FROM telemetry_dashboards WHERE uid = $1', [uid]);
  if (!dashboard.rows[0]) return null;
  const result = await query<{ version: number; title: string; saved_at: Date; saved_by: string | null }>(
    `SELECT version, title, saved_at, saved_by FROM telemetry_dashboard_versions
     WHERE dashboard_id = $1 ORDER BY version DESC`,
    [dashboard.rows[0].id]
  );
  return result.rows.map((row) => ({ version: row.version, title: row.title, savedAt: row.saved_at.toISOString(), savedBy: row.saved_by }));
}

export async function getTelemetryDashboardVersion(uid: string, version: number): Promise<DashboardContent | null> {
  const result = await query<{ title: string; description: string; content: DashboardRow['content'] }>(
    `SELECT v.title, v.description, v.content
     FROM telemetry_dashboard_versions v JOIN telemetry_dashboards d ON d.id = v.dashboard_id
     WHERE d.uid = $1 AND v.version = $2`,
    [uid, version]
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    title: row.title,
    description: row.description,
    ...(row.content.defaults ? { defaults: row.content.defaults } : {}),
    variables: row.content.variables ?? [],
    rows: row.content.rows ?? [],
  };
}

/**
 * Keep the dashboard as it is and stop offering the current default: records
 * the current template as seen. Null when missing or not from a default.
 */
export async function keepTelemetryDashboardContent(uid: string): Promise<TelemetryDashboard | null> {
  const existing = await query<{ template_key: string | null }>('SELECT template_key FROM telemetry_dashboards WHERE uid = $1', [uid]);
  const hash = hashFor(existing.rows[0]?.template_key);
  if (!hash) return null;
  const result = await query<DashboardRow>(
    `UPDATE telemetry_dashboards SET template_hash = $2 WHERE uid = $1 RETURNING ${COLUMNS}`,
    [uid, hash]
  );
  return result.rows[0] ? mapDashboard(result.rows[0]) : null;
}
