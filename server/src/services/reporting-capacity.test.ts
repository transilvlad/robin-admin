import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReportingCapacityError, runSourceRead } from './reporting-capacity.js';
import { applyReportingSettings, reportingDefaults } from './reporting-settings.js';

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

describe('source read capacity', () => {
  beforeEach(() => applyReportingSettings(reportingDefaults()));
  afterEach(() => applyReportingSettings(reportingDefaults()));

  it('drains FIFO on increases and lets active work finish after a decrease', async () => {
    const blocked = gate();
    const started: number[] = [];
    const work = [0, 1, 2, 3].map(i => runSourceRead(async () => { started.push(i); await blocked.promise; }));
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    applyReportingSettings({ ...reportingDefaults(), reportingSourceConcurrency: 4 });
    await vi.waitFor(() => expect(started).toEqual([0, 1, 2, 3]));
    applyReportingSettings({ ...reportingDefaults(), reportingSourceConcurrency: 1, reportingSourceQueueSize: 0 });
    await expect(runSourceRead(async () => 1)).rejects.toBeInstanceOf(ReportingCapacityError);
    blocked.release();
    await Promise.all(work);
    expect(await runSourceRead(async () => 42)).toBe(42);
  });
  it('bounds the complete read to two active operations and drains in FIFO order', async () => {
    const gates = Array.from({ length: 6 }, gate);
    const started: number[] = [];
    let active = 0;
    let peak = 0;
    const work = gates.map((item, index) => runSourceRead(async () => {
      started.push(index);
      peak = Math.max(peak, ++active);
      await item.promise;
      active -= 1;
      return index;
    }));
    await vi.waitFor(() => expect(started).toEqual([0, 1]));
    for (let i = 0; i < gates.length; i++) {
      gates[i].release();
      await work[i];
    }
    expect(await Promise.all(work)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(started).toEqual([0, 1, 2, 3, 4, 5]);
    expect(peak).toBe(2);
  });

  it('rejects overflow without invoking its computation', async () => {
    const blocked = gate();
    const accepted = Array.from({ length: 10 }, () => runSourceRead(async () => {
      await blocked.promise;
      return 1;
    }));
    const extra = vi.fn(async () => 2);
    await expect(runSourceRead(extra)).rejects.toBeInstanceOf(ReportingCapacityError);
    expect(extra).not.toHaveBeenCalled();
    blocked.release();
    await Promise.all(accepted);
  });

  it('expires only waiting reads and releases capacity after thrown errors', async () => {
    vi.useFakeTimers();
    try {
      const blocked = gate();
      const first = runSourceRead(() => blocked.promise);
      const second = runSourceRead(() => blocked.promise);
      const read = vi.fn(async () => 'not run');
      const expired = expect(runSourceRead(read)).rejects.toThrow('waited too long');
      await vi.advanceTimersByTimeAsync(30_000);
      await expired;
      expect(read).not.toHaveBeenCalled();
      blocked.release();
      await Promise.all([first, second]);
      await expect(runSourceRead(() => { throw new Error('database'); })).rejects.toThrow('database');
      expect(await runSourceRead(async () => 'recovered')).toBe('recovered');
    } finally { vi.useRealTimers(); }
  });
});
