export const TELEMETRY_ALERT_COMPARATORS = ['>', '>=', '<', '<=', '==', '!='] as const;
export type TelemetryAlertComparator = (typeof TELEMETRY_ALERT_COMPARATORS)[number];
export type TelemetryAlertSeverity = 'warning' | 'critical';

export interface TelemetryAlertRuleInput {
  name: string;
  description: string | null;
  query: string;
  comparator: TelemetryAlertComparator;
  threshold: number;
  forSeconds: number;
  severity: TelemetryAlertSeverity;
  enabled: boolean;
}

export interface TelemetryAlertSeriesState {
  ruleId: number;
  seriesKey: string;
  issueId: string | null;
  labels: Record<string, string>;
  status: 'pending' | 'firing';
  pendingSince: string;
  firingSince: string | null;
  lastValue: number | null;
  lastSeenAt: string;
}

export type TelemetryAlertIssueStatus = 'active' | 'dismissed' | 'resolved';
export type TelemetryAlertIssueResolution = 'recovered' | 'absent' | 'edited' | 'disabled' | 'deleted';
export type TelemetryAlertIssueEventType =
  | 'firing'
  | 'dismissed'
  | 'resumed'
  | 'dismissal_expired'
  | 'severity_escalated'
  | 'resolved';

export interface TelemetryAlertIssueEvent {
  id: number;
  eventType: TelemetryAlertIssueEventType;
  actorName: string | null;
  reason: string | null;
  expiresAt: string | null;
  occurredAt: string;
}

export interface TelemetryAlertIssue {
  id: string;
  ruleId: number;
  ruleName: string;
  query: string;
  comparator: TelemetryAlertComparator;
  threshold: number;
  forSeconds: number;
  severity: TelemetryAlertSeverity;
  seriesKey: string;
  labels: Record<string, string>;
  lastValue: number | null;
  status: TelemetryAlertIssueStatus;
  openedAt: string;
  lastSeenAt: string;
  dismissedAt: string | null;
  dismissedBy: string | null;
  dismissedUntil: string | null;
  dismissalReason: string | null;
  revision: number;
  resolvedAt: string | null;
  resolutionReason: TelemetryAlertIssueResolution | null;
  events: TelemetryAlertIssueEvent[];
}

export interface TelemetryAlertRule extends TelemetryAlertRuleInput {
  id: number;
  lastEvaluatedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
  states: TelemetryAlertSeriesState[];
}

export interface TelemetryAlertPreview {
  series: Array<{ labels: Record<string, string>; value: number | null; matches: boolean }>;
  truncated: boolean;
}
