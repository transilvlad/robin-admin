import { createHash } from 'crypto';
import { query } from '../connection.js';
import { quotePostgresIdentifier, validatePostgresIdentifier, type PostgresIdentifier } from '../postgres-identifier.js';

export const ROBIN_CONFIG_STORE_TABLE = 'robin_config_store';
export const RSPAMD_CONFIG_STORE_TABLE = 'rspamd_config_store';
export const CLAMAV_CONFIG_STORE_TABLE = 'clamav_config_store';
export const DOVECOT_CONFIG_STORE_TABLE = 'dovecot_config_store';
export const POSTFIX_CONFIG_STORE_TABLE = 'postfix_config_store';
export const REDIS_CONFIG_STORE_TABLE = 'redis_config_store';
export const POSTGRES_CONFIG_STORE_TABLE = 'postgres_config_store';
export const MARIADB_CONFIG_STORE_TABLE = 'mariadb_config_store';

export type ConfigStoreTable =
  | typeof ROBIN_CONFIG_STORE_TABLE
  | typeof RSPAMD_CONFIG_STORE_TABLE
  | typeof CLAMAV_CONFIG_STORE_TABLE
  | typeof DOVECOT_CONFIG_STORE_TABLE
  | typeof POSTFIX_CONFIG_STORE_TABLE
  | typeof REDIS_CONFIG_STORE_TABLE
  | typeof POSTGRES_CONFIG_STORE_TABLE
  | typeof MARIADB_CONFIG_STORE_TABLE
  | PostgresIdentifier;
export type ConfigStoreOwnerColumn = 'server_id' | 'service_id';

const REQUIRED_COLUMNS = ['file_name', 'payload_json', 'updated_epoch', 'sha256'] as const;

const VALID_TABLES = new Set<ConfigStoreTable>([
  ROBIN_CONFIG_STORE_TABLE,
  RSPAMD_CONFIG_STORE_TABLE,
  CLAMAV_CONFIG_STORE_TABLE,
  DOVECOT_CONFIG_STORE_TABLE,
  POSTFIX_CONFIG_STORE_TABLE,
  REDIS_CONFIG_STORE_TABLE,
  POSTGRES_CONFIG_STORE_TABLE,
  MARIADB_CONFIG_STORE_TABLE,
]);

const VALID_OWNER_COLUMNS = new Set<ConfigStoreOwnerColumn>(['server_id', 'service_id']);

export interface ConfigStoreEntry<T = Record<string, unknown>> {
  ownerId: string;
  fileName: string;
  payloadJson: T;
  updatedEpoch: number;
  sha256: string;
}

function assertTableName(tableName: ConfigStoreTable): PostgresIdentifier {
  if (VALID_TABLES.has(tableName as ConfigStoreTable)) {
    return validatePostgresIdentifier(tableName);
  }
  return validatePostgresIdentifier(tableName, 'Config store table name');
}

function assertOwnerColumn(ownerColumn: ConfigStoreOwnerColumn): ConfigStoreOwnerColumn {
  if (!VALID_OWNER_COLUMNS.has(ownerColumn)) {
    throw new Error(`Unsupported config store owner column: ${ownerColumn}`);
  }
  return ownerColumn;
}

function normalizePayload<T>(payload: T | null | undefined): T {
  if (payload === null || payload === undefined) {
    return {} as T;
  }
  return payload;
}

export async function configStoreTableHasSchema(
  tableName: ConfigStoreTable,
  ownerColumn: ConfigStoreOwnerColumn
): Promise<boolean> {
  const validatedTable = assertTableName(tableName);
  const validatedOwnerColumn = assertOwnerColumn(ownerColumn);
  try {
    const [columnResult, uniqueResult] = await Promise.all([
      query<{ column_name: string }>(
      `SELECT columns.column_name
       FROM information_schema.columns AS columns
       JOIN information_schema.tables AS tables
         ON tables.table_schema = columns.table_schema
        AND tables.table_name = columns.table_name
       WHERE columns.table_schema = 'public'
         AND columns.table_name = $1
         AND tables.table_type = 'BASE TABLE'`,
      [validatedTable]
      ),
      query<{ columns: string[] }>(
        // ::text: node-postgres returns a name[] as its literal string, not an array.
        `SELECT array_agg(attr.attname::text ORDER BY key_column.ordinality) AS columns
         FROM pg_catalog.pg_index AS idx
         JOIN pg_catalog.pg_class AS table_class
           ON table_class.oid = idx.indrelid
         JOIN pg_catalog.pg_namespace AS ns
           ON ns.oid = table_class.relnamespace
         JOIN unnest(idx.indkey) WITH ORDINALITY AS key_column(attnum, ordinality)
           ON true
         JOIN pg_catalog.pg_attribute AS attr
           ON attr.attrelid = table_class.oid
          AND attr.attnum = key_column.attnum
         WHERE ns.nspname = 'public'
           AND table_class.relname = $1
           AND idx.indisunique
           AND idx.indisvalid
           AND idx.indpred IS NULL
         GROUP BY idx.indexrelid`,
        [validatedTable]
      ),
    ]);
    if (columnResult.rows.length === 0) {
      return false;
    }

    const columns = new Set(columnResult.rows.map((row) => row.column_name));
    if (!columns.has(validatedOwnerColumn)) {
      return false;
    }
    for (const requiredColumn of REQUIRED_COLUMNS) {
      if (!columns.has(requiredColumn)) {
        return false;
      }
    }
    return uniqueResult.rows.some((row) => (
      row.columns.length === 2 &&
      row.columns[0] === validatedOwnerColumn &&
      row.columns[1] === 'file_name'
    ));
  } catch {
    return false;
  }
}

