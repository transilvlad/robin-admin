export type MonitoringTargetType = 'host' | 'endpoint';
export type MonitoringCheckType = 'http' | 'tcp' | 'dns' | 'smtp' | 'imap' | 'push';
export type MonitoringStatus = 'unknown' | 'up' | 'down' | 'warning';
export type MonitoringIssueStatus = 'open' | 'closed';
export type MonitoringTlsMode = 'strict' | 'allow_self_signed';
export type MonitoringCertificateErrorMode = 'down' | 'warning';
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

export interface MonitoringConfiguration {
  format: 'robin-admin-monitoring';
  version: 1;
  targets: Array<{ name: string; targetType: MonitoringTargetType; environment: string; description: string | null; enabled: boolean }>;
  checks: Array<{
    target: { name: string; environment: string };
    name: string;
    checkType: MonitoringCheckType;
    endpoint: string;
    port: number | null;
    intervalSeconds: number;
    timeoutSeconds: number;
    confirmationSeconds: number;
    recoverySeconds: number;
    certExpiryDays: number | null;
    tlsMode: MonitoringTlsMode;
    certificateErrorMode: MonitoringCertificateErrorMode;
    allowPrivate: boolean;
    options: MonitoringCheckOptions;
    enabled: boolean;
  }>;
  sections: Array<{ name: string; position: number; enabled: boolean }>;
  components: Array<{
    section: string;
    publicName: string;
    description: string | null;
    position: number;
    enabled: boolean;
    showHistory: boolean;
    checks: Array<{ target: { name: string; environment: string }; name: string }>;
  }>;
}

export interface MonitoringImportReport {
  changes: Array<{ resource: 'target' | 'check' | 'section' | 'component'; action: 'create' | 'update'; identity: string }>;
  conflicts: Array<{ path: string; message: string }>;
  errors: Array<{ path: string; message: string }>;
}

export interface MonitoringTarget {
  id: number;
  name: string;
  targetType: MonitoringTargetType;
  environment: string;
  description: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One UTC day of a check's observations, from the daily rollup. */
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
  pausedAt: string | null;
  pauseReason: string | null;
  currentStatus: MonitoringStatus;
  /** False when the check's target is disabled: it is not probed. */
  targetEnabled: boolean;
  statusSince: string | null;
  lastRunAt: string | null;
  nextRunAt: string | null;
  lastResponseTimeMs: number | null;
  lastError: string | null;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  /** Push checks: the last ping the job sent, and whether it reported success. */
  lastPingAt: string | null;
  lastPingStatus: 'ok' | 'fail' | null;
  createdAt: string;
  updatedAt: string;
}

export interface MonitoringObservation {
  id: number;
  checkId: number;
  locationId: number | null;
  status: Exclude<MonitoringStatus, 'unknown'>;
  errorCode: string | null;
  responseTimeMs: number | null;
  error: string | null;
  details: Record<string, unknown>;
  observedAt: string;
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
  openedAt: string;
  closedAt: string | null;
  updatedAt: string;
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
  createdAt: string;
  completedAt: string | null;
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

export type MonitoringHeartbeatFormat = 'generic' | 'sentry_crons';

export interface MonitoringHeartbeat {
  id: number;
  name: string;
  format: MonitoringHeartbeatFormat;
  intervalSeconds: number;
  minimumFreshLocations: number;
  enabled: boolean;
  pingUrlConfigured: boolean;
  failureUrlConfigured: boolean;
  lastAttemptAt: string | null;
  lastResult: string | null;
  lastReason: string | null;
}

export interface MonitoringHeartbeatHealth {
  healthy: boolean;
  reason: 'database' | 'monitoring_disabled' | 'scheduler_lag' | 'alert_backlog' | 'locations' | null;
  checkedAt: number;
}

export interface MonitoringProbeLocation {
  id: number;
  locationKey: string;
  name: string;
  region: string | null;
  locationType: 'local' | 'remote';
  agentId: string | null;
  agentName: string | null;
  agentStatus: 'pending' | 'online' | 'offline' | null;
  enabled: boolean;
  shadow: boolean;
  probeConcurrency: number;
  lastSeenAt: string | null;
  agentVersion: string | null;
  protocolVersion: number | null;
  clockOffsetMs: number | null;
  manifestRevision: number;
  assignedCheckCount: number;
  probeDutyPerMinute: number;
  recentErrors: Array<{ checkName: string; errorCode: string | null; count: number; lastObservedAt: string; recovered: boolean }>;
  openIssue: { summary: string; openedAt: string } | null;
}

export interface MonitoringProbeLocationsResponse {
  locations: MonitoringProbeLocation[];
  availableAgents: Array<{
    agentId: string;
    name: string;
    hostname: string | null;
    status: 'pending' | 'online' | 'offline';
  }>;
}
