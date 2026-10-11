import { describe, expect, it } from 'vitest';

import {
  aggregateComplianceMetrics,
  complianceBand,
  computeComplianceMetrics,
} from './compliance-metrics.js';

describe('computeComplianceMetrics', () => {
  it('uses aligned-pass over total, not the average of SPF and DKIM rates', () => {
    // Fully DKIM-aligned, zero SPF alignment (classic forwarding case).
    const metrics = computeComplianceMetrics({ totalVolume: 1000, alignedPassVolume: 1000 });
    expect(metrics.complianceRate).toBe(1);
  });

  it('treats a zero-volume domain as compliant rather than 0%', () => {
    const metrics = computeComplianceMetrics({ totalVolume: 0, alignedPassVolume: 0 });
    expect(metrics.complianceRate).toBe(1);
    expect(metrics.unidentifiedRate).toBe(0);
  });

  it('clamps aligned volume that exceeds the total', () => {
    const metrics = computeComplianceMetrics({ totalVolume: 100, alignedPassVolume: 250 });
    expect(metrics.alignedPassVolume).toBe(100);
    expect(metrics.complianceRate).toBe(1);
  });

  it('reports unidentified volume as a share of the total', () => {
    const metrics = computeComplianceMetrics({
      totalVolume: 400,
      alignedPassVolume: 300,
      unidentifiedVolume: 100,
    });
    expect(metrics.complianceRate).toBe(0.75);
    expect(metrics.unidentifiedRate).toBe(0.25);
  });
});

describe('aggregateComplianceMetrics', () => {
  it('weights by volume so a tiny failing domain cannot dominate', () => {
    const metrics = aggregateComplianceMetrics([
      { totalVolume: 100000, alignedPassVolume: 100000 },
      { totalVolume: 10, alignedPassVolume: 0 },
    ]);
    expect(metrics.complianceRate).toBeCloseTo(0.9999, 4);
  });

  it('returns full compliance for an empty portfolio', () => {
    expect(aggregateComplianceMetrics([]).complianceRate).toBe(1);
  });
});

describe('complianceBand', () => {
  it('distinguishes no data from failing', () => {
    expect(complianceBand(1, 0)).toBe('no_data');
    expect(complianceBand(0, 10)).toBe('failing');
  });

  it('bands at the same thresholds the DMARC analyzer uses', () => {
    expect(complianceBand(0.96, 100)).toBe('compliant');
    expect(complianceBand(0.95, 100)).toBe('compliant');
    expect(complianceBand(0.9, 100)).toBe('at_risk');
    expect(complianceBand(0.8, 100)).toBe('at_risk');
    expect(complianceBand(0.79, 100)).toBe('failing');
  });
});
