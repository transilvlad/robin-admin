/**
 * Load test for the Monitoring scheduler against a REAL Postgres: 150 checks
 * on a 10-second interval, a fifth of them slow or timing out, must all keep
 * running on time, with one issue per failing check and daily rollups that
 * match the raw observations. Probes are simulated so timing is deterministic;
 * claims, observations, issues and rollups use the database. Skipped by
 * default; run like the other *.integration.test.ts files, one at a time:
 *
 *   ROLLUP_IT_DB=1 DB_HOST=localhost DB_PORT=5433 DB_NAME=robin_test \
 *     DB_USER=test DB_PASSWORD=test npx vitest run src/services/monitoring/scheduler.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { setTimeout as delay } from 'node:timers/promises';
import type { MonitoringCheck } from '../../types/monitoring.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

const SLOW_MS = 1500;
const TIMEOUT_MS = 2000;
const INTERVAL_SECONDS = 10;
const RUN_MS = 26_000;

vi.mock('./probes.js', () => ({
  runMonitoringProbe: vi.fn(async (check: MonitoringCheck) => {
    if (check.name.startsWith('timeout')) {
      await delay(TIMEOUT_MS);
      return { status: 'down', responseTimeMs: TIMEOUT_MS, error: 'Connection timed out', details: {} };
    }
    const wait = check.name.startsWith('slow') ? SLOW_MS : 5;
    await delay(wait);
    return { status: 'up', responseTimeMs: wait, error: null, details: {} };
  }),
}));

const { initializeSchema } = await import('../../db/schema.js');
const { closePool, query } = await import('../../db/connection.js');
const { createMonitoringCheck, createMonitoringTarget, getMonitoringCheckHistory, pruneMonitoringHistory } = await import('../../db/queries/monitoring.js');
const { startMonitoringScheduler, stopMonitoringScheduler } = await import('./scheduler.js');

describe.skipIf(!RUN)('monitoring scheduler under load (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
    await query('TRUNCATE monitoring_targets RESTART IDENTITY CASCADE');
    const target = await createMonitoringTarget({ name: 'Load test', targetType: 'host', environment: 'test' });
    const kinds = [
      ...Array.from({ length: 120 }, (_, i) => `fast-${i}`),
      ...Array.from({ length: 20 }, (_, i) => `slow-${i}`),
      ...Array.from({ length: 10 }, (_, i) => `timeout-${i}`),
    ];
    for (const name of kinds) {
      await createMonitoringCheck({
        targetId: target.id,
        name,
        checkType: 'smtp',
        endpoint: `${name}.example.test`,
        port: 2525,
        intervalSeconds: INTERVAL_SECONDS,
        timeoutSeconds: 2,
        confirmationSeconds: 0,
        recoverySeconds: 0,
      }, 30000);
    }
  });

  afterAll(async () => {
    stopMonitoringScheduler();
    await closePool();
  });

  it('keeps 150 checks on schedule with slow and timing-out targets', async () => {
    startMonitoringScheduler();
    await delay(RUN_MS);
    stopMonitoringScheduler();
    // Let in-flight probes finish and record.
    await delay(TIMEOUT_MS + 1000);

    const perCheck = await query<{ name: string; observations: string; max_gap: number | null }>(
      `SELECT c.name, COUNT(o.id) AS observations,
              MAX(EXTRACT(EPOCH FROM o.observed_at - o.previous)) AS max_gap
       FROM monitoring_checks c
       LEFT JOIN (
         SELECT id, check_id, observed_at, LAG(observed_at) OVER (PARTITION BY check_id ORDER BY observed_at) AS previous
         FROM monitoring_observations
       ) o ON o.check_id = c.id
       GROUP BY c.name`
    );
    expect(perCheck.rows).toHaveLength(150);
    for (const row of perCheck.rows) {
      // Due at 0 s, 10 s and 20 s: at least three runs, each starting within
      // two seconds of its due time.
      expect(Number(row.observations), row.name).toBeGreaterThanOrEqual(3);
      expect(Number(row.max_gap ?? 0), row.name).toBeLessThan(INTERVAL_SECONDS + 2);
    }

    const issues = await query<{ name: string; issues: string }>(
      `SELECT c.name, COUNT(i.id) AS issues
       FROM monitoring_checks c LEFT JOIN monitoring_issues i ON i.check_id = c.id
       GROUP BY c.name`
    );
    for (const row of issues.rows) {
      expect(Number(row.issues), row.name).toBe(row.name.startsWith('timeout') ? 1 : 0);
    }

    const rollups = await query<{ mismatched: string }>(
      `SELECT COUNT(*) AS mismatched FROM (
         SELECT o.check_id, COUNT(*) AS raw, MAX(d.up_count + d.warning_count + d.down_count) AS rolled
         FROM monitoring_observations o
         JOIN monitoring_check_daily d ON d.check_id = o.check_id AND d.day = (o.observed_at AT TIME ZONE 'UTC')::date
         GROUP BY o.check_id
       ) counts WHERE raw <> rolled`
    );
    expect(Number(rollups.rows[0].mismatched)).toBe(0);

    const timeoutCheck = await query<{ id: number }>(`SELECT id FROM monitoring_checks WHERE name = 'timeout-0'`);
    const [today] = await getMonitoringCheckHistory(timeoutCheck.rows[0].id, 1);
    expect(today).toMatchObject({ up: 0, warning: 0, availability: 0, averageResponseTimeMs: TIMEOUT_MS, maxResponseTimeMs: TIMEOUT_MS });
  }, RUN_MS + 30_000);

  it('prunes raw observations and daily rollups past retention', async () => {
    const { rows: [check] } = await query<{ id: number }>(`SELECT id FROM monitoring_checks WHERE name = 'fast-0'`);
    await query(
      `INSERT INTO monitoring_observations (check_id, status, response_time_ms, observed_at)
       SELECT $1, 'up', 5, CURRENT_TIMESTAMP - INTERVAL '40 days' - (n * INTERVAL '1 minute')
       FROM generate_series(1, 25000) n`,
      [check.id]
    );
    await query(
      `INSERT INTO monitoring_check_daily (check_id, day, up_count) VALUES ($1, CURRENT_DATE - 500, 10)`,
      [check.id]
    );
    const before = await query<{ count: string }>(`SELECT COUNT(*) FROM monitoring_observations WHERE observed_at >= CURRENT_TIMESTAMP - INTERVAL '30 days'`);

    const removed = await pruneMonitoringHistory(30, 400);

    expect(removed).toEqual({ observations: 25000, days: 1 });
    const after = await query<{ count: string }>(`SELECT COUNT(*) FROM monitoring_observations`);
    expect(after.rows[0].count).toBe(before.rows[0].count);
    const days = await query<{ count: string }>(`SELECT COUNT(*) FROM monitoring_check_daily WHERE day < CURRENT_DATE - 400`);
    expect(days.rows[0].count).toBe('0');
  });
});
