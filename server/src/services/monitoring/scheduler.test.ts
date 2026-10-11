import { beforeEach, expect, it, vi } from 'vitest';
import { observabilityDefaults } from '../observability-settings.js';
import { getConfig } from '../../db/queries/config.js';
vi.mock('../../db/queries/config.js', () => ({ getConfig: vi.fn() }));
import { getMonitoringCheck, getMonitoringCheckSecrets, listDueMonitoringChecks, pruneMonitoringHistory, recordMonitoringObservation } from '../../db/queries/monitoring.js';
import { runMonitoringProbe } from './probes.js';
import { runMonitoringCheckNow, runMonitoringMaintenance, runMonitoringSchedulerOnce } from './scheduler.js';

vi.mock('../../db/queries/monitoring.js', () => ({
  listDueMonitoringChecks: vi.fn(),
  recordMonitoringObservation: vi.fn(),
  getMonitoringCheck: vi.fn(),
  getMonitoringCheckSecrets: vi.fn(),
  pruneMonitoringHistory: vi.fn(),
}));
vi.mock('./probes.js', () => ({ runMonitoringProbe: vi.fn() }));

type ProbeResult = Awaited<ReturnType<typeof runMonitoringProbe>>;
const UP = { status: 'up', responseTimeMs: 1 } as ProbeResult;
const policy = observabilityDefaults();
const CONCURRENCY = policy.monitoringConcurrency;
let nextId = 1;

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getConfig).mockResolvedValue({ ...policy } as never);
  nextId = 1;
  vi.mocked(getMonitoringCheck).mockImplementation(async id => ({ id, enabled: true, pausedAt: null, secretHeaderNames: [] }) as never);
  vi.mocked(recordMonitoringObservation).mockResolvedValue({} as never);
  vi.mocked(listDueMonitoringChecks).mockImplementation(async (limit = 25) =>
    Array.from({ length: limit }, () => ({ id: nextId++ })) as never);
});

it('records an unavailable credential failure without probing or exposing the decryption error', async () => {
  vi.mocked(getMonitoringCheck).mockResolvedValueOnce({ id: 987, secretHeaderNames: ['authorization'] } as never);
  vi.mocked(getMonitoringCheckSecrets).mockRejectedValueOnce(new Error('private decryption detail'));
  await runMonitoringCheckNow(987);
  expect(runMonitoringProbe).not.toHaveBeenCalled();
  expect(recordMonitoringObservation).toHaveBeenCalledWith(expect.objectContaining({ status: 'down', error: 'Stored check credentials unavailable' }));
});

/** Probes that stay pending until released one by one. */
function holdProbes() {
  const waiting: Array<(result: ProbeResult) => void> = [];
  vi.mocked(runMonitoringProbe).mockImplementation(() => new Promise<ProbeResult>((resolve) => waiting.push(resolve)));
  return {
    waiting,
    release(count = waiting.length) {
      waiting.splice(0, count).forEach((resolve) => resolve(UP));
    },
    /** Keep releasing probes, including ones queued work starts later, until `work` settles. */
    async drain(work: Promise<unknown>) {
      let done = false;
      void work.finally(() => { done = true; });
      while (!done) {
        this.release();
        await new Promise((resolve) => setTimeout(resolve, 2));
      }
    },
  };
}

it('claims only free slots and keeps claiming while earlier probes are still running', async () => {
  const probes = holdProbes();
  try {
    await runMonitoringSchedulerOnce();
    expect(listDueMonitoringChecks).toHaveBeenLastCalledWith(CONCURRENCY);
    await vi.waitFor(() => expect(runMonitoringProbe).toHaveBeenCalledTimes(CONCURRENCY));

    // Every slot is busy: no claim, so no check's next run is pushed back.
    await runMonitoringSchedulerOnce();
    expect(listDueMonitoringChecks).toHaveBeenCalledOnce();

    // Five finish while the rest are still stuck: exactly five more start.
    probes.release(5);
    await vi.waitFor(() => expect(recordMonitoringObservation).toHaveBeenCalledTimes(5));
    await runMonitoringSchedulerOnce();
    expect(listDueMonitoringChecks).toHaveBeenLastCalledWith(5);
    await vi.waitFor(() => expect(runMonitoringProbe).toHaveBeenCalledTimes(CONCURRENCY + 5));
  } finally {
    probes.release();
    await vi.waitFor(() => expect(recordMonitoringObservation).toHaveBeenCalledTimes(CONCURRENCY + 5));
  }
});

