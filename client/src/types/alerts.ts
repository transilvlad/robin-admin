import type { FleetServiceType } from '../constants/serviceTypes';

export type AlertType =
  | 'availability'
  | 'telemetry_stale'
  | 'postfix_queue'
  | 'postfix_deferred_age'
  | 'cyrus_auth_failures'
  | 'postgres_connections'
  | 'postgres_cache_hit'
  | 'mariadb_connections'
  | 'mariadb_buffer_pool_hit'
  | 'mariadb_long_transaction'
  | 'mariadb_replica_lag'
  | 'redis_hit_ratio'
  | 'clamav_database_age'
  | 'monitoring_issue'
  | 'email_delivery_failure'
  | 'telemetry_rule';

export type AlertServiceType = FleetServiceType | 'monitoring';

export type AlertWebhookAdapter = 'slack' | 'generic' | 'sentry';
export type AlertDeliveryStatus = 'pending' | 'processing' | 'accepted' | 'failed' | 'cancelled' | 'expired';
export type AlertJson = Record<string, unknown>;

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
  pausedAt: string | null;
  pausedUntil: string | null;
  pauseReason: string | null;
  sentryOrg: string | null;
  sentryApiUrl: string | null;
  hasSentryToken: boolean;
  createdAt: string;
  updatedAt: string;
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

export interface AlertRuntime {
  enabled: boolean;
  monitoringEnabled?: boolean;
  evaluationIntervalMs: number;
  deliveryConcurrency: number;
  instanceName: string;
  encryptionKeyConfigured: boolean;
  deliveryRetentionDays: number;
  workerIntervalMs: number;
  maxAttempts: number;
  baseRetryDelayMs: number;
  maxRetryDelayMs: number;
  deliveryExpiryMs: number;
  enabledWebhooks: number;
  pausedWebhooks: number;
  pendingDeliveries: number;
  failedDeliveries: number;
}

export interface AlertWebhookResponse {
  webhooks: AlertWebhook[];
  catalog: AlertCatalogEntry[];
  runtime: AlertRuntime;
}

export interface AlertDelivery {
  id: number;
  notificationId: string;
  webhookId: number | null;
  webhookName: string;
  fleetServiceId: number | null;
  monitoringIssueId: number | null;
  telemetryAlertIssueId?: string | null;
  serviceId: string;
  serviceName: string;
  serviceType: AlertServiceType;
  alertType: AlertType;
  eventKind: 'failure' | 'repeat' | 'recovery' | 'test' | 'dismissed';
  status: AlertDeliveryStatus;
  attempts: number;
  nextAttemptAt: string | null;
  lastAttemptAt: string | null;
  responseStatus: number | null;
  error: string | null;
  createdAt: string;
  completedAt: string | null;
}
