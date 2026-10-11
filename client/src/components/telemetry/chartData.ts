import type { TelemetrySeries } from '../../types/telemetry';

/** Series sorted by name so each keeps its colour across refreshes. */
export function sortSeries(series: TelemetrySeries[]): TelemetrySeries[] {
  return [...series].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

/**
 * Cumulative values for a stacked chart: each series sits on top of the ones
 * before it. Gaps stay gaps; a missing lower value counts as zero.
 */
export function stackValues(series: Array<Array<number | null>>, visible: boolean[]): Array<Array<number | null>> {
  const length = series[0]?.length ?? 0;
  const totals = new Array<number>(length).fill(0);
  return series.map((values, index) => {
    if (!visible[index]) return values.map(() => null);
    return values.map((value, i) => {
      if (value === null) return null;
      totals[i] += value;
      return totals[i];
    });
  });
}

export interface SeriesSummary {
  last: number | null;
  min: number | null;
  max: number | null;
  mean: number | null;
}

export function summarize(values: Array<number | null>): SeriesSummary {
  let last: number | null = null;
  let min = Infinity;
  let max = -Infinity;
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value === null) continue;
    last = value;
    min = Math.min(min, value);
    max = Math.max(max, value);
    sum += value;
    count++;
  }
  return count === 0
    ? { last: null, min: null, max: null, mean: null }
    : { last, min, max, mean: sum / count };
}
