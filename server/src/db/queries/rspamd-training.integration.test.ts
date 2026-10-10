/**
 * Integration test for the Rspamd training queries against a REAL Postgres
 * (the unit suite mocks the driver, which hid a parameter-type error). Skipped
 * by default; run like the other *.integration.test.ts files, one at a time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../schema.js';
import { closePool, query } from '../connection.js';
import {
  createTrainingImport,
  createTrainingSample,
  getTrainingSample,
  relabelTrainingSample,
  updateTrainingSampleLearning,
} from './rspamd.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

describe.skipIf(!RUN)('rspamd training queries (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
    await query('DELETE FROM rspamd_training_samples');
  });
  afterAll(async () => {
    await query('DELETE FROM rspamd_training_samples');
    await closePool();
  });

  it('stores a sample and records its learn outcome', async () => {
    const job = await createTrainingImport({ sourceFilename: 'a.eml', label: 'ham', createdBy: null, totalFiles: 1 });
    const sample = await createTrainingSample({
      importId: Number(job.id), filename: 'a.eml', contentHash: 'a'.repeat(64), label: 'ham',
      sourceType: 'eml', storedRelpath: 'samples/a.eml', sizeBytes: 10,
    });
    expect(sample).not.toBeNull();

    await updateTrainingSampleLearning(sample!.id, { status: 'failed', error: 'controller down' });
    expect(await getTrainingSample(sample!.id)).toMatchObject({ learnStatus: 'failed', learnError: 'controller down', learnedAt: null });

    await updateTrainingSampleLearning(sample!.id, { status: 'learned' });
    const learned = await getTrainingSample(sample!.id);
    expect(learned).toMatchObject({ learnStatus: 'learned', learnError: null });
    expect(learned?.learnedAt).toBeInstanceOf(Date);

    expect(await relabelTrainingSample(sample!.id, 'spam')).toMatchObject({ label: 'spam', learnStatus: 'pending' });
  });
});
