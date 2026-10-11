import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import {
  applyPostfixQueueAction,
  deliverPostfixMessage,
  flushPostfixQueue,
  getPostfixConfigState,
  listPostfixConfigScopes,
  listPostfixQueue,
  showPostfixMessage,
  type PostfixQueueAction,
  reloadPostfix,
  renderPostfixConfig,
  renderPostfixCheckFile,
  resetPostfixConfigFile,
  savePostfixManagedConfig,
  savePostfixManagedFile,
} from '../services/postfix.js';
import { routeParam } from './params.js';

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
    res.json({ success: true, data: await getPostfixConfigState(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Postfix config',
    });
  }
});

router.put('/config', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const state = await savePostfixManagedConfig(serviceId, req.body ?? {});
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postfix_config',
      entityId: serviceId,
      newValues: req.body ?? {},
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Postfix config',
    });
  }
});

// Per-file managed configs (robin-tls.cf, robin-restrictions.cf, robin-milters.cf).
router.put('/config/files/:key', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const entry = await savePostfixManagedFile(serviceId, routeParam(req, 'key'), req.body?.values ?? req.body ?? {});
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postfix_config_file',
      entityId: `${serviceId}:${entry.fileName}`,
      newValues: { file: entry.fileName, values: entry.values },
    });
    res.json({ success: true, data: entry });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Postfix config file',
    });
  }
});

router.get('/config/scopes', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listPostfixConfigScopes() });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list Postfix config scopes',
    });
  }
});

router.delete('/config/files/:key', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const state = await resetPostfixConfigFile(serviceId, routeParam(req, 'key'));
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postfix_config_file',
      entityId: `${serviceId}:${routeParam(req, 'key')}`,
      newValues: { file: routeParam(req, 'key'), action: 'reset-to-base' },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset Postfix config file',
    });
  }
});

router.get('/config/rendered', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const config = await getPostfixConfigState(serviceId);
    res.json({
      success: true,
      data: {
        mainCf: renderPostfixConfig(config.managed),
        headerChecks: renderPostfixCheckFile('header', config.managed),
        bodyChecks: renderPostfixCheckFile('body', config.managed),
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to render Postfix config',
    });
  }
});

router.post('/reload', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await reloadPostfix(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postfix_runtime',
      entityId: serviceId,
      newValues: { action: 'reload', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reload Postfix',
    });
  }
});

router.post('/flush', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await flushPostfixQueue(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postfix_runtime',
      entityId: serviceId,
      newValues: { action: 'flush', response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to flush Postfix queue',
    });
  }
});

const QUEUE_ACTIONS: readonly PostfixQueueAction[] = ['hold', 'release', 'requeue', 'delete'];

router.get('/queue', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await listPostfixQueue(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list the Postfix queue',
    });
  }
});

router.get('/queue/:queueId', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: { content: await showPostfixMessage(serviceId, routeParam(req, 'queueId')) } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read the queued message',
    });
  }
});

// Hold, release, requeue, or delete a set of queued messages.
router.post('/queue/actions', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    const action = req.body?.action as PostfixQueueAction;
    const queueIds: unknown = req.body?.queueIds;
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    if (!QUEUE_ACTIONS.includes(action)) {
      return res.status(400).json({ success: false, error: `action must be one of ${QUEUE_ACTIONS.join(', ')}` });
    }
    if (!Array.isArray(queueIds) || queueIds.length === 0 || !queueIds.every((id) => typeof id === 'string')) {
      return res.status(400).json({ success: false, error: 'queueIds must be a non-empty list of queue IDs' });
    }
    const responseText = await applyPostfixQueueAction(serviceId, action, queueIds);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postfix_queue',
      entityId: serviceId,
      newValues: { action, queueIds, response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to update queued messages',
    });
  }
});

router.post('/queue/:queueId/deliver', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const responseText = await deliverPostfixMessage(serviceId, routeParam(req, 'queueId'));
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'postfix_queue',
      entityId: serviceId,
      newValues: { action: 'deliver', queueIds: [routeParam(req, 'queueId')], response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to deliver the queued message',
    });
  }
});

export default router;
