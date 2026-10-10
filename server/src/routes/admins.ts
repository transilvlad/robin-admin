/**
 * Admin management routes.
 */

import { Router, Request, Response } from 'express';
import {
  getAllAdmins,
  getAdminById,
  createAdmin,
  updateAdmin,
  deleteAdmin,
  countAdminsByRole,
  invalidateAdminSessions,
} from '../db/queries/admins.js';
import { hashAdminPassword, validatePasswordStrength } from '../services/password.js';
import { requireAuth } from '../middleware/auth.js';
import { parseList, validateCidrOrIp } from '../middleware/security.js';
import { requireAdmin } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { logger } from '../logger.js';
import type { AdminRole } from '../types/index.js';
import { routeParam } from './params.js';

const router = Router();

function parseAndValidateAllowedCidrs(raw: unknown): { ok: true; value: string[] } | { ok: false } {
  const allowedCidrs = parseList(raw as string | string[] | undefined);
  if (!allowedCidrs.every(validateCidrOrIp)) {
    return { ok: false };
  }
  return { ok: true, value: allowedCidrs };
}

// All admin routes require authentication and admin role
router.use(requireAuth);
router.use(requireAdmin);

/**
 * GET /api/admins
 * List all admins.
 */
router.get('/', async (_req: Request, res: Response) => {
  try {
    const admins = await getAllAdmins();
    res.json({
      success: true,
      data: admins,
    });
  } catch (error) {
    logger.error('Failed to list admins', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to list admins',
    });
  }
});

/**
 * GET /api/admins/:id
 * Get admin by ID.
 */
router.get('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid admin ID',
      });
      return;
    }

    const admin = await getAdminById(id);
    if (!admin) {
      res.status(404).json({
        success: false,
        error: 'Admin not found',
      });
      return;
    }

    res.json({
      success: true,
      data: admin,
    });
  } catch (error) {
    logger.error('Failed to get admin', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get admin',
    });
  }
});

/**
 * POST /api/admins
 * Create a new admin.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, email, password, role, disabled, allowedCidrs } = req.body;

    // Validate required fields
    if (!name || !email || !password || !role) {
      res.status(400).json({
        success: false,
        error: 'Name, email, password, and role are required',
      });
      return;
    }

    if (!String(name).trim()) {
      res.status(400).json({
        success: false,
        error: 'Name is required',
      });
      return;
    }

    if (disabled !== undefined && typeof disabled !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'Disabled must be a boolean value',
      });
      return;
    }

    const parsedAllowedCidrs = parseAndValidateAllowedCidrs(allowedCidrs);
    if (!parsedAllowedCidrs.ok) {
      res.status(400).json({
        success: false,
        error: 'Allowed CIDRs must contain valid IP or CIDR entries',
      });
      return;
    }

    // Validate email format
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({
        success: false,
        error: 'Invalid email format',
      });
      return;
    }

    // Validate role
    const validRoles: AdminRole[] = ['viewer', 'editor', 'admin'];
    if (!validRoles.includes(role)) {
      res.status(400).json({
        success: false,
        error: 'Invalid role. Must be viewer, editor, or admin.',
      });
      return;
    }

    // Validate password strength
    const passwordValidation = validatePasswordStrength(password);
    if (!passwordValidation.valid) {
      res.status(400).json({
        success: false,
        error: 'Password does not meet requirements',
        details: passwordValidation.errors,
      });
      return;
    }

    // Hash password and create admin
    const passwordHash = await hashAdminPassword(password);
    const admin = await createAdmin(name, email, passwordHash, role, parsedAllowedCidrs.value, disabled === true);

    // Audit log
    await logAudit(req, AuditActions.ADMIN_CREATE, {
      entityType: 'admin',
      entityId: admin.id.toString(),
      newValues: { name: admin.name, email: admin.email, role: admin.role, allowedCidrs: admin.allowedCidrs, disabled: admin.disabled },
    });

    logger.info('Admin created', { email: admin.email, role: admin.role });

    res.status(201).json({
      success: true,
      data: admin,
    });
  } catch (error) {
    logger.error('Failed to create admin', { error: (error as Error).message });

    if ((error as Error).message.includes('duplicate key')) {
      res.status(400).json({
        success: false,
        error: 'An admin with this email already exists',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create admin',
    });
  }
});

/**
 * PUT /api/admins/:id
 * Update an admin.
 */
