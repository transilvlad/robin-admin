/**
 * Queue management routes.
 * 
 * Provides a hybrid interface for Robin's email queue:
 * - Database queries for listing and viewing queue items
 * - Robin API calls for actions (retry, bounce, delete)
 * 
 * Endpoints:
 * - GET / - List queue items with pagination and filters
 * - GET /stats - Queue statistics for dashboard
 * - POST /bulk/retry - Retry multiple items (via Robin API)
 * - POST /bulk/bounce - Bounce multiple items (via Robin API)
 * - POST /bulk/delete - Delete multiple items (via Robin API)
 * - GET /:uid - Get queue item details
 * - POST /:uid/retry - Retry single item (via Robin API)
 * - POST /:uid/bounce - Bounce single item (via Robin API)
 * - DELETE /:uid - Delete single item (via Robin API)
 *
 * The /bulk routes are registered before /:uid so "bulk" is never read as a uid.
 * 
 * Queue actions use Robin's API, not direct database updates.
 * The queue table may not exist if Robin has not been run.
 * Bulk actions require editor+ role. View actions require viewer+ role.
 */

import { Router, Request, Response } from 'express';
import {
  getAllQueueItems,
  getQueueItemByUid,
  getQueueStats,
  queueTableExists,
} from '../db/queries/queue.js';
import {
  retryQueueItem,
  retryQueueItems,
  deleteQueueItem,
  deleteQueueItems,
  bounceQueueItem,
  bounceQueueItems,
  robinApiFailure,
} from '../services/robin-api.js';
import { requireAuth } from '../middleware/auth.js';
import { requireEditor, requireViewer } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { logger } from '../logger.js';
import { routeParam } from './params.js';

const router = Router();

function respondToRobinApiFailure(res: Response, error: unknown): boolean {
  const failure = robinApiFailure(error, 'Robin MTA API is unavailable. Queue actions are not available on this deployment.');
  if (!failure) {
    return false;
  }
  res.status(failure.status).json({ success: false, error: failure.error });
  return true;
}

// All routes require authentication
router.use(requireAuth);

/**
 * GET /api/queue
 * List queue items with pagination and filtering.
 */
router.get('/', requireViewer, async (req: Request, res: Response) => {
  try {
    const exists = await queueTableExists();
    if (!exists) {
      res.json({
        success: true,
        data: [],
        pagination: { page: 1, limit: 50, total: 0, totalPages: 0 },
        message: 'Queue table does not exist. Robin may be using a different queue backend.',
      });
      return;
    }

    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const state = req.query.state as string | undefined;
    const protocol = req.query.protocol as string | undefined;
    const search = req.query.search as string | undefined;

    const { items, total } = await getAllQueueItems(page, limit, {
      state,
      protocol,
      search,
    });

    res.json({
      success: true,
      data: items,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to list queue items', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to list queue items',
    });
  }
});

/**
 * GET /api/queue/stats
 * Get queue statistics.
 */
router.get('/stats', requireViewer, async (_req: Request, res: Response) => {
  try {
    const stats = await getQueueStats();
    res.json({
      success: true,
      data: stats,
    });
  } catch (error) {
    logger.error('Failed to get queue stats', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get queue stats',
    });
  }
});

/**
 * POST /api/queue/bulk/retry
 * Retry multiple queue items.
 */
router.post('/bulk/retry', requireEditor, async (req: Request, res: Response) => {
  try {
    const { uids } = req.body;
    const serviceId = req.query.serviceId as string | undefined;

    if (!Array.isArray(uids) || uids.length === 0) {
      res.status(400).json({
        success: false,
        error: 'UIDs array is required',
      });
      return;
    }

    const result = await retryQueueItems(uids, serviceId);

    await logAudit(req, AuditActions.QUEUE_BULK_RETRY, {
      entityType: 'queue',
      newValues: { uids, count: uids.length },
    });

    logger.info('Bulk queue retry requested', { count: uids.length, serviceId });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to bulk retry queue items', { error: (error as Error).message });
    if (respondToRobinApiFailure(res, error)) return;
    res.status(500).json({
      success: false,
      error: 'Failed to bulk retry queue items',
    });
  }
});

/**
 * POST /api/queue/bulk/delete
 * Delete multiple queue items.
 */
