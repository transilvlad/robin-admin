import { describe, expect, it } from 'vitest';
import { calculateRobinActivity24h, sumDelta } from './dashboard.js';
import type { RobinMetricsHistoryRow } from '../services/metrics-poller.js';

function makeRow(overrides: Partial<RobinMetricsHistoryRow>): RobinMetricsHistoryRow {
  return {
    serviceId: 'default',
    serviceType: 'robin',
    timestamp: new Date(),
    emailReceiptStart: 0,
    emailReceiptSuccess: 0,
    emailReceiptLimit: 0,
    emailReceiptException: 0,
    rblRejections: 0,
    virusRejections: 0,
    spamRejections: 0,
    dosRatelimitRejections: 0,
    dosConnlimitRejections: 0,
    dosTarpitCount: 0,
    dosSlowtransferRejections: 0,
    dosCommandfloodRejections: 0,
    whitelistBypasses: 0,
    adaptiveRatelimitApplied: 0,
    geoipBlockRejections: 0,
    geoipLimitApplied: 0,
    distributedStoreErrors: 0,
    jvmMemoryUsed: 0,
    jvmMemoryMax: 0,
    jvmMemoryCommitted: 0,
    jvmThreadsLive: 0,
    jvmThreadsDaemon: 0,
    jvmThreadsPeak: 0,
    jvmThreadsStarted: 0,
    jvmGcPauseSeconds: 0,
    jvmGcPauseCount: 0,
    jvmGcMemoryAllocated: 0,
    jvmGcMemoryPromoted: 0,
    jvmGcLiveDataSize: 0,
    jvmGcMaxDataSize: 0,
    jvmBufferCount: 0,
    jvmBufferMemoryUsed: 0,
    jvmBufferTotalCapacity: 0,
    cpuUsage: 0,
    processCpuUsage: 0,
    systemCpuCount: 0,
    systemLoadAverage: 0,
    rateEmailStart: 0,
    rateEmailSuccess: 0,
    rateRejections: 0,
    ...overrides,
  };
}

describe('sumDelta', () => {
  it('sums a monotonically increasing counter like a plain last-minus-first delta', () => {
    const values = [100, 150, 225, 400];
    expect(sumDelta(values.map((v) => ({ v })), (row) => row.v)).toBe(300);
  });

  it('does not lose the pre-reset portion when a counter resets mid-window', () => {
    // Service restarts between the 2nd and 3rd sample: the counter drops from
    // 900 back to 0. A naive (last - first) delta would clamp this to 0 and
    // erase the whole day's activity even though 900 + 50 real events happened.
    const values = [500, 900, 0, 50];
    expect(sumDelta(values.map((v) => ({ v })), (row) => row.v)).toBe(450);
  });

  it('returns 0 for empty or single-point history', () => {
    expect(sumDelta([], (row: { v: number }) => row.v)).toBe(0);
    expect(sumDelta([{ v: 42 }], (row) => row.v)).toBe(0);
  });
});

describe('calculateRobinActivity24h', () => {
  it('matches a simple last-minus-first delta when there is no restart', () => {
    const history = [
      makeRow({ emailReceiptSuccess: 1000, emailReceiptStart: 1200 }),
      makeRow({ emailReceiptSuccess: 1600, emailReceiptStart: 1900 }),
      makeRow({ emailReceiptSuccess: 2500, emailReceiptStart: 2800 }),
    ];

    const activity = calculateRobinActivity24h(history);

    expect(activity.delivered).toBe(1500);
    expect(activity.received).toBe(1600);
  });

  it('keeps counting delivered mail across a mid-window service restart', () => {
    const history = [
      makeRow({ emailReceiptSuccess: 500 }),
      makeRow({ emailReceiptSuccess: 900 }), // last sample before restart
      makeRow({ emailReceiptSuccess: 0 }),   // first sample after restart
      makeRow({ emailReceiptSuccess: 50 }),
    ];

    const activity = calculateRobinActivity24h(history);

    // 400 delivered before the restart (500 -> 900) plus 50 after (0 -> 50).
    // The old (last - first) approach returned max(0, 50 - 500) = 0 here.
    expect(activity.delivered).toBe(450);
  });
});
