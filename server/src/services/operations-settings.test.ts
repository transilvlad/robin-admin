import { afterEach, describe, expect, it } from 'vitest';
import { OPERATIONS_SETTINGS, operationsDefaults, operationsPolicy, applyOperationsSettings, validateOperationsSettings } from './operations-settings.js';
import { OPERATION_FIELDS, operationsDefaults as uiDefaults } from '../../../client/src/constants/operationsSettings.js';

afterEach(() => applyOperationsSettings(operationsDefaults()));

describe('Operations policy', () => {
  it('keeps UI defaults and ranges identical to server policy', () => {
    expect(uiDefaults()).toEqual(operationsDefaults());
    expect(Object.fromEntries(OPERATION_FIELDS.map(([key, , value, min, max]) => [key, { default: value, min, max }]))).toEqual(OPERATIONS_SETTINGS);
  });
  it('rejects malformed numeric, boolean and label updates without changing active policy', () => {
    for (const [key, rule] of Object.entries(OPERATIONS_SETTINGS)) {
      for (const value of [rule.min - 1, rule.max + 1, 1.5, '20', NaN, null]) {
        expect(validateOperationsSettings({ [key]: value })).not.toBeNull();
      }
    }
    expect(validateOperationsSettings({ alertsEnabled: 'false' })).not.toBeNull();
    for (const value of ['', '  ', 'bad\nlabel', 'x'.repeat(101)]) expect(validateOperationsSettings({ alertInstanceName: value })).not.toBeNull();
    expect(() => applyOperationsSettings({ ...operationsDefaults(), fleetCommandLeaseMs: 5000 })).toThrow('lease');
    expect(operationsPolicy()).toEqual(operationsDefaults());
  });
  it('validates related values as one policy and applies live changes', () => {
    expect(validateOperationsSettings({ alertRetryBaseMs: 300000, alertRetryMaxMs: 1000 })).not.toBeNull();
    const policy = { ...operationsDefaults(), fleetCommandPollWaitMs: 1000, fleetCommandLeaseMs: 5000,
      alertRetryBaseMs: 1000, alertRetryMaxMs: 1000, alertsEnabled: true, alertInstanceName: ' Example ' };
    applyOperationsSettings(policy);
    expect(operationsPolicy()).toEqual({ ...policy, alertInstanceName: 'Example' });
  });
});
