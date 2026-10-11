import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import {
  getDovecotConfigState,
  getDovecotQuota,
  kickDovecotUser,
  listDovecotConfigScopes,
  listDovecotSessions,
  lookupDovecotUser,
  reloadDovecot,
  renderDovecotConfig,
  resetDovecotConfigFile,
  saveDovecotManagedConfig,
  saveDovecotManagedFile,
  withDetectedDovecotVersion,
} from '../services/dovecot.js';
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

    res.json({ success: true, data: await getDovecotConfigState(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load Dovecot config',
    });
  }
});

router.put('/config', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    const state = await saveDovecotManagedConfig(serviceId, req.body ?? {});
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'dovecot_config',
      entityId: serviceId,
      newValues: req.body ?? {},
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Dovecot config',
    });
  }
});

// Per-file managed configs (50-robin-logging.conf, 50-robin-limits.conf, …).
router.put('/config/files/:key', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const entry = await saveDovecotManagedFile(serviceId, routeParam(req, 'key'), req.body?.values ?? req.body ?? {});
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'dovecot_config_file',
      entityId: `${serviceId}:${entry.fileName}`,
      newValues: { file: entry.fileName, values: entry.values },
    });
    res.json({ success: true, data: entry });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save Dovecot config file',
    });
  }
});

router.get('/config/scopes', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listDovecotConfigScopes() });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list Dovecot config scopes',
    });
  }
});

router.delete('/config/files/:key', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const state = await resetDovecotConfigFile(serviceId, routeParam(req, 'key'));
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'dovecot_config_file',
      entityId: `${serviceId}:${routeParam(req, 'key')}`,
      newValues: { file: routeParam(req, 'key'), action: 'reset-to-base' },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset Dovecot config file',
    });
  }
});

router.get('/config/rendered', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    const config = await getDovecotConfigState(serviceId);
    res.json({
      success: true,
      data: {
        managed: renderDovecotConfig(withDetectedDovecotVersion(config.managed, config.detectedVersion)),
        renderedFor: withDetectedDovecotVersion(config.managed, config.detectedVersion).dovecotVersion,
        detectedVersion: config.detectedVersion,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to render Dovecot config',
    });
  }
});

router.post('/reload', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    const responseText = await reloadDovecot(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'dovecot_runtime',
      entityId: serviceId,
      newValues: { action: 'reload', response: responseText },
    });

    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reload Dovecot',
    });
  }
});

router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await listDovecotSessions(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list Dovecot sessions',
    });
  }
});

// Disconnect every session of one user (`doveadm kick`).
router.post('/sessions/kick', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    const user = typeof req.body?.user === 'string' ? req.body.user.trim() : '';
    if (!serviceId || !user) {
      return res.status(400).json({ success: false, error: 'serviceId and user are required' });
    }
    const responseText = await kickDovecotUser(serviceId, user);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'dovecot_session',
      entityId: serviceId,
      newValues: { action: 'kick', user, response: responseText },
    });
    res.json({ success: true, data: { response: responseText } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to disconnect the user',
    });
  }
});

// Quota usage for every user (when the userdb can list users).
router.get('/quota', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await getDovecotQuota(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read Dovecot quota',
    });
  }
});

// One user's userdb record and quota usage.
router.get('/users/:user', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const fields = await lookupDovecotUser(serviceId, routeParam(req, 'user'));
    const quota = fields ? await getDovecotQuota(serviceId, routeParam(req, 'user')) : null;
    res.json({ success: true, data: { user: routeParam(req, 'user'), exists: fields !== null, fields: fields ?? {}, quota } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to look up the user',
    });
  }
});

export default router;
