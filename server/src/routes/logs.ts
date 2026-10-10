import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { getServiceLogs } from '../services/service-logs.js';
import { parseServiceType } from '../services/service-types.js';
import { logger } from '../logger.js';

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/logs?serviceType=<type>&serviceId=<id>&lines=<n>
// Returns recent log lines for a co-located fleet service.
router.get('/', async (req: Request, res: Response) => {
  try {
    const serviceType = parseServiceType(req.query.serviceType);
    if (!serviceType) {
      return res.status(400).json({ success: false, error: 'serviceType is required' });
    }
    const serviceId = typeof req.query.serviceId === 'string' ? req.query.serviceId.trim() : '';
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const lines = Number.parseInt(String(req.query.lines ?? ''), 10);

    const result = await getServiceLogs(serviceType, serviceId, lines);
    res.json({ success: true, data: result });
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }
    logger.error('Failed to read service logs', { error: (error as Error).message });
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read service logs',
    });
  }
});

export default router;
