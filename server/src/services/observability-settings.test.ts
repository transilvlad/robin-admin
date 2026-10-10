import { describe, expect, it } from 'vitest';
import { observabilityDefaults, validateObservabilitySettings } from './observability-settings.js';

describe('observability policy', () => {
  it('accepts bounded numeric updates', () => {
    expect(validateObservabilitySettings({ telemetrySourceWindowDays: 14, monitoringConcurrency: 32 }, observabilityDefaults())).toBeNull();
  });
  it.each([0, 91, 1.5, '14', '14x', null, true, NaN, Infinity])('rejects invalid discovery windows: %s', value => {
    expect(validateObservabilitySettings({ telemetrySourceWindowDays: value }, observabilityDefaults())).toContain('integer');
  });
  it('reserves scheduled capacity, including partial updates', () => {
    expect(validateObservabilitySettings({ monitoringConcurrency: 8 }, observabilityDefaults())).toContain('scheduled');
    expect(validateObservabilitySettings({ monitoringConcurrency: 4, monitoringManualConcurrency: 3 }, observabilityDefaults())).toBeNull();
  });
  it('does not permit daily evidence to expire before raw evidence', () => {
    expect(validateObservabilitySettings({ monitoringHistoryRetentionDays: 29 }, observabilityDefaults())).toContain('retention');
  });
});
