/**
 * Ping URLs for push checks. Jobs call them without logging in, so the secret
 * token in the path is the only credential: unknown tokens get a plain 404.
 *
 *   GET or POST /api/monitoring/ping/<token>       the job ran successfully
 *   GET or POST /api/monitoring/ping/<token>/fail  the job ran and failed
 */
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import { recordMonitoringCheckPing } from '../db/queries/monitoring.js';
import { logger } from '../logger.js';
import { runMonitoringCheckNow } from '../services/monitoring/scheduler.js';
import { isPushToken } from '../services/monitoring/push.js';

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

router.all('/:token', (req, res) => void ping(req, res, 'ok'));
router.all('/:token/fail', (req, res) => void ping(req, res, 'fail'));

export default router;
