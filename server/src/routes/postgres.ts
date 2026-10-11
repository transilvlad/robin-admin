import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import {
  analyzePostgres,
  cancelPostgresBackend,
  getPostgresActivity,
  getPostgresConfigState,
  getPostgresLocks,
  getPostgresStatStatements,
  getPostgresStatus,
  getPostgresTableSizes,
  listPostgresConfigScopes,
  reloadPostgres,
  renderPostgresConfig,
  resetPostgresConfig,
  resetPostgresStats,
  savePostgresManagedConfig,
  terminatePostgresBackend,
  vacuumPostgres,
} from '../services/postgres.js';

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

function getServiceId(req: Request): string | undefined {
  return typeof req.query.serviceId === 'string' && req.query.serviceId.trim() !== ''
    ? req.query.serviceId.trim()
    : typeof req.body?.serviceId === 'string' && req.body.serviceId.trim() !== ''
      ? req.body.serviceId.trim()
      : undefined;
}

router.get('/config', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await getPostgresConfigState(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Postgres config',
    });
  }
});

router.put('/config', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const state = await savePostgresManagedConfig(serviceId, req.body ?? {});
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postgres_config',
      entityId: serviceId,
      newValues: req.body ?? {},
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Postgres config',
    });
  }
});

router.get('/config/scopes', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listPostgresConfigScopes() });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list Postgres config scopes',
    });
  }
});

router.delete('/config', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const state = await resetPostgresConfig(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postgres_config',
      entityId: serviceId,
      newValues: { action: 'reset-to-base' },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset Postgres config',
    });
  }
});

router.get('/status', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await getPostgresStatus(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Postgres status',
    });
  }
});

router.get('/config/rendered', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const config = await getPostgresConfigState(serviceId);
    res.json({
      success: true,
      data: {
        managed: renderPostgresConfig(config.managed),
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to render Postgres config',
    });
  }
});

router.post('/reload', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await reloadPostgres(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postgres_runtime',
      entityId: serviceId,
      newValues: { action: 'reload', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reload Postgres',
    });
  }
});

router.get('/activity', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    const limit = Number.isInteger(limitParam) && (limitParam as number) > 0 ? (limitParam as number) : undefined;
    res.json({ success: true, data: await getPostgresActivity(serviceId, limit) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Postgres activity',
    });
  }
});

router.post('/activity/cancel', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const pid = req.body?.pid;
    if (pid === undefined || pid === null || pid === '') {
      return res.status(400).json({ success: false, error: 'pid is required' });
    }
    const cancelled = await cancelPostgresBackend(serviceId, pid);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postgres_runtime',
      entityId: serviceId,
      newValues: { action: 'cancel_backend', pid, cancelled },
    });
    res.json({ success: true, data: { cancelled } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to cancel Postgres backend',
    });
  }
});

router.post('/activity/terminate', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const pid = req.body?.pid;
    if (pid === undefined || pid === null || pid === '') {
      return res.status(400).json({ success: false, error: 'pid is required' });
    }
    const terminated = await terminatePostgresBackend(serviceId, pid);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postgres_runtime',
      entityId: serviceId,
      newValues: { action: 'terminate_backend', pid, terminated },
    });
    res.json({ success: true, data: { terminated } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to terminate Postgres backend',
    });
  }
});

router.get('/locks', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await getPostgresLocks(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Postgres locks',
    });
  }
});

router.post('/vacuum', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const table = typeof req.body?.table === 'string' ? req.body.table : undefined;
    const analyze = Boolean(req.body?.analyze);
    const responseText = await vacuumPostgres(serviceId, { table, analyze });
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postgres_runtime',
      entityId: serviceId,
      newValues: { action: 'vacuum', table, analyze, response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to vacuum Postgres',
    });
  }
});

router.post('/analyze', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const table = typeof req.body?.table === 'string' ? req.body.table : undefined;
    const responseText = await analyzePostgres(serviceId, { table });
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postgres_runtime',
      entityId: serviceId,
      newValues: { action: 'analyze', table, response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to analyze Postgres',
    });
  }
});

router.get('/tables', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    const limit = Number.isInteger(limitParam) && (limitParam as number) > 0 ? (limitParam as number) : undefined;
    res.json({ success: true, data: await getPostgresTableSizes(serviceId, limit) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Postgres table sizes',
    });
  }
});

router.get('/statements', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const limitParam = typeof req.query.limit === 'string' ? Number.parseInt(req.query.limit, 10) : undefined;
    const limit = Number.isInteger(limitParam) && (limitParam as number) > 0 ? (limitParam as number) : undefined;
    res.json({ success: true, data: await getPostgresStatStatements(serviceId, limit) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Postgres statements',
    });
  }
});

router.post('/stats/reset', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await resetPostgresStats(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postgres_runtime',
      entityId: serviceId,
      newValues: { action: 'stats_reset', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset Postgres stats',
    });
  }
});

export default router;
