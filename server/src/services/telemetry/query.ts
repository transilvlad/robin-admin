/**
 * Bounded reads from the Telemetry store for the UI.
 *
 * Range results are aligned onto one shared timestamp array so a chart can
 * plot every series against the same x values. Steps are clamped so a series
 * never exceeds MAX_POINTS, and responses carry at most MAX_SERIES series.
 */

import { readTelemetryStore, TelemetryQueryError } from './store-client.js';
import { getConfig } from '../../db/queries/config.js';
import { discoverySelector } from './discovery.js';

export const MAX_POINTS = 1500;
export const MAX_SERIES = 100;
export const MAX_QUERY_LENGTH = 4000;
export const MAX_RANGE_SECONDS = 400 * 24 * 3600;
export const MAX_LABEL_VALUES = 5000;
const AUTO_POINTS = 600;
const NICE_STEPS = [15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400];
const LABEL_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export type Labels = Record<string, string>;

export interface RangeResult {
  start: number;
  end: number;
  step: number;
  timestamps: number[];
  series: Array<{ labels: Labels; values: Array<number | null> }>;
  truncated: boolean;
}

export interface InstantResult {
  series: Array<{ labels: Labels; value: number | null }>;
  truncated: boolean;
}

type Sample = [number, string];

interface MatrixData {
  resultType: 'matrix';
  result: Array<{ metric: Labels; values: Sample[] }>;
}

interface VectorData {
  resultType: 'vector' | 'scalar' | 'string';
  result: Array<{ metric: Labels; value: Sample }> | Sample;
}

function sampleValue(raw: string): number | null {
  const value = Number(raw);
  return Number.isFinite(value) ? value : null;
}

function validateQuery(query: unknown): string {
  if (typeof query !== 'string' || !query.trim()) {
    throw new TelemetryQueryError('query is required');
  }
  if (query.length > MAX_QUERY_LENGTH) {
    throw new TelemetryQueryError(`query must be at most ${MAX_QUERY_LENGTH} characters`);
  }
  return query;
}

/**
 * Pick the step for a range: the requested step (or a step giving about
 * AUTO_POINTS points), never finer than MAX_POINTS points across the range.
 */
export function resolveStep(rangeSeconds: number, requested?: number, maxPoints = MAX_POINTS): number {
  const minimum = Math.ceil(rangeSeconds / Math.max(1, maxPoints - 1));
  if (requested !== undefined) {
    return Math.max(1, Math.ceil(requested), minimum);
  }
  const target = rangeSeconds / AUTO_POINTS;
  const nice = NICE_STEPS.find((step) => step >= target) ?? Math.ceil(target);
  return Math.max(nice, minimum);
}

function parseSeconds(value: unknown, name: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new TelemetryQueryError(`${name} must be a Unix timestamp in seconds`);
  }
  return parsed;
}

export async function queryRange(input: { query: unknown; start: unknown; end: unknown; step?: unknown }): Promise<RangeResult> {
  const settings = await getConfig();
  const query = validateQuery(input.query);
  const start = Math.floor(parseSeconds(input.start, 'start'));
  const end = Math.ceil(parseSeconds(input.end, 'end'));
  if (end <= start) {
    throw new TelemetryQueryError('end must be after start');
  }
  const rangeDays = settings.telemetryQueryMaxRangeDays ?? 400;
  if (end - start > Math.min(MAX_RANGE_SECONDS, rangeDays * 86400)) {
    throw new TelemetryQueryError(`range must be at most ${rangeDays} days`);
  }
  const requestedStep = input.step === undefined || input.step === '' ? undefined : parseSeconds(input.step, 'step');
  const step = resolveStep(end - start, requestedStep, settings.telemetryQueryMaxPoints ?? MAX_POINTS);

  const data = await readTelemetryStore<MatrixData>(
    '/api/v1/query_range',
    new URLSearchParams({ query, start: String(start), end: String(end), step: String(step) }),
  );
  if (data.resultType !== 'matrix') {
    throw new TelemetryQueryError(`Expected a range result, got ${data.resultType}`);
  }

  const maxSeries = Math.min(MAX_SERIES, settings.telemetryQueryMaxSeries ?? MAX_SERIES);
  const kept = data.result.slice(0, maxSeries);
  const timestampSet = new Set<number>();
  for (const series of kept) {
    for (const [timestamp] of series.values.slice(0, settings.telemetryQueryMaxPoints ?? MAX_POINTS)) timestampSet.add(timestamp);
  }
  const maxPoints = settings.telemetryQueryMaxPoints ?? MAX_POINTS;
  const timestamps = [...timestampSet].sort((a, b) => a - b).slice(0, maxPoints);
  const index = new Map(timestamps.map((timestamp, i) => [timestamp, i]));

  return {
    start,
    end,
    step,
    timestamps,
    series: kept.map((series) => {
      const values: Array<number | null> = new Array(timestamps.length).fill(null);
      for (const [timestamp, raw] of series.values.slice(0, maxPoints)) {
        const position = index.get(timestamp);
        if (position !== undefined) values[position] = sampleValue(raw);
      }
      return { labels: series.metric, values };
    }),
    truncated: data.result.length > maxSeries || timestampSet.size > maxPoints || kept.some(series => series.values.length > maxPoints),
  };
}

