/**
 * Postfix message counters and the Robin sample that rates are measured
 * against live in PostgreSQL, so several server replicas (or a restarted
 * server) agree on them. Skipped by default; run like the other
 * *.integration.test.ts files:
 *
 *   ROLLUP_IT_DB=1 DB_HOST=localhost DB_PORT=5433 DB_NAME=robin_test \
 *     DB_USER=test DB_PASSWORD=test npx vitest run src/services/metrics-poller.shared-state.integration.test.ts
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../db/schema.js';
import { closePool, query } from '../db/connection.js';
import { createFleetService } from '../db/queries/fleet-services.js';
import { ingestAgentMetrics, ingestPostfixLogLines } from './metrics-poller.js';

const SENT = 'postfix/smtp[1]: 4AB: to=<a@example.test>, relay=mx.example.test, status=sent (250 ok)';
const DEFERRED = 'postfix/smtp[1]: 4AC: to=<b@example.test>, relay=none, status=deferred (connect timeout)';

describe.skipIf(process.env.ROLLUP_IT_DB !== '1')('metrics state shared across server replicas (real PostgreSQL)', () => {
  const suffix = Date.now().toString(36);
  const created: number[] = [];

  beforeAll(async () => {
    await initializeSchema();
  }, 30000);

  afterAll(async () => {
    if (created.length) await query('DELETE FROM fleet_services WHERE id = ANY($1::int[])', [created]);
    await closePool();
  });

  it('counts concurrent Postfix log pushes once each, starting from the newest stored snapshot', async () => {
    const service = await createFleetService({ serviceId: `pf-shared-${suffix}`, serviceType: 'postfix', name: 'Shared counters' });
    created.push(service.id);
    await query(
      `INSERT INTO postfix_metrics_history (fleet_service_id, service_id, timestamp, reachable, messages_delivered, messages_deferred)
       VALUES ($1, $2, $3, true, 10, 2)`,
      [service.id, service.serviceId, new Date()],
    );

    // As if each push reached a different replica at the same moment.
    await Promise.all(Array.from({ length: 20 }, () => ingestPostfixLogLines(service.id, [SENT])));
    await ingestPostfixLogLines(service.id, [DEFERRED]);

    const { rows: [counters] } = await query<{ messages_delivered: string; messages_deferred: string }>(
      'SELECT messages_delivered, messages_deferred FROM postfix_message_counters WHERE fleet_service_id = $1',
      [service.id],
    );
    expect(Number(counters?.messages_delivered)).toBe(30);
    expect(Number(counters?.messages_deferred)).toBe(3);

    // The next agent snapshot stores the shared totals.
    await ingestAgentMetrics({ id: service.id, serviceId: service.serviceId, serviceType: 'postfix' }, { postqueue: 'Mail queue is empty' });
    const { rows: [stored] } = await query<{ messages_delivered: string }>(
      'SELECT messages_delivered FROM postfix_metrics_history WHERE fleet_service_id = $1 ORDER BY timestamp DESC, id DESC LIMIT 1',
      [service.id],
    );
    expect(Number(stored?.messages_delivered)).toBe(30);
  });

  it('measures a Robin sample against the newest stored one', async () => {
    const service = await createFleetService({ serviceId: `robin-shared-${suffix}`, serviceType: 'robin', name: 'Shared rates' });
    created.push(service.id);
    await query(
      `INSERT INTO robin_metrics_history (fleet_service_id, service_id, timestamp, email_receipt_start, process_cpu_time_ns, system_cpu_count)
       VALUES ($1, $2, $3, 100, 1000000000, 2)`,
      [service.id, service.serviceId, new Date(Date.now() - 60_000)],
    );

    const snapshot = await ingestAgentMetrics(
      { id: service.id, serviceId: service.serviceId, serviceType: 'robin' },
      { prometheus: 'robin_email_receipt_start_total 160\nprocess_cpu_time_ns_total 31000000000\nsystem_cpu_count 2\n' },
    );

    // 60 messages and 30 s of CPU on 2 cores over about a minute.
    const { rows: [stored] } = await query<{ rate_email_start: number; process_cpu_time_ns: string }>(
      'SELECT rate_email_start, process_cpu_time_ns FROM robin_metrics_history WHERE fleet_service_id = $1 ORDER BY timestamp DESC LIMIT 1',
      [service.id],
    );
    expect(stored?.rate_email_start).toBeGreaterThan(55);
    expect(stored?.rate_email_start).toBeLessThan(65);
    expect(Number(stored?.process_cpu_time_ns)).toBe(31_000_000_000);
    expect((snapshot as { processCpuUsage: number }).processCpuUsage).toBeCloseTo(0.25, 1);
  });
});
