import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../connection.js';
import { createAlertDelivery } from './alerts.js';
import { syncAutomaticStatusPageReports } from './status-page.js';
import { closeStaleMonitoringIssue, createMonitoringCheck, evaluateMonitoringCheckLocations, getMonitoringCheckHistory, getMonitoringCheckSecrets, listDueMonitoringChecks, recordMonitoringObservation, updateMonitoringCheck } from './monitoring.js';
import { encryptStoredSecret } from './secret-crypto.js';
import type { MonitoringCheck } from '../../types/monitoring.js';

vi.mock('../connection.js', () => ({
  getClient: vi.fn(),
  query: vi.fn(),
}));

vi.mock('./alerts.js', () => ({
  createAlertDelivery: vi.fn(),
}));

vi.mock('./status-page.js', () => ({
  syncAutomaticStatusPageReports: vi.fn(),
}));

const observedAt = new Date('2026-09-22T12:00:00.000Z');

function queryResult<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount } as never;
}

function mockQueryRows<T>(rows: T[], rowCount = rows.length) {
  vi.mocked(query).mockResolvedValueOnce(queryResult(rows, rowCount));
}

function monitoringCheck(overrides: Partial<MonitoringCheck> = {}): MonitoringCheck {
  return {
    id: 7,
    targetId: 2,
    targetName: 'Local Docker suite',
    targetEnvironment: 'local',
    name: 'Suite Robin SMTPS 465',
    checkType: 'smtp',
    endpoint: 'suite-robin',
    port: 465,
    intervalSeconds: 60,
    timeoutSeconds: 5,
    confirmationSeconds: 0,
    recoverySeconds: 0,
    placementMode: 'all',
    locationIds: [],
    quorum: 0,
    certExpiryDays: 14,
    tlsMode: 'strict',
    certificateErrorMode: 'down',
    allowPrivate: false,
    options: {},
    secretHeaderNames: [],
    enabled: true,
    pausedAt: null,
    pauseReason: null,
    currentStatus: 'up',
    targetEnabled: true,
    statusSince: new Date('2026-09-22T11:59:00.000Z'),
    lastRunAt: null,
    nextRunAt: null,
    lastResponseTimeMs: null,
    lastError: null,
    consecutiveFailures: 0,
    consecutiveSuccesses: 0,
    createdAt: new Date('2026-09-22T11:00:00.000Z'),
    updatedAt: new Date('2026-09-22T11:00:00.000Z'),
    ...overrides,
  };
}

