/**
 * Firing series must recover through the normal delivery path when their rule
 * is edited, disabled or deleted, so Slack hears the recovery and the Sentry
 * issue resolves. Editing a rule once dropped its state without a recovery.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateRow } from '../../db/queries/telemetry-alert-rules.js';
import type { AlertWebhook } from '../../types/alerts.js';
import type { TelemetryAlertRule } from '../../types/telemetry-alerts.js';

const client = { query: vi.fn(), release: vi.fn() };
vi.mock('../../db/connection.js', () => ({ getClient: vi.fn(() => Promise.resolve(client)), query: vi.fn() }));
vi.mock('../../db/queries/alerts.js', () => ({ createAlertDelivery: vi.fn(), listAlertWebhooks: vi.fn() }));
vi.mock('../operations-settings.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../operations-settings.js')>(),
  operationsPolicy: () => ({ alertsEnabled: true }),
}));
vi.mock('../../db/queries/telemetry-alert-rules.js', () => ({
  clearDisabledTelemetryAlertStates: vi.fn(),
  deleteTelemetryAlertRule: vi.fn(),
  deleteTelemetryAlertState: vi.fn(),
  listEnabledTelemetryAlertRules: vi.fn(),
  listTelemetryAlertRulesByIds: vi.fn(),
  loadTelemetryAlertStates: vi.fn(),
  recordTelemetryAlertRuleEvaluation: vi.fn(),
  saveTelemetryAlertState: vi.fn(),
}));

const alerts = await import('../../db/queries/alerts.js');
const queries = await import('../../db/queries/telemetry-alert-rules.js');
const { deleteTelemetryAlertRuleWithRecoveries, runTelemetryRuleEvaluation, seriesKey } = await import('./telemetry-rules.js');

const t0 = new Date('2026-10-15T12:00:00Z');
const at = (seconds: number) => new Date(t0.getTime() + seconds * 1000);

const rule: TelemetryAlertRule = {
  id: 3,
  name: 'Host stopped sending telemetry',
  description: null,
  query: 'time() - max by (host) (timestamp(up{host!~"cube-aibees"}))',
  comparator: '>',
  threshold: 300,
  forSeconds: 0,
  severity: 'critical',
  enabled: true,
  lastEvaluatedAt: null,
  lastError: null,
  createdAt: t0.toISOString(),
  updatedAt: t0.toISOString(),
};

function firing(host: string, overrides: Partial<StateRow> = {}): StateRow {
  const labels = { host };
  return {
    rule_id: rule.id,
    series_key: seriesKey(labels),
    labels_json: labels,
    status: 'firing',
    pending_since: t0,
    firing_since: t0,
    last_value: 900,
    last_seen_at: t0,
    ...overrides,
  };
}

const webhooks = [
  { id: 1, name: 'mission-control', adapter: 'slack' },
  { id: 2, name: 'Sentry', adapter: 'sentry' },
].map((webhook) => ({
  ...webhook,
  enabled: true,
  pausedAt: null,
  pausedUntil: null,
  notifyRecovery: true,
  subscriptions: [{ alertType: 'telemetry_rule', enabled: true }],
})) as unknown as AlertWebhook[];

function deliveries() {
  return vi.mocked(alerts.createAlertDelivery).mock.calls.map(([input]) => ({
    adapter: input.adapter,
    eventKind: input.eventKind,
    serviceName: input.serviceName,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
  client.query.mockImplementation((sql: string) => Promise.resolve({ rows: sql.includes('pg_try_advisory_xact_lock') ? [{ locked: true }] : [] }));
  vi.mocked(alerts.listAlertWebhooks).mockResolvedValue(webhooks);
  vi.mocked(queries.clearDisabledTelemetryAlertStates).mockResolvedValue([]);
  vi.mocked(queries.listEnabledTelemetryAlertRules).mockResolvedValue([]);
  vi.mocked(queries.listTelemetryAlertRulesByIds).mockResolvedValue([]);
  vi.mocked(queries.loadTelemetryAlertStates).mockResolvedValue([]);
});

describe('runTelemetryRuleEvaluation after a rule change', () => {
  it('recovers a host the edited query excludes on the next evaluation, and keeps the others firing', async () => {
    const edited = { ...rule, updatedAt: at(30).toISOString() };
    vi.mocked(queries.listEnabledTelemetryAlertRules).mockResolvedValue([edited]);
    vi.mocked(queries.loadTelemetryAlertStates).mockResolvedValue([firing('cube-aibees'), firing('cube-general')]);
    const runQuery = vi.fn().mockResolvedValue({ series: [{ labels: { host: 'cube-general' }, value: 960 }], truncated: false });

    expect(await runTelemetryRuleEvaluation(at(60), runQuery)).toBe(true);

    expect(deliveries()).toEqual([
      { adapter: 'slack', eventKind: 'recovery', serviceName: 'Host stopped sending telemetry · host=cube-aibees' },
      { adapter: 'sentry', eventKind: 'recovery', serviceName: 'Host stopped sending telemetry · host=cube-aibees' },
    ]);
    const payload = vi.mocked(alerts.createAlertDelivery).mock.calls[0][0].payload as { text: string };
    expect(payload.text).toContain('cleared for host=cube-aibees: the rule was edited');
    expect(queries.deleteTelemetryAlertState).toHaveBeenCalledWith(client, rule.id, seriesKey({ host: 'cube-aibees' }));
    expect(queries.saveTelemetryAlertState).toHaveBeenCalledWith(client, expect.objectContaining({ labels_json: { host: 'cube-general' }, status: 'firing' }));
  });

  it('recovers a series that no longer matches an edited condition', async () => {
    vi.mocked(queries.listEnabledTelemetryAlertRules).mockResolvedValue([{ ...rule, threshold: 1000, updatedAt: at(30).toISOString() }]);
    vi.mocked(queries.loadTelemetryAlertStates).mockResolvedValue([firing('cube-general')]);
    const runQuery = vi.fn().mockResolvedValue({ series: [{ labels: { host: 'cube-general' }, value: 960 }], truncated: false });

    await runTelemetryRuleEvaluation(at(60), runQuery);

    expect(deliveries().map((delivery) => delivery.eventKind)).toEqual(['recovery', 'recovery']);
  });

  it('recovers each firing series of a disabled rule, and drops pending ones quietly', async () => {
    vi.mocked(queries.clearDisabledTelemetryAlertStates).mockResolvedValue([
      firing('cube-aibees'),
      firing('cube-opptywaveai', { status: 'pending', firing_since: null }),
    ]);
    vi.mocked(queries.listTelemetryAlertRulesByIds).mockResolvedValue([{ ...rule, enabled: false }]);

    await runTelemetryRuleEvaluation(at(60), vi.fn());

    expect(queries.listTelemetryAlertRulesByIds).toHaveBeenCalledWith(client, [rule.id]);
    expect(deliveries()).toEqual([
      { adapter: 'slack', eventKind: 'recovery', serviceName: 'Host stopped sending telemetry · host=cube-aibees' },
      { adapter: 'sentry', eventKind: 'recovery', serviceName: 'Host stopped sending telemetry · host=cube-aibees' },
    ]);
    const payload = vi.mocked(alerts.createAlertDelivery).mock.calls[0][0].payload as { text: string };
    expect(payload.text).toContain('cleared for host=cube-aibees: the rule was disabled');
  });
});

describe('deleteTelemetryAlertRuleWithRecoveries', () => {
  it('waits for the evaluator, recovers firing series, then deletes the rule', async () => {
    vi.mocked(queries.listTelemetryAlertRulesByIds).mockResolvedValue([rule]);
    vi.mocked(queries.loadTelemetryAlertStates).mockResolvedValue([
      firing('cube-aibees'),
      firing('cube-opptywaveai', { status: 'pending', firing_since: null }),
    ]);
    vi.mocked(queries.deleteTelemetryAlertRule).mockResolvedValue(true);

    expect(await deleteTelemetryAlertRuleWithRecoveries(rule.id, at(60))).toBe(true);

    const statements = client.query.mock.calls.map(([sql]) => sql);
    expect(statements).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock($1)', 'COMMIT']);
    expect(deliveries()).toEqual([
      { adapter: 'slack', eventKind: 'recovery', serviceName: 'Host stopped sending telemetry · host=cube-aibees' },
      { adapter: 'sentry', eventKind: 'recovery', serviceName: 'Host stopped sending telemetry · host=cube-aibees' },
    ]);
    expect(vi.mocked(alerts.createAlertDelivery).mock.invocationCallOrder[1])
      .toBeLessThan(vi.mocked(queries.deleteTelemetryAlertRule).mock.invocationCallOrder[0]);
    expect(queries.deleteTelemetryAlertRule).toHaveBeenCalledWith(client, rule.id);
    expect(client.release).toHaveBeenCalled();
  });

  it('returns false for a missing rule without sending anything', async () => {
    expect(await deleteTelemetryAlertRuleWithRecoveries(99, at(60))).toBe(false);
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual(['BEGIN', 'SELECT pg_advisory_xact_lock($1)', 'ROLLBACK']);
    expect(alerts.createAlertDelivery).not.toHaveBeenCalled();
    expect(queries.deleteTelemetryAlertRule).not.toHaveBeenCalled();
  });
});
