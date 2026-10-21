import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StateRow } from '../../db/queries/telemetry-alert-rules.js';
import type { TelemetryAlertIssue, TelemetryAlertRule } from '../../types/telemetry-alerts.js';

const client = { query: vi.fn(), release: vi.fn() };
vi.mock('../../db/connection.js', () => ({ getClient: vi.fn(() => Promise.resolve(client)), query: vi.fn() }));
vi.mock('../../db/queries/alerts.js', () => ({ createAlertDelivery: vi.fn(), listAlertWebhooks: vi.fn() }));
vi.mock('../../db/queries/telemetry-alert-rules.js', () => ({
  clearDisabledTelemetryAlertStates: vi.fn(),
  deleteTelemetryAlertRule: vi.fn(),
  deleteTelemetryAlertState: vi.fn(),
  listEnabledTelemetryAlertRules: vi.fn(),
  listTelemetryAlertRulesByIds: vi.fn(),
  loadTelemetryAlertStates: vi.fn(),
  recordTelemetryAlertRuleEvaluation: vi.fn(),
  saveTelemetryAlertState: vi.fn(),
  updateTelemetryAlertRule: vi.fn(),
}));
vi.mock('../../db/queries/telemetry-alert-issues.js', () => ({
  cancelTelemetryAlertIssueFailures: vi.fn(),
  cancelTelemetryAlertIssueDismissals: vi.fn(),
  createTelemetryAlertIssue: vi.fn(),
  getTelemetryAlertIssue: vi.fn(),
  recordTelemetryAlertIssueEvent: vi.fn(),
  resolveTelemetryAlertIssue: vi.fn(),
  updateTelemetryAlertIssueObservation: vi.fn(),
  updateTelemetryAlertIssueSeverity: vi.fn(),
}));
vi.mock('../operations-settings.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../operations-settings.js')>(),
  operationsPolicy: () => ({ alertsEnabled: true }),
}));

const alertQueries = await import('../../db/queries/alerts.js');
const ruleQueries = await import('../../db/queries/telemetry-alert-rules.js');
const issueQueries = await import('../../db/queries/telemetry-alert-issues.js');
const {
  changeTelemetryAlertIssueDismissal,
  runTelemetryRuleEvaluation,
  seriesKey,
  updateTelemetryAlertRuleWithRecoveries,
} = await import('./telemetry-rules.js');

const now = new Date('2026-10-15T12:00:00Z');
const issueId = '11a00195-51c9-49a8-812a-31ae48541c23';
const labels = { host: 'mail-1' };
const key = seriesKey(labels);

const rule: TelemetryAlertRule = {
  id: 3,
  name: 'Telemetry load',
  description: null,
  query: 'max by (host) (node_load1)',
  comparator: '>',
  threshold: 6,
  forSeconds: 300,
  severity: 'warning',
  enabled: true,
  lastEvaluatedAt: null,
  lastError: null,
  createdAt: now.toISOString(),
  updatedAt: now.toISOString(),
};

const issue: TelemetryAlertIssue = {
  id: issueId,
  ruleId: rule.id,
  ruleName: rule.name,
  query: rule.query,
  comparator: rule.comparator,
  threshold: rule.threshold,
  forSeconds: rule.forSeconds,
  severity: rule.severity,
  seriesKey: key,
  labels,
  lastValue: 9,
  status: 'active',
  openedAt: now.toISOString(),
  lastSeenAt: now.toISOString(),
  dismissedAt: null,
  dismissedBy: null,
  dismissedUntil: null,
  dismissalReason: null,
  revision: 1,
  resolvedAt: null,
  resolutionReason: null,
  events: [],
};

const state: StateRow = {
  rule_id: rule.id,
  series_key: key,
  issue_id: issueId,
  labels_json: labels,
  status: 'firing',
  pending_since: now,
  firing_since: now,
  last_value: 9,
  last_seen_at: now,
};

const webhook = {
  id: 4,
  name: 'Operations',
  adapter: 'slack' as const,
  enabled: true,
  pausedAt: null,
  pausedUntil: null,
  notifyRecovery: true,
  subscriptions: [{ alertType: 'telemetry_rule' as const, enabled: true }],
};

