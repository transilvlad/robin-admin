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

export interface TelemetryAlertRule extends TelemetryAlertRuleInput {
  id: number;
  lastEvaluatedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

/** A series the rule is tracking: matching but not yet for long enough, or firing. */
export interface TelemetryAlertSeriesState {
  ruleId: number;
  seriesKey: string;
  labels: Record<string, string>;
  status: 'pending' | 'firing';
  pendingSince: string;
  firingSince: string | null;
  lastValue: number | null;
  lastSeenAt: string;
}

export interface TelemetryAlertRuleWithStates extends TelemetryAlertRule {
  states: TelemetryAlertSeriesState[];
}

export interface TelemetryAlertPreviewSeries {
  labels: Record<string, string>;
  value: number | null;
  matches: boolean;
}