export async function getConfigStorePayload<T = Record<string, unknown>>(
  tableName: ConfigStoreTable,
  ownerColumn: ConfigStoreOwnerColumn,
  ownerId: string,
  fileName: string
): Promise<T | null> {
  const validatedTable = assertTableName(tableName);
  const validatedOwnerColumn = assertOwnerColumn(ownerColumn);
  const result = await query<{ payload_json: T }>(
    `SELECT payload_json
     FROM ${quotePostgresIdentifier(validatedTable)}
     WHERE ${validatedOwnerColumn} = $1 AND file_name = $2`,
    [ownerId, fileName]
  );
  return (result.rows[0]?.payload_json ?? null) as T | null;
}

export async function listConfigStoreFileNames(
  tableName: ConfigStoreTable,
  ownerColumn: ConfigStoreOwnerColumn,
  ownerId: string
): Promise<string[]> {
  const validatedTable = assertTableName(tableName);
  const validatedOwnerColumn = assertOwnerColumn(ownerColumn);
  const result = await query<{ file_name: string }>(
    `SELECT file_name
     FROM ${quotePostgresIdentifier(validatedTable)}
     WHERE ${validatedOwnerColumn} = $1
     ORDER BY file_name ASC`,
    [ownerId]
  );
  return result.rows.map((row) => row.file_name);
}

/**
 * Distinct owner ids present in the store (the config scopes). Mirrors Robin's
 * `SELECT DISTINCT server_id`. Always includes 'default' so the base scope is
 * offered even before any override row exists.
 */
export async function listConfigStoreOwners(
  tableName: ConfigStoreTable,
  ownerColumn: ConfigStoreOwnerColumn
): Promise<string[]> {
  const validatedTable = assertTableName(tableName);
  const validatedOwnerColumn = assertOwnerColumn(ownerColumn);
  const result = await query<{ owner_id: string }>(
    `SELECT DISTINCT ${validatedOwnerColumn} AS owner_id
     FROM ${quotePostgresIdentifier(validatedTable)}
     ORDER BY owner_id ASC`,
    []
  );
  const owners = result.rows.map((row) => row.owner_id);
  return owners.includes('default') ? owners : ['default', ...owners];
}

export async function upsertConfigStorePayload<T = Record<string, unknown>>(
  tableName: ConfigStoreTable,
  ownerColumn: ConfigStoreOwnerColumn,
  ownerId: string,
  fileName: string,
  payload: T
): Promise<ConfigStoreEntry<T>> {
  const validatedTable = assertTableName(tableName);
  const validatedOwnerColumn = assertOwnerColumn(ownerColumn);
  const normalizedPayload = normalizePayload(payload);
  const canonicalPayload = JSON.stringify(normalizedPayload);
  const updatedEpoch = Math.floor(Date.now() / 1000);
  const sha256 = createHash('sha256').update(canonicalPayload).digest('hex');

  await query(
    `INSERT INTO ${quotePostgresIdentifier(validatedTable)} (${validatedOwnerColumn}, file_name, payload_json, updated_epoch, sha256)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (${validatedOwnerColumn}, file_name)
     DO UPDATE SET payload_json = $3::jsonb, updated_epoch = $4, sha256 = $5`,
    [ownerId, fileName, canonicalPayload, updatedEpoch, sha256]
  );

  return {
    ownerId,
    fileName,
    payloadJson: normalizedPayload,
    updatedEpoch,
    sha256,
  };
}

export async function deleteConfigStoreEntry(
  tableName: ConfigStoreTable,
  ownerColumn: ConfigStoreOwnerColumn,
  ownerId: string,
  fileName: string
): Promise<void> {
  const validatedTable = assertTableName(tableName);
  const validatedOwnerColumn = assertOwnerColumn(ownerColumn);
  await query(
    `DELETE FROM ${quotePostgresIdentifier(validatedTable)}
     WHERE ${validatedOwnerColumn} = $1 AND file_name = $2`,
    [ownerId, fileName]
  );
}
