import { describe, expect, it } from 'vitest';
import { DISCOVERY_DEFAULTS, discoverySelector, selectorMatchers, validateDiscoverySettings } from './discovery.js';

describe('telemetry discovery settings', () => {
  it('uses generic labels and permits another collector schema without renaming samples', () => {
    expect(DISCOVERY_DEFAULTS).toMatchObject({ telemetrySourceLabel: 'instance', telemetryGroupLabel: 'job' });
    expect(validateDiscoverySettings({ telemetrySourceLabel: 'host', telemetryGroupLabel: 'role' }, DISCOVERY_DEFAULTS)).toBeNull();
    expect(validateDiscoverySettings({ telemetryGroupLabel: '' }, DISCOVERY_DEFAULTS)).toBeNull();
  });
  it.each(['host) or vector(1)', '__name__', '', 'bad-name'])('rejects injected/reserved identity label %s', label => {
    expect(validateDiscoverySettings({ telemetrySourceLabel: label }, DISCOVERY_DEFAULTS)).not.toBeNull();
  });
  it('rejects duplicate labels and non-string values', () => {
    expect(validateDiscoverySettings({ telemetrySourceLabel: 'a'.repeat(129) }, DISCOVERY_DEFAULTS)).not.toBeNull();
    expect(validateDiscoverySettings({ telemetryGroupLabel: 'a'.repeat(129) }, DISCOVERY_DEFAULTS)).not.toBeNull();
    expect(validateDiscoverySettings({ telemetryGroupLabel: 'instance' }, DISCOVERY_DEFAULTS)).not.toBeNull();
    expect(validateDiscoverySettings({ telemetrySourceSelector: 4 }, DISCOVERY_DEFAULTS)).not.toBeNull();
  });
  it('normalizes metric names and quoted matcher values', () => {
    expect(selectorMatchers('up')).toEqual(['__name__="up"']);
    expect(selectorMatchers('up{ job = "app",zone!="test" }')).toEqual(['__name__="up"', 'job="app"', 'zone!="test"']);
    expect(discoverySelector(DISCOVERY_DEFAULTS, ['instance="node\\\"a"'])).toBe('{__name__=~".+",instance!="",instance="node\\\"a"}');
  });
  it('bounds the total number of matchers including the metric name', () => {
    const matchers = Array.from({ length: 20 }, (_, index) => `label${index}="value"`).join(',');
    expect(selectorMatchers(`{${matchers}}`)).toHaveLength(20);
    expect(() => selectorMatchers(`up{${matchers}}`)).toThrow('too many');
  });
  it.each(['{}', '{job="app"} or vector(1)', '{job="app",}', '{job="x" bad="y"}', '{job="x"\n} offset 1h', 'x'.repeat(1025)])('rejects unsafe selector %s', selector => {
    expect(() => selectorMatchers(selector)).toThrow();
  });
});