function httpCheckRow(certificateErrorMode: 'down' | 'warning' = 'down') {
  return { id: 7, target_id: 2, target_name: 'Test', target_environment: 'test', name: 'Service health', check_type: 'http', endpoint: 'https://example.test', port: null,
    interval_seconds: 60, timeout_seconds: 10, confirmation_seconds: 0, recovery_seconds: 0, placement_mode: 'all', location_ids: [], quorum: 0, cert_expiry_days: null, tls_mode: 'strict', certificate_error_mode: certificateErrorMode, allow_private: false,
    options_json: {}, secret_header_names: ['authorization'], enabled: true, paused_at: null, pause_reason: null, current_status: 'unknown', target_enabled: true,
    status_since: null, last_run_at: null, next_run_at: null, last_response_time_ms: null, last_error: null, consecutive_failures: 0, consecutive_successes: 0, created_at: observedAt, updated_at: observedAt };
}
describe('monitoring credentials', () => {
  const key = process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
  beforeEach(() => { vi.clearAllMocks(); vi.mocked(query).mockReset(); process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'test-only-monitoring-encryption-key'; });
  afterEach(() => { if (key === undefined) delete process.env.ROBIN_ADMIN_ENCRYPTION_KEY; else process.env.ROBIN_ADMIN_ENCRYPTION_KEY = key; });
  it('encrypts credential headers at rest and exposes only their names', async () => {
    mockQueryRows([{ id: 1, enabled: true, shadow: false }]); mockQueryRows([{ id: 7 }]); mockQueryRows([httpCheckRow()]);
    const result = await createMonitoringCheck({ targetId: 2, name: 'Service health', checkType: 'http', endpoint: 'https://example.test', secretHeaders: { Authorization: 'Bearer fixture-secret' } });
    const encrypted = vi.mocked(query).mock.calls[1][1]![18] as string;
    expect(encrypted).not.toContain('fixture-secret');
    expect(result.secretHeaderNames).toEqual(['authorization']);
    expect(result.certificateErrorMode).toBe('down');
    expect(vi.mocked(query).mock.calls[1][1]![14]).toBe('down');
    expect(JSON.stringify(result)).not.toContain('fixture-secret');
    mockQueryRows([{ encrypted_headers: encrypted }]);
    expect(await getMonitoringCheckSecrets(7)).toEqual({ authorization: 'Bearer fixture-secret' });
  });
  it('preserves omitted credentials and explicitly deletes cleared headers', async () => {
    const encrypted = encryptStoredSecret(JSON.stringify({ authorization: 'Bearer fixture-secret' }));
    mockQueryRows([httpCheckRow()]); mockQueryRows([{ encrypted_headers: encrypted }]); mockQueryRows([{ id: 7 }]); mockQueryRows([httpCheckRow()]);
    await updateMonitoringCheck(7, { name: 'Renamed' });
    expect(vi.mocked(query).mock.calls[2][0]).not.toContain('encrypted_headers');
    vi.clearAllMocks();
    mockQueryRows([httpCheckRow()]); mockQueryRows([{ encrypted_headers: encrypted }]); mockQueryRows([{ id: 7 }]); mockQueryRows([{ ...httpCheckRow(), secret_header_names: [] }]);
    await updateMonitoringCheck(7, { secretHeaders: { Authorization: null } });
    expect(vi.mocked(query).mock.calls[2][1]).toEqual([null, '[]', 7]);
  });
  it('persists an explicitly selected certificate error warning mode', async () => {
    mockQueryRows([{ id: 1, enabled: true, shadow: false }]); mockQueryRows([{ id: 7 }]); mockQueryRows([httpCheckRow('warning')]);
    const result = await createMonitoringCheck({
      targetId: 2,
      name: 'Service health',
      checkType: 'http',
      endpoint: 'https://example.test',
      certificateErrorMode: 'warning',
    });
    expect(result.certificateErrorMode).toBe('warning');
    expect(vi.mocked(query).mock.calls[1][1]![14]).toBe('warning');
  });
  it('rejects transport downgrades while credentials remain stored', async () => {
    mockQueryRows([httpCheckRow()]); mockQueryRows([{ encrypted_headers: encryptStoredSecret(JSON.stringify({ authorization: 'secret' })) }]);
    await expect(updateMonitoringCheck(7, { endpoint: 'http://example.test' })).rejects.toThrow('HTTPS');
    expect(vi.mocked(query).mock.calls).toHaveLength(2);
  });
});

function observationRow(status: 'up' | 'down' | 'warning', error: string | null = null) {
  return {
    id: 31,
    check_id: 7,
    location_id: 1,
    status,
    error_code: status === 'down' ? 'probe_failed' : null,
    response_time_ms: 48,
    error,
    details_json: { tlsAuthorizationError: 'DEPTH_ZERO_SELF_SIGNED_CERT', certValidTo: '2026-12-01T00:00:00.000Z' },
    observed_at: observedAt,
  };
}

function issueRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 55,
    check_id: 7,
    check_name: 'Suite Robin SMTPS 465',
    target_name: 'Local Docker suite',
    status: 'open',
    severity: 'warning',
    summary: 'Suite Robin SMTPS 465 is warning',
    details_json: { error: 'TLS authorization failed: DEPTH_ZERO_SELF_SIGNED_CERT' },
    opened_at: new Date('2026-09-22T11:50:00.000Z'),
    closed_at: null,
    updated_at: new Date('2026-09-22T11:55:00.000Z'),
    ...overrides,
  };
}

function monitoringWebhookRows(notifyRecovery = true) {
  return [
    {
      id: 3,
      name: 'Ops Slack',
      adapter: 'slack',
      notify_recovery: notifyRecovery,
      subscriptions_json: [{ alertType: 'monitoring_issue', enabled: true }],
    },
    {
      id: 4,
      name: 'Fleet only',
      adapter: 'generic',
      notify_recovery: true,
      subscriptions_json: [{ alertType: 'service_unavailable', enabled: true }],
    },
  ];
}