it('applies a reduced live limit without cancelling active probes', async () => {
  const probes = holdProbes();
  try {
    vi.mocked(getConfig).mockResolvedValue({ ...policy, monitoringConcurrency: 4, monitoringManualConcurrency: 2 } as never);
    await runMonitoringSchedulerOnce();
    await vi.waitFor(() => expect(runMonitoringProbe).toHaveBeenCalledTimes(4));
    vi.mocked(getConfig).mockResolvedValue({ ...policy, monitoringConcurrency: 6, monitoringManualConcurrency: 2 } as never);
    await runMonitoringSchedulerOnce();
    await vi.waitFor(() => expect(runMonitoringProbe).toHaveBeenCalledTimes(6));
    vi.mocked(getConfig).mockResolvedValue({ ...policy, monitoringConcurrency: 4, monitoringManualConcurrency: 2 } as never);
    await runMonitoringSchedulerOnce();
    expect(listDueMonitoringChecks).toHaveBeenCalledTimes(2);
  } finally {
    probes.release();
    await vi.waitFor(() => expect(recordMonitoringObservation).toHaveBeenCalledTimes(6));
  }
});

it('leaves scheduled slots free during a manual burst and bounds waiting manual work', async () => {
  const probes = holdProbes();
  const manuals = Array.from({ length: 28 }, (_, id) => runMonitoringCheckNow(id + 1000));
  const settled = Promise.allSettled(manuals);
  try {
    await vi.waitFor(() => expect(runMonitoringProbe).toHaveBeenCalledTimes(8));
    await expect(runMonitoringCheckNow(9999)).rejects.toThrow('busy');

    await runMonitoringSchedulerOnce();
    expect(listDueMonitoringChecks).toHaveBeenLastCalledWith(CONCURRENCY - 8);
    await vi.waitFor(() => expect(runMonitoringProbe).toHaveBeenCalledTimes(CONCURRENCY));

    await probes.drain(settled);
    expect((await settled).every(result => result.status === 'fulfilled')).toBe(true);
    await vi.waitFor(() => expect(recordMonitoringObservation).toHaveBeenCalledTimes(28 + CONCURRENCY - 8));
  } finally {
    await probes.drain(settled);
  }
});

it('releases the slot of a scheduled check whose observation write fails', async () => {
  vi.mocked(listDueMonitoringChecks).mockResolvedValueOnce([{ id: 1 }] as never).mockResolvedValue([]);
  vi.mocked(runMonitoringProbe).mockResolvedValue(UP);
  vi.mocked(recordMonitoringObservation).mockRejectedValueOnce(new Error('DB unavailable'));
  await runMonitoringSchedulerOnce();
  await vi.waitFor(() => expect(recordMonitoringObservation).toHaveBeenCalledOnce());
  await vi.waitFor(async () => {
    await runMonitoringSchedulerOnce();
    expect(listDueMonitoringChecks).toHaveBeenLastCalledWith(CONCURRENCY);
  });
});

it('coalesces a repeated check and holds its slot through the observation write', async () => {
  const delayed = Promise.withResolvers<Awaited<ReturnType<typeof recordMonitoringObservation>>>();
  vi.mocked(runMonitoringProbe).mockResolvedValue(UP);
  vi.mocked(recordMonitoringObservation).mockReturnValue(delayed.promise);
  const first = runMonitoringCheckNow(1);
  const second = runMonitoringCheckNow(1);
  try {
    await vi.waitFor(() => expect(recordMonitoringObservation).toHaveBeenCalledOnce());
    expect(runMonitoringProbe).toHaveBeenCalledOnce();
  } finally {
    delayed.resolve({ id: 1 } as never);
    expect(await first).toEqual(await second);
  }
});

it('expires waiting manual work without running it and releases failed execution slots', async () => {
  vi.useFakeTimers();
  const delayed = Promise.withResolvers<ProbeResult>();
  vi.mocked(runMonitoringProbe).mockReturnValue(delayed.promise);
  const work = Array.from({ length: 9 }, (_, id) => runMonitoringCheckNow(id + 1));
  const settled = Promise.allSettled(work);
  try {
    await vi.advanceTimersByTimeAsync(30_000);
    expect(runMonitoringProbe).toHaveBeenCalledTimes(8);
    delayed.reject(new Error('probe failed'));
    expect((await settled).filter(result => result.status === 'rejected')).toHaveLength(9);
    vi.mocked(runMonitoringProbe).mockResolvedValue(UP);
    await expect(runMonitoringCheckNow(9)).resolves.not.toBeNull();
  } finally {
    delayed.resolve(UP);
    await settled;
    vi.useRealTimers();
  }
});

it('prunes history with the configured retention and survives database errors', async () => {
  vi.mocked(pruneMonitoringHistory).mockResolvedValueOnce({ observations: 3, days: 0 });
  await runMonitoringMaintenance();
  expect(pruneMonitoringHistory).toHaveBeenCalledWith(policy.monitoringObservationRetentionDays, policy.monitoringHistoryRetentionDays);

  vi.mocked(pruneMonitoringHistory).mockRejectedValueOnce(new Error('DB unavailable'));
  await expect(runMonitoringMaintenance()).resolves.toBeUndefined();
});
