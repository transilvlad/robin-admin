import { describe, it, expect, vi } from 'vitest';

// buildClamavSnapshotFromRaw is a pure assembler over parseVersion/parseStats;
// mock the DB layer clamav.ts imports so importing the module is side-effect free.
vi.mock('../db/queries/fleet-services.js', () => ({ getFleetServiceById: vi.fn() }));
vi.mock('../db/queries/service-metrics.js', () => ({ getMetricsFleetServiceById: vi.fn() }));

import { buildClamavSnapshotFromRaw, clamdEndpointOf } from './clamav.js';

const VERSION = 'ClamAV 1.0.0/27000/Mon Sep 7 10:00:00 2026';
const STATS = [
  'POOLS: 1',
  'STATE: VALID PRIMARY',
  'THREADS: live 2  idle 1 max 12 idle-timeout 30',
  'QUEUE: 3 items',
  'MEMSTATS: heap 5.2M mmap 0.5M used 4.1M free 1.1M releasable 0.2M pools 1 pools_used 0.9M pools_total 1.0M',
  'END',
].join('\n');

describe('buildClamavSnapshotFromRaw', () => {
  it('assembles a live snapshot from raw VERSION + STATS replies', () => {
    const snap = buildClamavSnapshotFromRaw('c1', VERSION, STATS);
    expect(snap.serviceType).toBe('clamav');
    expect(snap.serviceId).toBe('c1');
    expect(snap.pingOk).toBe(true);
    expect(snap.engineVersion).toBe('1.0.0');
    expect(snap.databaseVersion).toBe(27000);
    expect(snap.statusText).toBe('VALID PRIMARY');
    expect(snap.threadsLive).toBe(2);
    expect(snap.threadsIdle).toBe(1);
    expect(snap.threadsMax).toBe(12);
    expect(snap.queueItems).toBe(3);
    expect(snap.memoryHeapMB).toBeCloseTo(5.2);
    expect(snap.memoryUsedMB).toBeCloseTo(4.1);
  });

  it('is reachable with only a VERSION reply (stats empty)', () => {
    const snap = buildClamavSnapshotFromRaw('c1', VERSION, '');
    expect(snap.pingOk).toBe(true);
    expect(snap.engineVersion).toBe('1.0.0');
    expect(snap.threadsLive).toBe(0);
  });

  it('is unreachable when both replies are empty', () => {
    const snap = buildClamavSnapshotFromRaw('c1', null, '');
    expect(snap.pingOk).toBe(false);
    expect(snap.engineVersion).toBeNull();
  });
});

describe('clamdEndpointOf', () => {
  it('reads host and port from the service address in any of its forms', () => {
    expect(clamdEndpointOf({ apiUrl: 'http://antivirus-backend:3310', metricsUrl: null })).toEqual({ host: 'antivirus-backend', port: 3310 });
    expect(clamdEndpointOf({ apiUrl: 'tcp://10.0.0.5:3311', metricsUrl: null })).toEqual({ host: '10.0.0.5', port: 3311 });
    expect(clamdEndpointOf({ apiUrl: 'clamav.internal:3310', metricsUrl: null })).toEqual({ host: 'clamav.internal', port: 3310 });
    expect(clamdEndpointOf({ apiUrl: 'tcp://[fd00::5]:3310', metricsUrl: null })).toEqual({ host: 'fd00::5', port: 3310 });
    expect(clamdEndpointOf({ apiUrl: null, metricsUrl: 'clamav' })).toEqual({ host: 'clamav', port: 3310 });
  });

  it('returns null when the service has no address', () => {
    expect(clamdEndpointOf({ apiUrl: null, metricsUrl: '  ' })).toBeNull();
  });
});