router.post('/bulk/delete', requireEditor, async (req: Request, res: Response) => {
  try {
    const { uids } = req.body;
    const serviceId = req.query.serviceId as string | undefined;

    if (!Array.isArray(uids) || uids.length === 0) {
      res.status(400).json({
        success: false,
        error: 'UIDs array is required',
      });
      return;
    }

    const result = await deleteQueueItems(uids, serviceId);

    await logAudit(req, AuditActions.QUEUE_BULK_DELETE, {
      entityType: 'queue',
      newValues: { uids, count: uids.length },
    });

    logger.info('Bulk queue delete requested', { count: uids.length, serviceId });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to bulk delete queue items', { error: (error as Error).message });
    if (respondToRobinApiFailure(res, error)) return;
    res.status(500).json({
      success: false,
      error: 'Failed to bulk delete queue items',
    });
  }
});

/**
 * POST /api/queue/bulk/bounce
 * Bounce multiple queue items.
 */
router.post('/bulk/bounce', requireEditor, async (req: Request, res: Response) => {
  try {
    const { uids } = req.body;
    const serviceId = req.query.serviceId as string | undefined;

    if (!Array.isArray(uids) || uids.length === 0) {
      res.status(400).json({
        success: false,
        error: 'UIDs array is required',
      });
      return;
    }

    const result = await bounceQueueItems(uids, serviceId);

    await logAudit(req, AuditActions.QUEUE_BULK_BOUNCE, {
      entityType: 'queue',
      newValues: { uids, count: uids.length },
    });

    logger.info('Bulk queue bounce requested', { count: uids.length, serviceId });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to bulk bounce queue items', { error: (error as Error).message });
    if (respondToRobinApiFailure(res, error)) return;
    res.status(500).json({
      success: false,
      error: 'Failed to bulk bounce queue items',
    });
  }
});

/**
 * GET /api/queue/:uid
 * Get queue item by UID.
 */
router.get('/:uid', requireViewer, async (req: Request, res: Response) => {
  try {
    const uid = routeParam(req, 'uid');

    const item = await getQueueItemByUid(uid);
    if (!item) {
      res.status(404).json({
        success: false,
        error: 'Queue item not found',
      });
      return;
    }

    res.json({
      success: true,
      data: item,
    });
  } catch (error) {
    logger.error('Failed to get queue item', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get queue item',
    });
  }
});

/**
 * POST /api/queue/:uid/retry
 * Retry a queue item via Robin API.
 */
router.post('/:uid/retry', requireEditor, async (req: Request, res: Response) => {
  try {
    const uid = routeParam(req, 'uid');
    const serviceId = req.query.serviceId as string | undefined;

    const result = await retryQueueItem(uid, serviceId);

    await logAudit(req, AuditActions.QUEUE_RETRY, {
      entityType: 'queue',
      entityId: uid,
    });

    logger.info('Queue item retry requested', { uid, serviceId });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to retry queue item', { error: (error as Error).message });
    if (respondToRobinApiFailure(res, error)) return;
    res.status(500).json({
      success: false,
      error: 'Failed to retry queue item',
    });
  }
});

/**
 * DELETE /api/queue/:uid
 * Delete a queue item via Robin API.
 */
router.delete('/:uid', requireEditor, async (req: Request, res: Response) => {
  try {
    const uid = routeParam(req, 'uid');
    const serviceId = req.query.serviceId as string | undefined;

    const result = await deleteQueueItem(uid, serviceId);

    await logAudit(req, AuditActions.QUEUE_DELETE, {
      entityType: 'queue',
      entityId: uid,
    });

    logger.info('Queue item delete requested', { uid, serviceId });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to delete queue item', { error: (error as Error).message });
    if (respondToRobinApiFailure(res, error)) return;
    res.status(500).json({
      success: false,
      error: 'Failed to delete queue item',
    });
  }
});

/**
 * POST /api/queue/:uid/bounce
 * Bounce a queue item via Robin API.
 */
router.post('/:uid/bounce', requireEditor, async (req: Request, res: Response) => {
  try {
    const uid = routeParam(req, 'uid');
    const serviceId = req.query.serviceId as string | undefined;

    const result = await bounceQueueItem(uid, serviceId);

    await logAudit(req, AuditActions.QUEUE_BOUNCE, {
      entityType: 'queue',
      entityId: uid,
    });

    logger.info('Queue item bounce requested', { uid, serviceId });

    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to bounce queue item', { error: (error as Error).message });
    if (respondToRobinApiFailure(res, error)) return;
    res.status(500).json({
      success: false,
      error: 'Failed to bounce queue item',
    });
  }
});

export default router;
