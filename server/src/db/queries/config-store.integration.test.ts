/**
 * Integration test for the config-store schema check against a REAL Postgres
 * (the unit suite mocks the driver, which hid a name[] parsing bug). Skipped
 * by default. To run:
 *   ROLLUP_IT_DB=1 DB_HOST=localhost DB_PORT=5433 DB_NAME=robin_test \
 *   DB_USER=test DB_PASSWORD=test SESSION_SECRET=x \
 *   npx vitest run src/db/queries/config-store.integration.test.ts
 * Run one integration file at a time: they share and reset the same tables.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { initializeSchema } from '../schema.js';
import { query, closePool } from '../connection.js';
import { configStoreTableHasSchema } from './config-store.js';
import { robinConfigTableHasSchema } from './robin-config-meta.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

describe.skipIf(!RUN)('config-store schema check (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
  });
  afterAll(async () => {
    await query('DROP TABLE IF EXISTS robin_config_store_no_key');
    await closePool();
  });

  it('recognises the schema-created Robin config store', async () => {
    expect(await robinConfigTableHasSchema()).toBe(true);
    expect(await configStoreTableHasSchema('rspamd_config_store', 'service_id')).toBe(true);
  });

  it('rejects a table without the (owner, file_name) unique key', async () => {
    await query(`CREATE TABLE IF NOT EXISTS robin_config_store_no_key (
      server_id VARCHAR(64) NOT NULL, file_name VARCHAR(255) NOT NULL,
      payload_json JSONB NOT NULL, updated_epoch BIGINT NOT NULL, sha256 VARCHAR(64) NOT NULL)`);
    expect(await configStoreTableHasSchema('robin_config_store_no_key' as never, 'server_id')).toBe(false);
  });
});
