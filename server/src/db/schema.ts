/**
 * Database schema bootstrap.
 *
 * This module handles:
 * - Table creation for Robin Admin specific tables
 * - First-run setup wizard session management
 *
 * Tables created by this module:
 * - admins, admin_audit_log: Administrator accounts and audit trail
 * - admin_password_recovery_tokens: One-time password recovery tokens
 * - admin_login_attempts, admin_api_keys, admin_ip_jail, admin_config: Security and app settings
 * - *_config_store: Managed config row stores for every fleet service type
 * - fleet_services, fleet_service_secrets, fleet_service_sync_status: Fleet registry, secrets, and sync status
 * - modules_catalog, modules_installed, module_licenses: External module catalog, local installs, and license cache
 * - *_metrics_history: Historical metrics for every fleet service type
 * - rspamd_dkim_domains, rspamd_dkim_selectors: DKIM signing metadata
 * - rspamd_training_jobs, rspamd_training_samples: Rspamd training jobs and samples
 * - rspamd_scan_runs, rspamd_scan_actions: Rspamd scan lab history and follow-up actions
 * - dmarc_reports, dmarc_records: DMARC aggregate reports
 * - tlsrpt_reports, tlsrpt_policies, tlsrpt_failures: TLSRPT reports
 * - forensic_reports: DMARC forensic/AFRF reports
 * - session: Express session storage (connect-pg-simple)
 *
 * Reporting Intelligence tables:
 * - sender_inventory: Classified senders from DMARC data
 * - domain_health: Aggregated domain health snapshots
 * - reporting_issues: Detected issues with severity/evidence
 * - remediation_suggestions: Actionable fixes for issues
 *
 * Tables NOT created (must exist from Robin MTA):
 * - users: Dovecot mailbox users
 * - aliases: Email aliases
 * - auto_aliases: Automatic alias rules
 * - webmail_user_prefs: Webmail preferences
 * - robin_queue: Robin relay queue
 *
 * The setup session ID is held in memory, so setup must complete in one
 * uninterrupted server session.
 * This module defines a single authoritative schema: one CREATE TABLE IF NOT
 * EXISTS per table with its final columns, constraints, and indexes.
 */

import { query, getClient } from './connection.js';
import type { PoolClient } from 'pg';
import { logger } from '../logger.js';
import { v4 as uuidv4 } from 'uuid';
import { chmod, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { FLEET_SERVICE_TYPES, serviceTypeSqlList } from '../services/service-types.js';
import { TAXONOMY_COLUMNS, rollupTaxonomyColumnDdl } from '../services/dmarc-taxonomy.js';
import { ALERT_CATALOG } from '../services/alerts/alert-types.js';
import { STATUS_PAGE_REPORT_SOURCES } from '../types/status-page.js';
import { TEMPLATES } from '../services/telemetry/dashboards/templates/index.js';
import { DISCOVERY_DEFAULTS } from '../services/telemetry/discovery.js';
import { encryptStoredSecret } from './queries/secret-crypto.js';
import { OPERATIONS_KEYS, OPERATIONS_SETTINGS, operationsDefaults, validateOperationsSettings } from '../services/operations-settings.js';

const sqlList = (values: readonly string[]) => values.map((value) => `'${value}'`).join(', ');
const ALERT_TYPES = ALERT_CATALOG.map((entry) => entry.key);
// Monitoring alerts are delivered directly, without per-service alert state.
const ALERT_STATE_TYPES = ALERT_CATALOG.filter((entry) => !entry.serviceTypes.includes('monitoring')).map((entry) => entry.key);
const ALERT_TYPES_SQL = sqlList(ALERT_TYPES);
const ALERT_STATE_TYPES_SQL = sqlList(ALERT_STATE_TYPES);

// Store the setup ID in memory and in a local root-readable file until the
// first admin is created. It is never exposed through an API endpoint.
let setupSessionId: string | null = null;
const setupSessionIdFile = process.env.SETUP_ID_FILE?.trim()
  || path.join(os.tmpdir(), 'robin-admin-setup-id');

/**
 * Get the current setup session ID (for first admin creation).
 */
export function getSetupSessionId(): string | null {
  return setupSessionId;
}

export function getSetupSessionIdFilePath(): string {
  return setupSessionIdFile;
}

async function writeSetupSessionIdFile(id: string): Promise<void> {
  try {
    await mkdir(path.dirname(setupSessionIdFile), { recursive: true, mode: 0o700 });
    await writeFile(setupSessionIdFile, `${id}\n`, { mode: 0o600 });
    await chmod(setupSessionIdFile, 0o600);
  } catch (error) {
    logger.warn('Failed to write setup ID file', {
      path: setupSessionIdFile,
      error: (error as Error).message,
    });
  }
}

/**
 * Clear the setup session ID after first admin is created.
 */
export async function clearSetupSessionId(): Promise<void> {
  setupSessionId = null;
  try {
    await rm(setupSessionIdFile, { force: true });
  } catch (error) {
    logger.warn('Failed to remove setup ID file', {
      path: setupSessionIdFile,
      error: (error as Error).message,
    });
  }
}

/**
 * Check if the admins table exists.
 */
async function tableExists(tableName: string): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = $1
    )`,
    [tableName]
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Check if the admins table is empty (needs setup).
 */
export async function needsSetup(): Promise<boolean> {
  const exists = await tableExists('admins');
  if (!exists) {
    return true;
  }
  const result = await query<{ count: string }>('SELECT COUNT(*) as count FROM admins');
  return parseInt(result.rows[0]?.count ?? '0', 10) === 0;
}

/** Tables partitioned by month on a date or timestamp column. */
export const MONTHLY_PARTITIONED_TABLES = ['dmarc_reports', 'dmarc_records', 'dmarc_rollup_source_daily'] as const;
export type MonthlyPartitionedTable = typeof MONTHLY_PARTITIONED_TABLES[number];

/**
 * Ensure the monthly partition of `table` covering `day` (UTC) exists.
 * Partitions are named `<table>_YYYYMM` with bounds `[firstOfMonth,
 * firstOfNextMonth)`. Idempotent. Must run before any write that could route a
 * row to a not-yet-created month, so rows never fall into the default
 * partition and every month stays individually droppable for retention.
 */
export async function ensureMonthlyPartition(client: PoolClient, table: MonthlyPartitionedTable, day: Date): Promise<void> {
  const year = day.getUTCFullYear();
  const month = day.getUTCMonth(); // 0-based
  const startStr = new Date(Date.UTC(year, month, 1)).toISOString().slice(0, 10);
  const endStr = new Date(Date.UTC(year, month + 1, 1)).toISOString().slice(0, 10);
  const partition = `${table}_${year}${String(month + 1).padStart(2, '0')}`;
  await client.query(
    `CREATE TABLE IF NOT EXISTS ${partition}
       PARTITION OF ${table}
       FOR VALUES FROM ('${startStr}') TO ('${endStr}')`
  );
}

interface LegacyDmarcRawTables {
  reports: string;
  records: string;
}

interface LegacyTable {
  table: string;
  legacy: string;
}

const quoteIdentifier = (identifier: string): string => `"${identifier.replace(/"/g, '""')}"`;

async function getTableRelkind(client: PoolClient, table: string): Promise<string | null> {
  const result = await client.query<{ relkind: string }>(
    `SELECT c.relkind
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = current_schema()
        AND c.relname = $1`,
    [table]
  );
  return result.rows[0]?.relkind ?? null;
}

function legacyTableName(table: string): string {
  return `${table}_legacy_${Date.now().toString(36)}`;
}

async function prepareLegacyDmarcRawTables(client: PoolClient): Promise<LegacyDmarcRawTables | null> {
  const reportsKind = await getTableRelkind(client, 'dmarc_reports');
  const recordsKind = await getTableRelkind(client, 'dmarc_records');

  if (reportsKind === null && recordsKind === null) {
    return null;
  }
  if (reportsKind === 'p' && recordsKind === 'p') {
    return null;
  }
  if (reportsKind !== 'r' || recordsKind !== 'r') {
    throw new Error('Unsupported DMARC table state: expected both raw DMARC tables to be partitioned or both legacy tables to be ordinary tables');
  }

  const reports = legacyTableName('dmarc_reports');
  const records = legacyTableName('dmarc_records');
  logger.info('Migrating legacy unpartitioned DMARC raw tables to monthly partitions');
  await client.query(`ALTER TABLE dmarc_records RENAME TO ${quoteIdentifier(records)}`);
  await client.query(`ALTER TABLE dmarc_reports RENAME TO ${quoteIdentifier(reports)}`);
  return { reports, records };
}

async function prepareLegacyPartitionedTable(client: PoolClient, table: MonthlyPartitionedTable): Promise<LegacyTable | null> {
  const relkind = await getTableRelkind(client, table);
  if (relkind === null || relkind === 'p') {
    return null;
  }
  if (relkind !== 'r') {
    throw new Error(`Unsupported table state for ${table}: expected an ordinary or partitioned table`);
  }

  const legacy = legacyTableName(table);
  logger.info(`Migrating legacy unpartitioned ${table} table to monthly partitions`);
  await client.query(`ALTER TABLE ${quoteIdentifier(table)} RENAME TO ${quoteIdentifier(legacy)}`);
  return { table, legacy };
}

function parsePgDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  if (value instanceof Date) return value;
  return new Date(`${value}T00:00:00.000Z`);
}

async function ensureMonthlyPartitionsForRange(
  client: PoolClient,
  table: MonthlyPartitionedTable,
  start: Date | string | null | undefined,
  end: Date | string | null | undefined
): Promise<void> {
  const startDate = parsePgDate(start);
  const endDate = parsePgDate(end);
  if (!startDate || !endDate) {
    return;
  }

  const cursor = new Date(Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1));
  const last = Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1);
  while (cursor.getTime() <= last) {
    await ensureMonthlyPartition(client, table, cursor);
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
}

async function setSerialSequenceToMax(client: PoolClient, table: string, column: string): Promise<void> {
  await client.query(
    `SELECT setval(
       pg_get_serial_sequence($1, $2),
       COALESCE((SELECT MAX(${quoteIdentifier(column)}) FROM ${quoteIdentifier(table)}), 1),
       (SELECT COUNT(*) > 0 FROM ${quoteIdentifier(table)})
     )`,
    [table, column]
  );
}

async function migrateLegacyDmarcRawTables(client: PoolClient, legacy: LegacyDmarcRawTables): Promise<void> {
  const range = await client.query<{ min_day: string | null; max_day: string | null }>(
    `SELECT MIN(date_begin)::date::text AS min_day,
            MAX(date_begin)::date::text AS max_day
       FROM ${quoteIdentifier(legacy.reports)}`
  );
  await ensureMonthlyPartitionsForRange(client, 'dmarc_reports', range.rows[0]?.min_day, range.rows[0]?.max_day);
  await ensureMonthlyPartitionsForRange(client, 'dmarc_records', range.rows[0]?.min_day, range.rows[0]?.max_day);

  await client.query(`
    INSERT INTO dmarc_reports (
      id, report_id, reporter_id, org_name, email, domain, date_begin, date_end,
      policy, subdomain_policy, dkim_alignment, spf_alignment, pct, total_count,
      error_count, raw_payload, created_at
    )
    SELECT
      id, report_id, reporter_id, org_name, email, domain, date_begin, date_end,
      policy, subdomain_policy, dkim_alignment, spf_alignment, pct, total_count,
      error_count, raw_payload, created_at
    FROM ${quoteIdentifier(legacy.reports)}
    ORDER BY date_begin, id
  `);
  await client.query(`
    INSERT INTO dmarc_records (
      id, report_id, source_ip, count, disposition, dkim, spf, reason_type,
      reason_comment, header_from, envelope_from, envelope_to, dkim_domain,
      dkim_result, dkim_selector, spf_domain, spf_result, spf_scope,
      report_day, created_at
    )
    SELECT
      rec.id, rec.report_id, rec.source_ip, rec.count, rec.disposition, rec.dkim, rec.spf, rec.reason_type,
      rec.reason_comment, rec.header_from, rec.envelope_from, rec.envelope_to, rec.dkim_domain,
      rec.dkim_result, rec.dkim_selector, rec.spf_domain, rec.spf_result, rec.spf_scope,
      rep.date_begin::date, rec.created_at
    FROM ${quoteIdentifier(legacy.records)} rec
    JOIN ${quoteIdentifier(legacy.reports)} rep ON rep.id = rec.report_id
    ORDER BY rep.date_begin, rec.id
  `);
  await setSerialSequenceToMax(client, 'dmarc_reports', 'id');
  await setSerialSequenceToMax(client, 'dmarc_records', 'id');
  await client.query(`DROP TABLE ${quoteIdentifier(legacy.records)}`);
  await client.query(`DROP TABLE ${quoteIdentifier(legacy.reports)}`);
  logger.info('Legacy DMARC raw table migration completed');
}

async function migrateLegacyDmarcSourceRollup(client: PoolClient, legacy: LegacyTable): Promise<void> {
  const range = await client.query<{ min_day: string | null; max_day: string | null }>(
    `SELECT MIN(day)::text AS min_day,
            MAX(day)::text AS max_day
       FROM ${quoteIdentifier(legacy.legacy)}`
  );
  await ensureMonthlyPartitionsForRange(client, legacy.table as MonthlyPartitionedTable, range.rows[0]?.min_day, range.rows[0]?.max_day);

  const columns = ['day', 'domain', 'source_ip', ...TAXONOMY_COLUMNS, 'dkim_pass_volume', 'spf_pass_volume'];
  const columnList = columns.map(quoteIdentifier).join(', ');
  await client.query(`
    INSERT INTO ${quoteIdentifier(legacy.table)} (${columnList})
    SELECT ${columnList}
      FROM ${quoteIdentifier(legacy.legacy)}
     ORDER BY day, domain, source_ip
  `);
  await client.query(`DROP TABLE ${quoteIdentifier(legacy.legacy)}`);
  logger.info(`Legacy ${legacy.table} table migration completed`);
}

/**
 * CHECK constraints that list service or alert types are written once, by the
 * CREATE TABLE IF NOT EXISTS that made the table. When a release adds a type,
 * replace any constraint whose literals no longer match the current list so
 * the new type can be stored. A matching constraint is left alone (replacing
 * one re-validates every row).
 */
async function syncTypeListConstraint(
  client: PoolClient,
  table: string,
  name: string,
  column: string,
  values: readonly string[]
): Promise<void> {
  const result = await client.query<{ def: string }>(
    'SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid = $1::regclass AND conname = $2',
    [table, name]
  );
  const def = result.rows[0]?.def;
  const current = new Set(Array.from(def?.matchAll(/'([^']*)'/g) ?? [], (match) => match[1]));
  if (def && current.size === values.length && values.every((value) => current.has(value))) {
    return;
  }
  await client.query(
    `ALTER TABLE ${table} DROP CONSTRAINT IF EXISTS ${name}, ADD CONSTRAINT ${name} CHECK (${column} IN (${sqlList(values)}))`
  );
  logger.info('Refreshed type-list constraint', { table, constraint: name });
}

/**
 * Initialize database schema.
 * Creates the Robin Admin steady-state schema if the tables do not already exist.
 */
// Built outside the init transaction so a large monitoring_observations table is not write-locked while they build.
const CONCURRENT_INDEXES: Array<{ name: string; ddl: string }> = [
  {
    name: 'idx_monitoring_observations_check_location_latest',
    ddl: 'CREATE INDEX CONCURRENTLY idx_monitoring_observations_check_location_latest ON monitoring_observations (check_id, location_id, observed_at DESC, id DESC)',
  },
  {
    name: 'idx_monitoring_observations_remote_dedupe',
    ddl: `CREATE UNIQUE INDEX CONCURRENTLY idx_monitoring_observations_remote_dedupe
      ON monitoring_observations (location_id, check_id, manifest_revision, started_at, observed_at)
      WHERE location_id IS NOT NULL AND manifest_revision IS NOT NULL AND started_at IS NOT NULL`,
  },
];

async function backfillObservationLocations(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }> }): Promise<void> {
  const key = 'migration:monitoring-observation-location-backfill-v1';
  const marker = await client.query(`SELECT value FROM admin_config WHERE key = $1`, [key]);
  const value: string | undefined = marker.rows[0]?.value;
  if (!value?.startsWith('pending:')) return;
  const maxId = Number(value.slice('pending:'.length));
  for (;;) {
    const batch = await client.query(
      `UPDATE monitoring_observations SET location_id = (SELECT id FROM monitoring_locations WHERE location_key = 'local')
       WHERE id IN (SELECT id FROM monitoring_observations WHERE location_id IS NULL AND id <= $1 LIMIT 5000)`,
      [maxId],
    );
    if (!batch.rowCount) break;
  }
  await client.query(`UPDATE admin_config SET value = 'complete', updated_at = CURRENT_TIMESTAMP WHERE key = $1`, [key]);
}