router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid admin ID',
      });
      return;
    }

    const oldAdmin = await getAdminById(id);
    if (!oldAdmin) {
      res.status(404).json({
        success: false,
        error: 'Admin not found',
      });
      return;
    }

    const { name, email, password, role, disabled, allowedCidrs } = req.body;
    const updates: {
      name?: string;
      email?: string;
      passwordHash?: string;
      role?: AdminRole;
      allowedCidrs?: string[];
      disabled?: boolean;
    } = {};

    if (name !== undefined) {
      if (!String(name).trim()) {
        res.status(400).json({
          success: false,
          error: 'Name is required',
        });
        return;
      }
      updates.name = name;
    }

    if (disabled !== undefined && typeof disabled !== 'boolean') {
      res.status(400).json({
        success: false,
        error: 'Disabled must be a boolean value',
      });
      return;
    }

    // Validate and set email
    if (email !== undefined) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) {
        res.status(400).json({
          success: false,
          error: 'Invalid email format',
        });
        return;
      }
      updates.email = email;
    }

    // Validate and set role
    if (role !== undefined) {
      const validRoles: AdminRole[] = ['viewer', 'editor', 'admin'];
      if (!validRoles.includes(role)) {
        res.status(400).json({
          success: false,
          error: 'Invalid role. Must be viewer, editor, or admin.',
        });
        return;
      }

      // Prevent removing the last admin role
      if (oldAdmin.role === 'admin' && role !== 'admin') {
        const adminCount = await countAdminsByRole('admin');
        if (adminCount <= 1) {
          res.status(400).json({
            success: false,
            error: 'Cannot remove the last admin. Promote another user first.',
          });
          return;
        }
      }

      updates.role = role;
    }

    // Validate and set password
    if (password !== undefined) {
      const passwordValidation = validatePasswordStrength(password);
      if (!passwordValidation.valid) {
        res.status(400).json({
          success: false,
          error: 'Password does not meet requirements',
          details: passwordValidation.errors,
        });
        return;
      }
      updates.passwordHash = await hashAdminPassword(password);
    }

    if (allowedCidrs !== undefined) {
      const parsedAllowedCidrs = parseAndValidateAllowedCidrs(allowedCidrs);
      if (!parsedAllowedCidrs.ok) {
        res.status(400).json({
          success: false,
          error: 'Allowed CIDRs must contain valid IP or CIDR entries',
        });
        return;
      }
      updates.allowedCidrs = parsedAllowedCidrs.value;
    }

    // Set disabled status
    if (disabled !== undefined) {
      if (req.session.admin?.id === id && disabled) {
        res.status(400).json({
          success: false,
          error: 'Cannot disable your own account',
        });
        return;
      }

      // Prevent disabling the last enabled admin
      if (!oldAdmin.disabled && disabled && oldAdmin.role === 'admin') {
        const adminCount = await countAdminsByRole('admin');
        if (adminCount <= 1) {
          res.status(400).json({
            success: false,
            error: 'Cannot disable the last enabled admin.',
          });
          return;
        }
      }
      updates.disabled = disabled;
    }

    const admin = await updateAdmin(id, updates);

    // A stolen or otherwise-stale session shouldn't survive the account being
    // disabled or given a new password. Keep the current
    // session alive if an admin is editing their own record this way.
    if (updates.disabled === true || updates.passwordHash !== undefined) {
      const exceptSid = req.session.admin?.id === id ? req.sessionID : undefined;
      await invalidateAdminSessions(id, exceptSid);
    }

    // Audit log
    await logAudit(req, AuditActions.ADMIN_UPDATE, {
      entityType: 'admin',
      entityId: id.toString(),
      oldValues: { name: oldAdmin.name, email: oldAdmin.email, role: oldAdmin.role, allowedCidrs: oldAdmin.allowedCidrs, disabled: oldAdmin.disabled },
      newValues: { name: admin?.name, email: admin?.email, role: admin?.role, allowedCidrs: admin?.allowedCidrs, disabled: admin?.disabled },
    });

    if (req.session.admin?.id === id && admin) {
      req.session.admin = {
        id: admin.id,
        uid: admin.uid,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        allowedCidrs: admin.allowedCidrs,
      };
    }

    res.json({
      success: true,
      data: admin,
    });
  } catch (error) {
    logger.error('Failed to update admin', { error: (error as Error).message });

    if ((error as Error).message.includes('duplicate key')) {
      res.status(400).json({
        success: false,
        error: 'An admin with this email already exists',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to update admin',
    });
  }
});

/**
 * DELETE /api/admins/:id
 * Delete an admin.
 */
router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid admin ID',
      });
      return;
    }

    // Prevent self-deletion
    if (req.session.admin?.id === id) {
      res.status(400).json({
        success: false,
        error: 'Cannot delete your own account',
      });
      return;
    }

    const admin = await getAdminById(id);
    if (!admin) {
      res.status(404).json({
        success: false,
        error: 'Admin not found',
      });
      return;
    }

    // Prevent deleting the last admin
    if (admin.role === 'admin') {
      const adminCount = await countAdminsByRole('admin');
      if (adminCount <= 1) {
        res.status(400).json({
          success: false,
          error: 'Cannot delete the last admin',
        });
        return;
      }
    }

    await deleteAdmin(id);
    await invalidateAdminSessions(id);

    // Audit log
    await logAudit(req, AuditActions.ADMIN_DELETE, {
      entityType: 'admin',
      entityId: id.toString(),
      oldValues: { email: admin.email, role: admin.role },
    });

    logger.info('Admin deleted', { id, email: admin.email });

    res.json({
      success: true,
      message: 'Admin deleted successfully',
    });
  } catch (error) {
    logger.error('Failed to delete admin', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete admin',
    });
  }
});

export default router;
