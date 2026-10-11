/**
 * One-shot rebuild of the DMARC reporting rollups from the raw tables.
 *
 *   npm run rollups:backfill
 *
 * Atomically replaces complete retained days and preserves retired aggregates.
 * Incomplete raw evidence is refused before changes. Raw ingestion/retention
 * waits during the transaction; run in a quiet maintenance window with a backup.
 * Ingest maintains the rollups itself; this is for a rebuild after a data fix.
 */
import { initializeSchema } from '../src/db/schema.js';
import { rebuildDmarcRollups } from '../src/db/queries/dmarc-rollup.js';
import { closePool } from '../src/db/connection.js';

async function main(): Promise<void> {
  await initializeSchema();
  const result = await rebuildDmarcRollups();
  console.log(JSON.stringify(result, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closePool();
  });
