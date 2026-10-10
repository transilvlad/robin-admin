import type { FleetServiceType } from '../services/service-types.js';

export const ALERT_TYPES = [
  'availability',
  'telemetry_stale',
  'postfix_queue',
  'postfix_deferred_age',
  'postfix_bounce_rate',
  'dovecot_auth_failures',
  'postgres_connections',
  'postgres_cache_hit',
  'mariadb_connections',
  'mariadb_buffer_pool_hit',
  'mariadb_long_transaction',
  'mariadb_replica_lag',
  'redis_hit_ratio',
  'clamav_database_age',
  'monitoring_issue',
  'email_delivery_failure',
  'telemetry_rule',
] as const;

export type AlertType = (typeof ALERT_TYPES)[number];
export type AlertServiceType = FleetServiceType | 'monitoring';
export type AlertWebhookAdapter = 'slack' | 'generic' | 'sentry';
export type AlertEventKind = 'failure' | 'repeat' | 'recovery' | 'test';
export type AlertDeliveryStatus = 'pending' | 'processing' | 'accepted' | 'failed' | 'cancelled' | 'expired';
export type JsonRecord = Record<string, unknown>;

export interface AlertSubscription {
  alertType: AlertType;
  enabled: boolean;
  threshold: number | null;
}

export interface AlertWebhook {
  id: number;
  name: string;
  adapter: AlertWebhookAdapter;
  enabled: boolean;
  hasSecret: boolean;
  subscriptions: AlertSubscription[];
  consecutiveFailures: number;
  repeatIntervalSeconds: number | null;
  notifyRecovery: boolean;
  pausedAt: Date | null;
  pausedUntil: Date | null;
  pauseReason: string | null;
  /** Sentry destinations: optional settings that let recoveries resolve the issue. */
  sentryOrg: string | null;
  sentryApiUrl: string | null;
  hasSentryToken: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface AlertCatalogEntry {
  key: AlertType;
  label: string;
  description: string;
  serviceTypes: AlertServiceType[];
  unit: 'none' | 'seconds' | 'messages' | 'percent' | 'failures';
  direction: 'boolean' | 'above' | 'below';
  defaultThreshold: number | null;
  minimum: number | null;
  maximum: number | null;
}

export interface AlertDelivery {
  id: number;
  notificationId: string;
  webhookId: number | null;
  webhookName: string;
  fleetServiceId: number | null;
  monitoringIssueId: number | null;
  serviceId: string;
  serviceName: string;
  serviceType: AlertServiceType;
  alertType: AlertType;
  eventKind: AlertEventKind;
  status: AlertDeliveryStatus;
  attempts: number;
  nextAttemptAt: Date | null;
  lastAttemptAt: Date | null;
  responseStatus: number | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface AlertEvidence {
  alertType: AlertType;
  fleetServiceId: number;
  serviceId: string;
  serviceName: string;
  serviceType: FleetServiceType;
  observationKey: string;
  failing: boolean | null;
  value: number | boolean | null;
  threshold: number | null;
  unit: AlertCatalogEntry['unit'];
  observedAt: Date;
}
