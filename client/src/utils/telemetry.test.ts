import { describe, expect, it } from 'vitest';
import {
  formatTelemetryValue,
  currentValue,
  formatSpan,
  parseTimeRange,
  readVariableValues,
  resolveRange,
  thresholdLevel,
  writeTimeRange,
  writeVariableValues,
} from './telemetry';

describe('formatTelemetryValue', () => {
  it('formats each unit', () => {
    expect(formatTelemetryValue(42.345, 'percent')).toBe('42%');
    expect(formatTelemetryValue(4.25, 'percent')).toBe('4.3%');
    expect(formatTelemetryValue(0.5, 'percentunit')).toBe('50%');
    expect(formatTelemetryValue(1536, 'bytes')).toBe('1.5 KiB');
    expect(formatTelemetryValue(16 * 1024 ** 3, 'bytes')).toBe('16 GiB');
    expect(formatTelemetryValue(2.5 * 1024 ** 2, 'bytes_per_second')).toBe('2.5 MiB/s');
    expect(formatTelemetryValue(12_500_000, 'bits_per_second')).toBe('12.5 Mbps');
    expect(formatTelemetryValue(0.25, 'seconds')).toBe('250 ms');
    expect(formatTelemetryValue(90, 'seconds')).toBe('1.5 min');
    expect(formatTelemetryValue(2 * 86400, 'seconds')).toBe('2 d');
    expect(formatTelemetryValue(35, 'milliseconds')).toBe('35 ms');
    expect(formatTelemetryValue(1500, 'count')).toBe('1.5k');
    expect(formatTelemetryValue(3, 'count')).toBe('3');
    expect(formatTelemetryValue(20.1, 'count')).toBe('20');
    expect(formatTelemetryValue(2.5, 'count')).toBe('2.5');
    expect(formatTelemetryValue(0.123456, 'none')).toBe('0.123');
    expect(formatTelemetryValue(12.5, 'per_second')).toBe('12.5/s');
    expect(formatTelemetryValue(1, 'up_down')).toBe('Up');
    expect(formatTelemetryValue(0, 'up_down')).toBe('Down');
  });

  it('uses a fixed number of decimals when asked', () => {
    expect(formatTelemetryValue(42.346, 'percent', 2)).toBe('42.35%');
    expect(formatTelemetryValue(1536, 'bytes', 0)).toBe('2 KiB');
    expect(formatTelemetryValue(3, 'count', 2)).toBe('3.00');
    expect(formatTelemetryValue(1500, 'none', 3)).toBe('1.500k');
  });

  it('shows a dash for missing values', () => {
    expect(formatTelemetryValue(null, 'percent')).toBe('—');
    expect(formatTelemetryValue(Number.NaN, 'bytes')).toBe('—');
  });
});

describe('thresholdLevel', () => {
  it('compares against warning and critical limits', () => {
    const panel = { unit: 'percent' as const, thresholds: { warning: 80, critical: 90 } };
    expect(thresholdLevel(50, panel)).toBe('ok');
    expect(thresholdLevel(85, panel)).toBe('warning');
    expect(thresholdLevel(95, panel)).toBe('critical');
    expect(thresholdLevel(null, panel)).toBe('ok');
  });

  it('supports lower-is-worse limits and up/down units', () => {
    expect(thresholdLevel(5, { unit: 'bytes', thresholds: { warning: 10, critical: 2 }, invertThresholds: true })).toBe('warning');
    expect(thresholdLevel(1, { unit: 'bytes', thresholds: { warning: 10, critical: 2 }, invertThresholds: true })).toBe('critical');
    expect(thresholdLevel(0, { unit: 'up_down' })).toBe('critical');
    expect(thresholdLevel(1, { unit: 'up_down' })).toBe('ok');
  });
});

describe('time ranges', () => {
  it('resolves presets against now', () => {
    expect(resolveRange({ kind: 'relative', preset: '1h' }, 10_000)).toEqual({ start: 6400, end: 10_000 });
    expect(resolveRange({ kind: 'absolute', from: 1, to: 2 })).toEqual({ start: 1, end: 2 });
  });

  it('round-trips through the URL and defaults to 6h', () => {
    expect(parseTimeRange(new URLSearchParams())).toEqual({ kind: 'relative', preset: '6h' });
    expect(parseTimeRange(new URLSearchParams('range=bogus'))).toEqual({ kind: 'relative', preset: '6h' });
    expect(parseTimeRange(new URLSearchParams('from=200&to=100'))).toEqual({ kind: 'relative', preset: '6h' });

    const params = new URLSearchParams('range=1h');
    writeTimeRange(params, { kind: 'absolute', from: 100, to: 200 });
    expect(params.toString()).toBe('from=100&to=200');
    expect(parseTimeRange(params)).toEqual({ kind: 'absolute', from: 100, to: 200 });
    writeTimeRange(params, { kind: 'relative', preset: '6h' });
    expect(params.toString()).toBe('');
  });
});

describe('variable values in the URL', () => {
  it('reads and writes repeated var- parameters', () => {
    const params = new URLSearchParams('dashboard=host&var-host=a&var-vm=x&var-vm=y&var-empty=');
    expect(readVariableValues(params)).toEqual({ host: ['a'], vm: ['x', 'y'] });
    writeVariableValues(params, { host: ['b'] });
    expect(params.toString()).toBe('dashboard=host&var-host=b');
  });
});

describe('currentValue', () => {
  const data = (timestamps: number[], step = 60) => ({ timestamps, step, end: timestamps[timestamps.length - 1] });

  it('skips a short trailing gap', () => {
    expect(currentValue(data([0, 60, 120, 180]), [1, 2, null, null])).toEqual({ value: 2, stoppedAt: null });
  });

  it('reports a series that stopped instead of its old value', () => {
    expect(currentValue(data([0, 600, 1200, 1800]), [1, 2, null, null])).toEqual({ value: null, stoppedAt: 600 });
  });

  it('allows two steps on coarse ranges', () => {
    expect(currentValue(data([0, 3600, 7200], 3600), [1, 2, null])).toEqual({ value: 2, stoppedAt: null });
    expect(currentValue(data([0, 3600, 7200, 10800], 3600), [1, null, null, null])).toEqual({ value: null, stoppedAt: 0 });
  });

  it('has nothing for an empty series', () => {
    expect(currentValue(data([0, 60]), [null, null])).toEqual({ value: null, stoppedAt: null });
  });
});

describe('formatSpan', () => {
  it('uses the largest whole unit', () => {
    expect([formatSpan(5), formatSpan(125), formatSpan(7200), formatSpan(200000)]).toEqual(['5s', '2m', '2h', '2d']);
  });
});
