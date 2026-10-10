import { operationsPolicy } from '../operations-settings.js';
import { logger } from '../../logger.js';
import { runAlertEvaluation } from './evaluator.js';
import { reportError } from '../error-reporting.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startAlertScheduler(): void {
  if (timer || !operationsPolicy().alertsEnabled) {
    return;
  }
  timer = setInterval(() => void runOnce(), operationsPolicy().alertEvaluationIntervalMs);
  timer.unref();
  void runOnce();
  logger.info('Alert evaluator started', { intervalMs: operationsPolicy().alertEvaluationIntervalMs });
}

export function stopAlertScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('Alert evaluator stopped');
}

export async function runAlertSchedulerOnce(): Promise<void> {
  await runOnce();
}

async function runOnce(): Promise<void> {
  if (running || !operationsPolicy().alertsEnabled) return;
  running = true;
  try {
    await runAlertEvaluation();
  } catch (error) {
    logger.error('Alert evaluator failed', { error: (error as Error).message });
    reportError(error, 'alert-evaluator');
  } finally {
    running = false;
  }
}
