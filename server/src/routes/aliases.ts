/**
 * Alias management routes.
 */

import { Router, Request, Response } from 'express';
import {
  getAllAliases,
  getAliasById,
  createAlias,
  updateAlias,
  deleteAlias,
  getAllAutoAliases,
  getAutoAliasById,
  createAutoAlias,
  updateAutoAlias,
  deleteAutoAlias,
} from '../db/queries/aliases.js';
import { requireAuth } from '../middleware/auth.js';
import { requireEditor, requireViewer } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { logger } from '../logger.js';
import { routeParam } from './params.js';
import { requireMailboxBackend } from '../middleware/mailboxes.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);
router.use(requireMailboxBackend('aliases'));

// ============================================================================
// Auto-Aliases (must come before /:id routes to avoid matching "auto" as ID)
// ============================================================================

/**
 * GET /api/aliases/auto
 * List all auto-aliases with pagination.
 */
router.get('/auto', requireViewer, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const search = req.query.search as string | undefined;

    const { aliases, total } = await getAllAutoAliases(page, limit, search);

    res.json({
      success: true,
      data: aliases,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to list auto-aliases', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to list auto-aliases',
    });
  }
});

/**
 * GET /api/aliases/auto/:id
 * Get auto-alias by ID.
 */
router.get('/auto/:id', requireViewer, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid auto-alias ID',
      });
      return;
    }

    const alias = await getAutoAliasById(id);
    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Auto-alias not found',
      });
      return;
    }

    res.json({
      success: true,
      data: alias,
    });
  } catch (error) {
    logger.error('Failed to get auto-alias', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get auto-alias',
    });
  }
});

/**
 * POST /api/aliases/auto
 * Create a new auto-alias.
 */
router.post('/auto', requireEditor, async (req: Request, res: Response) => {
  try {
    const { source, destination } = req.body;

    if (!source || !destination) {
      res.status(400).json({
        success: false,
        error: 'Source and destination are required',
      });
      return;
    }

    const alias = await createAutoAlias(source, destination);

    // Audit log
    await logAudit(req, AuditActions.AUTO_ALIAS_CREATE, {
      entityType: 'auto_alias',
      entityId: alias.id.toString(),
      newValues: { source: alias.source, destination: alias.destination },
    });

    logger.info('Auto-alias created', { source: alias.source, destination: alias.destination });

    res.status(201).json({
      success: true,
      data: alias,
    });
  } catch (error) {
    logger.error('Failed to create auto-alias', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to create auto-alias',
    });
  }
});

/**
 * PUT /api/aliases/auto/:id
 * Update an auto-alias.
 */
router.put('/auto/:id', requireEditor, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid auto-alias ID',
      });
      return;
    }

    const oldAlias = await getAutoAliasById(id);
    if (!oldAlias) {
      res.status(404).json({
        success: false,
        error: 'Auto-alias not found',
      });
      return;
    }

    const { source, destination } = req.body;
    const updates: { source?: string; destination?: string } = {};

    if (source !== undefined) {
      updates.source = source;
    }
    if (destination !== undefined) {
      updates.destination = destination;
    }

    const alias = await updateAutoAlias(id, updates);

    // Audit log
    await logAudit(req, AuditActions.AUTO_ALIAS_UPDATE, {
      entityType: 'auto_alias',
      entityId: id.toString(),
      oldValues: { source: oldAlias.source, destination: oldAlias.destination },
      newValues: { source: alias?.source, destination: alias?.destination },
    });

    res.json({
      success: true,
      data: alias,
    });
  } catch (error) {
    logger.error('Failed to update auto-alias', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to update auto-alias',
    });
  }
});

/**
 * DELETE /api/aliases/auto/:id
 * Delete an auto-alias.
 */
router.delete('/auto/:id', requireEditor, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid auto-alias ID',
      });
      return;
    }

    const alias = await getAutoAliasById(id);
    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Auto-alias not found',
      });
      return;
    }

    await deleteAutoAlias(id);

    // Audit log
    await logAudit(req, AuditActions.AUTO_ALIAS_DELETE, {
      entityType: 'auto_alias',
      entityId: id.toString(),
      oldValues: { source: alias.source, destination: alias.destination },
    });

    logger.info('Auto-alias deleted', { id, source: alias.source, destination: alias.destination });

    res.json({
      success: true,
      message: 'Auto-alias deleted successfully',
    });
  } catch (error) {
    logger.error('Failed to delete auto-alias', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete auto-alias',
    });
  }
});

