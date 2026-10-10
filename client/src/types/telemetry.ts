/**
 * Telemetry types. Dashboard definitions mirror
 * server/src/services/telemetry/dashboards/types.ts.
 */

export const TELEMETRY_UNITS = [
  'percent',
  'percentunit',
  'bytes',
  'bytes_per_second',
  'bits_per_second',
  'seconds',
  'milliseconds',
  'count',
  'per_second',
  'up_down',
  'none',
] as const;

export type TelemetryUnit = typeof TELEMETRY_UNITS[number];

export const PANEL_TYPES = ['timeseries', 'stat', 'table'] as const;
export type TelemetryPanelType = typeof PANEL_TYPES[number];

/** Columns in a row's grid. */
export const GRID_COLUMNS = 12;

export const LEGEND_MODES = ['last', 'min', 'max', 'mean', 'hidden'] as const;
export type TelemetryLegendMode = typeof LEGEND_MODES[number];

export interface TelemetryVariable {
  name: string;
  label: string;
  source: string;
  match?: string;
  multi?: boolean;
}

export interface TelemetryPanelQuery {
  expr: string;
  legend?: string;
  /** Unit for this query's column in a joined table. */
  unit?: TelemetryUnit;
}

/** Open another dashboard with one variable set from a series label. */
export interface TelemetryPanelLink {
  dashboardUid: string;
  variable: string;
  label: string;
}

export interface TelemetryPanelLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface TelemetryPanel {
  id: string;
  title: string;
  description?: string;
  type: TelemetryPanelType;
  unit: TelemetryUnit;
  queries: TelemetryPanelQuery[];
  layout: TelemetryPanelLayout;
  stacked?: boolean;
  min?: number;
  max?: number;
  thresholds?: { warning?: number; critical?: number };
  invertThresholds?: boolean;
  optional?: boolean;
  legend?: TelemetryLegendMode;
  decimals?: number;
  logScale?: boolean;
  /** Table panels: one row per value of this label, one column per query. */
  tableBy?: string;
  link?: TelemetryPanelLink;
}

export interface TelemetryRow {
  id: string;
  title: string;
  collapsed?: boolean;
  /** Repeat the row for each selected value of this variable (all values when none). */
  repeat?: string;
  panels: TelemetryPanel[];
}

export interface TelemetryDashboardDefaults {
  range?: '15m' | '1h' | '6h' | '24h' | '7d' | '30d';
  refresh?: number;
}

/** Everything a user edits about a dashboard. */
export interface TelemetryDashboardContent {
  title: string;
  description: string;
  defaults?: TelemetryDashboardDefaults;
  variables: TelemetryVariable[];
  rows: TelemetryRow[];
}

export interface TelemetryDashboard extends TelemetryDashboardContent {
  uid: string;
  templateKey: string | null;
  /** The default it was added from has changed since. */
  templateUpdated: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface TelemetryDashboardSummary {
  uid: string;
  title: string;
  description: string;
  templateKey: string | null;
  templateUpdated: boolean;
  version: number;
  updatedAt: string;
}

export interface TelemetryDashboardVersion {
  version: number;
  title: string;
  savedAt: string;
  savedBy: string | null;
}

export interface TelemetryTemplate {
  key: string;
  title: string;
  description: string;
}

export interface TelemetrySeries {
  name: string;
  query?: number;
  labels: Record<string, string>;
  values: Array<number | null>;
}

/** Range data on one shared time axis (Unix seconds). */
export interface TelemetryRangeData {
  start: number;
  end: number;
  step: number;
  timestamps: number[];
  series: TelemetrySeries[];
  truncated: boolean;
}

export interface TelemetryStatus {
  silentAfterSeconds: number;
  enabled: boolean;
  configured: boolean;
  reachable: boolean;
  totalSeries: number;
  sources: string[];
}

/** Selected values per variable; an empty list means all. */
export type TelemetryVariableValues = Record<string, string[]>;

export interface TelemetrySource {
  name: string;
  groups: string[];
  query: string;
  series: number;
  /** Unix seconds of the newest sample, or null when older than a day. */
  lastSeen: number | null;
  silent: boolean;
}

export interface TelemetrySources {
  sourceLabel: string;
  groupLabel: string;
  sources: TelemetrySource[];
  sourceWindowDays: number;
  silentAfterSeconds: number;
  refreshSeconds: number;
  limit: number;
  truncated: boolean;
  emptyReason: 'no-data' | 'selector-mismatch' | 'missing-source-label' | null;
  suggestedSourceLabels?: string[];
}

export interface TelemetryStoreHealth {
  address: string;
  kind: 'victoriametrics' | 'prometheus-compatible';
  version: string | null;
  retention: string | null;
  totalSeries: number;
  dataSizeBytes: number | null;
  freeDiskBytes: number | null;
  memoryLimitBytes: number | null;
  rowsInserted: number | null;
  rowsRejected: number | null;
  ingestRate: number | null;
  rejectRate: number | null;
  topMetrics: Array<{ name: string; series: number }>;
}

/** A Monitoring issue drawn on charts. */
export interface TelemetryAnnotation {
  id: number;
  checkName: string;
  severity: 'warning' | 'critical';
  summary: string;
  openedAt: string;
  closedAt: string | null;
}

export interface TelemetryPanelQueries {
  step: number;
  unit: TelemetryUnit;
  queries: Array<{ expr: string; legend?: string }>;
}
