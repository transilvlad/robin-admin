/**
 * Telemetry helpers: value formatting per unit, time ranges and thresholds.
 */

import type { TelemetryPanel, TelemetryRangeData, TelemetryUnit, TelemetryVariableValues } from '../types/telemetry';

const EMPTY = '—';

/** `digits` decimals with trailing zeros dropped, or exactly `fixed` when set. */
function num(value: number, digits: number, fixed?: number): string {
  return fixed === undefined ? Number(value.toFixed(digits)).toString() : value.toFixed(fixed);
}

function scaled(value: number, base: number, units: string[], fixed?: number, digits = 1): string {
  let index = 0;
  let magnitude = Math.abs(value);
  while (magnitude >= base && index < units.length - 1) {
    magnitude /= base;
    index++;
  }
  const sign = value < 0 ? '-' : '';
  return `${sign}${num(magnitude, magnitude >= 100 ? 0 : digits, fixed)} ${units[index]}`.trim();
}

function compact(value: number, fixed?: number): string {
  const magnitude = Math.abs(value);
  if (magnitude >= 1000) return scaled(value, 1000, ['', 'k', 'M', 'B', 'T'], fixed).replace(' ', '');
  if (magnitude === 0 || magnitude >= 100) return num(value, 0, fixed);
  if (magnitude >= 1) return num(value, magnitude >= 10 ? 1 : 2, fixed);
  return num(value, 3, fixed);
}

function duration(seconds: number, fixed?: number): string {
  const magnitude = Math.abs(seconds);
  if (magnitude === 0) return '0 s';
  if (magnitude < 1) return `${num(seconds * 1000, magnitude < 0.01 ? 2 : 0, fixed)} ms`;
  if (magnitude < 60) return `${num(seconds, magnitude < 10 ? 2 : 1, fixed)} s`;
  if (magnitude < 3600) return `${num(seconds / 60, 1, fixed)} min`;
  if (magnitude < 86400) return `${num(seconds / 3600, 1, fixed)} h`;
  return `${num(seconds / 86400, 1, fixed)} d`;
}

/** Human-readable value in a panel's unit, optionally with a fixed number of decimals. */
export function formatTelemetryValue(value: number | null | undefined, unit: TelemetryUnit, decimals?: number): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return EMPTY;
  switch (unit) {
    case 'percent':
      return `${num(value, Math.abs(value) < 10 ? 1 : 0, decimals)}%`;
    case 'percentunit':
      return formatTelemetryValue(value * 100, 'percent', decimals);
    case 'bytes':
      return scaled(value, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'], decimals);
    case 'bytes_per_second':
      return `${scaled(value, 1024, ['B', 'KiB', 'MiB', 'GiB', 'TiB'], decimals)}/s`;
    case 'bits_per_second':
      return scaled(value, 1000, ['bps', 'kbps', 'Mbps', 'Gbps', 'Tbps'], decimals);
    case 'seconds':
      return duration(value, decimals);
    case 'milliseconds':
      return duration(value / 1000, decimals);
    case 'per_second':
      return `${compact(value, decimals)}/s`;
    case 'up_down':
      return value >= 0.5 ? 'Up' : 'Down';
    case 'count':
      // Counts are whole things; averages of them only need a decimal when small.
      return Math.abs(value) >= 1000 ? compact(value, decimals) : num(value, Math.abs(value) >= 10 ? 0 : 1, decimals);
    case 'none':
    default:
      return compact(value, decimals);
  }
}

export type ThresholdLevel = 'ok' | 'warning' | 'critical';

export function thresholdLevel(value: number | null | undefined, panel: Pick<TelemetryPanel, 'thresholds' | 'invertThresholds' | 'unit'>): ThresholdLevel {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'ok';
  if (panel.unit === 'up_down') return value >= 0.5 ? 'ok' : 'critical';
  const { warning, critical } = panel.thresholds ?? {};
  const breached = (limit: number | undefined) => limit !== undefined && (panel.invertThresholds ? value <= limit : value >= limit);
  if (breached(critical)) return 'critical';
  if (breached(warning)) return 'warning';
  return 'ok';
}

export interface CurrentValue {
  value: number | null;
  /** Unix seconds of the last sample when the series stopped before the range ends. */
  stoppedAt: number | null;
}

/**
 * The value a series has at the end of the range: its last sample, unless that
 * is older than two steps (and at least five minutes), meaning the series
 * stopped, for example a host that went silent. A stopped series has no
 * current value, so it never shows a stale reading as if it were live.
 */