// ============================================================================
// Standard Aliases
// ============================================================================

/**
 * GET /api/aliases
 * List all aliases with pagination.
 */
router.get('/', requireViewer, async (req: Request, res: Response) => {
  try {
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const search = req.query.search as string | undefined;

    const { aliases, total } = await getAllAliases(page, limit, search);

    res.json({
      success: true,
      data: aliases,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to list aliases', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to list aliases',
    });
  }
});

/**
 * GET /api/aliases/:id
 * Get alias by ID.
 */
router.get('/:id', requireViewer, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid alias ID',
      });
      return;
    }

    const alias = await getAliasById(id);
    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    res.json({
      success: true,
      data: alias,
    });
  } catch (error) {
    logger.error('Failed to get alias', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get alias',
    });
  }
});

/**
 * POST /api/aliases
 * Create a new alias.
 */
router.post('/', requireEditor, async (req: Request, res: Response) => {
  try {
    const { source, destination } = req.body;

    // Validate required fields
    if (!source || !destination) {
      res.status(400).json({
        success: false,
        error: 'Source and destination are required',
      });
      return;
    }

    // Validate format (basic email or local part check)
    const emailOrLocalRegex = /^[^\s@]+(@[^\s@]+\.[^\s@]+)?$/;
    if (!emailOrLocalRegex.test(source)) {
      res.status(400).json({
        success: false,
        error: 'Invalid source format',
      });
      return;
    }
    if (!emailOrLocalRegex.test(destination)) {
      res.status(400).json({
        success: false,
        error: 'Invalid destination format',
      });
      return;
    }

    const alias = await createAlias(source, destination);

    // Audit log
    await logAudit(req, AuditActions.ALIAS_CREATE, {
      entityType: 'alias',
      entityId: alias.id.toString(),
      newValues: { source: alias.source, destination: alias.destination },
    });

    logger.info('Alias created', { source: alias.source, destination: alias.destination });

    res.status(201).json({
      success: true,
      data: alias,
    });
  } catch (error) {
    logger.error('Failed to create alias', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to create alias',
    });
  }
});

/**
 * PUT /api/aliases/:id
 * Update an alias.
 */
router.put('/:id', requireEditor, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid alias ID',
      });
      return;
    }

    const oldAlias = await getAliasById(id);
    if (!oldAlias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    const { source, destination } = req.body;
    const updates: { source?: string; destination?: string } = {};

    // Validate and set source
    if (source !== undefined) {
      const emailOrLocalRegex = /^[^\s@]+(@[^\s@]+\.[^\s@]+)?$/;
      if (!emailOrLocalRegex.test(source)) {
        res.status(400).json({
          success: false,
          error: 'Invalid source format',
        });
        return;
      }
      updates.source = source;
    }

    // Validate and set destination
    if (destination !== undefined) {
      const emailOrLocalRegex = /^[^\s@]+(@[^\s@]+\.[^\s@]+)?$/;
      if (!emailOrLocalRegex.test(destination)) {
        res.status(400).json({
          success: false,
          error: 'Invalid destination format',
        });
        return;
      }
      updates.destination = destination;
    }

    const alias = await updateAlias(id, updates);

    // Audit log
    await logAudit(req, AuditActions.ALIAS_UPDATE, {
      entityType: 'alias',
      entityId: id.toString(),
      oldValues: { source: oldAlias.source, destination: oldAlias.destination },
      newValues: { source: alias?.source, destination: alias?.destination },
    });

    res.json({
      success: true,
      data: alias,
    });
  } catch (error) {
    logger.error('Failed to update alias', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to update alias',
    });
  }
});

/**
 * DELETE /api/aliases/:id
 * Delete an alias.
 */
router.delete('/:id', requireEditor, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid alias ID',
      });
      return;
    }

    const alias = await getAliasById(id);
    if (!alias) {
      res.status(404).json({
        success: false,
        error: 'Alias not found',
      });
      return;
    }

    await deleteAlias(id);

    // Audit log
    await logAudit(req, AuditActions.ALIAS_DELETE, {
      entityType: 'alias',
      entityId: id.toString(),
      oldValues: { source: alias.source, destination: alias.destination },
    });

    logger.info('Alias deleted', { id, source: alias.source, destination: alias.destination });

    res.json({
      success: true,
      message: 'Alias deleted successfully',
    });
  } catch (error) {
    logger.error('Failed to delete alias', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete alias',
    });
  }
});

export default router;