async function ensureLargeTableIndexes(client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: any[] }> }): Promise<void> {
  for (const index of CONCURRENT_INDEXES) {
    const state = await client.query(
      `SELECT i.indisvalid AS valid FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
       WHERE c.relname = $1 AND c.relnamespace = current_schema()::regnamespace`,
      [index.name],
    );
    if (state.rows[0]?.valid) continue;
    // An interrupted concurrent build leaves an invalid index behind; rebuild it.
    if (state.rows.length) await client.query(`DROP INDEX CONCURRENTLY IF EXISTS ${index.name}`);
    await client.query(index.ddl);
  }
}
export async function initializeSchema(): Promise<void> {
  const client = await getClient();

  let locked = false;
  try {
    // Session-level so the post-commit concurrent index builds stay serialized with other replicas' DDL.
    // Polled, not blocking: a session waiting in pg_advisory_lock holds an old snapshot that a concurrent index build would wait on forever.
    while (!(await client.query(`SELECT pg_try_advisory_lock(hashtext('robin-admin-schema')) AS ok`)).rows[0].ok) {
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
    locked = true;
    await client.query('BEGIN');
    let hadPriorTelemetryState = false;

    // Create admins table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        uid UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE,
        name VARCHAR(120) NOT NULL,
        email VARCHAR(255) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        allowed_cidrs TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        last_login TIMESTAMP,
        disabled BOOLEAN NOT NULL DEFAULT false,
        CONSTRAINT valid_role CHECK (role IN ('viewer', 'editor', 'admin'))
      )
    `);

    await client.query(`
      ALTER TABLE admins ADD COLUMN IF NOT EXISTS uid UUID NOT NULL DEFAULT gen_random_uuid() UNIQUE
    `);

    // Serialize directory revisions in the account transaction so feed cursors cannot skip commits.
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_directory_revision (
        singleton BOOLEAN PRIMARY KEY DEFAULT true CHECK (singleton),
        revision BIGINT NOT NULL DEFAULT 0
      );
      INSERT INTO admin_directory_revision (singleton) VALUES (true) ON CONFLICT DO NOTHING;
      CREATE TABLE IF NOT EXISTS admin_directory_events (
        revision BIGINT PRIMARY KEY,
        uid UUID NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('created', 'updated', 'deleted')),
        disabled BOOLEAN NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE OR REPLACE FUNCTION record_admin_directory_event() RETURNS TRIGGER AS $$
      DECLARE next_revision BIGINT;
      BEGIN
        IF TG_OP = 'UPDATE' AND ROW(NEW.name, NEW.email, NEW.role, NEW.disabled)
          IS NOT DISTINCT FROM ROW(OLD.name, OLD.email, OLD.role, OLD.disabled) THEN
          RETURN NEW;
        END IF;
        UPDATE admin_directory_revision SET revision = revision + 1 WHERE singleton RETURNING revision INTO next_revision;
        IF TG_OP = 'DELETE' THEN
          INSERT INTO admin_directory_events (revision, uid, kind, disabled) VALUES (next_revision, OLD.uid, 'deleted', true);
          RETURN OLD;
        END IF;
        INSERT INTO admin_directory_events (revision, uid, kind, disabled)
          VALUES (next_revision, NEW.uid, CASE WHEN TG_OP = 'INSERT' THEN 'created' ELSE 'updated' END, NEW.disabled);
        RETURN NEW;
      END; $$ LANGUAGE plpgsql;
      CREATE OR REPLACE TRIGGER admin_directory_changed AFTER INSERT OR UPDATE OR DELETE ON admins
        FOR EACH ROW EXECUTE FUNCTION record_admin_directory_event();
      CREATE TABLE IF NOT EXISTS module_host_policies (
        slug TEXT PRIMARY KEY,
        directory_read BOOLEAN NOT NULL DEFAULT false,
        lifecycle_read BOOLEAN NOT NULL DEFAULT false,
        max_body_mib INTEGER NOT NULL DEFAULT 5 CHECK (max_body_mib BETWEEN 1 AND 64),
        timeout_seconds INTEGER NOT NULL DEFAULT 30 CHECK (timeout_seconds BETWEEN 5 AND 120)
      )
    `);

    // Express sessions live in "session"; retire the unused earlier table.
    await client.query('DROP TABLE IF EXISTS admin_sessions');

    // Create admin_audit_log table
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_audit_log (
        id SERIAL PRIMARY KEY,
        admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        action VARCHAR(50) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id TEXT,
        old_values JSONB,
        new_values JSONB,
        ip_address VARCHAR(45),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_login_attempts (
        id SERIAL PRIMARY KEY,
        email VARCHAR(255),
        ip_address VARCHAR(45) NOT NULL,
        user_agent TEXT,
        success BOOLEAN NOT NULL DEFAULT false,
        failure_reason VARCHAR(80),
        locked_until TIMESTAMP,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_password_recovery_tokens (
        id BIGSERIAL PRIMARY KEY,
        admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        token_hash VARCHAR(64) UNIQUE NOT NULL,
        requested_ip VARCHAR(45),
        expires_at TIMESTAMPTZ NOT NULL,
        used_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_api_keys (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        key_prefix VARCHAR(20) UNIQUE NOT NULL,
        key_hash VARCHAR(128) UNIQUE NOT NULL,
        role VARCHAR(20) NOT NULL DEFAULT 'viewer',
        scopes TEXT[] NOT NULL DEFAULT '{}',
        allowed_cidrs TEXT[] NOT NULL DEFAULT '{}',
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        revoked_at TIMESTAMP,
        last_used_at TIMESTAMP,
        last_used_ip VARCHAR(45),
        CONSTRAINT valid_api_key_role CHECK (role IN ('viewer', 'editor', 'admin'))
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_ip_jail (
        id SERIAL PRIMARY KEY,
        cidr VARCHAR(64) NOT NULL,
        reason TEXT,
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        expires_at TIMESTAMP,
        lifted_at TIMESTAMP,
        lifted_by INTEGER REFERENCES admins(id) ON DELETE SET NULL
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_config (
        key VARCHAR(100) PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);
    const operationsRows = await client.query<{ key: string }>(
      'SELECT key FROM admin_config WHERE key = ANY($1::text[]) LIMIT 1',
      [OPERATIONS_KEYS]
    );
    if (!operationsRows.rows.length) {
      const imported = operationsDefaults();
      const numericEnvironment: Partial<Record<keyof typeof OPERATIONS_SETTINGS, string>> = {
        alertEvaluationIntervalMs: 'ALERT_EVALUATION_INTERVAL_MS',
        alertDeliveryIntervalMs: 'ALERT_DELIVERY_INTERVAL_MS',
        alertDeliveryConcurrency: 'ALERT_DELIVERY_CONCURRENCY',
        alertDeliveryMaxAttempts: 'ALERT_DELIVERY_MAX_ATTEMPTS',
        alertRetryBaseMs: 'ALERT_RETRY_BASE_MS',
        alertRetryMaxMs: 'ALERT_RETRY_MAX_MS',
      };
      for (const [key, name] of Object.entries(numericEnvironment) as Array<[keyof typeof OPERATIONS_SETTINGS, string]>) {
        const raw = process.env[name];
        if (raw === undefined || raw === '') continue;
        const value = Number(raw);
        const rule = OPERATIONS_SETTINGS[key];
        if (Number.isInteger(value) && value >= rule.min && value <= rule.max) imported[key] = value;
        else logger.warn(`Ignoring invalid ${name} while importing alert settings`);
      }
      const ingestLimitBytes = process.env.REPORT_INGEST_BODY_LIMIT_BYTES;
      if (ingestLimitBytes !== undefined && ingestLimitBytes !== '') {
        const bytes = Number(ingestLimitBytes);
        const mebibytes = Math.ceil(bytes / (1024 * 1024));
        const rule = OPERATIONS_SETTINGS.reportingIngestMaxMiB;
        if (Number.isSafeInteger(bytes) && bytes > 0 && mebibytes >= rule.min && mebibytes <= rule.max) {
          imported.reportingIngestMaxMiB = mebibytes;
        } else logger.warn('Ignoring invalid REPORT_INGEST_BODY_LIMIT_BYTES while importing operations settings');
      }
      const enabled = process.env.ALERTING_ENABLED;
      if (enabled !== undefined) {
        if (enabled === 'true' || enabled === 'false') imported.alertsEnabled = enabled === 'true';
        else logger.warn('Ignoring invalid ALERTING_ENABLED while importing alert settings');
      }
      const instanceName = process.env.ALERT_INSTANCE_NAME;
      if (instanceName !== undefined) {
        if (validateOperationsSettings({ alertInstanceName: instanceName }, imported)) logger.warn('Ignoring invalid ALERT_INSTANCE_NAME while importing alert settings');
        else imported.alertInstanceName = instanceName;
      }
      const incompatible = validateOperationsSettings(imported);
      if (incompatible) logger.warn('Ignoring incompatible legacy alert settings while importing alert policy', { error: incompatible });
      const seeded = incompatible ? operationsDefaults() : imported;
      await client.query(
        `INSERT INTO admin_config (key, value, updated_at)
         SELECT key, value, CURRENT_TIMESTAMP FROM UNNEST($1::text[], $2::text[]) AS settings(key, value)
         ON CONFLICT (key) DO NOTHING`,
        [Object.keys(seeded), Object.values(seeded).map(value => String(value))]
      );
      if (enabled === 'true') logger.info('Imported alert policy from legacy environment settings');
    }

    // Per-admin preferences (generic key/value JSON). Powers dashboard
    // card customization; reusable for other per-admin UI state.
    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_preferences (
        admin_id INTEGER NOT NULL REFERENCES admins(id) ON DELETE CASCADE,
        key VARCHAR(64) NOT NULL,
        value JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (admin_id, key)
      )
    `);

    // Bootstrap the default Robin store. Integrations may point Robin Admin at
    // another table with the same shape without renaming or moving data.
    await client.query(`
      CREATE TABLE IF NOT EXISTS robin_config_store (
        server_id VARCHAR(100) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::BIGINT,
        sha256 VARCHAR(64) NOT NULL DEFAULT '',
        PRIMARY KEY (server_id, file_name)
      )
    `);

    // ── robin-agent fleet agents ────────────────────────────────────────────
    // An enrolled agent runs on a host/container and reports over an outbound
    // channel. Services collected via an agent carry fleet_services.agent_id;
    // directly-reachable services (the bundled suite) leave it null.
    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_agents (
        id BIGSERIAL PRIMARY KEY,
        agent_id VARCHAR(64) UNIQUE NOT NULL,
        name VARCHAR(100) NOT NULL,
        hostname VARCHAR(255),
        os VARCHAR(32),
        arch VARCHAR(32),
        agent_version VARCHAR(64),
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        labels_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        discovered_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        services_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        enrolled_at TIMESTAMPTZ,
        last_seen_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_fleet_agent_status
          CHECK (status IN ('pending', 'online', 'offline'))
      )
    `);
    // Added after the table first shipped; existing installs need it explicitly.
    await client.query(`ALTER TABLE fleet_agents ADD COLUMN IF NOT EXISTS services_json JSONB NOT NULL DEFAULT '{}'::jsonb`);

    // Per-agent secrets, same reversible-crypto envelope as fleet_service_secrets.
    // secret_type is 'enrollment_token' (one-time, TTL via expires_at) or
    // 'agent_credential' (long-lived bearer the agent authenticates channels with).
    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_agent_secrets (
        id BIGSERIAL PRIMARY KEY,
        agent_id VARCHAR(64) NOT NULL
          CONSTRAINT fleet_agent_secrets_agent_id_fkey
          REFERENCES fleet_agents(agent_id) ON DELETE CASCADE ON UPDATE CASCADE,
        secret_type VARCHAR(64) NOT NULL,
        encrypted_secret TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        key_version VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_rotated_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        UNIQUE(agent_id, secret_type)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_agent_commands (
        id UUID PRIMARY KEY,
        agent_id VARCHAR(64) NOT NULL
          CONSTRAINT fleet_agent_commands_agent_id_fkey
          REFERENCES fleet_agents(agent_id) ON DELETE CASCADE ON UPDATE CASCADE,
        service_id VARCHAR(64) NOT NULL,
        service_type VARCHAR(16) NOT NULL,
        action VARCHAR(64) NOT NULL,
        args_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(16) NOT NULL DEFAULT 'queued',
        result_output TEXT,
        result_error TEXT,
        sent_at TIMESTAMPTZ,
        acknowledged_at TIMESTAMPTZ,
        completed_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ NOT NULL,
        lease_expires_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_fleet_agent_command_status
          CHECK (status IN ('queued', 'sent', 'acknowledged', 'succeeded', 'failed', 'expired')),
        CONSTRAINT valid_fleet_agent_command_service_type CHECK (service_type IN (${serviceTypeSqlList()}))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_agent_commands_agent_pending
      ON fleet_agent_commands (agent_id, status, created_at)
      WHERE status IN ('queued', 'sent', 'acknowledged')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_agent_commands_expires
      ON fleet_agent_commands (expires_at)
      WHERE status IN ('queued', 'sent', 'acknowledged')
    `);

    // A service is collected either 'direct' (robin-admin connects) or 'agent'
    // (a robin-agent reports it; agent_id is then also its log and config
    // agent). log_agent_id and config_agent_id are independent axes: a
    // direct-metrics service can still have a co-located agent ship its
    // root-owned logs or apply its config.
    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_services (
        id SERIAL PRIMARY KEY,
        service_id VARCHAR(64) UNIQUE NOT NULL,
        service_type VARCHAR(16) NOT NULL,
        name VARCHAR(100) NOT NULL,
        description TEXT,
        api_url VARCHAR(255),
        health_url VARCHAR(255),
        metrics_url TEXT,
        controller_url VARCHAR(255),
        normal_url VARCHAR(255),
        enabled BOOLEAN NOT NULL DEFAULT true,
        agent_id VARCHAR(64)
          CONSTRAINT fleet_services_agent_id_fkey
          REFERENCES fleet_agents(agent_id) ON DELETE SET NULL ON UPDATE CASCADE,
        collection_mode VARCHAR(16) NOT NULL DEFAULT 'direct',
        log_agent_id VARCHAR(64)
          CONSTRAINT fleet_services_log_agent_id_fkey
          REFERENCES fleet_agents(agent_id) ON DELETE SET NULL ON UPDATE CASCADE,
        config_agent_id VARCHAR(64)
          CONSTRAINT fleet_services_config_agent_id_fkey
          REFERENCES fleet_agents(agent_id) ON DELETE SET NULL ON UPDATE CASCADE,
        role VARCHAR(32),
        tags_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        -- The service's own version as its agent last reported it (e.g.
        -- dovecot --version), so config renders for the syntax the host speaks.
        software_version VARCHAR(64),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_fleet_service_type CHECK (service_type IN (${serviceTypeSqlList()})),
        CONSTRAINT valid_fleet_collection_mode CHECK (collection_mode IN ('direct', 'agent'))
      )
    `);
    // Seal saved native DSNs once; runtime reads require encrypted envelopes.
    await client.query('ALTER TABLE fleet_services ALTER COLUMN metrics_url TYPE TEXT');
    const unsealedDsns = await client.query<{ service_id: string; metrics_url: string }>(
      `SELECT service_id, metrics_url FROM fleet_services
       WHERE service_type IN ('redis', 'postgres', 'mariadb')
         AND metrics_url IS NOT NULL AND metrics_url NOT LIKE '{%'`
    );
    for (const row of unsealedDsns.rows) {
      await client.query('UPDATE fleet_services SET metrics_url=$1 WHERE service_id=$2', [encryptStoredSecret(row.metrics_url), row.service_id]);
    }
    // The installer-provisioned "managed" store became the deployment's bundled store.
    await client.query(
      `UPDATE admin_config SET value = jsonb_set(value::jsonb, '{mode}', '"bundled"')::text, updated_at = CURRENT_TIMESTAMP
       WHERE key = 'telemetryConnection' AND value::jsonb->>'mode' = 'managed'`
    );
    const discoverySeed = await client.query<{ value: string }>(
      `SELECT value FROM admin_config WHERE key = 'migration:telemetry-discovery-defaults-v1'`
    );
    if (!discoverySeed.rows[0]) {
      const legacyHost = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM information_schema.columns
           WHERE table_schema = current_schema() AND table_name = 'fleet_services' AND column_name = 'telemetry_host'
         ) AS exists`
      );
      const legacyTables = await client.query<{ dashboards: string | null; templates: string | null }>(
        `SELECT to_regclass('telemetry_dashboards')::text AS dashboards,
                to_regclass('telemetry_seeded_templates')::text AS templates`
      );
      let savedDashboard = false;
      if (legacyTables.rows[0]?.dashboards) {
        const dashboards = await client.query<{ exists: boolean }>(
          'SELECT EXISTS (SELECT 1 FROM telemetry_dashboards) AS exists'
        );
        savedDashboard = dashboards.rows[0]?.exists ?? false;
      }
      hadPriorTelemetryState = Boolean(
        legacyHost.rows[0]?.exists || legacyTables.rows[0]?.templates || savedDashboard
      );
    }
    // Preserve existing source bindings while using collector-neutral naming.
    await client.query(`
      DO $$ BEGIN
        IF EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_schema = current_schema() AND table_name = 'fleet_services' AND column_name = 'telemetry_host') THEN
          ALTER TABLE fleet_services RENAME COLUMN telemetry_host TO telemetry_source;
        END IF;
      END $$
    `);
    await client.query(`ALTER TABLE fleet_services ADD COLUMN IF NOT EXISTS telemetry_source VARCHAR(255)`);
    await client.query(`ALTER TABLE fleet_services ADD COLUMN IF NOT EXISTS software_version VARCHAR(64)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_services_agent_id ON fleet_services (agent_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_services_log_agent_id ON fleet_services (log_agent_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_services_config_agent_id ON fleet_services (config_agent_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_service_secrets (
        id BIGSERIAL PRIMARY KEY,
        service_id VARCHAR(64) NOT NULL
          CONSTRAINT fleet_service_secrets_service_id_fkey
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        secret_type VARCHAR(64) NOT NULL,
        encrypted_secret TEXT NOT NULL,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        key_version VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_rotated_at TIMESTAMPTZ,
        expires_at TIMESTAMPTZ,
        UNIQUE(service_id, secret_type)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_service_sync_status (
        service_id VARCHAR(64) PRIMARY KEY
          CONSTRAINT fleet_service_sync_status_service_id_fkey
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        manifest_sha256 VARCHAR(64),
        manifest_etag VARCHAR(128),
        manifest_file_count INTEGER,
        last_seen_at TIMESTAMPTZ,
        last_manifest_pulled_at TIMESTAMPTZ,
        last_file_pulled_at TIMESTAMPTZ,
        last_apply_started_at TIMESTAMPTZ,
        last_apply_finished_at TIMESTAMPTZ,
        last_apply_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
        last_apply_error TEXT,
        last_applied_sha256 VARCHAR(64),
        last_applied_file_count INTEGER,
        agent_version VARCHAR(128),
        -- Force-sync marker: bumped by "Sync now"; folded into the manifest hash
        -- so the agent re-pulls and re-applies even when the config is unchanged.
        sync_requested_at TIMESTAMPTZ,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_fleet_service_apply_status
          CHECK (last_apply_status IN ('unknown', 'pending', 'succeeded', 'failed'))
      )
    `);

    // Append-only audit trail of fleet-agent sync events (manifest pulls and
    // config applies), so every push to a service can be reviewed over time.
    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_service_sync_log (
        id BIGSERIAL PRIMARY KEY,
        service_id VARCHAR(64) NOT NULL
          CONSTRAINT fleet_service_sync_log_service_id_fkey
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        event_type VARCHAR(24) NOT NULL,
        apply_status VARCHAR(16),
        manifest_sha256 VARCHAR(64),
        applied_sha256 VARCHAR(64),
        file_count INTEGER,
        agent_version VARCHAR(128),
        message TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_fleet_sync_log_event
          CHECK (event_type IN ('manifest_pulled', 'apply_started', 'apply_succeeded', 'apply_failed', 'registered', 'sync_requested'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_service_sync_log_service_time
      ON fleet_service_sync_log (service_id, created_at DESC)
    `);

    // Latest log tail an agent pushed for an agent-mode service. Agent-mode
    // hosts aren't reachable by robin-admin, so the agent tails the service's
    // journald unit / log file and ships the recent lines here each cycle. Only
    // the newest buffer per service is kept (upsert) — a live tail, not an
    // archive — mirroring the metrics push model with no unbounded growth.
    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_agent_service_logs (
        service_id VARCHAR(64) PRIMARY KEY
          CONSTRAINT fleet_agent_service_logs_service_id_fkey
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        source VARCHAR(255),
        lines_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        captured_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS modules_catalog (
        slug VARCHAR(120) PRIMARY KEY,
        display_name VARCHAR(160) NOT NULL,
        description TEXT,
        vendor_name VARCHAR(160),
        tier VARCHAR(16) NOT NULL DEFAULT 'free',
        latest_version VARCHAR(64),
        remote_scope VARCHAR(160) NOT NULL,
        exposed_module VARCHAR(160) NOT NULL DEFAULT './module',
        remote_entry_path VARCHAR(255),
        route_slug VARCHAR(120) NOT NULL,
        icon_name VARCHAR(64),
        sort_order INTEGER NOT NULL DEFAULT 1000,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        module_definition_json JSONB,
        synced_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_modules_catalog_tier CHECK (tier IN ('free', 'paid'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_modules_catalog_sort
      ON modules_catalog (sort_order ASC, display_name ASC)
    `);
    await client.query(`ALTER TABLE modules_catalog ADD COLUMN IF NOT EXISTS module_definition_json JSONB`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS modules_installed (
        id SERIAL PRIMARY KEY,
        module_slug VARCHAR(120) NOT NULL UNIQUE,
        display_name VARCHAR(160),
        description TEXT,
        vendor_name VARCHAR(160),
        tier VARCHAR(16),
        latest_version VARCHAR(64),
        route_slug VARCHAR(120),
        remote_scope VARCHAR(160),
        exposed_module VARCHAR(160),
        remote_entry_path VARCHAR(255),
        icon_name VARCHAR(64),
        sort_order INTEGER,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        module_definition_json JSONB,
        remote_entry_url VARCHAR(512) NOT NULL,
        installed_version VARCHAR(64),
        probe_url VARCHAR(512),
        backend_url VARCHAR(512),
        asset_base_url VARCHAR(512),
        remote_scope_override VARCHAR(160),
        exposed_module_override VARCHAR(160),
        installed_source VARCHAR(32) NOT NULL DEFAULT 'bootstrap',
        notes TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS display_name VARCHAR(160)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS description TEXT`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS vendor_name VARCHAR(160)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS tier VARCHAR(16)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS latest_version VARCHAR(64)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS route_slug VARCHAR(120)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS remote_scope VARCHAR(160)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS exposed_module VARCHAR(160)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS remote_entry_path VARCHAR(255)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS icon_name VARCHAR(64)`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS sort_order INTEGER`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb`);
    await client.query(`ALTER TABLE modules_installed ADD COLUMN IF NOT EXISTS module_definition_json JSONB`);
    await client.query(`
      UPDATE modules_installed AS installed
      SET display_name = COALESCE(installed.display_name, catalog.display_name),
          description = COALESCE(installed.description, catalog.description),
          vendor_name = COALESCE(installed.vendor_name, catalog.vendor_name),
          tier = COALESCE(installed.tier, catalog.tier),
          latest_version = COALESCE(installed.latest_version, catalog.latest_version),
          route_slug = COALESCE(installed.route_slug, catalog.route_slug),
          remote_scope = COALESCE(installed.remote_scope, installed.remote_scope_override, catalog.remote_scope),
          exposed_module = COALESCE(installed.exposed_module, installed.exposed_module_override, catalog.exposed_module),
          remote_entry_path = COALESCE(installed.remote_entry_path, catalog.remote_entry_path),
          icon_name = COALESCE(installed.icon_name, catalog.icon_name),
          sort_order = COALESCE(installed.sort_order, catalog.sort_order),
          metadata_json = CASE
            WHEN installed.metadata_json = '{}'::jsonb THEN catalog.metadata_json
            ELSE installed.metadata_json
          END,
          module_definition_json = COALESCE(installed.module_definition_json, catalog.module_definition_json),
          updated_at = CURRENT_TIMESTAMP
      FROM modules_catalog AS catalog
      WHERE catalog.slug = installed.module_slug
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS module_licenses (
        module_slug VARCHAR(120) PRIMARY KEY,
        license_key TEXT NOT NULL,
        authority_url TEXT,
        status VARCHAR(16) NOT NULL DEFAULT 'inactive',
        customer_name VARCHAR(255),
        issued_to TEXT,
        lease_token TEXT,
        activation_id VARCHAR(255),
        refresh_credential TEXT,
        instance_id VARCHAR(255),
        instance_fingerprint VARCHAR(128),
        instance_key_thumbprint VARCHAR(128),
        lease_started_at TIMESTAMPTZ,
        lease_expires_at TIMESTAMPTZ,
        offline_grace_ends_at TIMESTAMPTZ,
        replacement_allowance INTEGER,
        replacements_used INTEGER,
        refresh_failure_terminal BOOLEAN NOT NULL DEFAULT false,
        last_validated_at TIMESTAMPTZ,
        last_validation_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_module_license_status CHECK (status IN ('inactive', 'active', 'expired', 'invalid'))
      )
    `);

    await client.query(`ALTER TABLE module_licenses ADD COLUMN IF NOT EXISTS authority_url TEXT`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rspamd_config_store (
        -- service_id holds a real fleet service_id OR the reserved 'default'
        -- override base (no FK, matching robin_config_store's server_id), so a
        -- default config can be layered with per-service overrides.
        service_id VARCHAR(64) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::BIGINT,
        sha256 VARCHAR(64) NOT NULL DEFAULT '',
        PRIMARY KEY (service_id, file_name)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS clamav_config_store (
        service_id VARCHAR(64) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::BIGINT,
        sha256 VARCHAR(64) NOT NULL DEFAULT '',
        PRIMARY KEY (service_id, file_name)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS robin_clamav_service_links (
        server_id VARCHAR(100) PRIMARY KEY,
        clamav_service_id VARCHAR(64) NOT NULL
          CONSTRAINT robin_clamav_service_links_clamav_service_id_fkey
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS clamav_metrics_history (
        id BIGSERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL
          CONSTRAINT clamav_metrics_history_fleet_service_id_fkey
          REFERENCES fleet_services(id) ON DELETE CASCADE ON UPDATE CASCADE,
        service_id VARCHAR(64) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        ping_ok BOOLEAN NOT NULL DEFAULT false,
        version_text TEXT,
        engine_version VARCHAR(64),
        database_version INTEGER,
        database_updated_at TIMESTAMPTZ,
        status_text VARCHAR(128),
        pools INTEGER NOT NULL DEFAULT 0,
        threads_live INTEGER NOT NULL DEFAULT 0,
        threads_idle INTEGER NOT NULL DEFAULT 0,
        threads_max INTEGER NOT NULL DEFAULT 0,
        queue_items INTEGER NOT NULL DEFAULT 0,
        memory_heap_mb DOUBLE PRECISION NOT NULL DEFAULT 0,
        memory_mmap_mb DOUBLE PRECISION NOT NULL DEFAULT 0,
        memory_used_mb DOUBLE PRECISION NOT NULL DEFAULT 0,
        memory_free_mb DOUBLE PRECISION NOT NULL DEFAULT 0,
        memory_releasable_mb DOUBLE PRECISION NOT NULL DEFAULT 0,
        memory_pools_used_mb DOUBLE PRECISION NOT NULL DEFAULT 0,
        memory_pools_total_mb DOUBLE PRECISION NOT NULL DEFAULT 0,
        raw_stats TEXT NOT NULL DEFAULT ''
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_clamav_metrics_history_service_time
      ON clamav_metrics_history (fleet_service_id, timestamp DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dovecot_config_store (
        service_id VARCHAR(64) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::BIGINT,
        sha256 VARCHAR(64) NOT NULL DEFAULT '',
        PRIMARY KEY (service_id, file_name)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS cyrus_metrics_history (
        id BIGSERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL REFERENCES fleet_services(id) ON DELETE CASCADE ON UPDATE CASCADE,
        service_id VARCHAR(64) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reachable BOOLEAN NOT NULL DEFAULT false,
        imap_connections BIGINT NOT NULL DEFAULT 0,
        active_connections BIGINT NOT NULL DEFAULT 0,
        auth_success BIGINT NOT NULL DEFAULT 0,
        auth_failure BIGINT NOT NULL DEFAULT 0,
        login_count BIGINT NOT NULL DEFAULT 0,
        imap_commands BIGINT NOT NULL DEFAULT 0,
        lmtp_connections BIGINT NOT NULL DEFAULT 0,
        mail_deliveries BIGINT NOT NULL DEFAULT 0,
        lmtp_recipients BIGINT NOT NULL DEFAULT 0,
        lmtp_bytes BIGINT NOT NULL DEFAULT 0,
        user_count BIGINT NOT NULL DEFAULT 0,
        mailbox_count BIGINT NOT NULL DEFAULT 0,
        quota_commitment BIGINT NOT NULL DEFAULT 0,
        session_count BIGINT NOT NULL DEFAULT 0,
        raw_stats TEXT NOT NULL DEFAULT ''
      )
    `);
    await client.query(`CREATE INDEX IF NOT EXISTS idx_cyrus_metrics_history_service_time ON cyrus_metrics_history (fleet_service_id, timestamp DESC)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS dovecot_metrics_history (
        id BIGSERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL
          CONSTRAINT dovecot_metrics_history_fleet_service_id_fkey
          REFERENCES fleet_services(id) ON DELETE CASCADE ON UPDATE CASCADE,
        service_id VARCHAR(64) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reachable BOOLEAN NOT NULL DEFAULT false,
        auth_success BIGINT NOT NULL DEFAULT 0,
        auth_failure BIGINT NOT NULL DEFAULT 0,
        login_count BIGINT NOT NULL DEFAULT 0,
        imap_commands BIGINT NOT NULL DEFAULT 0,
        mail_deliveries BIGINT NOT NULL DEFAULT 0,
        session_count INTEGER NOT NULL DEFAULT 0,
        user_count INTEGER NOT NULL DEFAULT 0,
        raw_stats TEXT NOT NULL DEFAULT ''
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dovecot_metrics_history_service_time
      ON dovecot_metrics_history (fleet_service_id, timestamp DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS postfix_config_store (
        service_id VARCHAR(64) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::BIGINT,
        sha256 VARCHAR(64) NOT NULL DEFAULT '',
        PRIMARY KEY (service_id, file_name)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS postfix_metrics_history (
        id BIGSERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL
          CONSTRAINT postfix_metrics_history_fleet_service_id_fkey
          REFERENCES fleet_services(id) ON DELETE CASCADE ON UPDATE CASCADE,
        service_id VARCHAR(64) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reachable BOOLEAN NOT NULL DEFAULT false,
        queue_active BIGINT NOT NULL DEFAULT 0,
        queue_deferred BIGINT NOT NULL DEFAULT 0,
        queue_hold BIGINT NOT NULL DEFAULT 0,
        queue_incoming BIGINT NOT NULL DEFAULT 0,
        queue_total BIGINT NOT NULL DEFAULT 0,
        oldest_deferred_age_secs BIGINT NOT NULL DEFAULT 0,
        messages_delivered BIGINT NOT NULL DEFAULT 0,
        messages_deferred BIGINT NOT NULL DEFAULT 0,
        messages_bounced BIGINT NOT NULL DEFAULT 0,
        messages_rejected BIGINT NOT NULL DEFAULT 0,
        raw_stats TEXT NOT NULL DEFAULT ''
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_postfix_metrics_history_service_time
      ON postfix_metrics_history (fleet_service_id, timestamp DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS redis_config_store (
        service_id VARCHAR(64) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::BIGINT,
        sha256 VARCHAR(64) NOT NULL DEFAULT '',
        PRIMARY KEY (service_id, file_name)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS redis_metrics_history (
        id BIGSERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL
          CONSTRAINT redis_metrics_history_fleet_service_id_fkey
          REFERENCES fleet_services(id) ON DELETE CASCADE ON UPDATE CASCADE,
        service_id VARCHAR(64) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reachable BOOLEAN NOT NULL DEFAULT false,
        role VARCHAR(32) NOT NULL DEFAULT '',
        uptime_secs BIGINT NOT NULL DEFAULT 0,
        connected_clients INTEGER NOT NULL DEFAULT 0,
        blocked_clients INTEGER NOT NULL DEFAULT 0,
        max_clients INTEGER NOT NULL DEFAULT 0,
        memory_used_bytes BIGINT NOT NULL DEFAULT 0,
        memory_peak_bytes BIGINT NOT NULL DEFAULT 0,
        memory_rss_bytes BIGINT NOT NULL DEFAULT 0,
        max_memory_bytes BIGINT NOT NULL DEFAULT 0,
        mem_fragmentation_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
        evicted_keys BIGINT NOT NULL DEFAULT 0,
        expired_keys BIGINT NOT NULL DEFAULT 0,
        keyspace_hits BIGINT NOT NULL DEFAULT 0,
        keyspace_misses BIGINT NOT NULL DEFAULT 0,
        hit_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
        instantaneous_ops_per_sec BIGINT NOT NULL DEFAULT 0,
        total_commands_processed BIGINT NOT NULL DEFAULT 0,
        total_connections_received BIGINT NOT NULL DEFAULT 0,
        rejected_connections BIGINT NOT NULL DEFAULT 0,
        total_net_input_bytes BIGINT NOT NULL DEFAULT 0,
        total_net_output_bytes BIGINT NOT NULL DEFAULT 0,
        connected_slaves INTEGER NOT NULL DEFAULT 0,
        master_link_status VARCHAR(32) NOT NULL DEFAULT '',
        rdb_changes_since_last_save BIGINT NOT NULL DEFAULT 0,
        rdb_last_save_time BIGINT NOT NULL DEFAULT 0,
        rdb_last_bgsave_status VARCHAR(32) NOT NULL DEFAULT '',
        aof_enabled BOOLEAN NOT NULL DEFAULT false,
        aof_last_write_status VARCHAR(32) NOT NULL DEFAULT '',
        db_keys BIGINT NOT NULL DEFAULT 0,
        db_expires BIGINT NOT NULL DEFAULT 0,
        pubsub_channels BIGINT NOT NULL DEFAULT 0,
        raw_info TEXT NOT NULL DEFAULT ''
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_redis_metrics_history_service_time
      ON redis_metrics_history (fleet_service_id, timestamp DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS postgres_config_store (
        service_id VARCHAR(64) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::BIGINT,
        sha256 VARCHAR(64) NOT NULL DEFAULT '',
        PRIMARY KEY (service_id, file_name)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS postgres_metrics_history (
        id BIGSERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL
          CONSTRAINT postgres_metrics_history_fleet_service_id_fkey
          REFERENCES fleet_services(id) ON DELETE CASCADE ON UPDATE CASCADE,
        service_id VARCHAR(64) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reachable BOOLEAN NOT NULL DEFAULT false,
        server_version_num INTEGER NOT NULL DEFAULT 0,
        connections_total INTEGER NOT NULL DEFAULT 0,
        connections_active INTEGER NOT NULL DEFAULT 0,
        connections_idle INTEGER NOT NULL DEFAULT 0,
        connections_idle_in_txn INTEGER NOT NULL DEFAULT 0,
        connections_waiting INTEGER NOT NULL DEFAULT 0,
        max_connections INTEGER NOT NULL DEFAULT 0,
        connection_saturation_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        xact_commit BIGINT NOT NULL DEFAULT 0,
        xact_rollback BIGINT NOT NULL DEFAULT 0,
        commit_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
        blks_hit BIGINT NOT NULL DEFAULT 0,
        blks_read BIGINT NOT NULL DEFAULT 0,
        cache_hit_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
        tup_returned BIGINT NOT NULL DEFAULT 0,
        tup_fetched BIGINT NOT NULL DEFAULT 0,
        tup_inserted BIGINT NOT NULL DEFAULT 0,
        tup_updated BIGINT NOT NULL DEFAULT 0,
        tup_deleted BIGINT NOT NULL DEFAULT 0,
        deadlocks BIGINT NOT NULL DEFAULT 0,
        temp_files BIGINT NOT NULL DEFAULT 0,
        temp_bytes BIGINT NOT NULL DEFAULT 0,
        conflicts BIGINT NOT NULL DEFAULT 0,
        database_size_bytes BIGINT NOT NULL DEFAULT 0,
        oldest_xact_age_secs BIGINT NOT NULL DEFAULT 0,
        oldest_idle_in_txn_secs BIGINT NOT NULL DEFAULT 0,
        blocked_queries INTEGER NOT NULL DEFAULT 0,
        checkpoints_timed BIGINT NOT NULL DEFAULT 0,
        checkpoints_req BIGINT NOT NULL DEFAULT 0,
        buffers_checkpoint BIGINT NOT NULL DEFAULT 0,
        replication_lag_bytes BIGINT NOT NULL DEFAULT 0,
        dead_tuples_total BIGINT NOT NULL DEFAULT 0,
        raw_stats TEXT NOT NULL DEFAULT ''
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_postgres_metrics_history_service_time
      ON postgres_metrics_history (fleet_service_id, timestamp DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS mariadb_config_store (
        service_id VARCHAR(64) NOT NULL,
        file_name VARCHAR(255) NOT NULL,
        payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        updated_epoch BIGINT NOT NULL DEFAULT FLOOR(EXTRACT(EPOCH FROM CURRENT_TIMESTAMP))::BIGINT,
        sha256 VARCHAR(64) NOT NULL DEFAULT '',
        PRIMARY KEY (service_id, file_name)
      )
    `);

    // Counters are cumulative since the server started (24h deltas are taken at
    // read time); database_size_bytes is collected on a slower cadence and
    // carried forward between collections.
    await client.query(`
      CREATE TABLE IF NOT EXISTS mariadb_metrics_history (
        id BIGSERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL
          CONSTRAINT mariadb_metrics_history_fleet_service_id_fkey
          REFERENCES fleet_services(id) ON DELETE CASCADE ON UPDATE CASCADE,
        service_id VARCHAR(64) NOT NULL,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        reachable BOOLEAN NOT NULL DEFAULT false,
        version VARCHAR(128) NOT NULL DEFAULT '',
        uptime_secs BIGINT NOT NULL DEFAULT 0,
        threads_connected INTEGER NOT NULL DEFAULT 0,
        threads_running INTEGER NOT NULL DEFAULT 0,
        threads_cached INTEGER NOT NULL DEFAULT 0,
        max_connections INTEGER NOT NULL DEFAULT 0,
        max_used_connections INTEGER NOT NULL DEFAULT 0,
        connection_saturation_pct DOUBLE PRECISION NOT NULL DEFAULT 0,
        aborted_connects BIGINT NOT NULL DEFAULT 0,
        aborted_clients BIGINT NOT NULL DEFAULT 0,
        questions BIGINT NOT NULL DEFAULT 0,
        com_select BIGINT NOT NULL DEFAULT 0,
        com_insert BIGINT NOT NULL DEFAULT 0,
        com_update BIGINT NOT NULL DEFAULT 0,
        com_delete BIGINT NOT NULL DEFAULT 0,
        com_commit BIGINT NOT NULL DEFAULT 0,
        com_rollback BIGINT NOT NULL DEFAULT 0,
        slow_queries BIGINT NOT NULL DEFAULT 0,
        bytes_received BIGINT NOT NULL DEFAULT 0,
        bytes_sent BIGINT NOT NULL DEFAULT 0,
        buffer_pool_read_requests BIGINT NOT NULL DEFAULT 0,
        buffer_pool_reads BIGINT NOT NULL DEFAULT 0,
        buffer_pool_hit_ratio DOUBLE PRECISION NOT NULL DEFAULT 0,
        buffer_pool_pages_total BIGINT NOT NULL DEFAULT 0,
        buffer_pool_pages_free BIGINT NOT NULL DEFAULT 0,
        buffer_pool_pages_dirty BIGINT NOT NULL DEFAULT 0,
        row_lock_waits BIGINT NOT NULL DEFAULT 0,
        row_lock_time_ms BIGINT NOT NULL DEFAULT 0,
        deadlocks BIGINT NOT NULL DEFAULT 0,
        history_list_length BIGINT NOT NULL DEFAULT 0,
        trx_active INTEGER NOT NULL DEFAULT 0,
        oldest_trx_age_secs BIGINT NOT NULL DEFAULT 0,
        trx_lock_waits INTEGER NOT NULL DEFAULT 0,
        created_tmp_disk_tables BIGINT NOT NULL DEFAULT 0,
        created_tmp_tables BIGINT NOT NULL DEFAULT 0,
        opened_tables BIGINT NOT NULL DEFAULT 0,
        schema_count INTEGER NOT NULL DEFAULT 0,
        database_size_bytes BIGINT,
        is_replica BOOLEAN NOT NULL DEFAULT false,
        replica_io_running BOOLEAN NOT NULL DEFAULT false,
        replica_sql_running BOOLEAN NOT NULL DEFAULT false,
        seconds_behind_source BIGINT,
        raw_stats TEXT NOT NULL DEFAULT ''
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_mariadb_metrics_history_service_time
      ON mariadb_metrics_history (fleet_service_id, timestamp DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rspamd_dkim_domains (
        id BIGSERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL UNIQUE,
        sign_domain VARCHAR(255) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        auto_rotate_enabled BOOLEAN NOT NULL DEFAULT false,
        rotate_interval_days INTEGER,
        retain_old_days INTEGER NOT NULL DEFAULT 30,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rspamd_dkim_selectors (
        id BIGSERIAL PRIMARY KEY,
        domain_id BIGINT NOT NULL REFERENCES rspamd_dkim_domains(id) ON DELETE CASCADE,
        selector VARCHAR(63) NOT NULL,
        public_key_txt TEXT NOT NULL,
        public_key_p TEXT NOT NULL,
        algorithm VARCHAR(16) NOT NULL DEFAULT 'rsa',
        key_bits INTEGER NOT NULL DEFAULT 2048,
        state VARCHAR(16) NOT NULL CHECK (state IN ('active', 'retired', 'revoked')),
        private_key_enc TEXT,
        activated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        retired_at TIMESTAMPTZ,
        purge_after TIMESTAMPTZ,
        private_key_deleted_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain_id, selector)
      )
    `);
    // Keys moved from files on disk into the database; older installs lack the column.
    await client.query(`ALTER TABLE rspamd_dkim_selectors ADD COLUMN IF NOT EXISTS private_key_enc TEXT`);

    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS rspamd_dkim_selectors_one_active_per_domain
      ON rspamd_dkim_selectors (domain_id)
      WHERE state = 'active'
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rspamd_training_jobs (
        id BIGSERIAL PRIMARY KEY,
        source_filename TEXT,
        label VARCHAR(10) NOT NULL CHECK (label IN ('spam', 'ham')),
        status VARCHAR(16) NOT NULL CHECK (status IN ('processing', 'completed', 'failed')),
        total_files INTEGER NOT NULL DEFAULT 0,
        total_samples INTEGER NOT NULL DEFAULT 0,
        learned_samples INTEGER NOT NULL DEFAULT 0,
        error_count INTEGER NOT NULL DEFAULT 0,
        errors TEXT[] NOT NULL DEFAULT '{}',
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rspamd_training_samples (
        id BIGSERIAL PRIMARY KEY,
        job_id BIGINT REFERENCES rspamd_training_jobs(id) ON DELETE SET NULL,
        filename TEXT NOT NULL,
        content_hash VARCHAR(128) NOT NULL UNIQUE,
        label VARCHAR(10) NOT NULL CHECK (label IN ('spam', 'ham')),
        source_type VARCHAR(16) NOT NULL CHECK (source_type IN ('eml', 'mbox', 'archive')),
        stored_relpath TEXT NOT NULL,
        size_bytes BIGINT NOT NULL DEFAULT 0,
        learn_status VARCHAR(16) NOT NULL CHECK (learn_status IN ('pending', 'learned', 'failed')),
        learn_error TEXT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        learned_at TIMESTAMPTZ,
        relabeled_at TIMESTAMPTZ
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rspamd_scan_runs (
        id BIGSERIAL PRIMARY KEY,
        service_id VARCHAR(64) NOT NULL
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        actor_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        parent_run_id BIGINT REFERENCES rspamd_scan_runs(id) ON DELETE SET NULL,
        transport VARCHAR(16) NOT NULL CHECK (transport IN ('checkv2', 'checkv3')),
        source_mode VARCHAR(16) NOT NULL CHECK (source_mode IN ('raw', 'upload', 'replay')),
        source_file_name TEXT,
        message_hash VARCHAR(64) NOT NULL,
        raw_message_relpath TEXT,
        message_size_bytes BIGINT NOT NULL DEFAULT 0,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        result_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        summary_action VARCHAR(64),
        summary_score DOUBLE PRECISION,
        summary_required_score DOUBLE PRECISION,
        summary_symbols TEXT[] NOT NULL DEFAULT '{}',
        is_skipped BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rspamd_scan_actions (
        id BIGSERIAL PRIMARY KEY,
        run_id BIGINT NOT NULL REFERENCES rspamd_scan_runs(id) ON DELETE CASCADE,
        service_id VARCHAR(64) NOT NULL
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        actor_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        action_type VARCHAR(24) NOT NULL CHECK (action_type IN ('learn_spam', 'learn_ham', 'fuzzy_add', 'fuzzy_remove')),
        details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create DMARC reporters table
    await client.query(`
      CREATE TABLE IF NOT EXISTS dmarc_reporters (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) UNIQUE NOT NULL,
        display_name VARCHAR(100) NOT NULL
      )
    `);
    const legacyDmarcRawTables = await prepareLegacyDmarcRawTables(client);

    // Raw DMARC aggregate reports and their per-source records. Both are
    // partitioned by month on the report's start (records carry it as
    // report_day), so retention drops whole months in O(1) and date-bounded
    // reads prune to the months they cover. Every unique key includes the
    // partition key, and records reference reports by id without a foreign key
    // (Postgres can't enforce one into a partitioned parent without the full
    // key): insertReport writes both in one transaction and retention drops the
    // same months from both.
    await client.query(`
      CREATE TABLE IF NOT EXISTS dmarc_reports (
        id SERIAL,
        report_id VARCHAR(255) NOT NULL,
        reporter_id INTEGER REFERENCES dmarc_reporters(id),
        org_name VARCHAR(255),
        email VARCHAR(255),
        domain VARCHAR(255) NOT NULL,
        date_begin TIMESTAMP NOT NULL,
        date_end TIMESTAMP NOT NULL,
        policy VARCHAR(50),
        subdomain_policy VARCHAR(50),
        dkim_alignment VARCHAR(10),
        spf_alignment VARCHAR(10),
        pct INTEGER,
        total_count INTEGER DEFAULT 0,
        error_count INTEGER DEFAULT 0,
        raw_payload JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, date_begin),
        UNIQUE (report_id, reporter_id, date_begin)
      ) PARTITION BY RANGE (date_begin)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS dmarc_records (
        id SERIAL,
        report_id INTEGER NOT NULL,
        source_ip VARCHAR(45) NOT NULL,
        count INTEGER NOT NULL DEFAULT 1,
        disposition VARCHAR(20),
        dkim VARCHAR(20),
        spf VARCHAR(20),
        reason_type VARCHAR(50),
        reason_comment TEXT,
        header_from VARCHAR(255),
        envelope_from VARCHAR(255),
        envelope_to VARCHAR(255),
        dkim_domain VARCHAR(255),
        dkim_result VARCHAR(20),
        dkim_selector VARCHAR(100),
        spf_domain VARCHAR(255),
        spf_result VARCHAR(20),
        spf_scope VARCHAR(20),
        -- The parent report's date_begin as a date: the partition key.
        report_day DATE NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (id, report_day)
      ) PARTITION BY RANGE (report_day)
    `);
    // Default partitions are a safety net; ensureMonthlyPartition() creates the
    // month before every write, so they normally stay empty.
    await client.query(`
      CREATE TABLE IF NOT EXISTS dmarc_reports_default PARTITION OF dmarc_reports DEFAULT
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS dmarc_records_default PARTITION OF dmarc_records DEFAULT
    `);
    if (legacyDmarcRawTables) {
      await migrateLegacyDmarcRawTables(client, legacyDmarcRawTables);
    }
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain ON dmarc_reports (domain)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_reports_date ON dmarc_reports (date_begin, date_end)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain_dates ON dmarc_reports (domain, date_begin, date_end)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_reports_reporter ON dmarc_reports (reporter_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_reports_domain_last_seen
      ON dmarc_reports (domain, (COALESCE(created_at, date_end)) DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_records_report_day ON dmarc_records (report_day)
    `);
    // Also serves lookups by report_id alone (its leading column).
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_records_report_source ON dmarc_records (report_id, source_ip)
    `);
    // Source-centric aggregation reads records by sending address.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_records_source_ip ON dmarc_records (source_ip)
    `);

    // Create TLSRPT reports table (RFC 8460)
    await client.query(`
      CREATE TABLE IF NOT EXISTS tlsrpt_reports (
        id SERIAL PRIMARY KEY,
        report_id VARCHAR(255) NOT NULL,
        organization_name VARCHAR(255),
        contact_info VARCHAR(255),
        date_begin TIMESTAMP NOT NULL,
        date_end TIMESTAMP NOT NULL,
        total_success INTEGER DEFAULT 0,
        total_failure INTEGER DEFAULT 0,
        raw_payload JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(report_id)
      )
    `);

    // Create TLSRPT policies table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tlsrpt_policies (
        id SERIAL PRIMARY KEY,
        report_id INTEGER NOT NULL REFERENCES tlsrpt_reports(id) ON DELETE CASCADE,
        policy_type VARCHAR(50) NOT NULL,
        policy_domain VARCHAR(255) NOT NULL,
        policy_string TEXT[],
        mx_host VARCHAR(255),
        success_count INTEGER DEFAULT 0,
        failure_count INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create TLSRPT failure details table
    await client.query(`
      CREATE TABLE IF NOT EXISTS tlsrpt_failures (
        id SERIAL PRIMARY KEY,
        policy_id INTEGER NOT NULL REFERENCES tlsrpt_policies(id) ON DELETE CASCADE,
        result_type VARCHAR(50) NOT NULL,
        sending_mta_ip VARCHAR(45),
        receiving_mx_hostname VARCHAR(255),
        receiving_mx_helo VARCHAR(255),
        receiving_ip VARCHAR(45),
        failed_session_count INTEGER DEFAULT 1,
        failure_reason_code VARCHAR(100),
        additional_info TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create Forensic reports table (RFC 6591 AFRF)
    await client.query(`
      CREATE TABLE IF NOT EXISTS forensic_reports (
        id SERIAL PRIMARY KEY,
        message_fingerprint VARCHAR(64),
        feedback_type VARCHAR(50) NOT NULL,
        user_agent VARCHAR(255),
        version VARCHAR(10),
        original_mail_from VARCHAR(255),
        original_rcpt_to VARCHAR(255),
        received_date TIMESTAMP,
        source_ip VARCHAR(45),
        reported_domain VARCHAR(255),
        auth_failure VARCHAR(50),
        authentication_results TEXT,
        delivery_result VARCHAR(50),
        incidents INTEGER DEFAULT 1,
        reported_uri TEXT[],
        original_envelope_id VARCHAR(255),
        dkim_domain VARCHAR(255),
        dkim_selector VARCHAR(100),
        dkim_identity VARCHAR(255),
        spf_dns VARCHAR(255),
        subject TEXT,
        arrival_date TIMESTAMP,
        original_headers TEXT,
        raw_payload JSONB,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Create Robin metrics history table
    await client.query(`
      CREATE TABLE IF NOT EXISTS robin_metrics_history (
        id SERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL
          CONSTRAINT robin_metrics_history_fleet_service_id_fkey
          REFERENCES fleet_services(id) ON DELETE CASCADE,
        service_id VARCHAR(64) NOT NULL
          CONSTRAINT robin_metrics_history_service_id_fkey
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        timestamp TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        -- Email counters (cumulative)
        email_receipt_start BIGINT DEFAULT 0,
        email_receipt_success BIGINT DEFAULT 0,
        email_receipt_limit BIGINT DEFAULT 0,
        email_receipt_exception BIGINT DEFAULT 0,
        -- Rejection counters
        rbl_rejections BIGINT DEFAULT 0,
        virus_rejections BIGINT DEFAULT 0,
        spam_rejections BIGINT DEFAULT 0,
        -- DoS protection counters
        dos_ratelimit_rejections BIGINT DEFAULT 0,
        dos_connlimit_rejections BIGINT DEFAULT 0,
        dos_tarpit_count BIGINT DEFAULT 0,
        dos_slowtransfer_rejections BIGINT DEFAULT 0,
        dos_commandflood_rejections BIGINT DEFAULT 0,
        -- Other counters
        whitelist_bypasses BIGINT DEFAULT 0,
        adaptive_ratelimit_applied BIGINT DEFAULT 0,
        geoip_block_rejections BIGINT DEFAULT 0,
        geoip_limit_applied BIGINT DEFAULT 0,
        distributed_store_errors BIGINT DEFAULT 0,
        -- JVM Memory
        jvm_memory_used BIGINT DEFAULT 0,
        jvm_memory_max BIGINT DEFAULT 0,
        jvm_memory_committed BIGINT DEFAULT 0,
        -- JVM Threads
        jvm_threads_live INTEGER DEFAULT 0,
        jvm_threads_daemon INTEGER DEFAULT 0,
        jvm_threads_peak INTEGER DEFAULT 0,
        jvm_threads_started BIGINT DEFAULT 0,
        -- JVM GC
        jvm_gc_pause_seconds REAL DEFAULT 0,
        jvm_gc_pause_count BIGINT DEFAULT 0,
        jvm_gc_memory_allocated BIGINT DEFAULT 0,
        jvm_gc_memory_promoted BIGINT DEFAULT 0,
        jvm_gc_live_data_size BIGINT DEFAULT 0,
        jvm_gc_max_data_size BIGINT DEFAULT 0,
        -- JVM Buffers
        jvm_buffer_count INTEGER DEFAULT 0,
        jvm_buffer_memory_used BIGINT DEFAULT 0,
        jvm_buffer_total_capacity BIGINT DEFAULT 0,
        -- System metrics
        cpu_usage REAL DEFAULT 0,
        process_cpu_usage REAL DEFAULT 0,
        process_cpu_time_ns BIGINT DEFAULT 0,
        system_cpu_count INTEGER DEFAULT 0,
        system_load_average REAL DEFAULT 0,
        -- Calculated rates (per minute, computed from deltas)
        rate_email_start REAL DEFAULT 0,
        rate_email_success REAL DEFAULT 0,
        rate_rejections REAL DEFAULT 0
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS rspamd_metrics_history (
        id BIGSERIAL PRIMARY KEY,
        fleet_service_id INTEGER NOT NULL
          CONSTRAINT rspamd_metrics_history_fleet_service_id_fkey
          REFERENCES fleet_services(id) ON DELETE CASCADE,
        service_id VARCHAR(64) NOT NULL
          CONSTRAINT rspamd_metrics_history_service_id_fkey
          REFERENCES fleet_services(service_id) ON DELETE CASCADE ON UPDATE CASCADE,
        timestamp TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        controller_reachable BOOLEAN NOT NULL DEFAULT false,
        controller_authenticated BOOLEAN NOT NULL DEFAULT false,
        controller_status_code INTEGER,
        controller_ping_ok BOOLEAN NOT NULL DEFAULT false,
        controller_ping_status_code INTEGER,
        controller_healthy_ok BOOLEAN NOT NULL DEFAULT false,
        controller_healthy_status_code INTEGER,
        controller_stat_authenticated BOOLEAN NOT NULL DEFAULT false,
        controller_stat_status_code INTEGER,
        normal_worker_ping_ok BOOLEAN NOT NULL DEFAULT false,
        normal_worker_ping_status_code INTEGER,
        scanned_messages BIGINT NOT NULL DEFAULT 0,
        learned_spam BIGINT NOT NULL DEFAULT 0,
        learned_ham BIGINT NOT NULL DEFAULT 0,
        actions_add_header BIGINT NOT NULL DEFAULT 0,
        actions_reject BIGINT NOT NULL DEFAULT 0,
        actions_soft_reject BIGINT NOT NULL DEFAULT 0,
        actions_greylist BIGINT NOT NULL DEFAULT 0,
        actions_no_action BIGINT NOT NULL DEFAULT 0,
        actions_rewrite_subject BIGINT NOT NULL DEFAULT 0,
        actions_discard BIGINT NOT NULL DEFAULT 0,
        actions_quarantine BIGINT NOT NULL DEFAULT 0,
        spam_messages BIGINT NOT NULL DEFAULT 0,
        ham_messages BIGINT NOT NULL DEFAULT 0,
        connections BIGINT NOT NULL DEFAULT 0,
        uptime_seconds BIGINT NOT NULL DEFAULT 0,
        memory_allocated_bytes BIGINT NOT NULL DEFAULT 0,
        memory_resident_bytes BIGINT NOT NULL DEFAULT 0,
        raw_metrics JSONB NOT NULL DEFAULT '{}'::jsonb
      )
    `);

    // Create indexes
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_admin_id ON admin_audit_log(admin_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_entity ON admin_audit_log(entity_type, entity_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_audit_log_created_at ON admin_audit_log(created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_email_created_at ON admin_login_attempts(email, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_login_attempts_ip_created_at ON admin_login_attempts(ip_address, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_password_recovery_tokens_admin_id
      ON admin_password_recovery_tokens(admin_id, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_password_recovery_tokens_expires_at
      ON admin_password_recovery_tokens(expires_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_api_keys_key_hash ON admin_api_keys(key_hash)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_admin_api_keys_revoked_expires ON admin_api_keys(revoked_at, expires_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tlsrpt_reports_date ON tlsrpt_reports(date_begin, date_end)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tlsrpt_policies_report ON tlsrpt_policies(report_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tlsrpt_policies_domain ON tlsrpt_policies(policy_domain)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tlsrpt_policies_domain_report
      ON tlsrpt_policies(policy_domain, report_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_tlsrpt_failures_policy ON tlsrpt_failures(policy_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_reports_domain ON forensic_reports(reported_domain)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_reports_domain_received
      ON forensic_reports(reported_domain, (COALESCE(arrival_date, received_date, created_at)) DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_reports_date ON forensic_reports(received_date)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_reports_type ON forensic_reports(feedback_type, auth_failure)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_services_type_enabled ON fleet_services(service_type, enabled)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_service_secrets_service_type ON fleet_service_secrets(service_id, secret_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_fleet_service_sync_status_apply_status
      ON fleet_service_sync_status(last_apply_status, updated_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_robin_metrics_history_timestamp ON robin_metrics_history(timestamp)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_robin_metrics_history_service_timestamp
      ON robin_metrics_history(service_id, timestamp DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_robin_metrics_history_fleet_service_timestamp
      ON robin_metrics_history(fleet_service_id, timestamp DESC)
    `);
    // The next sample's process CPU usage is measured against this counter.
    await client.query(`ALTER TABLE robin_metrics_history ADD COLUMN IF NOT EXISTS process_cpu_time_ns BIGINT DEFAULT 0`);
    // Running Postfix message counters, fed by agent log pushes. Kept here,
    // not in server memory, so every replica adds to the same totals.
    await client.query(`
      CREATE TABLE IF NOT EXISTS postfix_message_counters (
        fleet_service_id INTEGER PRIMARY KEY
          REFERENCES fleet_services(id) ON DELETE CASCADE ON UPDATE CASCADE,
        messages_delivered BIGINT NOT NULL DEFAULT 0,
        messages_deferred BIGINT NOT NULL DEFAULT 0,
        messages_bounced BIGINT NOT NULL DEFAULT 0,
        messages_rejected BIGINT NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_metrics_history_timestamp ON rspamd_metrics_history(timestamp)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_metrics_history_service_timestamp
      ON rspamd_metrics_history(service_id, timestamp DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_metrics_history_fleet_service_timestamp
      ON rspamd_metrics_history(fleet_service_id, timestamp DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_dkim_selectors_domain_state
      ON rspamd_dkim_selectors(domain_id, state)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_training_jobs_status_created_at
      ON rspamd_training_jobs(status, created_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_training_samples_job_created_at
      ON rspamd_training_samples(job_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_scan_runs_service_created_at
      ON rspamd_scan_runs(service_id, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_scan_runs_hash_created_at
      ON rspamd_scan_runs(message_hash, created_at DESC)
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_rspamd_scan_actions_run_created_at
      ON rspamd_scan_actions(run_id, created_at DESC)
    `);

    // Create express-session table for persistent sessions
    await client.query(`
      CREATE TABLE IF NOT EXISTS "session" (
        "sid" VARCHAR NOT NULL COLLATE "default",
        "sess" JSON NOT NULL,
        "expire" TIMESTAMP(6) NOT NULL,
        PRIMARY KEY ("sid")
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_session_expire ON "session"("expire")
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_webhooks (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        adapter VARCHAR(16) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT false,
        encrypted_url TEXT,
        subscriptions_json JSONB NOT NULL DEFAULT '[]'::jsonb,
        consecutive_failures INTEGER NOT NULL DEFAULT 3,
        repeat_interval_seconds INTEGER,
        notify_recovery BOOLEAN NOT NULL DEFAULT true,
        paused_at TIMESTAMPTZ,
        paused_until TIMESTAMPTZ,
        pause_reason VARCHAR(500),
        created_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        updated_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_alert_webhook_adapter CHECK (adapter IN ('slack', 'generic', 'sentry')),
        CONSTRAINT valid_alert_webhook_failures CHECK (consecutive_failures BETWEEN 1 AND 20),
        CONSTRAINT valid_alert_webhook_repeat CHECK (repeat_interval_seconds IS NULL OR repeat_interval_seconds BETWEEN 300 AND 2592000),
        CONSTRAINT valid_alert_webhook_pause CHECK (paused_until IS NULL OR paused_at IS NOT NULL)
      )
    `);
    // Sentry destinations: the DSN is the encrypted URL; the organization, API
    // URL and token (all optional) let recoveries resolve the Sentry issue.
    await client.query(`
      ALTER TABLE alert_webhooks
        ADD COLUMN IF NOT EXISTS sentry_org VARCHAR(100),
        ADD COLUMN IF NOT EXISTS sentry_api_url VARCHAR(200),
        ADD COLUMN IF NOT EXISTS encrypted_sentry_token TEXT
    `);
    await client.query(`
      ALTER TABLE alert_webhooks DROP CONSTRAINT IF EXISTS valid_alert_webhook_adapter;
      ALTER TABLE alert_webhooks ADD CONSTRAINT valid_alert_webhook_adapter CHECK (adapter IN ('slack', 'generic', 'sentry'))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS fleet_service_observations (
        fleet_service_id INTEGER PRIMARY KEY REFERENCES fleet_services(id) ON DELETE CASCADE,
        observation_key VARCHAR(160) NOT NULL,
        observed_at TIMESTAMPTZ NOT NULL,
        reachable BOOLEAN,
        error_code VARCHAR(64),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_targets (
        id SERIAL PRIMARY KEY,
        name VARCHAR(160) NOT NULL,
        target_type VARCHAR(24) NOT NULL DEFAULT 'host',
        environment VARCHAR(40) NOT NULL DEFAULT 'production',
        description TEXT,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_monitoring_target_type CHECK (target_type IN ('host', 'endpoint'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_targets_enabled
      ON monitoring_targets (enabled, name)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_checks (
        id SERIAL PRIMARY KEY,
        target_id INTEGER NOT NULL REFERENCES monitoring_targets(id) ON DELETE CASCADE,
        name VARCHAR(160) NOT NULL,
        check_type VARCHAR(16) NOT NULL,
        endpoint VARCHAR(500) NOT NULL,
        port INTEGER,
        interval_seconds INTEGER NOT NULL DEFAULT 60,
        timeout_seconds INTEGER NOT NULL DEFAULT 10,
        confirmation_seconds INTEGER NOT NULL DEFAULT 180,
        recovery_seconds INTEGER NOT NULL DEFAULT 180,
        placement_mode VARCHAR(12) NOT NULL DEFAULT 'all',
        location_ids INTEGER[] NOT NULL DEFAULT '{}',
        quorum INTEGER NOT NULL DEFAULT 0,
        cert_expiry_days INTEGER,
        tls_mode VARCHAR(24) NOT NULL DEFAULT 'strict',
        certificate_error_mode VARCHAR(16) NOT NULL DEFAULT 'down',
        allow_private BOOLEAN NOT NULL DEFAULT false,
        options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        encrypted_headers TEXT,
        secret_header_names JSONB NOT NULL DEFAULT '[]'::jsonb,
        enabled BOOLEAN NOT NULL DEFAULT true,
        paused_at TIMESTAMPTZ,
        pause_reason VARCHAR(500),
        current_status VARCHAR(16) NOT NULL DEFAULT 'unknown',
        status_since TIMESTAMPTZ,
        last_run_at TIMESTAMPTZ,
        next_run_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_response_time_ms INTEGER,
        last_error VARCHAR(500),
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        consecutive_successes INTEGER NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_monitoring_check_type CHECK (check_type IN ('http', 'tcp', 'dns', 'smtp', 'imap', 'push')),
        CONSTRAINT valid_monitoring_check_status CHECK (current_status IN ('unknown', 'up', 'down', 'warning')),
        CONSTRAINT valid_monitoring_check_port CHECK (port IS NULL OR port BETWEEN 1 AND 65535),
        CONSTRAINT valid_monitoring_check_interval CHECK (interval_seconds BETWEEN 10 AND 86400),
        CONSTRAINT valid_monitoring_check_timeout CHECK (timeout_seconds BETWEEN 1 AND 120),
        CONSTRAINT valid_monitoring_check_confirmation CHECK (confirmation_seconds BETWEEN 0 AND 86400),
        CONSTRAINT valid_monitoring_check_recovery CHECK (recovery_seconds BETWEEN 0 AND 86400),
        CONSTRAINT valid_monitoring_check_placement CHECK (placement_mode IN ('all', 'selected')),
        CONSTRAINT valid_monitoring_check_quorum CHECK (quorum BETWEEN 0 AND 128),
        CONSTRAINT valid_monitoring_check_cert_expiry CHECK (cert_expiry_days IS NULL OR cert_expiry_days BETWEEN 1 AND 365),
        CONSTRAINT valid_monitoring_check_tls_mode CHECK (tls_mode IN ('strict', 'allow_self_signed')),
        CONSTRAINT valid_monitoring_check_certificate_error_mode CHECK (certificate_error_mode IN ('down', 'warning'))
      )
    `);
    const privateColumnBeforeMigration = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'monitoring_checks' AND column_name = 'allow_private'
       ) AS present`
    );
    const monitoringPrivateColumnExisted = privateColumnBeforeMigration.rows[0]?.present === true;
    await client.query(`ALTER TABLE monitoring_checks
      ADD COLUMN IF NOT EXISTS allow_private BOOLEAN NOT NULL DEFAULT true,
      ADD COLUMN IF NOT EXISTS options_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      ADD COLUMN IF NOT EXISTS encrypted_headers TEXT,
      ADD COLUMN IF NOT EXISTS secret_header_names JSONB NOT NULL DEFAULT '[]'::jsonb,
      ADD COLUMN IF NOT EXISTS placement_mode VARCHAR(12) NOT NULL DEFAULT 'all',
      ADD COLUMN IF NOT EXISTS location_ids INTEGER[] NOT NULL DEFAULT '{}',
      ADD COLUMN IF NOT EXISTS quorum INTEGER NOT NULL DEFAULT 0,
      ADD COLUMN IF NOT EXISTS certificate_error_mode VARCHAR(16) NOT NULL DEFAULT 'warning'`);
     await client.query(`ALTER TABLE monitoring_checks DROP CONSTRAINT IF EXISTS valid_monitoring_check_placement`);
     await client.query(`ALTER TABLE monitoring_checks ADD CONSTRAINT valid_monitoring_check_placement CHECK (placement_mode IN ('all', 'selected'))`);
     await client.query(`ALTER TABLE monitoring_checks DROP CONSTRAINT IF EXISTS valid_monitoring_check_quorum`);
     await client.query(`ALTER TABLE monitoring_checks ADD CONSTRAINT valid_monitoring_check_quorum CHECK (quorum BETWEEN 0 AND 128)`);
    await client.query(`ALTER TABLE monitoring_checks ALTER COLUMN certificate_error_mode SET DEFAULT 'down'`);
    await client.query(`ALTER TABLE monitoring_checks DROP CONSTRAINT IF EXISTS valid_monitoring_check_certificate_error_mode`);
    await client.query(`ALTER TABLE monitoring_checks ADD CONSTRAINT valid_monitoring_check_certificate_error_mode
      CHECK (certificate_error_mode IN ('down', 'warning'))`);
    await client.query(`ALTER TABLE monitoring_checks ALTER COLUMN allow_private SET DEFAULT false`);
    const checkMigration = await client.query<{ value: string }>(
      `SELECT value FROM admin_config WHERE key = 'migration:monitoring-check-upgrade-v1'`
    );
    if (!checkMigration.rows[0]) {
      const privateChecks = monitoringPrivateColumnExisted
        ? { rows: [] as Array<{ id: number }> }
        : await client.query<{ id: number }>('SELECT id FROM monitoring_checks WHERE allow_private = true ORDER BY id');
      const plaintextChecks = await client.query<{ id: number }>(
        `UPDATE monitoring_checks
         SET tls_mode = 'strict', cert_expiry_days = NULL
        WHERE (cert_expiry_days IS NOT NULL OR tls_mode <> 'strict')
           AND (
             (check_type = 'http' AND endpoint NOT ILIKE 'https://%')
             OR (check_type = 'tcp' AND COALESCE(options_json->'tcp'->>'tls', 'false') <> 'true')
             OR (check_type = 'smtp' AND COALESCE(port, 25) <> 465)
             OR check_type = 'dns'
           )
         RETURNING id`
      );
      if (privateChecks.rows.length || plaintextChecks.rows.length) {
        await client.query(
          `INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, old_values, new_values)
           VALUES (NULL, 'monitoring.legacy_checks_migrated', 'monitoring_check', NULL, NULL, $1::jsonb)`,
          [JSON.stringify({
            allowPrivateCheckIds: privateChecks.rows.map(row => row.id),
            resetTlsCheckIds: plaintextChecks.rows.map(row => row.id),
          })]
        );
      }
      await client.query(
        `INSERT INTO admin_config (key, value) VALUES ('migration:monitoring-check-upgrade-v1', 'complete')
         ON CONFLICT (key) DO NOTHING`
      );
    }
    await client.query(`ALTER TABLE monitoring_checks DROP CONSTRAINT IF EXISTS valid_monitoring_check_type`);
    await client.query(`UPDATE monitoring_checks SET check_type = 'http' WHERE check_type = 'https'`);
    await client.query(`ALTER TABLE monitoring_checks ADD CONSTRAINT valid_monitoring_check_type
      CHECK (check_type IN ('http', 'tcp', 'dns', 'smtp', 'imap', 'push'))`);
    // Push checks: a secret ping URL (hash for lookup, encrypted to show admins
    // again) and the last ping. Their interval can be up to 30 days (weekly jobs).
    await client.query(`
      ALTER TABLE monitoring_checks
        ADD COLUMN IF NOT EXISTS push_token_hash VARCHAR(64),
        ADD COLUMN IF NOT EXISTS encrypted_push_token TEXT,
        ADD COLUMN IF NOT EXISTS last_ping_at TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS last_ping_status VARCHAR(8)
    `);
    await client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_monitoring_checks_push_token
      ON monitoring_checks (push_token_hash) WHERE push_token_hash IS NOT NULL`);
    await client.query(`ALTER TABLE monitoring_checks DROP CONSTRAINT IF EXISTS valid_monitoring_check_interval`);
    await client.query(`ALTER TABLE monitoring_checks ADD CONSTRAINT valid_monitoring_check_interval
      CHECK (interval_seconds BETWEEN 10 AND 2592000)`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_checks_due
      ON monitoring_checks (enabled, paused_at, next_run_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_checks_target
      ON monitoring_checks (target_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_locations (
        id SERIAL PRIMARY KEY,
        location_key VARCHAR(160) NOT NULL UNIQUE,
        name VARCHAR(100) NOT NULL,
        region VARCHAR(100),
        location_type VARCHAR(12) NOT NULL DEFAULT 'remote',
        agent_id VARCHAR(64) UNIQUE REFERENCES fleet_agents(agent_id) ON DELETE CASCADE ON UPDATE CASCADE,
        enabled BOOLEAN NOT NULL DEFAULT true,
        probe_concurrency INTEGER NOT NULL DEFAULT 4,
        last_seen_at TIMESTAMPTZ,
        agent_version VARCHAR(64),
        protocol_version INTEGER,
        clock_offset_ms INTEGER,
        manifest_revision INTEGER NOT NULL DEFAULT 0,
        previous_manifest_revision INTEGER,
        manifest_sha256 VARCHAR(64),
        manifest_updated_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_monitoring_location_type CHECK (location_type IN ('local', 'remote')),
        CONSTRAINT valid_monitoring_location_identity CHECK (
          (location_type = 'local' AND location_key = 'local' AND agent_id IS NULL)
          OR (location_type = 'remote' AND agent_id IS NOT NULL)
        ),
        CONSTRAINT valid_monitoring_location_concurrency CHECK (probe_concurrency BETWEEN 1 AND 128)
      )
    `);
    await client.query(`ALTER TABLE monitoring_locations ADD COLUMN IF NOT EXISTS manifest_revision INTEGER NOT NULL DEFAULT 0`);
    await client.query(`ALTER TABLE monitoring_locations ADD COLUMN IF NOT EXISTS previous_manifest_revision INTEGER`);
    await client.query(`ALTER TABLE monitoring_locations ADD COLUMN IF NOT EXISTS manifest_sha256 VARCHAR(64)`);
    await client.query(`ALTER TABLE monitoring_locations ADD COLUMN IF NOT EXISTS manifest_updated_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE monitoring_locations ADD COLUMN IF NOT EXISTS shadow BOOLEAN NOT NULL DEFAULT false`);
    // Remote locations that predate shadow mode (including builds that had the column but defaulted it to false)
    // start shadowed once, so they cannot change alerting or receive secrets until promoted.
    const shadowMigration = await client.query(`SELECT 1 FROM admin_config WHERE key = 'migration:monitoring-location-shadow-v1'`);
    if (!shadowMigration.rowCount) {
      await client.query(`UPDATE monitoring_locations SET shadow = true WHERE location_type = 'remote'`);
      await client.query(`INSERT INTO admin_config (key, value) VALUES ('migration:monitoring-location-shadow-v1', 'complete') ON CONFLICT (key) DO NOTHING`);
    }
    await client.query(`
      INSERT INTO monitoring_locations (location_key, name, region, location_type, enabled)
      VALUES ('local', 'Local', NULL, 'local', true)
      ON CONFLICT (location_key) DO NOTHING
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_probe_manifest_checks (
        location_id INTEGER NOT NULL REFERENCES monitoring_locations(id) ON DELETE CASCADE,
        manifest_revision INTEGER NOT NULL,
        check_id INTEGER NOT NULL REFERENCES monitoring_checks(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (location_id, manifest_revision, check_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_heartbeats (
        id SERIAL PRIMARY KEY,
        name VARCHAR(100) NOT NULL,
        encrypted_ping_url TEXT NOT NULL,
        encrypted_failure_url TEXT,
        interval_seconds INTEGER NOT NULL DEFAULT 60,
        minimum_fresh_locations INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT true,
        last_attempt_at TIMESTAMPTZ,
        last_result VARCHAR(24),
        last_reason VARCHAR(32),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_monitoring_heartbeat_interval CHECK (interval_seconds BETWEEN 15 AND 3600)
      )
    `);
    await client.query(`ALTER TABLE monitoring_heartbeats
      ADD COLUMN IF NOT EXISTS minimum_fresh_locations INTEGER NOT NULL DEFAULT 0`);
    // 'generic' POSTs {status, reason}; 'sentry_crons' sends Sentry Cron check-ins.
    await client.query(`ALTER TABLE monitoring_heartbeats
      ADD COLUMN IF NOT EXISTS format VARCHAR(16) NOT NULL DEFAULT 'generic'`);
    await client.query(`ALTER TABLE monitoring_heartbeats DROP CONSTRAINT IF EXISTS valid_monitoring_heartbeat_format`);
    await client.query(`ALTER TABLE monitoring_heartbeats ADD CONSTRAINT valid_monitoring_heartbeat_format
      CHECK (format IN ('generic', 'sentry_crons'))`);
    await client.query(`ALTER TABLE monitoring_heartbeats DROP CONSTRAINT IF EXISTS valid_monitoring_heartbeat_minimum_locations`);
    await client.query(`ALTER TABLE monitoring_heartbeats ADD CONSTRAINT valid_monitoring_heartbeat_minimum_locations
      CHECK (minimum_fresh_locations BETWEEN 0 AND 128)`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_observations (
        id BIGSERIAL PRIMARY KEY,
        check_id INTEGER NOT NULL REFERENCES monitoring_checks(id) ON DELETE CASCADE,
        location_id INTEGER REFERENCES monitoring_locations(id) ON DELETE SET NULL,
        status VARCHAR(16) NOT NULL,
        error_code VARCHAR(64),
        response_time_ms INTEGER,
        error VARCHAR(500),
        details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        manifest_revision INTEGER,
        started_at TIMESTAMPTZ,
        received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        observed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_monitoring_observation_status CHECK (status IN ('up', 'down', 'warning')),
        CONSTRAINT valid_monitoring_observation_response_time CHECK (response_time_ms IS NULL OR response_time_ms >= 0)
      )
    `);
    // Observations recorded before probe locations existed all came from the Admin server; attribute them once, when the column is first added.
    const hadObservationLocation = (await client.query(`SELECT 1 FROM information_schema.columns WHERE table_schema = current_schema() AND table_name = 'monitoring_observations' AND column_name = 'location_id'`)).rowCount! > 0;
    await client.query(`ALTER TABLE monitoring_observations ADD COLUMN IF NOT EXISTS location_id INTEGER REFERENCES monitoring_locations(id) ON DELETE SET NULL`);
    if (!hadObservationLocation) {
      // Backfilled in batches after commit, up to the highest id present now, so the transaction does not hold a long write lock.
      await client.query(
        `INSERT INTO admin_config (key, value)
         SELECT 'migration:monitoring-observation-location-backfill-v1', 'pending:' || COALESCE(MAX(id), 0) FROM monitoring_observations
         ON CONFLICT (key) DO NOTHING`,
      );
    }
    await client.query(`ALTER TABLE monitoring_observations ADD COLUMN IF NOT EXISTS error_code VARCHAR(64)`);
    await client.query(`ALTER TABLE monitoring_observations ADD COLUMN IF NOT EXISTS manifest_revision INTEGER`);
    await client.query(`ALTER TABLE monitoring_observations ADD COLUMN IF NOT EXISTS started_at TIMESTAMPTZ`);
    await client.query(`ALTER TABLE monitoring_observations ADD COLUMN IF NOT EXISTS received_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_location_daily (
        check_id INTEGER NOT NULL REFERENCES monitoring_checks(id) ON DELETE CASCADE,
        location_id INTEGER NOT NULL REFERENCES monitoring_locations(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        up_count INTEGER NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0,
        down_count INTEGER NOT NULL DEFAULT 0,
        unavailable_warning_count INTEGER NOT NULL DEFAULT 0,
        response_time_sum BIGINT NOT NULL DEFAULT 0,
        response_time_count INTEGER NOT NULL DEFAULT 0,
        response_time_max INTEGER,
        PRIMARY KEY (check_id, location_id, day)
      )
    `);
    await client.query(`ALTER TABLE monitoring_location_daily
      ADD COLUMN IF NOT EXISTS unavailable_warning_count INTEGER NOT NULL DEFAULT 0`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_observations_check_time
      ON monitoring_observations (check_id, observed_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_observations_location_time
      ON monitoring_observations (location_id, observed_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_observations_recent
      ON monitoring_observations (observed_at DESC, id DESC)
    `);
    // One row per check and UTC day, maintained with each observation, so
    // availability history outlives pruned raw observations.
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_check_daily (
        check_id INTEGER NOT NULL REFERENCES monitoring_checks(id) ON DELETE CASCADE,
        day DATE NOT NULL,
        up_count INTEGER NOT NULL DEFAULT 0,
        warning_count INTEGER NOT NULL DEFAULT 0,
        down_count INTEGER NOT NULL DEFAULT 0,
        unavailable_warning_count INTEGER NOT NULL DEFAULT 0,
        response_time_sum BIGINT NOT NULL DEFAULT 0,
        response_time_count INTEGER NOT NULL DEFAULT 0,
        response_time_max INTEGER,
        PRIMARY KEY (check_id, day)
      )
    `);
    await client.query(`ALTER TABLE monitoring_check_daily
      ADD COLUMN IF NOT EXISTS unavailable_warning_count INTEGER NOT NULL DEFAULT 0`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_check_daily_day
      ON monitoring_check_daily (day)
    `);

    // Dashboards are created explicitly by operators; startup never seeds them.
    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetry_dashboards (
        id SERIAL PRIMARY KEY,
        uid VARCHAR(40) NOT NULL UNIQUE,
        title VARCHAR(120) NOT NULL,
        description VARCHAR(500) NOT NULL DEFAULT '',
        content JSONB NOT NULL,
        template_key VARCHAR(40),
        position INTEGER NOT NULL DEFAULT 0,
        version INTEGER NOT NULL DEFAULT 1,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_by VARCHAR(255)
      )
    `);
    // Hash of the template content the dashboard was last set from, so the UI
    // can say when a newer default is available.
    await client.query(`ALTER TABLE telemetry_dashboards ADD COLUMN IF NOT EXISTS template_hash VARCHAR(64)`);
    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetry_dashboard_versions (
        dashboard_id INTEGER NOT NULL REFERENCES telemetry_dashboards(id) ON DELETE CASCADE,
        version INTEGER NOT NULL,
        title VARCHAR(120) NOT NULL,
        description VARCHAR(500) NOT NULL DEFAULT '',
        content JSONB NOT NULL,
        saved_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        saved_by VARCHAR(255),
        PRIMARY KEY (dashboard_id, version)
      )
    `);
    if (!discoverySeed.rows[0]) {
      const savedDiscovery = await client.query<{ key: string }>(
        'SELECT key FROM admin_config WHERE key = ANY($1::text[]) LIMIT 1',
        [Object.keys(DISCOVERY_DEFAULTS)]
      );
      if (hadPriorTelemetryState && !savedDiscovery.rows.length) {
        const previousDefaults = {
          telemetrySourceLabel: 'host',
          telemetryGroupLabel: 'role',
          telemetrySourceSelector: DISCOVERY_DEFAULTS.telemetrySourceSelector,
        };
        await client.query(
          `INSERT INTO admin_config (key, value, updated_at)
           SELECT key, value, CURRENT_TIMESTAMP FROM UNNEST($1::text[], $2::text[]) AS settings(key, value)
           ON CONFLICT (key) DO NOTHING`,
          [Object.keys(previousDefaults), Object.values(previousDefaults)]
        );
        logger.info('Preserved legacy telemetry discovery labels during upgrade');
      }
      await client.query(
        `INSERT INTO admin_config (key, value) VALUES ('migration:telemetry-discovery-defaults-v1', 'complete')
         ON CONFLICT (key) DO NOTHING`
      );
    }
    await client.query(`DROP TABLE IF EXISTS telemetry_seeded_templates`);
    await client.query(`
      UPDATE telemetry_dashboards SET template_key = NULL, template_hash = NULL
      WHERE template_key IS NOT NULL AND NOT (template_key = ANY($1::text[]))
    `, [TEMPLATES.map(template => template.key)]);

    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_issues (
        id BIGSERIAL PRIMARY KEY,
        check_id INTEGER NOT NULL REFERENCES monitoring_checks(id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        severity VARCHAR(16) NOT NULL DEFAULT 'critical',
        summary VARCHAR(255) NOT NULL,
        details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_monitoring_issue_status CHECK (status IN ('open', 'closed')),
        CONSTRAINT valid_monitoring_issue_severity CHECK (severity IN ('warning', 'critical')),
        CONSTRAINT valid_monitoring_issue_close CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_monitoring_one_open_issue
      ON monitoring_issues (check_id)
      WHERE status = 'open'
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_monitoring_issues_status_time
      ON monitoring_issues (status, opened_at DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS monitoring_location_issues (
        id BIGSERIAL PRIMARY KEY,
        location_id INTEGER NOT NULL REFERENCES monitoring_locations(id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        summary VARCHAR(255) NOT NULL,
        details_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        closed_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_monitoring_location_issue_status CHECK (status IN ('open', 'closed')),
        CONSTRAINT valid_monitoring_location_issue_close CHECK ((status = 'open' AND closed_at IS NULL) OR (status = 'closed' AND closed_at IS NOT NULL))
      )
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_monitoring_one_open_location_issue
      ON monitoring_location_issues (location_id) WHERE status = 'open'
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_settings (
        id INTEGER PRIMARY KEY DEFAULT 1,
        company_name VARCHAR(160) NOT NULL DEFAULT 'Service Status',
        company_url VARCHAR(500),
        logo_url VARCHAR(500),
        custom_domain VARCHAR(255),
        published BOOLEAN NOT NULL DEFAULT false,
        history_days INTEGER NOT NULL DEFAULT 30,
        timezone VARCHAR(80) NOT NULL DEFAULT 'UTC',
        theme VARCHAR(16) NOT NULL DEFAULT 'system',
        announcement TEXT,
        subscribable BOOLEAN NOT NULL DEFAULT false,
        incident_history_enabled BOOLEAN NOT NULL DEFAULT true,
        maintenance_page_enabled BOOLEAN NOT NULL DEFAULT true,
        feeds_enabled BOOLEAN NOT NULL DEFAULT true,
        incident_grouping_minutes INTEGER NOT NULL DEFAULT 15,
        home_incident_days INTEGER NOT NULL DEFAULT 7,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT status_page_settings_singleton CHECK (id = 1),
        CONSTRAINT valid_status_page_history CHECK (history_days BETWEEN 1 AND 365),
        CONSTRAINT valid_status_page_theme CHECK (theme IN ('system', 'light', 'dark')),
        CONSTRAINT valid_status_page_incident_grouping CHECK (incident_grouping_minutes BETWEEN 0 AND 1440),
        CONSTRAINT valid_status_page_home_incident_days CHECK (home_incident_days BETWEEN 0 AND 90)
      )
    `);
    await client.query(`
      ALTER TABLE status_page_settings
        ADD COLUMN IF NOT EXISTS incident_history_enabled BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS maintenance_page_enabled BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS feeds_enabled BOOLEAN NOT NULL DEFAULT true,
        ADD COLUMN IF NOT EXISTS incident_grouping_minutes INTEGER NOT NULL DEFAULT 15,
        ADD COLUMN IF NOT EXISTS home_incident_days INTEGER NOT NULL DEFAULT 7
    `);
    await client.query(`
      DO $$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_status_page_incident_grouping') THEN
          ALTER TABLE status_page_settings ADD CONSTRAINT valid_status_page_incident_grouping CHECK (incident_grouping_minutes BETWEEN 0 AND 1440);
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'valid_status_page_home_incident_days') THEN
          ALTER TABLE status_page_settings ADD CONSTRAINT valid_status_page_home_incident_days CHECK (home_incident_days BETWEEN 0 AND 90);
        END IF;
      END $$
    `);
    await client.query(`ALTER TABLE status_page_settings ALTER COLUMN company_name SET DEFAULT 'Service Status'`);
    await client.query(`ALTER TABLE status_page_settings ALTER COLUMN published SET DEFAULT false`);
    await client.query(`INSERT INTO status_page_settings (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_sections (
        id SERIAL PRIMARY KEY,
        name VARCHAR(160) NOT NULL UNIQUE,
        position INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_page_sections_position
      ON status_page_sections (enabled, position, id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_components (
        id SERIAL PRIMARY KEY,
        section_id INTEGER NOT NULL REFERENCES status_page_sections(id) ON DELETE CASCADE,
        public_name VARCHAR(180) NOT NULL UNIQUE,
        description TEXT,
        position INTEGER NOT NULL DEFAULT 0,
        enabled BOOLEAN NOT NULL DEFAULT true,
        show_history BOOLEAN NOT NULL DEFAULT true,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_page_components_section
      ON status_page_components (section_id, enabled, position, id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_component_checks (
        component_id INTEGER NOT NULL REFERENCES status_page_components(id) ON DELETE CASCADE,
        check_id INTEGER NOT NULL REFERENCES monitoring_checks(id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (component_id, check_id)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_page_component_checks_check
      ON status_page_component_checks (check_id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_reports (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'open',
        impact VARCHAR(16) NOT NULL,
        source VARCHAR(16) NOT NULL DEFAULT 'manual',
        opened_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        resolved_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_status_page_report_status CHECK (status IN ('open', 'resolved')),
        CONSTRAINT valid_status_page_report_impact CHECK (impact IN ('degraded', 'outage', 'maintenance')),
        CONSTRAINT valid_status_page_report_source CHECK (source IN ('automatic', 'manual', 'imported')),
        CONSTRAINT valid_status_page_report_resolution CHECK ((status = 'open' AND resolved_at IS NULL) OR (status = 'resolved' AND resolved_at IS NOT NULL))
      )
    `);
    await syncTypeListConstraint(client, 'status_page_reports', 'valid_status_page_report_source', 'source', STATUS_PAGE_REPORT_SOURCES);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_page_reports_time
      ON status_page_reports (status, opened_at DESC, id DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_page_reports_opened
      ON status_page_reports (opened_at DESC, id DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_report_issues (
        report_id BIGINT NOT NULL REFERENCES status_page_reports(id) ON DELETE CASCADE,
        monitoring_issue_id BIGINT NOT NULL UNIQUE REFERENCES monitoring_issues(id) ON DELETE CASCADE,
        PRIMARY KEY (report_id, monitoring_issue_id)
      )
    `);
    // Issues of a deleted automatic incident, so the sync never recreates it.
    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_dismissed_issues (
        monitoring_issue_id BIGINT PRIMARY KEY REFERENCES monitoring_issues(id) ON DELETE CASCADE,
        dismissed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    // Reports used to hold a single monitoring_issue_id; move those links to
    // the join table and drop the column.
    const reportIssueColumn = await client.query<{ present: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = 'status_page_reports' AND column_name = 'monitoring_issue_id'
       ) AS present`
    );
    if (reportIssueColumn.rows[0]?.present) {
      await client.query(`
        INSERT INTO status_page_report_issues (report_id, monitoring_issue_id)
        SELECT id, monitoring_issue_id FROM status_page_reports WHERE monitoring_issue_id IS NOT NULL
        ON CONFLICT DO NOTHING
      `);
      await client.query(`ALTER TABLE status_page_reports DROP COLUMN monitoring_issue_id`);
    }

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_report_components (
        report_id BIGINT NOT NULL REFERENCES status_page_reports(id) ON DELETE CASCADE,
        component_id INTEGER NOT NULL REFERENCES status_page_components(id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL,
        PRIMARY KEY (report_id, component_id),
        CONSTRAINT valid_status_page_report_component_status CHECK (status IN ('operational', 'degraded', 'outage', 'maintenance', 'unknown'))
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_report_updates (
        id BIGSERIAL PRIMARY KEY,
        report_id BIGINT NOT NULL REFERENCES status_page_reports(id) ON DELETE CASCADE,
        status VARCHAR(16) NOT NULL,
        message TEXT NOT NULL,
        event_keys TEXT[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_status_page_update_status CHECK (status IN ('investigating', 'identified', 'monitoring', 'resolved'))
      )
    `);
    await client.query(`ALTER TABLE status_page_report_updates ADD COLUMN IF NOT EXISTS event_keys TEXT[] NOT NULL DEFAULT '{}'`);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_page_report_updates_report
      ON status_page_report_updates (report_id, created_at ASC, id ASC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_maintenances (
        id BIGSERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'scheduled',
        starts_at TIMESTAMPTZ NOT NULL,
        ends_at TIMESTAMPTZ NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_status_page_maintenance_status CHECK (status IN ('scheduled', 'active', 'completed', 'cancelled')),
        CONSTRAINT valid_status_page_maintenance_window CHECK (ends_at > starts_at)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_page_maintenances_time
      ON status_page_maintenances (status, starts_at, ends_at)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_maintenance_components (
        maintenance_id BIGINT NOT NULL REFERENCES status_page_maintenances(id) ON DELETE CASCADE,
        component_id INTEGER NOT NULL REFERENCES status_page_components(id) ON DELETE CASCADE,
        PRIMARY KEY (maintenance_id, component_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_relays (
        id SERIAL PRIMARY KEY,
        name VARCHAR(160) NOT NULL UNIQUE,
        relay_type VARCHAR(16) NOT NULL,
        enabled BOOLEAN NOT NULL DEFAULT true,
        priority INTEGER NOT NULL DEFAULT 100,
        smtp_host VARCHAR(255),
        smtp_port INTEGER,
        smtp_security VARCHAR(16) NOT NULL DEFAULT 'starttls',
        tls_mode VARCHAR(24) NOT NULL DEFAULT 'strict',
        username VARCHAR(255),
        encrypted_password TEXT,
        robin_service_id VARCHAR(120),
        postfix_service_id VARCHAR(120),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_email_relay_type CHECK (relay_type IN ('smtp', 'robin', 'postfix')),
        CONSTRAINT valid_email_relay_smtp_port CHECK (smtp_port IS NULL OR smtp_port BETWEEN 1 AND 65535),
        CONSTRAINT valid_email_relay_security CHECK (smtp_security IN ('none', 'starttls', 'tls')),
        CONSTRAINT valid_email_relay_tls_mode CHECK (tls_mode IN ('strict', 'allow_self_signed'))
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_relays_enabled_priority
      ON email_relays (enabled, priority, id)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_sender_profiles (
        profile_key VARCHAR(24) PRIMARY KEY,
        display_name VARCHAR(120) NOT NULL,
        from_name VARCHAR(160) NOT NULL,
        from_email VARCHAR(255) NOT NULL,
        reply_to VARCHAR(255),
        envelope_from VARCHAR(255),
        enabled BOOLEAN NOT NULL DEFAULT true,
        relay_ids INTEGER[] NOT NULL DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_email_sender_profile_key CHECK (profile_key IN ('system', 'alerts', 'status'))
      )
    `);
    await client.query(`
      INSERT INTO email_sender_profiles (profile_key, display_name, from_name, from_email)
      VALUES
        ('system', 'System', 'Robin Admin', 'no-reply@localhost'),
        ('alerts', 'Alerts', 'Robin Admin Alerts', 'alerts@localhost'),
        ('status', 'Status page', 'Status Page', 'status@localhost')
      ON CONFLICT (profile_key) DO NOTHING
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS admin_email_subscriptions (
        admin_id INTEGER PRIMARY KEY REFERENCES admins(id) ON DELETE CASCADE,
        monitoring_issue_opened BOOLEAN NOT NULL DEFAULT false,
        monitoring_issue_recovered BOOLEAN NOT NULL DEFAULT false,
        status_page_reports BOOLEAN NOT NULL DEFAULT false,
        email_delivery_failure BOOLEAN NOT NULL DEFAULT false,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_subscribers (
        id BIGSERIAL PRIMARY KEY,
        email VARCHAR(255) UNIQUE NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        all_components BOOLEAN NOT NULL DEFAULT true,
        token_hash VARCHAR(64) UNIQUE,
        unsubscribe_hash VARCHAR(64) UNIQUE NOT NULL,
        confirmed_at TIMESTAMPTZ,
        unsubscribed_at TIMESTAMPTZ,
        last_notified_at TIMESTAMPTZ,
        confirmation_sent_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_status_page_subscriber_status CHECK (status IN ('pending', 'confirmed', 'unsubscribed'))
      )
    `);
    await client.query(`
      ALTER TABLE status_page_subscribers
      ADD COLUMN IF NOT EXISTS confirmation_sent_at TIMESTAMPTZ
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_status_page_subscribers_status
      ON status_page_subscribers (status, created_at DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS status_page_subscriber_components (
        subscriber_id BIGINT NOT NULL REFERENCES status_page_subscribers(id) ON DELETE CASCADE,
        component_id INTEGER NOT NULL REFERENCES status_page_components(id) ON DELETE CASCADE,
        PRIMARY KEY (subscriber_id, component_id)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_deliveries (
        id BIGSERIAL PRIMARY KEY,
        purpose VARCHAR(40) NOT NULL,
        sender_profile_key VARCHAR(24) NOT NULL REFERENCES email_sender_profiles(profile_key),
        recipient_email VARCHAR(255) NOT NULL,
        recipient_kind VARCHAR(24) NOT NULL,
        subject VARCHAR(255) NOT NULL,
        text_body TEXT NOT NULL,
        html_body TEXT,
        metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        claim_token UUID,
        last_relay_id INTEGER REFERENCES email_relays(id) ON DELETE SET NULL,
        error VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMPTZ,
        CONSTRAINT valid_email_delivery_status CHECK (status IN ('pending', 'processing', 'accepted', 'failed', 'cancelled')),
        CONSTRAINT valid_email_delivery_attempts CHECK (attempts >= 0)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_deliveries_due
      ON email_deliveries (status, next_attempt_at, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_deliveries_recent
      ON email_deliveries (created_at DESC, id DESC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS email_delivery_attempts (
        id BIGSERIAL PRIMARY KEY,
        delivery_id BIGINT NOT NULL REFERENCES email_deliveries(id) ON DELETE CASCADE,
        relay_id INTEGER REFERENCES email_relays(id) ON DELETE SET NULL,
        relay_name VARCHAR(160) NOT NULL,
        attempt_number INTEGER NOT NULL,
        accepted BOOLEAN NOT NULL DEFAULT false,
        response VARCHAR(500),
        error VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_email_delivery_attempts_delivery
      ON email_delivery_attempts (delivery_id, created_at ASC, id ASC)
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_state (
        webhook_id INTEGER NOT NULL REFERENCES alert_webhooks(id) ON DELETE CASCADE,
        fleet_service_id INTEGER NOT NULL REFERENCES fleet_services(id) ON DELETE CASCADE,
        alert_type VARCHAR(40) NOT NULL,
        failing BOOLEAN NOT NULL DEFAULT false,
        consecutive_failures INTEGER NOT NULL DEFAULT 0,
        generation BIGINT NOT NULL DEFAULT 0,
        last_observation_key VARCHAR(160),
        failure_started_at TIMESTAMPTZ,
        last_notification_at TIMESTAMPTZ,
        failure_notified BOOLEAN NOT NULL DEFAULT false,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (webhook_id, fleet_service_id, alert_type),
        CONSTRAINT valid_alert_state_type CHECK (alert_type IN (${ALERT_STATE_TYPES_SQL})),
        CONSTRAINT valid_alert_state_failures CHECK (consecutive_failures >= 0)
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS alert_deliveries (
        id BIGSERIAL PRIMARY KEY,
        notification_id UUID UNIQUE NOT NULL,
        dedupe_key VARCHAR(300) UNIQUE NOT NULL,
        webhook_id INTEGER REFERENCES alert_webhooks(id) ON DELETE SET NULL,
        webhook_name VARCHAR(120) NOT NULL,
        fleet_service_id INTEGER REFERENCES fleet_services(id) ON DELETE SET NULL,
        monitoring_issue_id BIGINT REFERENCES monitoring_issues(id) ON DELETE SET NULL,
        service_id VARCHAR(120) NOT NULL,
        service_name VARCHAR(160) NOT NULL,
        service_type VARCHAR(16) NOT NULL,
        alert_type VARCHAR(40) NOT NULL,
        event_kind VARCHAR(16) NOT NULL,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        adapter VARCHAR(16) NOT NULL,
        payload_json JSONB NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TIMESTAMPTZ,
        last_attempt_at TIMESTAMPTZ,
        claimed_at TIMESTAMPTZ,
        claim_token UUID,
        response_status INTEGER,
        error VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        completed_at TIMESTAMPTZ,
        CONSTRAINT valid_alert_delivery_service_type CHECK (service_type IN (${serviceTypeSqlList()}, 'monitoring')),
        CONSTRAINT valid_alert_delivery_type CHECK (alert_type IN (${ALERT_TYPES_SQL})),
        CONSTRAINT valid_alert_delivery_event CHECK (event_kind IN ('failure', 'repeat', 'recovery', 'test', 'dismissed')),
        CONSTRAINT valid_alert_delivery_status CHECK (status IN ('pending', 'processing', 'accepted', 'failed', 'cancelled')),
        CONSTRAINT valid_alert_delivery_adapter CHECK (adapter IN ('slack', 'generic', 'sentry'))
      )
    `);
    await client.query(`
      ALTER TABLE alert_deliveries DROP CONSTRAINT IF EXISTS valid_alert_delivery_adapter;
      ALTER TABLE alert_deliveries ADD CONSTRAINT valid_alert_delivery_adapter CHECK (adapter IN ('slack', 'generic', 'sentry'))
    `);
    await client.query(`
      ALTER TABLE alert_deliveries
      ADD COLUMN IF NOT EXISTS monitoring_issue_id BIGINT REFERENCES monitoring_issues(id) ON DELETE SET NULL
    `);
    await client.query(`
      ALTER TABLE alert_deliveries DROP CONSTRAINT IF EXISTS valid_alert_delivery_status;
      ALTER TABLE alert_deliveries ADD CONSTRAINT valid_alert_delivery_status
        CHECK (status IN ('pending', 'processing', 'accepted', 'failed', 'cancelled', 'expired'))
    `);
    await client.query(`
      ALTER TABLE alert_deliveries DROP CONSTRAINT IF EXISTS valid_alert_delivery_event;
      ALTER TABLE alert_deliveries ADD CONSTRAINT valid_alert_delivery_event
        CHECK (event_kind IN ('failure', 'repeat', 'recovery', 'test', 'dismissed'))
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_webhooks_enabled ON alert_webhooks (enabled, id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_deliveries_due
      ON alert_deliveries (status, next_attempt_at, created_at)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_deliveries_recent
      ON alert_deliveries (created_at DESC, id DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_alert_deliveries_monitoring_issue
      ON alert_deliveries (monitoring_issue_id, created_at DESC, id DESC)
    `);
    const alertRetention = await client.query<{ value: string }>(
      `SELECT value FROM admin_config WHERE key = 'alertDeliveryRetentionDays'`
    );
    const alertRetentionDays = Math.max(
      1,
      Math.min(365, Number.parseInt(alertRetention.rows[0]?.value ?? '30', 10) || 30)
    );
    await client.query(`
      DELETE FROM alert_deliveries
      WHERE created_at < CURRENT_TIMESTAMP - ($1::int * INTERVAL '1 day')
    `, [alertRetentionDays]);

    // Telemetry alert rules: an instant query against the telemetry store, a
    // condition and a duration. State is kept per result series (for example
    // per host), independent of webhooks; deliveries fan out like Monitoring
    // issues to webhooks subscribed to 'telemetry_rule'.
    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetry_alert_rules (
        id SERIAL PRIMARY KEY,
        name VARCHAR(120) NOT NULL,
        description VARCHAR(500),
        query TEXT NOT NULL,
        comparator VARCHAR(2) NOT NULL,
        threshold DOUBLE PRECISION NOT NULL,
        for_seconds INTEGER NOT NULL DEFAULT 300,
        severity VARCHAR(16) NOT NULL DEFAULT 'critical',
        enabled BOOLEAN NOT NULL DEFAULT true,
        last_evaluated_at TIMESTAMPTZ,
        last_error VARCHAR(500),
        created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_telemetry_alert_rule_comparator CHECK (comparator IN ('>', '>=', '<', '<=', '==', '!=')),
        CONSTRAINT valid_telemetry_alert_rule_severity CHECK (severity IN ('warning', 'critical')),
        CONSTRAINT valid_telemetry_alert_rule_for CHECK (for_seconds BETWEEN 0 AND 86400)
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetry_alert_states (
        rule_id INTEGER NOT NULL REFERENCES telemetry_alert_rules(id) ON DELETE CASCADE,
        series_key VARCHAR(64) NOT NULL,
        labels_json JSONB NOT NULL,
        status VARCHAR(16) NOT NULL,
        pending_since TIMESTAMPTZ NOT NULL,
        firing_since TIMESTAMPTZ,
        last_value DOUBLE PRECISION,
        last_seen_at TIMESTAMPTZ NOT NULL,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (rule_id, series_key),
        CONSTRAINT valid_telemetry_alert_state_status CHECK (status IN ('pending', 'firing'))
      )
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetry_alert_issues (
        id UUID PRIMARY KEY,
        rule_id INTEGER NOT NULL,
        rule_name VARCHAR(120) NOT NULL,
        query TEXT NOT NULL,
        comparator VARCHAR(2) NOT NULL,
        threshold DOUBLE PRECISION NOT NULL,
        for_seconds INTEGER NOT NULL,
        severity VARCHAR(16) NOT NULL,
        series_key VARCHAR(64) NOT NULL,
        labels_json JSONB NOT NULL,
        last_value DOUBLE PRECISION,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        opened_at TIMESTAMPTZ NOT NULL,
        last_seen_at TIMESTAMPTZ NOT NULL,
        dismissed_at TIMESTAMPTZ,
        dismissed_by INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        dismissed_until TIMESTAMPTZ,
        dismissal_reason VARCHAR(500),
        revision INTEGER NOT NULL DEFAULT 1,
        resume_notification_pending BOOLEAN NOT NULL DEFAULT false,
        resolved_at TIMESTAMPTZ,
        resolution_reason VARCHAR(16),
        CONSTRAINT valid_telemetry_alert_issue_status CHECK (status IN ('active', 'dismissed', 'resolved')),
        CONSTRAINT valid_telemetry_alert_issue_resolution CHECK (resolution_reason IS NULL OR resolution_reason IN ('recovered', 'absent', 'edited', 'disabled', 'deleted')),
        CONSTRAINT valid_telemetry_alert_issue_revision CHECK (revision > 0)
      )
    `);
    await client.query('ALTER TABLE telemetry_alert_issues ADD COLUMN IF NOT EXISTS resume_notification_pending BOOLEAN NOT NULL DEFAULT false');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_telemetry_alert_issues_status
      ON telemetry_alert_issues (status, opened_at DESC)
    `);
    await client.query(`
      CREATE TABLE IF NOT EXISTS telemetry_alert_issue_events (
        id BIGSERIAL PRIMARY KEY,
        issue_id UUID NOT NULL REFERENCES telemetry_alert_issues(id) ON DELETE CASCADE,
        event_type VARCHAR(24) NOT NULL,
        actor_admin_id INTEGER REFERENCES admins(id) ON DELETE SET NULL,
        actor_name VARCHAR(120),
        reason VARCHAR(500),
        expires_at TIMESTAMPTZ,
        occurred_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_telemetry_alert_issue_event_type CHECK (event_type IN ('firing', 'dismissed', 'resumed', 'dismissal_expired', 'severity_escalated', 'resolved'))
      )
    `);
    await client.query('ALTER TABLE telemetry_alert_issue_events ADD COLUMN IF NOT EXISTS actor_name VARCHAR(120)');
    await client.query('ALTER TABLE telemetry_alert_issue_events ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ');
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_telemetry_alert_issue_events_issue
      ON telemetry_alert_issue_events (issue_id, occurred_at, id)
    `);
    await client.query(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_telemetry_alert_issues_one_open_occurrence
      ON telemetry_alert_issues (rule_id, series_key)
      WHERE status IN ('active', 'dismissed')
    `);
    await client.query('ALTER TABLE telemetry_alert_states ADD COLUMN IF NOT EXISTS issue_id UUID');
    await client.query('ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS telemetry_alert_issue_id UUID');
    await client.query('ALTER TABLE alert_deliveries ADD COLUMN IF NOT EXISTS telemetry_alert_issue_revision INTEGER');
    await client.query(`
      UPDATE telemetry_alert_states
      SET issue_id = gen_random_uuid()
      WHERE status = 'firing' AND issue_id IS NULL
    `);
    await client.query(`
      INSERT INTO telemetry_alert_issues (
        id, rule_id, rule_name, query, comparator, threshold, for_seconds, severity,
        series_key, labels_json, last_value, status, opened_at, last_seen_at
      )
      SELECT s.issue_id, r.id, r.name, r.query, r.comparator, r.threshold, r.for_seconds, r.severity,
             s.series_key, s.labels_json, s.last_value, 'active', COALESCE(s.firing_since, s.pending_since), s.last_seen_at
      FROM telemetry_alert_states s
      JOIN telemetry_alert_rules r ON r.id = s.rule_id
      WHERE s.status = 'firing' AND s.issue_id IS NOT NULL
      ON CONFLICT (id) DO NOTHING
    `);
    await client.query(`
      INSERT INTO telemetry_alert_issue_events (issue_id, event_type, occurred_at)
      SELECT i.id, 'firing', i.opened_at
      FROM telemetry_alert_issues i
      WHERE NOT EXISTS (
        SELECT 1 FROM telemetry_alert_issue_events e
        WHERE e.issue_id = i.id AND e.event_type = 'firing'
      )
    `);
    await client.query(`
      UPDATE alert_deliveries d
      SET telemetry_alert_issue_id = i.id,
          telemetry_alert_issue_revision = i.revision
      FROM telemetry_alert_issues i
      WHERE (d.telemetry_alert_issue_id IS NULL OR d.telemetry_alert_issue_revision IS NULL)
        AND d.alert_type = 'telemetry_rule'
        AND d.webhook_id IS NOT NULL
        AND d.dedupe_key = 'telemetry-rule:' || i.rule_id || ':' || i.series_key || ':'
          || (EXTRACT(EPOCH FROM i.opened_at) * 1000)::bigint || ':failure:' || d.webhook_id
    `);

    // ========================================================================
    // REPORTING INTELLIGENCE TABLES
    // These derived tables power the unified reporting experience
    // ========================================================================

    // Sender inventory - classified senders derived from DMARC data
    await client.query(`
      CREATE TABLE IF NOT EXISTS sender_inventory (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        source_ip VARCHAR(45) NOT NULL,
        source_host VARCHAR(255),
        classification VARCHAR(20) NOT NULL DEFAULT 'unknown',
        confidence REAL DEFAULT 0,
        first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        total_volume BIGINT DEFAULT 0,
        pass_count BIGINT DEFAULT 0,
        fail_count BIGINT DEFAULT 0,
        spf_aligned BIGINT DEFAULT 0,
        dkim_aligned BIGINT DEFAULT 0,
        -- TLS failure count from TLSRPT (RFC 8460). Populated by
        -- analyzeTlsrptIntelligence — counts failed sessions where
        -- this IP was the sending MTA delivering to one of our MX hosts.
        tls_failure_count BIGINT DEFAULT 0,
        -- Mute: silences the issue detectors for this (domain, source_ip)
        -- so an operator can stop noisy repeat-issues without changing
        -- classification. muted_until NULL = forever; otherwise the
        -- detectors auto-resume when the timer expires.
        muted_at      TIMESTAMP NULL,
        muted_by      VARCHAR(255) NULL,
        muted_reason  TEXT NULL,
        muted_until   TIMESTAMP NULL,
        notes TEXT,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        -- Sender review state — the durable operator decision that drives
        -- detection: pending (detectors behave as normal), approved (sender-class
        -- issues suppressed, remediation offered instead), rejected (escalated
        -- severity, block suggested). Mute stays as a temporary snooze timer only.
        review_state VARCHAR(20) NOT NULL DEFAULT 'pending',
        review_state_by VARCHAR(255),
        review_state_at TIMESTAMP,
        review_state_reason TEXT,
        provider VARCHAR(100),
        org_domain VARCHAR(255),
        UNIQUE(domain, source_ip),
        CONSTRAINT valid_classification CHECK (classification IN (
          'own_server', 'authorized', 'forwarder', 'suspicious_forwarder',
          'misconfigured', 'unknown', 'trusted', 'suspicious', 'spoofing'
        )),
        CONSTRAINT valid_review_state CHECK (review_state IN ('pending', 'approved', 'rejected'))
      )
    `);

    // Partial index — only senders that are actively muted matter for
    // the "skip these" lookup in detectIssues().
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sender_inventory_muted
        ON sender_inventory(domain, muted_at)
        WHERE muted_at IS NOT NULL
    `);

    // Domain health snapshots - aggregated health metrics per domain
    await client.query(`
      CREATE TABLE IF NOT EXISTS domain_health (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        snapshot_date DATE NOT NULL,
        -- DMARC metrics
        dmarc_policy VARCHAR(20),
        dmarc_pct INTEGER,
        dmarc_pass_rate REAL DEFAULT 0,
        dmarc_volume BIGINT DEFAULT 0,
        spf_pass_rate REAL DEFAULT 0,
        dkim_pass_rate REAL DEFAULT 0,
        alignment_rate REAL DEFAULT 0,
        -- Transport security (TLSRPT)
        tls_success_rate REAL DEFAULT 0,
        tls_volume BIGINT DEFAULT 0,
        mta_sts_mode VARCHAR(20),
        mta_sts_dns_record_current TEXT,
        mta_sts_policy_current TEXT,
        tlsrpt_record_current TEXT,
        bimi_record_current TEXT,
        -- Forensic summary
        forensic_count INTEGER DEFAULT 0,
        -- Risk scoring
        risk_score REAL DEFAULT 0,
        risk_factors JSONB DEFAULT '[]',
        -- Live DNS records — populated by analyzeDmarcIntelligence so the
        -- issue detail UI can show the *real* current state instead of a
        -- templated example. spf_authorized_ips is the flattened set from
        -- recursive SPF expansion ({ipv4: cidrs[], ipv6: cidrs[]}).
        spf_record_current   TEXT NULL,
        dmarc_record_current TEXT NULL,
        dkim_records_current JSONB DEFAULT '{}',
        spf_authorized_ips   JSONB DEFAULT '{}',
        spf_permerror        BOOLEAN DEFAULT false,
        dns_checked_at       TIMESTAMP NULL,
        -- Change tracking
        volume_change_pct REAL DEFAULT 0,
        pass_rate_change REAL DEFAULT 0,
        org_domain VARCHAR(255),
        subdomain_policy VARCHAR(20),
        compliance_rate REAL DEFAULT 0,
        unidentified_volume BIGINT DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain, snapshot_date)
      )
    `);

    // Reporting issues - detected problems with severity and evidence
    await client.query(`
      CREATE TABLE IF NOT EXISTS reporting_issues (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        issue_type VARCHAR(50) NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'info',
        title VARCHAR(255) NOT NULL,
        description TEXT,
        evidence JSONB DEFAULT '{}',
        issue_fingerprint VARCHAR(255),
        affected_senders TEXT[],
        affected_volume BIGINT DEFAULT 0,
        first_detected TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_detected TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        status VARCHAR(20) NOT NULL DEFAULT 'open',
        status_history JSONB DEFAULT '[]',
        resolved_at TIMESTAMP,
        resolution_notes TEXT,
        -- Snooze: when set and in the future, the issue is hidden from the
        -- default open-list and detectors won't re-open a duplicate. NULL
        -- means not snoozed.
        muted_until TIMESTAMP NULL,
        -- Denormalized link to the contributing senders in sender_inventory.
        -- Cheaper than a junction table at our scale; the GIN index makes
        -- "find issues for sender X" a fast index-only lookup.
        sender_ids INTEGER[] DEFAULT '{}',
        org_domain VARCHAR(255),
        related_issue_ids INTEGER[] DEFAULT '{}',
        first_run_id INTEGER,
        last_run_id INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        CONSTRAINT valid_severity CHECK (severity IN ('critical', 'high', 'medium', 'low', 'info')),
        CONSTRAINT valid_status CHECK (status IN ('open', 'acknowledged', 'in_progress', 'resolved', 'ignored', 'suppressed'))
      )
    `);

    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reporting_issues_sender_ids
        ON reporting_issues USING GIN (sender_ids)
    `);

    // Remediation suggestions - actionable fixes linked to issues
    await client.query(`
      CREATE TABLE IF NOT EXISTS remediation_suggestions (
        id SERIAL PRIMARY KEY,
        issue_id INTEGER REFERENCES reporting_issues(id) ON DELETE CASCADE,
        domain VARCHAR(255) NOT NULL,
        suggestion_type VARCHAR(50) NOT NULL,
        priority INTEGER DEFAULT 0,
        title VARCHAR(255) NOT NULL,
        description TEXT NOT NULL,
        action_steps JSONB DEFAULT '[]',
        dns_changes JSONB DEFAULT '[]',
        verification_steps JSONB DEFAULT '[]',
        estimated_impact VARCHAR(100),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      )
    `);

    // Analysis runs — one row per detector pass. Gives every derived
    // number a provenance ("computed by run 412 over 2026-08-01..08-08")
    // and is the anchor for the persistence / grace-period logic below:
    // without a stored notion of a run, "the condition held for two
    // consecutive windows" cannot be expressed at all.
    await client.query(`
      CREATE TABLE IF NOT EXISTS reporting_analysis_runs (
        id SERIAL PRIMARY KEY,
        kind VARCHAR(20) NOT NULL,
        window_start TIMESTAMP NOT NULL,
        window_end TIMESTAMP NOT NULL,
        started_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        finished_at TIMESTAMP NULL,
        domains_processed INTEGER DEFAULT 0,
        issues_opened INTEGER DEFAULT 0,
        issues_refreshed INTEGER DEFAULT 0,
        issues_resolved INTEGER DEFAULT 0,
        issues_pending INTEGER DEFAULT 0,
        status VARCHAR(20) NOT NULL DEFAULT 'running',
        error TEXT NULL,
        CONSTRAINT valid_run_kind CHECK (kind IN ('dmarc', 'tlsrpt', 'forensic')),
        CONSTRAINT valid_run_status CHECK (status IN ('running', 'completed', 'failed'))
      )
    `);

    // One row per detector firing per run, keyed by the same fingerprint
    // used for issue dedup. Statistical detectors consult this to require
    // a condition to hold across consecutive runs before opening an
    // issue, and to require consecutive *absences* before auto-resolving.
    await client.query(`
      CREATE TABLE IF NOT EXISTS reporting_issue_observations (
        id SERIAL PRIMARY KEY,
        issue_fingerprint VARCHAR(255) NOT NULL,
        run_id INTEGER REFERENCES reporting_analysis_runs(id) ON DELETE CASCADE,
        domain VARCHAR(255) NOT NULL,
        issue_type VARCHAR(50) NOT NULL,
        severity VARCHAR(20) NOT NULL DEFAULT 'info',
        observed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        window_start TIMESTAMP NULL,
        window_end TIMESTAMP NULL,
        metrics JSONB DEFAULT '{}',
        UNIQUE(issue_fingerprint, run_id)
      )
    `);

    // Forensic clusters keep stable identity across analysis runs.
    await client.query(`
      CREATE TABLE IF NOT EXISTS forensic_clusters (
        id SERIAL PRIMARY KEY,
        domain VARCHAR(255) NOT NULL,
        source_ip VARCHAR(45) NOT NULL,
        auth_failure VARCHAR(50) NOT NULL,
        occurrence_count INTEGER NOT NULL DEFAULT 0,
        actionable_count INTEGER NOT NULL DEFAULT 0,
        first_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_seen TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        last_run_id INTEGER NULL,
        subjects JSONB DEFAULT '[]',
        senders JSONB DEFAULT '[]',
        report_ids JSONB DEFAULT '[]',
        updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(domain, source_ip, auth_failure)
      )
    `);

    // Create indexes for reporting intelligence tables
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sender_inventory_domain ON sender_inventory(domain)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sender_inventory_classification ON sender_inventory(classification)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sender_inventory_last_seen ON sender_inventory(last_seen)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_domain_health_domain_date ON domain_health(domain, snapshot_date DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reporting_issues_domain ON reporting_issues(domain)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reporting_issues_status ON reporting_issues(status, severity)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reporting_issues_actionable_domain
      ON reporting_issues(domain, severity, last_detected DESC)
      WHERE status IN ('open', 'acknowledged', 'in_progress')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reporting_issues_actionable_recent
      ON reporting_issues(status, last_detected DESC)
      WHERE status IN ('open', 'acknowledged', 'in_progress')
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reporting_issues_type ON reporting_issues(issue_type)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reporting_issues_fingerprint ON reporting_issues(issue_fingerprint)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_remediation_issue ON remediation_suggestions(issue_id)
    `);
    // idx_deliverability_domain went with the deliverability_signals table.
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_reports_fingerprint ON forensic_reports(message_fingerprint)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_analysis_runs_kind ON reporting_analysis_runs(kind, started_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_issue_observations_fingerprint
        ON reporting_issue_observations(issue_fingerprint, observed_at DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_issue_observations_run ON reporting_issue_observations(run_id)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_forensic_clusters_domain ON forensic_clusters(domain, last_seen DESC)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_sender_inventory_review ON sender_inventory(domain, review_state)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_reporting_issues_org_domain ON reporting_issues(org_domain)
    `);

    // Source identity cache — IP to service-name resolution.
    //
    // Resolving an address is a DNS round-trip, and the same few hundred
    // addresses recur across every report, so results are cached here rather
    // than resolved per request. `provider` is null when the catalogue does not
    // recognise the address, which keeps the "unknown source" bucket honest.
    //
    // `ip` is VARCHAR rather than INET deliberately: dmarc_records.source_ip is
    // VARCHAR, and an INET column cannot be joined against it without a cast
    // that both defeats the index and throws on any malformed address a report
    // happens to contain. Matching the storage type keeps the join exact.
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_identity (
        ip VARCHAR(64) PRIMARY KEY,
        ptr VARCHAR(255),
        fcrdns_verified BOOLEAN NOT NULL DEFAULT FALSE,
        provider VARCHAR(100),
        provider_category VARCHAR(50),
        provider_via VARCHAR(20),
        auth_docs_url TEXT,
        resolved_at TIMESTAMP NOT NULL DEFAULT NOW()
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_source_identity_provider ON source_identity(provider)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_source_identity_resolved ON source_identity(resolved_at)
    `);

    // Operator decisions about a sending service, held across every domain it
    // sends for.
    await client.query(`
      CREATE TABLE IF NOT EXISTS source_review (
        source_key VARCHAR(255) PRIMARY KEY,
        review_state VARCHAR(20) NOT NULL DEFAULT 'pending',
        reviewed_by VARCHAR(255),
        reviewed_at TIMESTAMP,
        note TEXT,
        created_at TIMESTAMP NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMP NOT NULL DEFAULT NOW(),
        CONSTRAINT valid_source_review_state
          CHECK (review_state IN ('pending', 'authorized', 'forwarder', 'threat'))
      )
    `);


    // ── DMARC reporting rollups ───────────────────────────────────────────────
    // Pre-aggregated daily taxonomy, maintained incrementally at ingest (see
    // db/queries/dmarc.ts) so reporting reads scale with distinct dimensions in
    // the window, not with total raw history. The taxonomy columns are generated
    // from TAXONOMY_COLUMNS (services/dmarc-taxonomy.ts) so table, upsert and read
    // cannot drift. Dimensions are stored already lower-cased ('' for null) so
    // reads are plain equality on indexed columns. Rollups live forever and are
    // never touched by raw retention — a windowed number stays stable as old raw
    // ages out.

    // Coarse grain: no source_ip => tiny and permanent. Powers trend, the domain
    // table's taxonomy, reporter aggregates, and the taxonomy half of totals.
    // report_count is attributed to DATE_TRUNC('day', date_begin), making report
    // and reporter counts rollup-derived and retention-independent.
    await client.query(`
      CREATE TABLE IF NOT EXISTS dmarc_rollup_daily (
        day          DATE         NOT NULL,
        domain       VARCHAR(255) NOT NULL,
        org_name     VARCHAR(255) NOT NULL DEFAULT '',
        policy       VARCHAR(50)  NOT NULL DEFAULT '',
        ${rollupTaxonomyColumnDdl()},
        report_count BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, domain, org_name, policy)
      )
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_rollup_daily_domain
        ON dmarc_rollup_daily (domain, day)
    `);
    const legacyDmarcSourceRollup = await prepareLegacyPartitionedTable(client, 'dmarc_rollup_source_daily');

    // Source grain: powers Sources, distinct source_count per domain, and
    // distinct domain_count per source. Permanent like the coarse rollup:
    // retention never touches rollups, so Sources numbers don't shift as raw
    // reports age out. Its higher cardinality is why it is partitioned by month:
    // reads prune to the months they cover.
    // dkim_pass_volume / spf_pass_volume are raw-auth-pass volume (aligned or
    // not) — not derivable from the taxonomy columns, but needed for the Sources
    // screen's DKIM/SPF rate columns. first/last seen are derived at read time
    // from MIN/MAX(day), so no timestamp columns are stored.
    await client.query(`
      CREATE TABLE IF NOT EXISTS dmarc_rollup_source_daily (
        day              DATE         NOT NULL,
        domain           VARCHAR(255) NOT NULL,
        source_ip        VARCHAR(45)  NOT NULL,
        ${rollupTaxonomyColumnDdl()},
        dkim_pass_volume BIGINT NOT NULL DEFAULT 0,
        spf_pass_volume  BIGINT NOT NULL DEFAULT 0,
        PRIMARY KEY (day, domain, source_ip)
      ) PARTITION BY RANGE (day)
    `);
    // Default partition is a safety net; ensureMonthlyPartition() pre-creates
    // the month before every write, so the default normally stays empty.
    await client.query(`
      CREATE TABLE IF NOT EXISTS dmarc_rollup_source_daily_default
        PARTITION OF dmarc_rollup_source_daily DEFAULT
    `);
    if (legacyDmarcSourceRollup) {
      await migrateLegacyDmarcSourceRollup(client, legacyDmarcSourceRollup);
    }
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_rollup_source_domain
        ON dmarc_rollup_source_daily (domain, day)
    `);
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_dmarc_rollup_source_ip
        ON dmarc_rollup_source_daily (source_ip, day)
    `);
    // The current and next month exist up front; writes ensure any other month.
    const nextMonth = new Date(Date.now() + 31 * 24 * 60 * 60 * 1000);
    for (const table of MONTHLY_PARTITIONED_TABLES) {
      await ensureMonthlyPartition(client, table, new Date());
      await ensureMonthlyPartition(client, table, nextMonth);
    }

    // Type lists grow between releases; bring existing tables' CHECKs up to date.
    await syncTypeListConstraint(client, 'fleet_agent_commands', 'valid_fleet_agent_command_service_type', 'service_type', FLEET_SERVICE_TYPES);
    await syncTypeListConstraint(client, 'fleet_services', 'valid_fleet_service_type', 'service_type', FLEET_SERVICE_TYPES);
    await syncTypeListConstraint(client, 'alert_deliveries', 'valid_alert_delivery_service_type', 'service_type', [...FLEET_SERVICE_TYPES, 'monitoring']);
    await syncTypeListConstraint(client, 'alert_deliveries', 'valid_alert_delivery_type', 'alert_type', ALERT_TYPES);
    await syncTypeListConstraint(client, 'alert_state', 'valid_alert_state_type', 'alert_type', ALERT_STATE_TYPES);

    await client.query('COMMIT');
    await backfillObservationLocations(client);
    await ensureLargeTableIndexes(client);
    logger.info('Database schema initialized successfully');
  } catch (error) {
    await client.query('ROLLBACK');
    logger.error('Failed to initialize database schema', { error: (error as Error).message });
    throw error;
  } finally {
    if (locked) await client.query(`SELECT pg_advisory_unlock(hashtext('robin-admin-schema'))`).catch(() => undefined);
    client.release();
  }

  // Generate setup ID if needed
  const needs = await needsSetup();
  if (needs) {
    setupSessionId = uuidv4();
    await writeSetupSessionIdFile(setupSessionId);
    logger.info('='.repeat(60));
    logger.info('[SETUP] First admin setup required');
    logger.info(`[SETUP] Setup Session ID: ${setupSessionId}`);
    logger.info(`[SETUP] Setup ID file: ${setupSessionIdFile}`);
    logger.info('[SETUP] Use this ID when creating the first admin user');
    logger.info('='.repeat(60));
  }
}
