import { describe, expect, it, vi } from 'vitest';

vi.mock('../../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../alerts/delivery-worker.js', () => ({ getAlertDeliveryWorkerHealth: vi.fn() }));
vi.mock('../alerts/webhook-transport.js', () => ({ sendAlertWebhook: vi.fn() }));
vi.mock('../../middleware/security.js', () => ({ validateOutboundUrl: vi.fn() }));
vi.mock('./scheduler.js', () => ({ getMonitoringSchedulerHealth: vi.fn() }));
vi.mock('../leader-lock.js', () => ({ isBackgroundJobsLeader: vi.fn() }));

import { parseHeartbeatMs } from './heartbeat.js';

describe('parseHeartbeatMs', () => {
  it('uses the fallback when unset or blank', () => {
    expect(parseHeartbeatMs(undefined, 5000, 1000, 60000)).toBe(5000);
    expect(parseHeartbeatMs('  ', 5000, 1000, 60000)).toBe(5000);
  });

  it('accepts whole values inside the bounds and floors fractions', () => {
    expect(parseHeartbeatMs('2500', 5000, 1000, 60000)).toBe(2500);
    expect(parseHeartbeatMs('2500.9', 5000, 1000, 60000)).toBe(2500);
    expect(parseHeartbeatMs('1000', 5000, 1000, 60000)).toBe(1000);
    expect(parseHeartbeatMs('60000', 5000, 1000, 60000)).toBe(60000);
  });

  it('falls back for values below, above or not numeric', () => {
    expect(parseHeartbeatMs('999', 5000, 1000, 60000)).toBe(5000);
    expect(parseHeartbeatMs('60001', 5000, 1000, 60000)).toBe(5000);
    expect(parseHeartbeatMs('abc', 5000, 1000, 60000)).toBe(5000);
    expect(parseHeartbeatMs('Infinity', 5000, 1000, 60000)).toBe(5000);
  });
});
