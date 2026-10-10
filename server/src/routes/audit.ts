/**
 * Audit log routes.
 */

import { Router, Request, Response } from 'express';
import { getAuditEntries } from '../db/queries/audit.js';
import { requireAuth } from '../middleware/auth.js';
import { requireViewer } from '../middleware/rbac.js';
import { logger } from '../logger.js';

const router = Router();

// All routes require authentication and at least viewer role
router.use(requireAuth);
router.use(requireViewer);

/**
 * GET /api/audit
 * List audit log entries with pagination and filtering.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const adminId = req.query.adminId ? parseInt(req.query.adminId as string, 10) : undefined;
    const entityType = req.query.entityType as string | undefined;
    const entityId = req.query.entityId as string | undefined;
    const action = req.query.action as string | undefined;
    const startDate = req.query.startDate ? new Date(req.query.startDate as string) : undefined;
    const endDate = req.query.endDate ? new Date(req.query.endDate as string) : undefined;

    const { entries, total } = await getAuditEntries(page, limit, {
      adminId,
      entityType,
      entityId,
      action,
      startDate,
      endDate,
    });

    res.json({
      success: true,
      data: entries,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to list audit entries', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to list audit entries',
    });
  }
});

export default router;
