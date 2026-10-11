import { afterEach, describe, expect, it } from 'vitest';
import { applyReportingSettings, reportingDefaults, reportingPolicy, validateReportingSettings } from './reporting-settings.js';

afterEach(() => applyReportingSettings(reportingDefaults()));
describe('reporting resource settings', () => {
  it('accepts every bound and rejects invalid types and unbounded values', () => {
    expect(validateReportingSettings({ reportingSourceQueueSize: 0 })).toBeNull();
    for (const value of [0, 9, 1.5, NaN, '2', null]) {
      expect(validateReportingSettings({ reportingSourceConcurrency: value })).toMatch(/integer/);
    }
    expect(validateReportingSettings({ reportingCacheMiB: 1024 })).toBeNull();
    expect(validateReportingSettings({ reportingCacheMiB: 1025 })).not.toBeNull();
  });
  it('copies recognized fields without retaining arbitrary config or secrets', () => {
    const settings = { ...reportingDefaults(), reportingSourceConcurrency: 4, password: 'secret' };
    applyReportingSettings(settings);
    settings.reportingSourceConcurrency = 6;
    expect(reportingPolicy().reportingSourceConcurrency).toBe(4);
    expect(reportingPolicy()).not.toHaveProperty('password');
  });
});
