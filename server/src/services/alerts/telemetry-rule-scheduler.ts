import { logger } from '../../logger.js';
import { operationsPolicy } from '../operations-settings.js';
import { runTelemetryRuleEvaluation } from './telemetry-rules.js';
import { reportError } from '../error-reporting.js';

let timer: NodeJS.Timeout | null = null;
let running = false;

/**
 * Evaluates telemetry alert rules on the alert evaluation interval. Runs even
 * while alert delivery is off, so rule state shows on the Alerts page before
 * anything is sent; deliveries are only queued when alerts are enabled.
 */
export function startTelemetryRuleScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void runOnce(), operationsPolicy().alertEvaluationIntervalMs);
  timer.unref();
  void runOnce();
  logger.info('Telemetry alert rule evaluator started', { intervalMs: operationsPolicy().alertEvaluationIntervalMs });
}

export function stopTelemetryRuleScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runTelemetryRuleEvaluation();
  } catch (error) {
    logger.error('Telemetry alert rule evaluation failed', { error: (error as Error).message });
    reportError(error, 'telemetry-rules');
  } finally {
    running = false;
  }
}
