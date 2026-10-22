import { describe, expect, it } from 'vitest';
import { ALERT_CATALOG, defaultAlertSubscriptions, normalizeAlertSubscriptions } from './alert-types.js';

describe('alert type catalog', () => {
  it('exposes the fixed defaults with all subscriptions initially disabled', () => {
    expect(ALERT_CATALOG.map((entry) => [entry.key, entry.defaultThreshold])).toEqual([
      ['availability', null],
      ['telemetry_stale', 180],
      ['postfix_queue', 1000],
      ['postfix_deferred_age', 900],
      ['postfix_bounce_rate', 20],
      ['dovecot_auth_failures', 100],
      ['cyrus_auth_failures', 100],
      ['postgres_connections', 80],
      ['postgres_cache_hit', 95],
      ['mariadb_connections', 80],
      ['mariadb_buffer_pool_hit', 95],
      ['mariadb_long_transaction', 300],
      ['mariadb_replica_lag', 60],
      ['redis_hit_ratio', 80],
      ['clamav_database_age', 86400],
      ['monitoring_issue', null],
      ['email_delivery_failure', null],
      ['telemetry_rule', null],
    ]);
    expect(defaultAlertSubscriptions().every((subscription) => !subscription.enabled)).toBe(true);
  });

  it('fills omitted alert types and rejects invalid thresholds', () => {
    const subscriptions = normalizeAlertSubscriptions([
      { alertType: 'postfix_queue', enabled: true, threshold: 2000 },
    ]);
    expect(subscriptions).toHaveLength(18);
    expect(subscriptions.find((item) => item.alertType === 'postfix_queue')).toMatchObject({
      enabled: true,
      threshold: 2000,
    });
    expect(() => normalizeAlertSubscriptions([
      { alertType: 'postgres_connections', enabled: true, threshold: 101 },
    ])).toThrow('outside the supported range');
  });
});
