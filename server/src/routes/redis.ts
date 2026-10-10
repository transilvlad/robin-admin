import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import {
  getRedisClients,
  getRedisConfigState,
  getRedisLatency,
  getRedisSlowlog,
  getRedisStatus,
  killRedisClient,
  listRedisConfigScopes,
  redisBgrewriteaof,
  redisBgsave,
  redisResetStats,
  reloadRedis,
  renderRedisConfig,
  resetRedisConfig,
  resetRedisSlowlog,
  saveRedisManagedConfig,
} from '../services/redis.js';

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
    res.json({ success: true, data: await getRedisConfigState(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Redis config',
    });
  }
});

router.put('/config', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const state = await saveRedisManagedConfig(serviceId, req.body ?? {});
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'redis_config',
      entityId: serviceId,
      newValues: req.body ?? {},
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Redis config',
    });
  }
});

router.get('/config/scopes', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listRedisConfigScopes() });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list Redis config scopes',
    });
  }
});

router.delete('/config', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const state = await resetRedisConfig(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'redis_config',
      entityId: serviceId,
      newValues: { action: 'reset-to-base' },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset Redis config',
    });
  }
});

router.get('/status', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await getRedisStatus(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Redis status',
    });
  }
});

router.get('/config/rendered', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const config = await getRedisConfigState(serviceId);
    res.json({
      success: true,
      data: {
        managed: renderRedisConfig(config.managed),
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to render Redis config',
    });
  }
});

router.post('/reload', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await reloadRedis(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'redis_runtime',
      entityId: serviceId,
      newValues: { action: 'reload', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reload Redis',
    });
  }
});

router.get('/slowlog', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const countParam = typeof req.query.count === 'string' ? Number.parseInt(req.query.count, 10) : undefined;
    const count = Number.isInteger(countParam) && (countParam as number) > 0 ? (countParam as number) : undefined;
    res.json({ success: true, data: await getRedisSlowlog(serviceId, count) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Redis slowlog',
    });
  }
});

router.post('/slowlog/reset', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await resetRedisSlowlog(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'redis_runtime',
      entityId: serviceId,
      newValues: { action: 'slowlog_reset', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset Redis slowlog',
    });
  }
});

router.get('/clients', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await getRedisClients(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Redis clients',
    });
  }
});

router.post('/clients/kill', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const clientId = req.body?.clientId;
    if (clientId === undefined || clientId === null || clientId === '') {
      return res.status(400).json({ success: false, error: 'clientId is required' });
    }
    const responseText = await killRedisClient(serviceId, clientId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'redis_runtime',
      entityId: serviceId,
      newValues: { action: 'client_kill', clientId, response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to kill Redis client',
    });
  }
});

router.post('/bgsave', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await redisBgsave(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'redis_runtime',
      entityId: serviceId,
      newValues: { action: 'bgsave', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start Redis background save',
    });
  }
});

router.post('/bgrewriteaof', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await redisBgrewriteaof(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'redis_runtime',
      entityId: serviceId,
      newValues: { action: 'bgrewriteaof', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to start Redis AOF rewrite',
    });
  }
});

router.post('/stats/reset', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await redisResetStats(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'redis_runtime',
      entityId: serviceId,
      newValues: { action: 'stats_reset', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset Redis stats',
    });
  }
});

router.get('/latency', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await getRedisLatency(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Redis latency',
    });
  }
});

export default router;
