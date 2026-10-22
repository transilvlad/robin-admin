import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { listCyrusSessions, getCyrusQuota, lookupCyrusUser } from '../services/cyrus.js';
import { routeParam } from './params.js';
const router = Router();
router.use(requireAuth);
router.use(requireAdmin);
function getServiceId(req: Request): string | undefined {
  return typeof req.query.serviceId === 'string' ? req.query.serviceId.trim() || undefined : undefined;
}

router.get('/sessions', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await listCyrusSessions(serviceId) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to list Cyrus sessions',
    });
  }
});

router.get('/quota', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    res.json({ success: true, data: await getCyrusQuota(serviceId, typeof req.query.user === 'string' ? req.query.user : undefined) });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read Cyrus quota',
    });
  }
});

router.get('/users/:user', async (req: Request, res: Response) => {
  try {
    const serviceId = getServiceId(req);
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const fields = await lookupCyrusUser(serviceId, routeParam(req, 'user'));
    const quota = fields ? await getCyrusQuota(serviceId, routeParam(req, 'user')) : null;
    res.json({ success: true, data: { user: routeParam(req, 'user'), exists: fields !== null, fields: fields ?? {}, quota } });
  } catch (error) {
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to look up the user',
    });
  }
});

export default router;
