import { describe, expect, it } from 'vitest';
import { ALERT_CATALOG, defaultAlertSubscriptions, normalizeAlertSubscriptions } from './alert-types.js';
import { parseModuleAlertPublishers } from './module-alert-policy.js';

describe('alert type catalog', () => {
  it('exposes the fixed defaults with all subscriptions initially disabled', () => {
    expect(ALERT_CATALOG.map((entry) => [entry.key, entry.defaultThreshold])).toEqual([
      ['host_ssh_keys', null],
      ['host_sshd', null],
      ['host_network', null],
      ['host_privilege', null],
      ['host_integrity', null],
      ['host_unknown_login', null],
      ['host_password_login', null],
      ['host_failed_auth_rate', null],
      ['host_patching', null],
      ['host_security_stale', null],
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
      ['logs_rule', null],
      ['logs_pipeline_health', null],
    ]);
    expect(defaultAlertSubscriptions().every((subscription) => !subscription.enabled)).toBe(true);
  });

  it('normalizes categories independently and keeps native defaults', () => {
    const item = { alertType: 'module_alert', moduleSlug: 'example-module', enabled: true, threshold: null };
    const security = { ...item, moduleCategory: 'security' };
    const other = { ...item, moduleCategory: 'other' };
    expect(normalizeAlertSubscriptions([security, other]).slice(-2)).toEqual([security, other]);
    expect(() => normalizeAlertSubscriptions([item])).toThrow('requires a valid module and category');
  });

  it('validates publisher bindings and prevents arbitrary link targets', () => {
    const registration = {
      apiKeyId: 3, link: { path: 'reviews', parameter: 'id' },
      categories: { finding: { label: 'Example finding', maxSeverity: 'warning' } },
    };
    expect(parseModuleAlertPublishers(JSON.stringify({ example: registration })).example.requirePaid).toBe(true);
    expect(() => parseModuleAlertPublishers(JSON.stringify({ one: registration, other: registration }))).toThrow();
    expect(() => parseModuleAlertPublishers(JSON.stringify({ example: { ...registration, link: { path: '../security', parameter: 'id' } } }))).toThrow();
  });

  it('fills omitted alert types and rejects invalid thresholds', () => {
    const subscriptions = normalizeAlertSubscriptions([
      { alertType: 'postfix_queue', enabled: true, threshold: 2000 },
    ]);
    expect(subscriptions).toHaveLength(ALERT_CATALOG.length);
    expect(subscriptions.find((item) => item.alertType === 'postfix_queue')).toMatchObject({
      enabled: true,
      threshold: 2000,
    });
    expect(() => normalizeAlertSubscriptions([
      { alertType: 'postgres_connections', enabled: true, threshold: 101 },
    ])).toThrow('outside the supported range');
  });
});
