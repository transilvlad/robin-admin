import type { AlertCatalogEntry, AlertSubscription, AlertType } from '../../types/alerts.js';
import { ALERT_TYPES } from '../../types/alerts.js';

export const ALERT_CATALOG: readonly AlertCatalogEntry[] = [
  {
    key: 'availability',
    label: 'Service availability',
    description: 'Alerts when a service collection attempt reports that the service is unreachable.',
    serviceTypes: ['robin', 'rspamd', 'clamav', 'dovecot', 'cyrus', 'postfix', 'redis', 'postgres', 'mariadb'],
    unit: 'none',
    direction: 'boolean',
    defaultThreshold: null,
    minimum: null,
    maximum: null,
  },
  {
    key: 'telemetry_stale',
    label: 'Telemetry stale',
    description: 'Alerts when Robin Admin stops receiving collection observations for a service.',
    serviceTypes: ['robin', 'rspamd', 'clamav', 'dovecot', 'cyrus', 'postfix', 'redis', 'postgres', 'mariadb'],
    unit: 'seconds',
    direction: 'above',
    defaultThreshold: 180,
    minimum: 60,
    maximum: 86400,
  },
  {
    key: 'postfix_queue',
    label: 'Postfix queue',
    description: 'Alerts when the total Postfix queue exceeds the configured number of messages.',
    serviceTypes: ['postfix'],
    unit: 'messages',
    direction: 'above',
    defaultThreshold: 1000,
    minimum: 1,
    maximum: 10000000,
  },
  {
    key: 'postfix_deferred_age',
    label: 'Oldest deferred message',
    description: 'Alerts when the oldest known deferred Postfix message exceeds the configured age.',
    serviceTypes: ['postfix'],
    unit: 'seconds',
    direction: 'above',
    defaultThreshold: 900,
    minimum: 60,
    maximum: 2592000,
  },
  {
    key: 'postfix_bounce_rate',
    label: 'Postfix bounce/deferral rate',
    description: 'Alerts when bounced plus deferred deliveries exceed the configured share of delivery attempts over the last 15 minutes (at least 20 attempts).',
    serviceTypes: ['postfix'],
    unit: 'percent',
    direction: 'above',
    defaultThreshold: 20,
    minimum: 1,
    maximum: 100,
  },
  {
    key: 'dovecot_auth_failures',
    label: 'Dovecot auth failure spike',
    description: 'Alerts when Dovecot records more than the configured number of failed authentications over the last 15 minutes.',
    serviceTypes: ['dovecot'],
    unit: 'failures',
    direction: 'above',
    defaultThreshold: 100,
    minimum: 1,
    maximum: 10000000,
  },
  {
    key: 'cyrus_auth_failures',
    label: 'Cyrus IMAP auth failure spike',
    description: 'Alerts when Cyrus IMAP records more than the configured number of failed authentications over the last 15 minutes.',
    serviceTypes: ['cyrus'],
    unit: 'failures',
    direction: 'above',
    defaultThreshold: 100,
    minimum: 1,
    maximum: 10000000,
  },
  {
    key: 'postgres_connections',
    label: 'PostgreSQL connection use',
    description: 'Alerts when PostgreSQL connection use exceeds the configured percentage.',
    serviceTypes: ['postgres'],
    unit: 'percent',
    direction: 'above',
    defaultThreshold: 80,
    minimum: 1,
    maximum: 100,
  },
  {
    key: 'postgres_cache_hit',
    label: 'PostgreSQL cache hit ratio',
    description: 'Alerts when the PostgreSQL cache hit ratio falls below the configured percentage.',
    serviceTypes: ['postgres'],
    unit: 'percent',
    direction: 'below',
    defaultThreshold: 95,
    minimum: 0,
    maximum: 100,
  },
  {
    key: 'mariadb_connections',
    label: 'MariaDB connection use',
    description: 'Alerts when connected threads exceed the configured percentage of max_connections.',
    serviceTypes: ['mariadb'],
    unit: 'percent',
    direction: 'above',
    defaultThreshold: 80,
    minimum: 1,
    maximum: 100,
  },
  {
    key: 'mariadb_buffer_pool_hit',
    label: 'MariaDB buffer pool hit ratio',
    description: 'Alerts when the InnoDB buffer pool hit ratio over the last 15 minutes falls below the configured percentage (at least 1,000 reads).',
    serviceTypes: ['mariadb'],
    unit: 'percent',
    direction: 'below',
    defaultThreshold: 95,
    minimum: 0,
    maximum: 100,
  },
  {
    key: 'mariadb_long_transaction',
    label: 'MariaDB long-running transaction',
    description: 'Alerts when the oldest open InnoDB transaction is older than the configured age (a stuck transaction holds row locks and blocks purge).',
    serviceTypes: ['mariadb'],
    unit: 'seconds',
    direction: 'above',
    defaultThreshold: 300,
    minimum: 10,
    maximum: 86400,
  },
  {
    key: 'mariadb_replica_lag',
    label: 'MariaDB replica lag',
    description: 'Alerts when a replica falls behind its source by more than the configured time, or its replication threads stop.',
    serviceTypes: ['mariadb'],
    unit: 'seconds',
    direction: 'above',
    defaultThreshold: 60,
    minimum: 1,
    maximum: 86400,
  },
  {
    key: 'redis_hit_ratio',
    label: 'Redis cache hit ratio',
    description: 'Alerts when the Redis cache hit ratio falls below the configured percentage.',
    serviceTypes: ['redis'],
    unit: 'percent',
    direction: 'below',
    defaultThreshold: 80,
    minimum: 0,
    maximum: 100,
  },
  {
    key: 'clamav_database_age',
    label: 'ClamAV database age',
    description: 'Alerts when the ClamAV signature database is older than the configured age.',
    serviceTypes: ['clamav'],
    unit: 'seconds',
    direction: 'above',
    defaultThreshold: 86400,
    minimum: 3600,
    maximum: 2592000,
  },
  {
    key: 'monitoring_issue',
    label: 'Monitoring issue',
    description: 'Alerts when an independent Monitoring check opens or recovers an issue.',
    serviceTypes: ['monitoring'],
    unit: 'none',
    direction: 'boolean',
    defaultThreshold: null,
    minimum: null,
    maximum: null,
  },
  {
    key: 'email_delivery_failure',
    label: 'Email delivery failure',
    description: 'Alerts when Robin Admin cannot deliver outbound email after all configured relays fail.',
    serviceTypes: ['monitoring'],
    unit: 'none',
    direction: 'boolean',
    defaultThreshold: null,
    minimum: null,
    maximum: null,
  },
  {
    key: 'telemetry_rule',
    label: 'Telemetry rule',
    description: 'Alerts when a telemetry alert rule fires for a series (for example a host) and when it recovers.',
    serviceTypes: ['monitoring'],
    unit: 'none',
    direction: 'boolean',
    defaultThreshold: null,
    minimum: null,
    maximum: null,
  },
];

