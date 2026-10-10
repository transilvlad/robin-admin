import { describe, expect, it } from 'vitest';
import { counterDeltas } from './metricTrends';

describe('counterDeltas', () => {
  it('converts cumulative samples to interval deltas', () => {
    expect(counterDeltas([{ value: 10 }, { value: 14 }, { value: 18 }], (sample) => sample.value)).toEqual([4, 4]);
  });

  it('does not report negative deltas when a counter resets', () => {
    expect(counterDeltas([{ value: 18 }, { value: 3 }], (sample) => sample.value)).toEqual([0]);
  });
});