beforeEach(() => {
  vi.clearAllMocks();
  client.query.mockImplementation((sql: string) => Promise.resolve({
    rows: sql.includes('pg_try_advisory_xact_lock') ? [{ locked: true }]
      : sql.includes('clock_timestamp') ? [{ now }] : [],
    rowCount: sql.includes('UPDATE telemetry_alert_issues') ? 1 : 0,
  }));
  vi.mocked(issueQueries.getTelemetryAlertIssue).mockResolvedValue(issue);
  vi.mocked(ruleQueries.listTelemetryAlertRulesByIds).mockResolvedValue([rule]);
  vi.mocked(ruleQueries.loadTelemetryAlertStates).mockResolvedValue([state]);
  vi.mocked(ruleQueries.clearDisabledTelemetryAlertStates).mockResolvedValue([]);
  vi.mocked(ruleQueries.listEnabledTelemetryAlertRules).mockResolvedValue([]);
  vi.mocked(alertQueries.listAlertWebhooks).mockResolvedValue([webhook]);
});

describe('telemetry issue dismiss and resume', () => {
  it('records a dismissal with actor, reason and expiry under the evaluator lock', async () => {
    const until = new Date(now.getTime() + 60 * 60_000);
    const result = await changeTelemetryAlertIssueDismissal({
      issueId,
      action: 'dismiss',
      expectedRevision: 1,
      actorAdminId: 12,
      actorName: 'Operator',
      reason: 'Load is expected during maintenance',
      until,
    });

    expect(result).toBe('updated');
    expect(client.query.mock.calls.map(([sql]) => sql)).toEqual([
      'BEGIN',
      'SELECT pg_advisory_xact_lock($1)',
      'SELECT clock_timestamp() AS now',
      expect.stringContaining("SET status = 'dismissed'"),
      'COMMIT',
    ]);
    expect(issueQueries.recordTelemetryAlertIssueEvent).toHaveBeenCalledWith(
      client, issueId, 'dismissed', 12, 'Load is expected during maintenance', now, 'Operator', until,
    );
    expect(issueQueries.cancelTelemetryAlertIssueFailures).toHaveBeenCalledWith(
      client, issueId, 'Telemetry alert issue dismissed',
    );
    expect(alertQueries.createAlertDelivery).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('revision-fences the Sentry resolution queued for a dismissal', async () => {
    vi.mocked(alertQueries.listAlertWebhooks).mockResolvedValue([{ ...webhook, adapter: 'sentry' }]);

    await changeTelemetryAlertIssueDismissal({
      issueId, action: 'dismiss', expectedRevision: 1, actorAdminId: 12,
    });

    expect(alertQueries.createAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `telemetry-issue:${issueId}:dismissed:2:${webhook.id}`,
      eventKind: 'dismissed',
      telemetryAlertIssueId: issueId,
      telemetryAlertIssueRevision: 2,
    }));
  });

  it('rejects a stale revision without changing or auditing the issue', async () => {
    vi.mocked(issueQueries.getTelemetryAlertIssue).mockResolvedValue({ ...issue, revision: 2 });

    const result = await changeTelemetryAlertIssueDismissal({
      issueId, action: 'dismiss', expectedRevision: 1, actorAdminId: 12,
    });

    expect(result).toBe('conflict');
    expect(client.query.mock.calls.at(-1)?.[0]).toBe('ROLLBACK');
    expect(issueQueries.recordTelemetryAlertIssueEvent).not.toHaveBeenCalled();
  });

  it('allows undo after an expiry timestamp but before the next evaluator tick', async () => {
    vi.mocked(issueQueries.getTelemetryAlertIssue).mockResolvedValue({
      ...issue,
      status: 'dismissed',
      dismissedUntil: new Date(now.getTime() - 1000).toISOString(),
      revision: 2,
    });

    const result = await changeTelemetryAlertIssueDismissal({
      issueId, action: 'resume', expectedRevision: 2, actorAdminId: 12, actorName: 'Operator',
    });

    expect(result).toBe('updated');
    expect(client.query).toHaveBeenCalledWith(expect.stringContaining("SET status = 'active'"), [issueId, 2]);
    expect(issueQueries.recordTelemetryAlertIssueEvent).toHaveBeenCalledWith(
      client, issueId, 'resumed', 12, null, now, 'Operator',
    );
    expect(issueQueries.cancelTelemetryAlertIssueDismissals).toHaveBeenCalledWith(
      client, issueId, 'Telemetry alert issue is active again',
    );
  });

  it('returns a dismissed issue to attention on a warning-to-critical rule change', async () => {
    vi.mocked(ruleQueries.listTelemetryAlertRulesByIds).mockResolvedValue([rule]);
    vi.mocked(ruleQueries.updateTelemetryAlertRule).mockResolvedValue({ ...rule, severity: 'critical' });

    const result = await updateTelemetryAlertRuleWithRecoveries(rule.id, { ...rule, severity: 'critical' });

    expect(result?.severity).toBe('critical');
    expect(issueQueries.updateTelemetryAlertIssueSeverity).toHaveBeenCalledWith(
      client, issueId, 'critical', now,
    );
  });
});