const catalogByKey = new Map(ALERT_CATALOG.map((entry) => [entry.key, entry]));

export function isAlertType(value: unknown): value is AlertType {
  return typeof value === 'string' && (ALERT_TYPES as readonly string[]).includes(value);
}

export function defaultAlertSubscriptions(): AlertSubscription[] {
  return ALERT_CATALOG.map((entry) => ({
    alertType: entry.key,
    enabled: false,
    threshold: entry.defaultThreshold,
  }));
}

export function normalizeAlertSubscriptions(value: unknown): AlertSubscription[] {
  if (!Array.isArray(value)) {
    throw new Error('subscriptions must be an array');
  }
  const byType = new Map<AlertType, AlertSubscription>();
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('Each subscription must be an object');
    }
    const candidate = item as Record<string, unknown>;
    if (!isAlertType(candidate.alertType)) {
      throw new Error('Subscription alertType is invalid');
    }
    const definition = catalogByKey.get(candidate.alertType)!;
    if (typeof candidate.enabled !== 'boolean') {
      throw new Error(`Subscription ${candidate.alertType} enabled must be boolean`);
    }
    const threshold = definition.defaultThreshold === null
      ? null
      : candidate.threshold;
    if (definition.defaultThreshold !== null) {
      if (typeof threshold !== 'number' || !Number.isFinite(threshold)) {
        throw new Error(`Subscription ${candidate.alertType} threshold must be a finite number`);
      }
      if ((definition.minimum !== null && threshold < definition.minimum)
        || (definition.maximum !== null && threshold > definition.maximum)) {
        throw new Error(`Subscription ${candidate.alertType} threshold is outside the supported range`);
      }
    }
    byType.set(candidate.alertType, {
      alertType: candidate.alertType,
      enabled: candidate.enabled,
      threshold: threshold as number | null,
    });
  }
  return ALERT_CATALOG.map((entry) => byType.get(entry.key) ?? {
    alertType: entry.key,
    enabled: false,
    threshold: entry.defaultThreshold,
  });
}
