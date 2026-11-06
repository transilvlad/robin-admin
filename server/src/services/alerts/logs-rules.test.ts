import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { LogsAlertRule } from '../../types/logs.js';
import { getClient } from '../../db/connection.js';
import { getConfig } from '../../db/queries/config.js';
import { getLogsAlertRuleById, listAllLogsAlertRules, recordLogsAlertEvaluation } from '../../db/queries/logs.js';
import { operationsPolicy } from '../operations-settings.js';
import { createAlertDelivery, listAlertWebhooks } from '../../db/queries/alerts.js';
import type { AlertWebhook } from '../../types/alerts.js';
import { getLogsStoreStatus } from '../logs-store.js';
import { logsAlertMatches, runLogsAlertEvaluation, transitionLogsAlert } from './logs-rules.js';

vi.mock('../../db/connection.js', () => ({ getClient: vi.fn() }));
vi.mock('../../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../../db/queries/logs.js', () => ({
  deleteLogsAlertRule: vi.fn(),
  getLogsAlertRuleById: vi.fn(),
  listAllLogsAlertRules: vi.fn(),
  recordLogsAlertEvaluation: vi.fn(),
}));
vi.mock('../../db/queries/alerts.js', () => ({
  createAlertDelivery: vi.fn(),
  listAlertWebhooks: vi.fn(),
}));
vi.mock('../operations-settings.js', () => ({ operationsPolicy: vi.fn() }));
vi.mock('../logs-store.js', () => ({ countLogs: vi.fn(), getLogsStoreStatus: vi.fn() }));

const healthyStatus = {
  enabled: true,
  reachable: true,
  storageBytes: 0,
  maxDiskBytes: null,
  retentionDays: 30,
  rowsIngested24h: 0,
  oldestLogAt: null,
  metrics: { rowsIngestedTotal: 0, bytesIngestedTotal: 0, rowsDroppedTotal: 0, streamsCreatedTotal: 0 },
  write: {
    queuedLines: 0, queuedBytes: 0, quarantinedBatches: 0, quarantinedLines: 0, quarantinedBytes: 0,
    usedBytes: 0, capacityBytes: 1024, oldestQueuedAt: null, retryingBatches: 0, uncertainBatches: 0,
    uncertainDeliveries24h: 0, droppedLines24h: 0, rejectedLines24h: 0, discardedLines24h: 0, lastDeliveredAt: null,
    lastErrorAt: null, lastError: null,
  },
};

const rule: LogsAlertRule = {
  id: 1,
  name: 'Repeated failures',
  description: null,
  query: 'error',
  windowSeconds: 300,
  comparator: '>=',
  threshold: 5,
  forSeconds: 120,
  enabled: true,
  status: 'pending',
  lastValue: 5,
  generation: 0,
  pendingSince: '2026-11-03T10:00:00.000Z',
  firingSince: null,
  lastEvaluatedAt: null,
  lastError: null,
  createdAt: '2026-11-03T09:00:00.000Z',
  updatedAt: '2026-11-03T09:00:00.000Z',
};

describe('transitionLogsAlert', () => {
  it.each([
    ['>', 6, 5, true], ['>=', 5, 5, true], ['<', 4, 5, true],
    ['<=', 5, 5, true], ['==', 5, 5, true], ['!=', 4, 5, true],
    ['>', 5, 5, false], ['<', 5, 5, false], ['==', 4, 5, false],
  ] as const)('compares %s counts', (comparator, value, threshold, matches) => {
    expect(logsAlertMatches(value, comparator, threshold)).toBe(matches);
  });

  it('starts a new hold after a failed evaluation or edited condition', () => {
    expect(transitionLogsAlert({ ...rule, pendingSince: null }, 6, new Date('2026-11-03T11:00:00Z'))).toMatchObject({
      status: 'pending', pendingSince: new Date('2026-11-03T11:00:00Z'), event: null,
    });
  });

  it('does not repeat firing notifications and recovers when the condition clears', () => {
    const firing = { ...rule, status: 'firing' as const, generation: 1 };
    expect(transitionLogsAlert(firing, 6, new Date())).toMatchObject({ status: 'firing', event: null, generation: 1 });
    expect(transitionLogsAlert(firing, 0, new Date())).toMatchObject({ status: 'ok', event: 'recovery', generation: 1 });
  });
  it('fires after the condition remains true for the hold period', () => {
    expect(transitionLogsAlert(rule, 6, new Date('2026-11-03T10:02:00.000Z'))).toMatchObject({
      status: 'firing',
      generation: 1,
      event: 'failure',
      firingSince: new Date('2026-11-03T10:00:00.000Z'),
    });
  });

  it('clears a disabled firing rule and emits one recovery transition', () => {
    expect(transitionLogsAlert({ ...rule, enabled: false, status: 'firing' }, 5, new Date())).toMatchObject({
      status: 'ok',
      pendingSince: null,
      firingSince: null,
      generation: 0,
      event: 'recovery',
    });
  });
});

