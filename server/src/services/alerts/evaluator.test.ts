import { describe, expect, it } from 'vitest';
import { ALERT_CATALOG } from './alert-types.js';
import { buildEvidence, isAlertThresholdFailing, transitionAlertState, type AlertStateSnapshot, type EvaluationRow } from './evaluator.js';
import type { AlertEvidence } from '../../types/alerts.js';

const now = new Date('2026-09-10T10:00:00Z');
const healthyState: AlertStateSnapshot = {
  failing: false,
  consecutiveFailures: 0,
  generation: 0,
  lastObservationKey: null,
  failureStartedAt: null,
  lastNotificationAt: null,
  failureNotified: false,
};

function evidence(overrides: Partial<AlertEvidence> = {}): AlertEvidence {
  return {
    alertType: 'availability',
    fleetServiceId: 1,
    serviceId: 'robin-primary',
    serviceName: 'Robin',
    serviceType: 'robin',
    observationKey: 'sample-1',
    failing: true,
    value: false,
    threshold: null,
    unit: 'none',
    observedAt: now,
    ...overrides,
  };
}

describe('alert threshold evaluation', () => {
  it('uses strict boundaries and treats missing evidence as unknown', () => {
    const above = ALERT_CATALOG.find((entry) => entry.key === 'postgres_connections')!;
    const below = ALERT_CATALOG.find((entry) => entry.key === 'postgres_cache_hit')!;
    expect(isAlertThresholdFailing(above, 80, 80)).toBe(false);
    expect(isAlertThresholdFailing(above, 80.1, 80)).toBe(true);
    expect(isAlertThresholdFailing(below, 95, 95)).toBe(false);
    expect(isAlertThresholdFailing(below, 94.9, 95)).toBe(true);
    expect(isAlertThresholdFailing(above, null, 80)).toBeNull();
    expect(isAlertThresholdFailing(above, Number.POSITIVE_INFINITY, 180)).toBe(true);
  });
});

