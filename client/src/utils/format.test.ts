import { describe, expect, it } from 'vitest';
import { formatMetricNumber, formatMetricPercent } from './format';

describe('metric number formatting', () => {
  it.each([
    [1, '1'],
    [1.2, '1.2'],
    [1.23, '1.23'],
    [1.234, '1.23'],
    [1.236, '1.24'],
    [-1.234, '-1.23'],
  ])('formats %s without unnecessary trailing zeroes', (value, expected) => {
    expect(formatMetricNumber(value)).toBe(expected);
  });

  it('preserves percentage meaning while appending the unit', () => {
    expect(formatMetricPercent(0.9981860054911877)).toBe('1%');
    expect(formatMetricPercent(99.125)).toBe('99.13%');
  });
});