describe('monitoring query state transitions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockReset();
    vi.useFakeTimers();
    vi.setSystemTime(observedAt);
  });
  afterEach(() => vi.useRealTimers());

  function mockCombinedLocation(status: 'up' | 'down' | 'warning', error: string | null = null) {
    mockQueryRows([{
      id: 31,
      location_id: 1,
      location_name: 'Local',
      region: null,
      status,
      error_code: status === 'down' ? 'probe_failed' : null,
      error,
      details_json: {},
      response_time_ms: 48,
      observed_at: observedAt,
      received_at: observedAt,
    }]);
  }

  it('persists observations under the Local location and returns stable error codes', async () => {
    mockQueryRows([{
      ...observationRow('down', 'Probe failed'),
      location_id: 1,
      error_code: 'probe_failed',
    }]);
    mockQueryRows([]);
    mockCombinedLocation('down', 'Probe failed');
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([]);

    const observation = await recordMonitoringObservation({
      check: monitoringCheck({ confirmationSeconds: 30 }),
      status: 'down',
      responseTimeMs: 48,
      error: 'Probe failed',
      errorCode: 'probe_failed',
      observedAt,
    });

    expect(observation).toMatchObject({ locationId: 1, errorCode: 'probe_failed' });
    const insertCall = vi.mocked(query).mock.calls[0];
    expect(String(insertCall[0])).toContain("SELECT id FROM monitoring_locations WHERE location_key = 'local'");
    expect(insertCall[1]).toEqual([7, 'down', 'probe_failed', 48, 'Probe failed', '{}', observedAt]);
  });

  it('opens a monitoring issue after confirmation and enqueues one subscribed alert delivery', async () => {
    const check = monitoringCheck();
    mockQueryRows([observationRow('warning', 'TLS authorization failed: DEPTH_ZERO_SELF_SIGNED_CERT')]);
    mockQueryRows([]);
    mockCombinedLocation('warning', 'TLS authorization failed: DEPTH_ZERO_SELF_SIGNED_CERT');
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([{ id: '55' }]);
    mockQueryRows([{ value: 'true' }]);
    mockQueryRows(monitoringWebhookRows());
    mockQueryRows([]);

    await recordMonitoringObservation({
      check,
      status: 'warning',
      responseTimeMs: 48,
      error: 'TLS authorization failed: DEPTH_ZERO_SELF_SIGNED_CERT',
      details: { certValidTo: '2026-12-01T00:00:00.000Z' },
      observedAt,
    });

    const insertIssueCall = vi.mocked(query).mock.calls.find(([statement]) => String(statement).includes('INSERT INTO monitoring_issues'));
    expect(insertIssueCall?.[1]).toEqual([
      7,
      'warning',
      'Suite Robin SMTPS 465 is warning',
      expect.stringContaining('"observationId":31'),
      observedAt,
    ]);
    expect(createAlertDelivery).toHaveBeenCalledTimes(1);
    expect(syncAutomaticStatusPageReports).toHaveBeenCalledTimes(1);
    expect(createAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      alertType: 'monitoring_issue',
      eventKind: 'failure',
      dedupeKey: 'monitoring:55:failure:3',
      webhookId: 3,
      monitoringIssueId: 55,
      serviceType: 'monitoring',
      serviceId: 'monitoring-check-7',
    }));
    const delivery = vi.mocked(createAlertDelivery).mock.calls[0][0] as { payload: Record<string, unknown> };
    expect(delivery.payload.text).toContain('Monitoring warning: local / Local Docker suite');
    expect(delivery.payload.text).toContain('Suite Robin SMTPS 465 is warning');
    expect(delivery.payload.robin_alert).toMatchObject({
      monitoring: {
        targetName: 'Local Docker suite',
        targetEnvironment: 'local',
        endpointDisplay: 'suite-robin:465',
      },
    });
    expect(JSON.stringify(delivery.payload.blocks)).toContain('*Suite Robin SMTPS 465 is warning*');
    expect(JSON.stringify(delivery.payload.blocks)).toContain('*Endpoint*');
    expect(JSON.stringify(delivery.payload.blocks)).toContain('*Cause*');
    expect(JSON.stringify(delivery.payload.blocks)).toContain('*Observed*');
    expect(JSON.stringify(delivery.payload.blocks)).toContain('suite-robin:465');
    expect(JSON.stringify(delivery.payload.blocks)).not.toContain('*Protocol*');
    expect(JSON.stringify(delivery.payload.blocks)).not.toContain('Monitoring check 7');
  });

  it('leaves checks of a disabled target alone instead of waiting for probe locations', async () => {
    await evaluateMonitoringCheckLocations(7, true, monitoringCheck({ targetEnabled: false }));
    expect(query).not.toHaveBeenCalled();
  });

  it('updates an existing open issue without creating duplicate failure deliveries', async () => {
    const check = monitoringCheck({ currentStatus: 'warning', consecutiveFailures: 1 });
    mockQueryRows([observationRow('down', 'Connection timed out')]);
    mockQueryRows([]);
    mockCombinedLocation('down', 'Connection timed out');
    mockQueryRows([{ id: 55, opened_at: new Date('2026-09-22T11:50:00.000Z'), severity: 'critical' }]);
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([]);

    await recordMonitoringObservation({
      check,
      status: 'down',
      responseTimeMs: 5000,
      error: 'Connection timed out',
      details: {},
      observedAt,
    });

    const updateIssueCall = vi.mocked(query).mock.calls.find(([statement]) => String(statement).includes('UPDATE monitoring_issues') && String(statement).includes('severity = $2'));
    expect(updateIssueCall?.[1]).toEqual([
      55,
      'critical',
      'Suite Robin SMTPS 465 is down',
      expect.stringContaining('"latestObservationId":31'),
    ]);
    expect(createAlertDelivery).not.toHaveBeenCalled();
    expect(syncAutomaticStatusPageReports).toHaveBeenCalledTimes(1);
  });

  it('keeps an open critical issue critical while it recovers at some locations first', async () => {
    const check = monitoringCheck({ currentStatus: 'down', consecutiveFailures: 4 });
    mockQueryRows([observationRow('warning', 'Connection timed out')]);
    mockQueryRows([]);
    mockCombinedLocation('warning', 'Connection timed out');
    mockQueryRows([{ id: 55, opened_at: new Date('2026-09-22T11:50:00.000Z'), severity: 'critical' }]);
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([]);

    await recordMonitoringObservation({ check, status: 'warning', responseTimeMs: 5000, error: 'Connection timed out', details: {}, observedAt });

    const updateIssueCall = vi.mocked(query).mock.calls.find(([statement]) => String(statement).includes('UPDATE monitoring_issues') && String(statement).includes('severity = $2'));
    expect(updateIssueCall?.[1]?.slice(0, 3)).toEqual([55, 'critical', 'Suite Robin SMTPS 465 is down']);
  });

  it('queues a notification when a real failure escalates an open warning issue', async () => {
    const check = monitoringCheck({ currentStatus: 'unknown', consecutiveFailures: 0 });
    mockQueryRows([observationRow('down', 'Connection timed out')]);
    mockQueryRows([]);
    mockCombinedLocation('down', 'Connection timed out');
    mockQueryRows([{ id: 56, opened_at: new Date('2026-09-22T11:50:00.000Z'), severity: 'warning' }]);
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([]);

    await recordMonitoringObservation({ check, status: 'down', responseTimeMs: 5000, error: 'Connection timed out', details: {}, observedAt });

    expect(vi.mocked(query).mock.calls.some(([statement]) => String(statement).includes("key = 'alertsEnabled'"))).toBe(true);
  });

  it('does not queue issue notifications while alert delivery is disabled', async () => {
    const check = monitoringCheck();
    mockQueryRows([observationRow('down', 'Connection timed out')]);
    mockQueryRows([]);
    mockCombinedLocation('down', 'Connection timed out');
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([{ id: '55' }]);
    mockQueryRows([{ value: 'false' }]);

    await recordMonitoringObservation({
      check,
      status: 'down',
      responseTimeMs: 5000,
      error: 'Connection timed out',
      details: {},
      observedAt,
    });

    expect(createAlertDelivery).not.toHaveBeenCalled();
    expect(vi.mocked(query).mock.calls.some(([statement]) => String(statement).includes('FROM alert_webhooks'))).toBe(false);
    expect(syncAutomaticStatusPageReports).toHaveBeenCalledTimes(1);
  });

  it('closes a recovered issue and respects recovery delivery subscriptions', async () => {
    const check = monitoringCheck({ currentStatus: 'down', consecutiveFailures: 3, statusSince: new Date('2026-09-22T11:55:00.000Z') });
    mockQueryRows([observationRow('up')]);
    mockQueryRows([]);
    mockCombinedLocation('up');
    mockQueryRows([{ id: 55, opened_at: new Date('2026-09-22T11:50:00.000Z') }]);
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([{ id: '55' }]);
    mockQueryRows([{ value: 'true' }]);
    mockQueryRows(monitoringWebhookRows());
    mockQueryRows([]);

    await recordMonitoringObservation({
      check,
      status: 'up',
      responseTimeMs: 25,
      error: null,
      details: {},
      observedAt,
    });

    const closeIssueCall = vi.mocked(query).mock.calls.find(([statement]) => String(statement).includes("SET status = 'closed'"));
    expect(closeIssueCall?.[1]).toEqual([
      55,
      observedAt,
      expect.stringContaining('"recoveryObservationId":31'),
    ]);
    expect(createAlertDelivery).toHaveBeenCalledTimes(1);
    expect(syncAutomaticStatusPageReports).toHaveBeenCalledTimes(1);
    expect(createAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      eventKind: 'recovery',
      dedupeKey: 'monitoring:55:recovery:3',
      alertType: 'monitoring_issue',
      monitoringIssueId: 55,
    }));
  });

  it('does not send recovery delivery when the webhook opted out', async () => {
    const check = monitoringCheck({ currentStatus: 'down', consecutiveFailures: 3 });
    mockQueryRows([observationRow('up')]);
    mockQueryRows([]);
    mockCombinedLocation('up');
    mockQueryRows([{ id: 55, opened_at: new Date('2026-09-22T11:50:00.000Z') }]);
    mockQueryRows([]);
    mockQueryRows([]);
    mockQueryRows([{ id: '55' }]);
    mockQueryRows([{ value: 'true' }]);
    mockQueryRows(monitoringWebhookRows(false));
    mockQueryRows([]);

    await recordMonitoringObservation({
      check,
      status: 'up',
      responseTimeMs: 25,
      error: null,
      details: {},
      observedAt,
    });

    expect(createAlertDelivery).not.toHaveBeenCalled();
    expect(syncAutomaticStatusPageReports).toHaveBeenCalledTimes(1);
  });

  it('claims due checks while keeping disabled, target-disabled, and paused checks out', async () => {
    mockQueryRows([]);
    await listDueMonitoringChecks(500);
    const [statement, params] = vi.mocked(query).mock.calls[0];
    expect(statement).toContain('c.enabled = true');
    expect(statement).toContain('t.enabled = true');
    expect(statement).toContain('c.paused_at IS NULL');
    expect(statement).toContain('FOR UPDATE OF c SKIP LOCKED');
    expect(statement).toContain("CASE WHEN c.check_type = 'push' THEN LEAST(c.interval_seconds, 60) ELSE c.interval_seconds END");
    expect(params).toEqual([100]);
  });

  it('excludes certificate-error warnings from availability but retains warning totals', async () => {
    mockQueryRows([{
      day: '2026-09-22',
      up_count: 7,
      warning_count: 4,
      down_count: 1,
      unavailable_warning_count: 4,
      response_time_sum: '480',
      response_time_count: 12,
      response_time_max: 100,
    }]);

    await expect(getMonitoringCheckHistory(7, 30)).resolves.toEqual([{
      day: '2026-09-22',
      up: 7,
      warning: 4,
      down: 1,
      availability: 7 / 12,
      averageResponseTimeMs: 40,
      maxResponseTimeMs: 100,
    }]);
    expect(vi.mocked(query).mock.calls[0][0]).toContain('unavailable_warning_count');
  });

  it('refuses to close a stale issue while its check is still firing', async () => {
    mockQueryRows([{ id: 55 }]);

    await expect(closeStaleMonitoringIssue(55)).resolves.toBe('active');

    expect(vi.mocked(query).mock.calls[0][1]).toEqual([55]);
    expect(vi.mocked(query).mock.calls).toHaveLength(1);
  });

  it('closes a stale open issue and returns linked deliveries', async () => {
    mockQueryRows([]);
    mockQueryRows([issueRow({ status: 'closed', closed_at: observedAt, details_json: { manuallyClosedAsStale: true } })]);
    mockQueryRows([{
      id: 12,
      monitoring_issue_id: 55,
      webhook_name: 'Slack - Robin Admin Alerts',
      event_kind: 'failure',
      status: 'accepted',
      attempts: 1,
      response_status: 200,
      error: null,
      created_at: observedAt,
      completed_at: observedAt,
    }]);

    const issue = await closeStaleMonitoringIssue(55);

    expect(issue).toMatchObject({
      id: 55,
      status: 'closed',
      deliveries: [expect.objectContaining({ id: 12, webhookName: 'Slack - Robin Admin Alerts' })],
    });
    const updateCall = vi.mocked(query).mock.calls.find(([statement]) => String(statement).includes("SET status = 'closed'"));
    expect(updateCall?.[1]).toEqual([55, JSON.stringify({ manuallyClosedAsStale: true })]);
  });
});