describe('runLogsAlertEvaluation', () => {
  function makeClient(locked = true) {
    return {
      query: vi.fn(async (sql: string) => ({
        rows: sql.includes('pg_try_advisory_lock') ? [{ locked }]
          : sql.includes('pg_advisory_unlock') ? [{ unlocked: true }]
            : sql.includes('FROM logs_pipeline_health_state') ? [{
              degraded: false, failing_checks: 0, healthy_checks: 0, generation: '0',
            }]
            : [],
      })),
      release: vi.fn(),
    };
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getConfig).mockResolvedValue({ logsEnabled: true } as never);
    vi.mocked(operationsPolicy).mockReturnValue({ alertsEnabled: false } as never);
    vi.mocked(getLogsStoreStatus).mockResolvedValue(healthyStatus as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([{ ...rule, enabled: false, status: 'firing' }]);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue({ ...rule, enabled: false, status: 'firing' });
  });

  it('clears disabled rules without querying VictoriaLogs', async () => {
    const client = makeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    const count = vi.fn();

    await expect(runLogsAlertEvaluation(new Date('2026-11-03T10:05:00.000Z'), count)).resolves.toBe(true);

    expect(count).not.toHaveBeenCalled();
    expect(recordLogsAlertEvaluation).toHaveBeenCalledWith(client, expect.objectContaining({
      id: rule.id,
      status: 'ok',
      pendingSince: null,
      firingSince: null,
    }));
    expect(client.query).toHaveBeenCalledWith('COMMIT');
    expect(client.query).toHaveBeenCalledWith('SELECT pg_advisory_unlock($1) AS unlocked', [846_255_034]);
    expect(client.release).toHaveBeenCalled();
  });

  it('runs VictoriaLogs queries outside database transactions', async () => {
    const client = makeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([rule]);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue(rule);
    const count = vi.fn(async () => {
      expect(client.query).not.toHaveBeenCalledWith('BEGIN');
      return 6;
    });

    await expect(runLogsAlertEvaluation(new Date('2026-11-03T10:02:00Z'), count)).resolves.toBe(true);

    expect(count).toHaveBeenCalledOnce();
    expect(client.query).toHaveBeenCalledWith('BEGIN');
  });

  it('pauses rule transitions and restarts the pending hold while ingestion data is incomplete', async () => {
    const client = makeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([rule]);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue(rule);
    vi.mocked(getLogsStoreStatus).mockResolvedValue({
      ...healthyStatus,
      write: { ...healthyStatus.write, queuedLines: 1, queuedBytes: 50 },
    } as never);
    const count = vi.fn();

    await runLogsAlertEvaluation(new Date('2026-11-03T10:03:00Z'), count);

    expect(count).not.toHaveBeenCalled();
    expect(recordLogsAlertEvaluation).toHaveBeenCalledWith(client, expect.objectContaining({
      status: 'pending',
      value: rule.lastValue,
      pendingSince: null,
      error: expect.stringContaining('incomplete'),
    }));
  });

  it('notifies for a persistent ingestion backlog after two checks, then confirms recovery', async () => {
    const state = { degraded: false, failing_checks: 0, healthy_checks: 0, generation: '0' };
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
        if (sql.includes('FROM logs_pipeline_health_state')) return { rows: [{ ...state }] };
        if (sql.includes('UPDATE logs_pipeline_health_state')) {
          [state.degraded, state.failing_checks, state.healthy_checks, state.generation] = values!.slice(0, 4) as [boolean, number, number, string];
          return { rows: [] };
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([]);
    vi.mocked(operationsPolicy).mockReturnValue({ alertsEnabled: true } as never);
    vi.mocked(getLogsStoreStatus).mockResolvedValue({
      ...healthyStatus,
      write: { ...healthyStatus.write, queuedLines: 1, queuedBytes: 50 },
    } as never);
    vi.mocked(listAlertWebhooks).mockResolvedValue([{
      id: 2, name: 'Operations', adapter: 'generic', enabled: true, pausedAt: null, pausedUntil: null,
      notifyRecovery: true, subscriptions: [{ alertType: 'logs_pipeline_health', enabled: true }],
    } as AlertWebhook]);

    await runLogsAlertEvaluation(new Date('2026-11-03T10:00:00Z'));
    expect(createAlertDelivery).not.toHaveBeenCalled();
    await runLogsAlertEvaluation(new Date('2026-11-03T10:01:00Z'));
    expect(createAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'logs-pipeline:1:failure:2',
      alertType: 'logs_pipeline_health',
      eventKind: 'failure',
    }));

    vi.mocked(getLogsStoreStatus).mockResolvedValue(healthyStatus as never);
    await runLogsAlertEvaluation(new Date('2026-11-03T10:02:00Z'));
    expect(createAlertDelivery).toHaveBeenCalledTimes(1);
    await runLogsAlertEvaluation(new Date('2026-11-03T10:03:00Z'));
    expect(createAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'logs-pipeline:1:recovery:2',
      alertType: 'logs_pipeline_health',
      eventKind: 'recovery',
    }));
  });

  it('baselines cumulative dropped rows and suppresses counts only after a recent increase', async () => {
    const state = {
      degraded: false,
      failing_checks: 0,
      healthy_checks: 0,
      generation: '0',
      dropped_rows_total: null as string | null,
      dropped_observed_at: null as Date | null,
    };
    const client = {
      query: vi.fn(async (sql: string, values?: unknown[]) => {
        if (sql.includes('pg_try_advisory_lock')) return { rows: [{ locked: true }] };
        if (sql.includes('pg_advisory_unlock')) return { rows: [{ unlocked: true }] };
        if (sql.includes('FROM logs_pipeline_health_state')) return { rows: [{ ...state }] };
        if (sql.includes('UPDATE logs_pipeline_health_state')) {
          [state.degraded, state.failing_checks, state.healthy_checks, state.generation,
            state.dropped_rows_total, state.dropped_observed_at] = values!.slice(0, 6) as [
            boolean, number, number, string, string | null, Date | null,
          ];
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([rule]);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue(rule);
    const runCount = vi.fn().mockResolvedValue(0);
    const now = new Date('2026-11-03T10:00:00Z');

    vi.mocked(getLogsStoreStatus).mockResolvedValue({
      ...healthyStatus,
      metrics: { ...healthyStatus.metrics, rowsDroppedTotal: 25 },
    } as never);
    await runLogsAlertEvaluation(now, runCount);
    expect(state.dropped_rows_total).toBe('25');
    expect(state.dropped_observed_at).toBeNull();
    expect(runCount).toHaveBeenCalledOnce();

    vi.mocked(getLogsStoreStatus).mockResolvedValue({
      ...healthyStatus,
      metrics: { ...healthyStatus.metrics, rowsDroppedTotal: 26 },
    } as never);
    await runLogsAlertEvaluation(new Date(now.getTime() + 60_000), runCount);
    expect(state.dropped_observed_at).toEqual(new Date(now.getTime() + 60_000));
    expect(runCount).toHaveBeenCalledOnce();
    expect(createAlertDelivery).not.toHaveBeenCalled();

    await runLogsAlertEvaluation(new Date(now.getTime() + 120_000), runCount);
    expect(state.degraded).toBe(true);
    await runLogsAlertEvaluation(new Date(now.getTime() + 24 * 60 * 60 * 1000 + 120_000), runCount);
    expect(state.degraded).toBe(true);
    await runLogsAlertEvaluation(new Date(now.getTime() + 24 * 60 * 60 * 1000 + 180_000), runCount);
    expect(state.degraded).toBe(false);
    expect(runCount).toHaveBeenCalledTimes(2);
  });

  it.each(['pending', 'firing'] as const)('preserves %s status on query failure without advancing a pending hold', async (status) => {
    const client = makeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([{ ...rule, status }]);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue({ ...rule, status });
    const count = vi.fn().mockRejectedValue(new Error('Store unavailable'));
    await runLogsAlertEvaluation(new Date(), count);
    expect(recordLogsAlertEvaluation).toHaveBeenCalledWith(client, expect.objectContaining({
      status,
      pendingSince: null,
      error: 'Store unavailable',
    }));
  });

  it.each(['generic', 'slack', 'sentry'] as const)('queues subscribed %s notifications through the shared delivery outbox', async (adapter) => {
    const client = makeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(operationsPolicy).mockReturnValue({ alertsEnabled: true } as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([rule]);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue(rule);
    vi.mocked(listAlertWebhooks).mockResolvedValue([{
      id: 2, name: 'Operations', adapter, enabled: true, pausedAt: null, pausedUntil: null,
      notifyRecovery: true, subscriptions: [{ alertType: 'logs_rule', enabled: true }],
    } as AlertWebhook]);
    await runLogsAlertEvaluation(new Date('2026-11-03T10:02:00Z'), vi.fn().mockResolvedValue(6));
    expect(createAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: 'logs-rule:1:1:failure:2', alertType: 'logs_rule', eventKind: 'failure', adapter, client,
    }));
    expect(client.query).toHaveBeenCalledWith('COMMIT');
  });

  it('does not queue recovery for destinations with recovery disabled', async () => {
    const client = makeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(operationsPolicy).mockReturnValue({ alertsEnabled: true } as never);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue({ ...rule, status: 'ok' });
    vi.mocked(listAlertWebhooks).mockResolvedValue([{
      id: 2, adapter: 'generic', enabled: true, pausedAt: null, pausedUntil: null,
      notifyRecovery: false, subscriptions: [{ alertType: 'logs_rule', enabled: true }],
    } as AlertWebhook]);
    await runLogsAlertEvaluation(new Date(), vi.fn());
    expect(createAlertDelivery).not.toHaveBeenCalled();
  });

  it('rolls back without evaluating when another instance holds the lock', async () => {
    const client = makeClient(false);
    vi.mocked(getClient).mockResolvedValue(client as never);
    await expect(runLogsAlertEvaluation()).resolves.toBe(false);
    expect(listAllLogsAlertRules).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('SELECT pg_try_advisory_lock($1) AS locked', [846_255_034]);
    expect(client.query).not.toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('rolls back the transition if queuing the delivery fails', async () => {
    const client = makeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(operationsPolicy).mockReturnValue({ alertsEnabled: true } as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([rule]);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue(rule);
    vi.mocked(listAlertWebhooks).mockRejectedValueOnce(new Error('DB unavailable'));
    await expect(runLogsAlertEvaluation(new Date(), vi.fn().mockResolvedValue(6))).rejects.toThrow('DB unavailable');
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
    expect(client.release).toHaveBeenCalled();
  });

  it('does not apply an evaluation after the rule definition changes during the store query', async () => {
    const client = makeClient();
    vi.mocked(getClient).mockResolvedValue(client as never);
    vi.mocked(listAllLogsAlertRules).mockResolvedValue([rule]);
    vi.mocked(getLogsAlertRuleById).mockResolvedValue({
      ...rule,
      query: 'warning',
      updatedAt: '2026-11-03T10:00:00.000Z',
    });
    const count = vi.fn().mockResolvedValue(10);

    await expect(runLogsAlertEvaluation(new Date(), count)).resolves.toBe(true);

    expect(count).toHaveBeenCalledOnce();
    expect(recordLogsAlertEvaluation).not.toHaveBeenCalled();
    expect(client.query).toHaveBeenCalledWith('ROLLBACK');
  });
});
