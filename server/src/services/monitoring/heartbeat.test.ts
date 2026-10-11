import { describe, expect, it } from 'vitest';
import { evaluateHeartbeatHealth } from './heartbeat.js';

const healthyInput = {
  now: 200_000,
  databaseReachable: true,
  monitoringEnabled: true,
  lastSchedulerTickAt: 199_999,
  overdueChecks: 0,
  alertsEnabled: true,
  lastAlertCycleAt: 199_999,
  alertIntervalMs: 5000,
  stuckDeliveries: 0,
};

describe('heartbeat health verdict', () => {
  it('reports healthy when each enabled subsystem is fresh', () => {
    expect(evaluateHeartbeatHealth(healthyInput)).toMatchObject({ healthy: true, reason: null });
  });

  it('reports database failures before other criteria', () => {
    expect(evaluateHeartbeatHealth({ ...healthyInput, databaseReachable: false, overdueChecks: 1 })).toMatchObject({ healthy: false, reason: 'database' });
  });

  it('reports a stalled or delayed monitoring scheduler', () => {
    expect(evaluateHeartbeatHealth({ ...healthyInput, lastSchedulerTickAt: null })).toMatchObject({ reason: 'scheduler_lag' });
    // Right after a restart the first cycles have not finished yet; that is not lag.
    const justStarted = { ...healthyInput, startedAt: healthyInput.now - 3000, lastSchedulerTickAt: null, lastAlertCycleAt: null };
    expect(evaluateHeartbeatHealth(justStarted)).toMatchObject({ healthy: true, reason: null });
    expect(evaluateHeartbeatHealth({ ...justStarted, startedAt: healthyInput.now - 60_000 })).toMatchObject({ reason: 'scheduler_lag' });
    expect(evaluateHeartbeatHealth({ ...justStarted, lastSchedulerTickAt: healthyInput.now, startedAt: healthyInput.now - 600_000 })).toMatchObject({ reason: 'alert_backlog' });
    expect(evaluateHeartbeatHealth({ ...healthyInput, overdueChecks: 1 })).toMatchObject({ reason: 'scheduler_lag' });
  });

  it('reports alert backlog or a stalled delivery worker', () => {
    expect(evaluateHeartbeatHealth({ ...healthyInput, stuckDeliveries: 1 })).toMatchObject({ reason: 'alert_backlog' });
    expect(evaluateHeartbeatHealth({ ...healthyInput, lastAlertCycleAt: null })).toMatchObject({ reason: 'alert_backlog' });
  });

  it('requires the configured number of fresh probe locations', () => {
    expect(evaluateHeartbeatHealth({
      ...healthyInput,
      minimumFreshLocations: 2,
      freshProbeLocations: 1,
    })).toMatchObject({ healthy: false, reason: 'locations' });
    expect(evaluateHeartbeatHealth({
      ...healthyInput,
      minimumFreshLocations: 2,
      freshProbeLocations: 2,
    })).toMatchObject({ healthy: true, reason: null });
  });

  it('reports unhealthy when Monitoring is switched off', () => {
    expect(evaluateHeartbeatHealth({ ...healthyInput, monitoringEnabled: false })).toMatchObject({ healthy: false, reason: 'monitoring_disabled' });
  });

  it('does not require leader-local signals on follower replicas', () => {
    expect(evaluateHeartbeatHealth({
      ...healthyInput, isLeader: false, lastSchedulerTickAt: null, lastAlertCycleAt: null,
    })).toMatchObject({ healthy: true, reason: null });
    expect(evaluateHeartbeatHealth({ ...healthyInput, isLeader: false, overdueChecks: 1 })).toMatchObject({ reason: 'scheduler_lag' });
  });

  it('does not require the alert worker when alerts are disabled', () => {
    expect(evaluateHeartbeatHealth({ ...healthyInput, alertsEnabled: false, lastAlertCycleAt: null })).toMatchObject({ healthy: true });
  });
});