describe('fresh evaluation before resuming notifications', () => {
  it('queues one fresh alert after a complete successful evaluation confirms firing', async () => {
    vi.mocked(ruleQueries.listEnabledTelemetryAlertRules).mockResolvedValue([rule]);
    vi.mocked(ruleQueries.loadTelemetryAlertStates).mockResolvedValue([state]);
    client.query.mockImplementation((sql: string) => Promise.resolve({
      rows: sql.includes('pg_try_advisory_xact_lock') ? [{ locked: true }]
        : sql.includes('resume_notification_pending') ? [{
          id: issueId, rule_id: rule.id, rule_name: rule.name, query: rule.query, comparator: rule.comparator,
          threshold: rule.threshold, for_seconds: rule.forSeconds, severity: rule.severity, series_key: key,
          labels_json: labels, last_value: 9, opened_at: now, revision: 2,
        }]
          : [],
      rowCount: 1,
    }));

    await runTelemetryRuleEvaluation(now, vi.fn().mockResolvedValue({
      series: [{ labels, value: 9 }],
      truncated: false,
    }));

    expect(alertQueries.createAlertDelivery).toHaveBeenCalledOnce();
    expect(alertQueries.createAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      dedupeKey: `telemetry-issue:${issueId}:attention:2:${webhook.id}`,
      eventKind: 'failure',
      telemetryAlertIssueId: issueId,
    }));
    expect(issueQueries.updateTelemetryAlertIssueObservation).toHaveBeenCalledOnce();
    expect(issueQueries.recordTelemetryAlertIssueEvent).toHaveBeenCalledWith(
      client, issueId, 'dismissal_expired', null, null, now,
    );
  });

  it('does not resume or queue notifications after a query error or truncated result', async () => {
    vi.mocked(ruleQueries.listEnabledTelemetryAlertRules).mockResolvedValue([rule]);
    vi.mocked(ruleQueries.loadTelemetryAlertStates).mockResolvedValue([state]);
    const queryError = vi.fn().mockRejectedValue(new Error('telemetry store unavailable'));
    await runTelemetryRuleEvaluation(now, queryError);
    expect(alertQueries.createAlertDelivery).not.toHaveBeenCalled();

    client.query.mockImplementation((sql: string) => Promise.resolve({
      rows: sql.includes('pg_try_advisory_xact_lock') ? [{ locked: true }] : [],
      rowCount: 1,
    }));
    await runTelemetryRuleEvaluation(now, vi.fn().mockResolvedValue({
      series: [{ labels, value: 9 }],
      truncated: true,
    }));
    expect(alertQueries.createAlertDelivery).not.toHaveBeenCalled();
  });

  it('does not resume notifications when the firing series is absent', async () => {
    vi.mocked(ruleQueries.listEnabledTelemetryAlertRules).mockResolvedValue([rule]);
    vi.mocked(ruleQueries.loadTelemetryAlertStates).mockResolvedValue([state]);

    await runTelemetryRuleEvaluation(now, vi.fn().mockResolvedValue({
      series: [],
      truncated: false,
    }));

    expect(issueQueries.updateTelemetryAlertIssueObservation).not.toHaveBeenCalled();
    expect(issueQueries.recordTelemetryAlertIssueEvent).not.toHaveBeenCalled();
    expect(client.query.mock.calls.some(([sql]) => String(sql).includes('resume_notification_pending'))).toBe(false);
    expect(alertQueries.createAlertDelivery).not.toHaveBeenCalled();
  });

  it('resolves the occurrence when a successful observation no longer matches', async () => {
    vi.mocked(ruleQueries.listEnabledTelemetryAlertRules).mockResolvedValue([rule]);
    vi.mocked(ruleQueries.loadTelemetryAlertStates).mockResolvedValue([state]);

    await runTelemetryRuleEvaluation(now, vi.fn().mockResolvedValue({
      series: [{ labels, value: 2 }],
      truncated: false,
    }));

    expect(issueQueries.resolveTelemetryAlertIssue).toHaveBeenCalledWith(
      client, issueId, 'recovered', now,
    );
  });
});