export function currentValue(data: Pick<TelemetryRangeData, 'timestamps' | 'step' | 'end'>, values: Array<number | null>): CurrentValue {
  for (let i = values.length - 1; i >= 0; i--) {
    const value = values[i];
    if (value === null) continue;
    const at = data.timestamps[i];
    if (data.end - at > Math.max(2 * data.step, 300)) return { value: null, stoppedAt: at };
    return { value, stoppedAt: null };
  }
  return { value: null, stoppedAt: null };
}

/** A duration in its largest whole unit: `45s`, `12m`, `3h`, `2d`. */
export function formatSpan(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

// ── Time ranges ──────────────────────────────────────────────────────────────

export const RANGE_PRESETS = [
  { value: '15m', label: '15m', seconds: 15 * 60 },
  { value: '1h', label: '1h', seconds: 3600 },
  { value: '6h', label: '6h', seconds: 6 * 3600 },
  { value: '24h', label: '24h', seconds: 24 * 3600 },
  { value: '7d', label: '7d', seconds: 7 * 86400 },
  { value: '30d', label: '30d', seconds: 30 * 86400 },
] as const;

export type RangePreset = typeof RANGE_PRESETS[number]['value'];
export const DEFAULT_RANGE: RangePreset = '6h';

export type TimeRange =
  | { kind: 'relative'; preset: RangePreset }
  | { kind: 'absolute'; from: number; to: number };

export const REFRESH_OPTIONS = [
  { value: 0, label: 'Off' },
  { value: 30, label: '30s' },
  { value: 60, label: '1m' },
  { value: 300, label: '5m' },
] as const;

export function resolveRange(range: TimeRange, nowSeconds = Math.floor(Date.now() / 1000)): { start: number; end: number } {
  if (range.kind === 'absolute') return { start: range.from, end: range.to };
  const preset = RANGE_PRESETS.find((candidate) => candidate.value === range.preset) ?? RANGE_PRESETS[2];
  return { start: nowSeconds - preset.seconds, end: nowSeconds };
}

/** Read `range` or `from`/`to` (Unix seconds) from the URL. */
export function parseTimeRange(params: URLSearchParams): TimeRange {
  const from = Number(params.get('from'));
  const to = Number(params.get('to'));
  if (Number.isFinite(from) && Number.isFinite(to) && from > 0 && to > from) {
    return { kind: 'absolute', from: Math.floor(from), to: Math.ceil(to) };
  }
  const preset = RANGE_PRESETS.find((candidate) => candidate.value === params.get('range'));
  return { kind: 'relative', preset: preset?.value ?? DEFAULT_RANGE };
}

/** Whether the URL picks a time range itself. */
export function hasTimeRange(params: URLSearchParams): boolean {
  return params.has('range') || (params.has('from') && params.has('to'));
}

/**
 * Put a range in the URL. The default preset is left out unless `explicit`,
 * which dashboards need so a chosen 6h still beats a dashboard default.
 */
export function writeTimeRange(params: URLSearchParams, range: TimeRange, explicit = false): void {
  params.delete('range');
  params.delete('from');
  params.delete('to');
  if (range.kind === 'absolute') {
    params.set('from', String(range.from));
    params.set('to', String(range.to));
  } else if (explicit || range.preset !== DEFAULT_RANGE) {
    params.set('range', range.preset);
  }
}

export function readVariableValues(params: URLSearchParams): TelemetryVariableValues {
  const values: TelemetryVariableValues = {};
  for (const [key, value] of params.entries()) {
    if (!key.startsWith('var-') || !value) continue;
    (values[key.slice(4)] ??= []).push(value);
  }
  return values;
}

export function writeVariableValues(params: URLSearchParams, values: TelemetryVariableValues): void {
  for (const key of [...params.keys()]) {
    if (key.startsWith('var-')) params.delete(key);
  }
  for (const [name, list] of Object.entries(values)) {
    for (const value of list) params.append(`var-${name}`, value);
  }
}

/** `2026-10-01T14:05` in local time, for datetime-local inputs. */
export function toLocalInput(seconds: number): string {
  const date = new Date(seconds * 1000);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function fromLocalInput(value: string): number | null {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? Math.floor(time / 1000) : null;
}

export function describeRange(range: TimeRange): string {
  if (range.kind === 'relative') return `Last ${range.preset}`;
  const format = (seconds: number) => new Date(seconds * 1000).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
  return `${format(range.from)} – ${format(range.to)}`;
}
