import { describe, expect, it } from 'vitest';
import { sortSeries, stackValues, summarize } from './chartData';
import { MAX_COLORED_SERIES, seriesColor } from './chartTheme';

describe('sortSeries', () => {
  it('orders by name naturally so colours stay with their series', () => {
    const names = sortSeries([
      { name: 'host-10', labels: {}, values: [] },
      { name: 'host-2', labels: {}, values: [] },
      { name: 'alpha', labels: {}, values: [] },
    ]).map((series) => series.name);
    expect(names).toEqual(['alpha', 'host-2', 'host-10']);
  });
});

describe('stackValues', () => {
  it('accumulates visible series and keeps gaps', () => {
    expect(stackValues([[1, 2, null], [3, null, 4], [5, 5, 5]], [true, true, true])).toEqual([
      [1, 2, null],
      [4, null, 4],
      [9, 7, 9],
    ]);
  });

  it('leaves hidden series out of the stack', () => {
    expect(stackValues([[1, 1], [2, 2], [3, 3]], [true, false, true])).toEqual([
      [1, 1],
      [null, null],
      [4, 4],
    ]);
  });
});

describe('summarize', () => {
  it('reports last, min, max and mean over non-null values', () => {
    expect(summarize([2, null, 6, 4, null])).toEqual({ last: 4, min: 2, max: 6, mean: 4 });
    expect(summarize([null])).toEqual({ last: null, min: null, max: null, mean: null });
  });
});

describe('seriesColor', () => {
  it('uses each palette slot once and a muted colour after the last', () => {
    const colors = Array.from({ length: MAX_COLORED_SERIES }, (_, index) => seriesColor(index, 'light'));
    expect(new Set(colors).size).toBe(MAX_COLORED_SERIES);
    expect(seriesColor(MAX_COLORED_SERIES, 'light')).toBe(seriesColor(MAX_COLORED_SERIES + 5, 'light'));
    expect(seriesColor(0, 'dark')).not.toBe(seriesColor(0, 'light'));
  });
});
