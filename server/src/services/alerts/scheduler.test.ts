import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyOperationsSettings, operationsDefaults } from '../operations-settings.js';
import { runAlertEvaluation } from './evaluator.js';
import { startAlertScheduler, stopAlertScheduler } from './scheduler.js';

vi.mock('./evaluator.js', () => ({ runAlertEvaluation: vi.fn().mockResolvedValue(undefined) }));
afterEach(() => { stopAlertScheduler(); applyOperationsSettings(operationsDefaults()); vi.useRealTimers(); vi.clearAllMocks(); });

describe('Live alert scheduler policy', () => {
  it('honours enablement and the saved interval after reconfiguration', async () => {
    vi.useFakeTimers();
    startAlertScheduler();
    await vi.advanceTimersByTimeAsync(30000);
    expect(runAlertEvaluation).not.toHaveBeenCalled();
    applyOperationsSettings({ ...operationsDefaults(), alertsEnabled: true, alertEvaluationIntervalMs: 5000 });
    startAlertScheduler();
    await vi.advanceTimersByTimeAsync(10000);
    expect(runAlertEvaluation).toHaveBeenCalledTimes(3);
    stopAlertScheduler();
    applyOperationsSettings({ ...operationsDefaults(), alertsEnabled: true, alertEvaluationIntervalMs: 10000 });
    startAlertScheduler();
    await vi.advanceTimersByTimeAsync(10000);
    expect(runAlertEvaluation).toHaveBeenCalledTimes(5);
    stopAlertScheduler();
    applyOperationsSettings(operationsDefaults());
    startAlertScheduler();
    await vi.advanceTimersByTimeAsync(30000);
    expect(runAlertEvaluation).toHaveBeenCalledTimes(5);
  });
});
