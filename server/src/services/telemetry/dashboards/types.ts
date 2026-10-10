/**
 * Telemetry dashboard definitions.
 *
 * Dashboards are stored in the database and managed in the UI. Templates in
 * `templates/` are opt-in exporter examples and back "Restore default".
 * They are never installed automatically.
 *
 * Queries are PromQL with placeholders the server substitutes:
 * - `$<variable>`: a dashboard variable as an escaped regular expression; use
 *   it only inside a regex matcher, for example `host=~"$host"`. Multiple
 *   selections become an alternation and an empty or "all" selection matches
 *   any non-empty value.
 * - `$__interval`: the query step, for example `60s`.
 * - `$__rate_interval`: a window for rate() and increase() that always spans
 *   several samples, for example `240s`.
 *
 * Legends use `{{label}}` placeholders filled from each series' labels.
 */

export const TELEMETRY_UNITS = [
  'percent', // 0-100
  'percentunit', // 0-1
  'bytes',
  'bytes_per_second',
  'bits_per_second',
  'seconds',
  'milliseconds',
  'count',
  'per_second',
  'up_down', // 1 up, 0 down
  'none',
] as const;

export type TelemetryUnit = typeof TELEMETRY_UNITS[number];

export const PANEL_TYPES = ['timeseries', 'stat', 'table'] as const;
export type PanelType = typeof PANEL_TYPES[number];

/** Columns in a row's grid. */
export const GRID_COLUMNS = 12;

export const LEGEND_MODES = ['last', 'min', 'max', 'mean', 'hidden'] as const;
export type LegendMode = typeof LEGEND_MODES[number];

/** Time range presets a dashboard may default to. */
export const RANGE_PRESETS = ['15m', '1h', '6h', '24h', '7d', '30d'] as const;
export type RangePreset = typeof RANGE_PRESETS[number];

/** Auto-refresh intervals in seconds a dashboard may default to; 0 is off. */
export const REFRESH_INTERVALS = [0, 30, 60, 300] as const;

export interface DashboardVariable {
  /** Referenced as `$name` in queries. */
  name: string;
  label: string;
  /** Label whose values populate the picker. */
  source: string;
  /**
   * Series selector restricting the values, for example `{job="metrics"}`. May
   * reference variables declared earlier in the list.
   */
  match?: string;
  /** Allow several values; an empty selection means all. */
  multi?: boolean;
}

export interface PanelQuery {
  expr: string;
  /** Series name template, for example `{{host}} in`; a table column header. */
  legend?: string;
  /** Unit for this query's column in a joined table; defaults to the panel unit. */
  unit?: TelemetryUnit;
}

/** Open another dashboard with one variable set from a series label. */
export interface PanelLink {
  dashboardUid: string;
  /** Variable to set on the target dashboard. */
  variable: string;
  /** Series label whose value it gets. */
  label: string;
}

/** Position and size in grid units within the panel's row. */
export interface PanelLayout {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface DashboardPanel {
  /** Unique within the dashboard. */
  id: string;
  title: string;
  description?: string;
  /**
   * timeseries: lines over time. stat: the latest value with a sparkline.
   * table: the latest value of each series, one row per series.
   */
  type: PanelType;
  unit: TelemetryUnit;
  queries: PanelQuery[];
  layout: PanelLayout;
  stacked?: boolean;
  min?: number;
  max?: number;
  /** Stat and table colouring: values at or above these are highlighted. */
  thresholds?: { warning?: number; critical?: number };
  /** Lower values are worse (for example free space); flips thresholds. */
  invertThresholds?: boolean;
  /** Expected to be empty on some hosts (optional services). */
  optional?: boolean;
  /** What the legend shows next to each series, or no legend. Defaults to last. */
  legend?: LegendMode;
  /** Fixed decimal places for values. */
  decimals?: number;
  /** Logarithmic value axis. */
  logScale?: boolean;
  /** Table panels: one row per value of this label, one column per query. */
  tableBy?: string;
  link?: PanelLink;
}

export interface DashboardRow {
  /** Unique within the dashboard. */
  id: string;
  title: string;
  collapsed?: boolean;
  /** Repeat the row once per selected value of this variable (all values when none). */
  repeat?: string;
  panels: DashboardPanel[];
}

export interface DashboardDefaults {
  range?: RangePreset;
  refresh?: number;
}

/** Everything a user edits about a dashboard. */
export interface DashboardContent {
  title: string;
  description: string;
  defaults?: DashboardDefaults;
  variables: DashboardVariable[];
  rows: DashboardRow[];
}

/** A stored dashboard. */
export interface TelemetryDashboard extends DashboardContent {
  uid: string;
  /** Template this dashboard was seeded from; enables "Restore default". */
  templateKey: string | null;
  /** The template has changed since this dashboard was added or restored. */
  templateUpdated: boolean;
  version: number;
  updatedAt: string;
  updatedBy: string | null;
}

export interface DashboardVersion {
  version: number;
  title: string;
  savedAt: string;
  savedBy: string | null;
}

// ── Templates ────────────────────────────────────────────────────────────────

/** A template panel: laid out left to right by width in quarters of a row. */
export interface TemplatePanel extends Omit<DashboardPanel, 'layout'> {
  width?: 1 | 2 | 3 | 4;
}

export interface TemplateRow {
  title: string;
  collapsed?: boolean;
  repeat?: string;
  panels: TemplatePanel[];
}

export interface DashboardTemplate {
  key: string;
  title: string;
  description: string;
  defaults?: DashboardDefaults;
  variables: DashboardVariable[];
  rows: TemplateRow[];
}

/** Interfaces that are virtual, container plumbing or loopback. */
export const IGNORED_INTERFACES = 'lo|veth.*|docker.*|br-.*|tap.*|fwbr.*|fwpr.*|fwln.*';
/** Pseudo devices excluded from disk charts. */
export const IGNORED_DISKS = 'loop.*|ram.*|zd.*|dm-.*|sr.*';
/** Pseudo filesystems excluded from filesystem charts. */
export const IGNORED_FILESYSTEMS = 'tmpfs|devtmpfs|overlay|squashfs|nsfs|proc|sysfs|cgroup.*|fuse.*';