describe('alert state transitions', () => {
  it('requires distinct observations before the first notification', () => {
    const first = transitionAlertState({
      previous: healthyState,
      evidence: evidence(),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    expect(first.eventKind).toBeNull();
    expect(first.state.consecutiveFailures).toBe(1);

    const duplicate = transitionAlertState({
      previous: first.state,
      evidence: evidence(),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    expect(duplicate.state.consecutiveFailures).toBe(1);

    const second = transitionAlertState({
      previous: duplicate.state,
      evidence: evidence({ observationKey: 'sample-2' }),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    const third = transitionAlertState({
      previous: second.state,
      evidence: evidence({ observationKey: 'sample-3' }),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    expect(third.eventKind).toBe('failure');
    expect(third.state.failureNotified).toBe(true);
  });

  it('suppresses paused notifications and sends only a current failure after resume', () => {
    const paused = transitionAlertState({
      previous: { ...healthyState, failing: true, consecutiveFailures: 3, generation: 1, lastObservationKey: 'sample-1' },
      evidence: evidence(),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: true,
      now,
    });
    expect(paused.eventKind).toBeNull();
    expect(paused.state.failureNotified).toBe(false);

    const resumed = transitionAlertState({
      previous: paused.state,
      evidence: evidence(),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    expect(resumed.eventKind).toBe('failure');
  });

  it('sends bounded repeats and recovery only after a failure notification', () => {
    const active: AlertStateSnapshot = {
      failing: true,
      consecutiveFailures: 3,
      generation: 2,
      lastObservationKey: 'sample-3',
      failureStartedAt: new Date('2026-09-10T05:00:00Z'),
      lastNotificationAt: new Date('2026-09-10T05:59:59Z'),
      failureNotified: true,
    };
    const repeated = transitionAlertState({
      previous: active,
      evidence: evidence(),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    expect(repeated.eventKind).toBe('repeat');

    const recovered = transitionAlertState({
      previous: repeated.state,
      evidence: evidence({ observationKey: 'sample-4', failing: false, value: true }),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    expect(recovered.eventKind).toBe('recovery');

    const unnotifiedRecovery = transitionAlertState({
      previous: { ...active, failureNotified: false },
      evidence: evidence({ observationKey: 'sample-4', failing: false, value: true }),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    expect(unnotifiedRecovery.eventKind).toBeNull();
  });

  it('does not change state for missing evidence', () => {
    const result = transitionAlertState({
      previous: healthyState,
      evidence: evidence({ failing: null, value: null }),
      requiredFailures: 3,
      repeatIntervalSeconds: 14400,
      notifyRecovery: true,
      paused: false,
      now,
    });
    expect(result.eventKind).toBeNull();
    expect(result.state).toMatchObject({ failing: false, consecutiveFailures: 0, lastObservationKey: 'sample-1' });
  });
});

describe('rate alert evidence', () => {
  const sampledAt = new Date('2026-09-10T09:59:30Z');
  function row(overrides: Partial<EvaluationRow>): EvaluationRow {
    return {
      fleet_service_id: 7,
      service_id: 'mx1',
      service_name: 'MX 1',
      service_type: 'postfix',
      observation_key: 'obs',
      observed_at: sampledAt,
      reachable: true,
      ...overrides,
    } as EvaluationRow;
  }

  it('fails the bounce rate once bounced plus deferred exceed the threshold share', () => {
    const result = buildEvidence(row({
      postfix_timestamp: sampledAt,
      postfix_window_delivered: '60',
      postfix_window_deferred: '25',
      postfix_window_bounced: '15',
    }), { alertType: 'postfix_bounce_rate', enabled: true, threshold: 20 }, now);
    expect(result).toMatchObject({ value: 40, failing: true, observationKey: sampledAt.toISOString() });
  });

  it('treats a low-volume window as healthy rather than a 100% bounce rate', () => {
    const result = buildEvidence(row({
      postfix_timestamp: sampledAt,
      postfix_window_delivered: '0',
      postfix_window_deferred: '3',
      postfix_window_bounced: '2',
    }), { alertType: 'postfix_bounce_rate', enabled: true, threshold: 20 }, now);
    expect(result).toMatchObject({ value: 0, failing: false });
  });

  it('fails the auth failure spike above the threshold and is unknown without samples', () => {
    const subscription = { alertType: 'dovecot_auth_failures' as const, enabled: true, threshold: 100 };
    expect(buildEvidence(row({
      service_type: 'dovecot',
      dovecot_timestamp: sampledAt,
      dovecot_window_auth_failures: '250',
    }), subscription, now)).toMatchObject({ value: 250, failing: true, unit: 'failures' });
    expect(buildEvidence(row({ service_type: 'dovecot', dovecot_timestamp: null }), subscription, now))
      .toMatchObject({ value: null, failing: null });
  });
});

describe('MariaDB alert evidence', () => {
  const sampledAt = new Date('2026-09-10T09:59:30Z');
  function row(overrides: Partial<EvaluationRow>): EvaluationRow {
    return {
      fleet_service_id: 9,
      service_id: 'app-db',
      service_name: 'Application DB',
      service_type: 'mariadb',
      observation_key: 'obs',
      observed_at: sampledAt,
      reachable: true,
      mariadb_timestamp: sampledAt,
      ...overrides,
    } as EvaluationRow;
  }

  it('fails a transaction held open past the threshold', () => {
    const subscription = { alertType: 'mariadb_long_transaction' as const, enabled: true, threshold: 300 };
    expect(buildEvidence(row({ mariadb_oldest_trx_age_secs: '900' }), subscription, now)).toMatchObject({ value: 900, failing: true, unit: 'seconds' });
    expect(buildEvidence(row({ mariadb_oldest_trx_age_secs: '0' }), subscription, now)).toMatchObject({ value: 0, failing: false });
  });

  it('rates the buffer pool over the window and ignores a quiet or warming server', () => {
    const subscription = { alertType: 'mariadb_buffer_pool_hit' as const, enabled: true, threshold: 95 };
    expect(buildEvidence(row({ mariadb_window_read_requests: '10000', mariadb_window_reads: '1000' }), subscription, now))
      .toMatchObject({ value: 90, failing: true });
    expect(buildEvidence(row({ mariadb_window_read_requests: '200', mariadb_window_reads: '200' }), subscription, now))
      .toMatchObject({ value: null, failing: null });
  });

  it('measures replica lag only on replicas, and a stopped replica always fails', () => {
    const subscription = { alertType: 'mariadb_replica_lag' as const, enabled: true, threshold: 60 };
    expect(buildEvidence(row({ mariadb_is_replica: false }), subscription, now)).toMatchObject({ value: null, failing: null });
    expect(buildEvidence(row({ mariadb_is_replica: true, mariadb_replica_running: true, mariadb_seconds_behind_source: '5' }), subscription, now))
      .toMatchObject({ value: 5, failing: false });
    expect(buildEvidence(row({ mariadb_is_replica: true, mariadb_replica_running: false, mariadb_seconds_behind_source: null }), subscription, now))
      .toMatchObject({ failing: true });
  });

  it('reports connection use from the latest sample', () => {
    const subscription = { alertType: 'mariadb_connections' as const, enabled: true, threshold: 80 };
    expect(buildEvidence(row({ mariadb_saturation_pct: 92 }), subscription, now)).toMatchObject({ value: 92, failing: true });
    expect(buildEvidence(row({ reachable: false, mariadb_saturation_pct: 92 }), subscription, now)).toMatchObject({ value: null });
  });
});
