import { Router, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import { pool } from '../db/connection.js';
import { logger } from '../logger.js';
import { getHeartbeatHealth } from '../services/monitoring/heartbeat.js';
import { clientErrorReportingConfig } from '../services/error-reporting.js';

const router = Router();

export async function databaseReady(): Promise<boolean> {
  let timeout: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      pool.query('SELECT 1'),
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error('Database readiness check timed out')), 2000);
      }),
    ]);
    return true;
  } catch (error) {
    logger.warn('Readiness database check failed', { error: (error as Error).message });
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

// Public, before sign-in: the UI reports its own errors only when this
// returns a DSN.
router.get('/client-config', (_req, res) => {
  res.json({ success: true, data: { errorReporting: clientErrorReportingConfig(process.env) } });
});

router.get('/live', (_req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

async function readinessHandler(_req: Request, res: Response): Promise<void> {
  const database = await databaseReady();
  res.status(database ? 200 : 503).json({
    status: database ? 'ok' : 'unavailable',
    checks: { database: database ? 'ok' : 'unavailable' },
    timestamp: new Date().toISOString(),
  });
}

router.get('/ready', readinessHandler);

router.get('/monitoring', rateLimit({
  windowMs: 60_000,
  limit: 60,
  standardHeaders: true,
  legacyHeaders: false,
}), async (_req, res) => {
  const health = await getHeartbeatHealth();
  res.status(health.healthy ? 200 : 503).type('text').send(health.healthy ? 'ok' : 'unhealthy');
});

export default router;
