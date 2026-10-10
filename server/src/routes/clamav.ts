import { Router, raw, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import {
  getClamavConfigState,
  getClamavStatus,
  listClamavConfigScopes,
  reloadClamav,
  renderClamdConfig,
  renderFreshclamConfig,
  resetClamavConfigFile,
  saveClamavManagedConfig,
  scanBufferWithClamd,
} from '../services/clamav.js';
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

    res.json({ success: true, data: await getClamavConfigState(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load ClamAV config',
    });
  }
});

router.put('/config', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    const state = await saveClamavManagedConfig(serviceId, req.body ?? {});
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'clamav_config',
      entityId: serviceId,
      newValues: req.body ?? {},
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to save ClamAV config',
    });
  }
});

router.get('/config/scopes', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listClamavConfigScopes() });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list ClamAV config scopes',
    });
  }
});

router.delete('/config/files/:key', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const state = await resetClamavConfigFile(serviceId, routeParam(req, 'key'));
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'clamav_config',
      entityId: `${serviceId}:${routeParam(req, 'key')}`,
      newValues: { file: routeParam(req, 'key'), action: 'reset-to-base' },
    });
    res.json({ success: true, data: state });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reset ClamAV config',
    });
  }
});

router.get('/status', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    res.json({ success: true, data: await getClamavStatus(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to load ClamAV status',
    });
  }
});

router.get('/config/rendered', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    const config = await getClamavConfigState(serviceId);
    res.json({
      success: true,
      data: {
        clamd: renderClamdConfig(config.clamd),
        freshclam: renderFreshclamConfig(config.freshclam),
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to render ClamAV config',
    });
  }
});

router.post('/reload', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    const responseText = await reloadClamav(serviceId);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'clamav_runtime',
      entityId: serviceId,
      newValues: { action: 'reload', response: responseText },
    });

    res.json({
      success: true,
      data: {
        response: responseText,
      },
    });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to reload ClamAV',
    });
  }
});

router.post('/scan', raw({ type: 'application/octet-stream', limit: '32mb' }), async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }

    const buffer = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (buffer.length === 0) {
      return res.status(400).json({ success: false, error: 'Request body must contain file bytes' });
    }

    const rawFileName = typeof req.headers['x-filename'] === 'string' ? req.headers['x-filename'] : 'upload.bin';
    const fileName = decodeURIComponent(rawFileName);
    const result = await scanBufferWithClamd(serviceId, buffer, fileName);

    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'clamav_scan',
      entityId: serviceId,
      newValues: {
        fileName: result.fileName,
        sizeBytes: result.sizeBytes,
        infected: result.infected,
        viruses: result.viruses,
        durationMs: result.durationMs,
      },
    });

    res.json({ success: true, data: result });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to scan file with ClamAV',
    });
  }
});

export default router;
