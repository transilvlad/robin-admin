import { logger } from '../../logger.js';
import { runLogsAlertEvaluation } from './logs-rules.js';

const EVALUATION_INTERVAL_MS = 60_000;
let timer: NodeJS.Timeout | null = null;
let running = false;

export function startLogsRuleScheduler(): void {
  if (timer) return;
  timer = setInterval(() => void runOnce(), EVALUATION_INTERVAL_MS);
  timer.unref();
  void runOnce();
  logger.info('Logs alert rule evaluator started', { intervalMs: EVALUATION_INTERVAL_MS });
}

export function stopLogsRuleScheduler(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await runLogsAlertEvaluation();
  } catch (error) {
    logger.error('Logs alert rule evaluation failed', { error: error instanceof Error ? error.message : String(error) });
  } finally {
    running = false;
  }
}
