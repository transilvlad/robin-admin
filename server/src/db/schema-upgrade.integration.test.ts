/**
 * Schema upgrades against a REAL Postgres: columns added after a table first
 * shipped must also appear on existing installs, not only in CREATE TABLE.
 * Skipped by default; run like the other *.integration.test.ts files.
 */
import { afterAll, describe, expect, it } from 'vitest';
import { initializeSchema } from './schema.js';
import { closePool, query } from './connection.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

const LATE_COLUMNS: Array<[table: string, column: string]> = [
  ['fleet_agents', 'services_json'],
  ['fleet_services', 'software_version'],
  ['rspamd_dkim_selectors', 'private_key_enc'],
];

async function hasColumn(table: string, column: string): Promise<boolean> {
  const result = await query<{ present: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2
     ) AS present`,
    [table, column]
  );
  return result.rows[0]?.present === true;
}

describe.skipIf(!RUN)('schema upgrades (integration)', () => {
  afterAll(async () => {
    await closePool();
  });

  it('adds late columns to tables created by an older release', async () => {
    await initializeSchema();
    for (const [table, column] of LATE_COLUMNS) {
      await query(`ALTER TABLE ${table} DROP COLUMN IF EXISTS ${column}`);
    }

    await initializeSchema();

    for (const [table, column] of LATE_COLUMNS) {
      expect(await hasColumn(table, column), `${table}.${column}`).toBe(true);
    }
  }, 120000);
});
