export const MONITORING_TARGET_TYPES = ['host', 'endpoint'] as const;
export const MONITORING_CHECK_TYPES = ['http', 'tcp', 'dns', 'smtp', 'imap', 'push'] as const;
export const MONITORING_STATUSES = ['unknown', 'up', 'down', 'warning'] as const;
export const MONITORING_ISSUE_STATUSES = ['open', 'closed'] as const;
export const MONITORING_TLS_MODES = ['strict', 'allow_self_signed'] as const;
export const MONITORING_CERTIFICATE_ERROR_MODES = ['down', 'warning'] as const;

export type MonitoringTargetType = (typeof MONITORING_TARGET_TYPES)[number];
export type MonitoringCheckType = (typeof MONITORING_CHECK_TYPES)[number];
export type MonitoringStatus = (typeof MONITORING_STATUSES)[number];
export type MonitoringIssueStatus = (typeof MONITORING_ISSUE_STATUSES)[number];
export type MonitoringTlsMode = (typeof MONITORING_TLS_MODES)[number];
export type MonitoringCertificateErrorMode = (typeof MONITORING_CERTIFICATE_ERROR_MODES)[number];
export type MonitoringJsonScalar = string | number | boolean | null;
export type MonitoringHttpAssertion =
  | { kind: 'body'; operator: 'contains' | 'not_contains' | 'equals'; value: string }
  | { kind: 'header'; name: string; operator: 'exists' | 'equals' | 'contains' | 'not_contains'; value?: string }
  | { kind: 'json'; pointer: string; operator: 'exists' | 'equals' | 'not_equals' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains'; value?: MonitoringJsonScalar };
export interface MonitoringHttpOptions {
  method: 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';
  headers: Record<string, string>;
  body: string;
  expectedStatuses: number[];
  followRedirects: boolean;
  maxRedirects: number;
  maxResponseTimeMs: number | null;
  assertions: MonitoringHttpAssertion[];
}
export interface MonitoringCheckOptions {
  http?: MonitoringHttpOptions;
  tcp?: { tls: boolean; bannerContains: string };
  dns?: { recordType: 'A' | 'AAAA' | 'CNAME' | 'MX' | 'TXT' | 'NS'; resolver: string | null; expectedValues: string[] };
  smtp?: { startTls: boolean };
  imap?: { startTls: boolean };
}

export interface MonitoringTarget {
  id: number;
  name: string;
  targetType: MonitoringTargetType;
  environment: string;
  description: string | null;
  enabled: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitoringCheck {
  id: number;
  targetId: number;
  targetName: string;
  targetEnvironment: string;
  name: string;
  checkType: MonitoringCheckType;
  endpoint: string;
  port: number | null;
  intervalSeconds: number;
  timeoutSeconds: number;
  confirmationSeconds: number;
  recoverySeconds: number;
  placementMode: 'all' | 'selected';
  locationIds: number[];
  quorum: number;
  certExpiryDays: number | null;
  tlsMode: MonitoringTlsMode;
  certificateErrorMode: MonitoringCertificateErrorMode;
  allowPrivate: boolean;
  options: MonitoringCheckOptions;
  secretHeaderNames: string[];
  enabled: boolean;
  pausedAt: Date | null;
  pauseReason: string | null;
  currentStatus: MonitoringStatus;
  /** False when the check's target is disabled: the check is not probed or evaluated. */
  targetEnabled: boolean;
  statusSince: Date | null;
  lastRunAt: Date | null;
  nextRunAt: Date | null;
  lastResponseTimeMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Push checks: the last ping the job sent, and whether it reported success. */
  lastPingAt: Date | null;
  lastPingStatus: 'ok' | 'fail' | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface MonitoringObservation {
  id: number;
  checkId: number;
  locationId: number | null;
  status: MonitoringStatus;
  errorCode: string | null;
  responseTimeMs: number | null;
  error: string | null;
  details: Record<string, unknown>;
  observedAt: Date;
}

/** One UTC day of a check's observations. */
export interface MonitoringCheckDay {
  day: string;
  up: number;
  warning: number;
  down: number;
  /** Share considered available; certificate-error warnings are excluded. */
  availability: number | null;
  averageResponseTimeMs: number | null;
  maxResponseTimeMs: number | null;
}

export interface MonitoringLocationDay extends MonitoringCheckDay {
  locationId: number;
  locationName: string;
  region: string | null;
}

export interface MonitoringIssue {
  id: number;
  checkId: number;
  checkName: string;
  targetName: string;
  status: MonitoringIssueStatus;
  severity: 'warning' | 'critical';
  summary: string;
  details: Record<string, unknown>;
  openedAt: Date;
  closedAt: Date | null;
  updatedAt: Date;
  deliveries: MonitoringIssueDelivery[];
}

export interface MonitoringIssueDelivery {
  id: number;
  webhookName: string;
  eventKind: 'failure' | 'repeat' | 'recovery' | 'test';
  status: 'pending' | 'processing' | 'accepted' | 'failed' | 'cancelled' | 'expired';
  attempts: number;
  responseStatus: number | null;
  error: string | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface MonitoringSummary {
  targets: MonitoringTarget[];
  checks: MonitoringCheck[];
  openIssues: MonitoringIssue[];
  recentIssues: MonitoringIssue[];
  recentObservations: MonitoringObservation[];
  weeklyIssueCounts: Array<{ weekStart: string; count: number }>;
  alertsEnabled?: boolean;
  monitoringEnabled?: boolean;
}
