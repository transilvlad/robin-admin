/** Metadata helpers for Robin's shared-config store. */

import {
  quotePostgresIdentifier,
  validatePostgresIdentifier,
  type PostgresIdentifier,
} from '../postgres-identifier.js';
import { configStoreTableHasSchema } from './config-store.js';
import { getConfig } from './config.js';

export async function getRobinConfigTableName(): Promise<PostgresIdentifier> {
  const config = await getConfig();
  return validatePostgresIdentifier(config.robinConfigTableName, 'Robin config-store table name');
}

export function validateTableName(name: string): string {
  return validatePostgresIdentifier(name, 'Robin config-store table name');
}

export async function getRobinConfigTableSqlIdentifier(): Promise<string> {
  return quotePostgresIdentifier(await getRobinConfigTableName());
}

export async function robinConfigTableHasSchema(): Promise<boolean> {
  return checkTableHasSchema(await getRobinConfigTableName());
}

export async function checkTableHasSchema(rawName: string): Promise<boolean> {
  let tableName: string;
  try {
    tableName = validateTableName(rawName);
  } catch {
    return false;
  }

  return configStoreTableHasSchema(validatePostgresIdentifier(tableName), 'server_id');
}
