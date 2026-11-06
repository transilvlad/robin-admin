export const LOGS_RANGE_PRESETS = ['15m', '1h', '6h', '24h', '7d', '30d'] as const;
export type LogsRangePreset = (typeof LOGS_RANGE_PRESETS)[number];

export interface LogsSearchFilters {
  query: string;
  serviceId: string;
  sourceName: string;
  rangePreset: LogsRangePreset;
}

export interface LogsSavedSearchInput {
  name: string;
  description: string | null;
  filters: LogsSearchFilters;
}

export interface LogsSavedSearch extends LogsSavedSearchInput {
  id: number;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LogsSource {
  sourceName: string;
  sourceType: string;
  serviceType: string;
  serviceId: string;
  count: number;
  lastSeen: string | null;
}

export interface LogsSourcesResult {
  windowDays: number;
  sources: LogsSource[];
  truncated: boolean;
  limit: number;
  quietAfterSeconds: number;
}

export const LOGS_ALERT_COMPARATORS = ['>', '>=', '<', '<=', '==', '!='] as const;
export type LogsAlertComparator = (typeof LOGS_ALERT_COMPARATORS)[number];
export type LogsAlertStatus = 'ok' | 'pending' | 'firing';

export interface LogsAlertRuleInput {
  name: string;
  description: string | null;
  query: string;
  windowSeconds: number;
  comparator: LogsAlertComparator;
  threshold: number;
  forSeconds: number;
  enabled: boolean;
}

export interface LogsAlertRule extends LogsAlertRuleInput {
  id: number;
  status: LogsAlertStatus;
  lastValue: number | null;
  generation: number;
  pendingSince: string | null;
  firingSince: string | null;
  lastEvaluatedAt: string | null;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface LogsAlertPreview {
  value: number;
  matches: boolean;
}