export async function queryInstant(input: { query: unknown; time?: unknown; maxSeries?: number }): Promise<InstantResult> {
  const query = validateQuery(input.query);
  const params = new URLSearchParams({ query });
  if (input.time !== undefined && input.time !== '') {
    params.set('time', String(parseSeconds(input.time, 'time')));
  }
  const data = await readTelemetryStore<VectorData>('/api/v1/query', params);
  if (data.resultType === 'scalar') {
    const [, raw] = data.result as Sample;
    return { series: [{ labels: {}, value: sampleValue(raw) }], truncated: false };
  }
  if (data.resultType !== 'vector') {
    throw new TelemetryQueryError(`Expected an instant result, got ${data.resultType}`);
  }
  const result = data.result as Array<{ metric: Labels; value: Sample }>;
  // Discovery has its own larger, bounded source policy. Only internal callers
  // supply maxSeries; interactive queries use the operator's query policy.
  const limit = input.maxSeries === undefined ? Math.min((await getConfig()).telemetryQueryMaxSeries ?? MAX_SERIES, MAX_SERIES) : Math.min(input.maxSeries, MAX_LABEL_VALUES);
  return {
    series: result.slice(0, limit).map((series) => ({ labels: series.metric, value: sampleValue(series.value[1]) })),
    truncated: result.length > limit,
  };
}

/**
 * Values of one label, optionally restricted by a series selector and time
 * window (defaults to the last hour so departed hosts drop out).
 */
export async function labelValues(input: { name: unknown; match?: unknown; start?: unknown; end?: unknown }): Promise<string[]> {
  if (typeof input.name !== 'string' || !LABEL_NAME_RE.test(input.name)) {
    throw new TelemetryQueryError('label name must be a valid Prometheus label name');
  }
  const end = input.end === undefined || input.end === '' ? Date.now() / 1000 : parseSeconds(input.end, 'end');
  const start = input.start === undefined || input.start === '' ? end - 3600 : parseSeconds(input.start, 'start');
  const params = new URLSearchParams({ start: String(Math.floor(start)), end: String(Math.ceil(end)), limit: String(MAX_LABEL_VALUES) });
  if (input.match !== undefined && input.match !== '') {
    params.append('match[]', validateQuery(input.match));
  }
  const values = await readTelemetryStore<string[]>(`/api/v1/label/${input.name}/values`, params);
  return values.slice(0, MAX_LABEL_VALUES);
}

/** Label names present on series matching `match` (default: all), for the Explore label browser. */
export async function labelNames(input: { match?: unknown; start?: unknown; end?: unknown }): Promise<string[]> {
  const end = input.end === undefined || input.end === '' ? Date.now() / 1000 : parseSeconds(input.end, 'end');
  const start = input.start === undefined || input.start === '' ? end - 3600 : parseSeconds(input.start, 'start');
  const params = new URLSearchParams({ start: String(Math.floor(start)), end: String(Math.ceil(end)) });
  if (input.match !== undefined && input.match !== '') {
    params.append('match[]', validateQuery(input.match));
  }
  const names = await readTelemetryStore<string[]>('/api/v1/labels', params);
  return names.filter((name) => name !== '__name__').slice(0, MAX_LABEL_VALUES);
}

export interface TelemetryStatus {
  totalSeries: number;
  sources: string[];
}

export async function telemetryStatus(): Promise<TelemetryStatus> {
  const settings = await getConfig();
  const [tsdb, sources] = await Promise.all([
    readTelemetryStore<{ totalSeries: number }>('/api/v1/status/tsdb', new URLSearchParams({ topN: '1' })),
    labelValues({ name: settings.telemetrySourceLabel, match: discoverySelector(settings), start: Date.now() / 1000 - settings.telemetrySilentAfterSeconds }),
  ]);
  return { totalSeries: tsdb.totalSeries, sources };
}
