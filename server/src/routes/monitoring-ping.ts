/**
 * Ping URLs for push checks. Jobs call them without logging in, so the secret
 * token in the path is the only credential: unknown tokens get a plain 404.
 *
 *   GET or POST /api/monitoring/ping/<token>       the job ran successfully
 *   GET or POST /api/monitoring/ping/<token>/fail  the job ran and failed
 */
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { finishMonitoringPushRun, recordMonitoringCheckPing, startMonitoringPushRun } from '../db/queries/monitoring.js';
import { logger } from '../logger.js';
import { runMonitoringCheckNow } from '../services/monitoring/scheduler.js';
import { isPushRunId, isPushToken } from '../services/monitoring/push.js';

const router = Router();

export function pushUrl(token: string): string {
  return `${config.publicBaseUrl}/api/monitoring/ping/${token}`;
}

async function ping(req: Request, res: Response, status: 'ok' | 'fail'): Promise<void> {
  const token = String(req.params.token ?? '');
  if (!isPushToken(token)) {
    res.status(404).type('text/plain').send('Not found\n');
    return;
  }
  try {
    const checkId = await recordMonitoringCheckPing(token, status);
    if (checkId === null) {
      res.status(404).type('text/plain').send('Not found\n');
      return;
    }
    // Evaluate now, so a recovery or a reported failure shows without waiting
    // for the next scheduled evaluation.
    void runMonitoringCheckNow(checkId).catch((error: unknown) => {
      logger.warn('Push check evaluation after ping failed', { checkId, error: String(error) });
    });
    res.type('text/plain').send('OK\n');
  } catch (error) {
    logger.error('Failed to record a push check ping', { error: (error as Error).message });
    res.status(500).type('text/plain').send('Error\n');
  }
}

router.post('/:token/runs', async (req, res) => {
  const token = String(req.params.token ?? '');
  if (!isPushToken(token)) {
    res.status(404).type('text/plain').send('Not found\n');
    return;
  }
  try {
    const started = await startMonitoringPushRun(token);
    if (!started) {
      res.status(404).type('text/plain').send('Not found\n');
      return;
    }
    res.status(201).json({
      success: true,
      data: {
        runId: started.run.id,
        startedAt: started.run.startedAt,
        maxRuntimeSeconds: started.maxRuntimeSeconds,
      },
    });
  } catch (error) {
    logger.error('Failed to start a push check run', { error: (error as Error).message });
    res.status(500).type('text/plain').send('Error\n');
  }
});

async function finishRun(req: Request, res: Response, status: 'succeeded' | 'failed'): Promise<void> {
  const token = String(req.params.token ?? '');
  const runId = String(req.params.runId ?? '');
  if (!isPushToken(token) || !isPushRunId(runId)) {
    res.status(404).type('text/plain').send('Not found\n');
    return;
  }
  let error: string | null = null;
  if (status === 'failed') {
    const body = req.body;
    if (body !== undefined && (!body || typeof body !== 'object' || Array.isArray(body)
      || Object.keys(body).some(key => key !== 'error'))) {
      res.status(400).type('text/plain').send('Invalid request\n');
      return;
    }
    if (body?.error !== undefined && typeof body.error !== 'string') {
      res.status(400).type('text/plain').send('Invalid request\n');
      return;
    }
    error = typeof body?.error === 'string' ? body.error.slice(0, 500) : 'The job reported a failure';
  }
  try {
    const checkId = await finishMonitoringPushRun(token, runId, status, error);
    if (checkId === null) {
      res.status(404).type('text/plain').send('Not found\n');
      return;
    }
    void runMonitoringCheckNow(checkId).catch((evaluationError: unknown) => {
      logger.warn('Push check evaluation after run completion failed', { checkId, error: String(evaluationError) });
    });
    res.type('text/plain').send('OK\n');
  } catch (caught) {
    logger.error('Failed to finish a push check run', { error: (caught as Error).message });
    res.status(500).type('text/plain').send('Error\n');
  }
}

router.post('/:token/runs/:runId/complete', (req, res) => void finishRun(req, res, 'succeeded'));
router.post('/:token/runs/:runId/fail', (req, res) => void finishRun(req, res, 'failed'));
router.all('/:token', (req, res) => void ping(req, res, 'ok'));
router.all('/:token/fail', (req, res) => void ping(req, res, 'fail'));

export default router;
