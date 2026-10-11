import { describe, expect, it } from 'vitest';
import { balancedExpr, formatSeriesName, parseVariableValues, rateInterval, renderExpr, variableRegex } from './expressions.js';
import { TelemetryQueryError } from './store-client.js';

describe('variable substitution', () => {
  it('escapes values for a regex inside a PromQL string', () => {
    expect(variableRegex(['worker-a'])).toBe('worker-a');
    expect(variableRegex(['a.b', 'c'])).toBe('(a\\\\.b|c)');
    expect(variableRegex(['x"y'])).toBe('x\\"y');
    expect(variableRegex([])).toBe('.+');
    expect(variableRegex(undefined)).toBe('.+');
  });

  it('renders variables, intervals and rejects unknown names', () => {
    const allowed = new Set(['host']);
    expect(renderExpr('rate(x{host=~"$host"}[$__rate_interval]) / $__interval', { host: ['a'] }, 30, allowed))
      .toBe('rate(x{host=~"a"}[240s]) / 30s');
    expect(() => renderExpr('x{vm=~"$vm"}', {}, 30, allowed)).toThrow(TelemetryQueryError);
    // Regex back-references in label_replace are not placeholders.
    expect(renderExpr('label_replace(x, "s", "$1", "__name__", "(.+)")', {}, 30, allowed)).toContain('"$1"');
  });

  it('keeps the rate window at least several samples long', () => {
    expect(rateInterval(15)).toBe('240s');
    expect(rateInterval(900)).toBe('3600s');
  });

  it('parses repeated var- query parameters within limits', () => {
    expect(parseVariableValues({ 'var-host': 'a', 'var-vm': ['x', 'y'], other: 'z', 'var-empty': '' }))
      .toEqual({ host: ['a'], vm: ['x', 'y'], empty: [] });
    expect(() => parseVariableValues({ 'var-host': Array.from({ length: 101 }, String) })).toThrow('at most 100');
    expect(() => parseVariableValues({ 'var-host': 'x'.repeat(257) })).toThrow('256 characters');
  });
});

describe('balancedExpr', () => {
  it('checks brackets and quotes outside strings', () => {
    expect(balancedExpr('sum(rate(x{a="(b"}[5m]))')).toBe(true);
    expect(balancedExpr('sum(rate(x[5m])')).toBe(false);
    expect(balancedExpr('x{a="b}')).toBe(false);
    expect(balancedExpr('x{a="b\\"c"}')).toBe(true);
  });
});

describe('formatSeriesName', () => {
  it('fills legends and falls back to labels or the panel title', () => {
    expect(formatSeriesName('{{device}} in', { device: 'eth0' }, 'Panel')).toBe('eth0 in');
    expect(formatSeriesName(undefined, { __name__: 'up', host: 'a' }, 'Panel')).toBe('host="a"');
    expect(formatSeriesName(undefined, {}, 'Panel')).toBe('Panel');
    expect(formatSeriesName('{{missing}}', { host: 'a' }, 'Panel')).toBe('host="a"');
  });
});
