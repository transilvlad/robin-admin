/**
 * Profile management routes.
 */

import { Router, Request, Response } from 'express';
import { getAdminById, getAdminByIdWithPassword, invalidateAdminSessions, updateAdmin } from '../db/queries/admins.js';
import { hashAdminPassword, verifyAdminPassword } from '../services/password.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { logger } from '../logger.js';
import type { Admin } from '../types/index.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

function toProfilePayload(admin: Admin) {
  return {
    id: admin.id,
    uid: admin.uid,
    name: admin.name,
    email: admin.email,
    role: admin.role,
    allowedCidrs: admin.allowedCidrs,
    createdAt: admin.createdAt,
    lastLogin: admin.lastLogin,
  };
}

/**
 * GET /api/profile
 * Get current user's profile.
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const adminId = req.session.admin?.id;
    if (!adminId) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
      return;
    }
    
    const admin = await getAdminById(adminId);
    if (!admin) {
      res.status(404).json({
        success: false,
        error: 'Profile not found',
      });
      return;
    }
    
    res.json({
      success: true,
      data: toProfilePayload(admin),
    });
  } catch (error) {
    logger.error('Failed to get profile', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get profile',
    });
  }
});

/**
 * PUT /api/profile
 * Update current user's display name and email.
 */
router.put('/', async (req: Request, res: Response) => {
  try {
    const adminId = req.session.admin?.id;
    if (!adminId) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
      return;
    }

    const name = String(req.body?.name ?? '').trim();
    const email = String(req.body?.email ?? '').trim().toLowerCase();

    if (!name) {
      res.status(400).json({
        success: false,
        error: 'Name is required',
      });
      return;
    }

    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) {
      res.status(400).json({
        success: false,
        error: 'Invalid email format',
      });
      return;
    }

    const oldAdmin = await getAdminById(adminId);
    if (!oldAdmin) {
      res.status(404).json({
        success: false,
        error: 'Profile not found',
      });
      return;
    }

    const admin = await updateAdmin(adminId, { name, email });
    if (!admin) {
      res.status(404).json({
        success: false,
        error: 'Profile not found',
      });
      return;
    }

    req.session.admin = {
      id: admin.id,
      uid: admin.uid,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      allowedCidrs: admin.allowedCidrs,
    };

    await logAudit(req, AuditActions.ADMIN_UPDATE, {
      entityType: 'admin',
      entityId: String(adminId),
      oldValues: { name: oldAdmin.name, email: oldAdmin.email },
      newValues: { name: admin.name, email: admin.email },
    });

    res.json({
      success: true,
      data: toProfilePayload(admin),
      message: 'Profile updated successfully',
    });
  } catch (error) {
    logger.error('Failed to update profile', { error: (error as Error).message });

    if ((error as Error).message.includes('duplicate key')) {
      res.status(400).json({
        success: false,
        error: 'An admin with this email already exists',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to update profile',
    });
  }
});

/**
 * PUT /api/profile/password
 * Change current user's password.
 */
router.put('/password', async (req: Request, res: Response) => {
  try {
    const adminId = req.session.admin?.id;
    if (!adminId) {
      res.status(401).json({
        success: false,
        error: 'Not authenticated',
      });
      return;
    }
    
    const { currentPassword, newPassword } = req.body;
    
    if (!currentPassword || !newPassword) {
      res.status(400).json({
        success: false,
        error: 'Current password and new password are required',
      });
      return;
    }
    
    if (newPassword.length < 8) {
      res.status(400).json({
        success: false,
        error: 'New password must be at least 8 characters',
      });
      return;
    }
    
    const admin = await getAdminByIdWithPassword(adminId);
    if (!admin) {
      res.status(404).json({
        success: false,
        error: 'Profile not found',
      });
      return;
    }
    
    // Verify current password
    const isValid = await verifyAdminPassword(currentPassword, admin.passwordHash);
    if (!isValid) {
      res.status(400).json({
        success: false,
        error: 'Current password is incorrect',
      });
      return;
    }
    
    // Hash new password and update
    const newPasswordHash = await hashAdminPassword(newPassword);
    await updateAdmin(adminId, { passwordHash: newPasswordHash });

    // A stolen session shouldn't survive its victim changing their password.
    // Keep the current session alive so this request's own login isn't cut off.
    await invalidateAdminSessions(adminId, req.sessionID);

    await logAudit(req, AuditActions.ADMIN_UPDATE, {
      entityType: 'admin',
      entityId: String(adminId),
      newValues: { passwordChanged: true },
    });
    
    logger.info('Password changed', { adminId });
    
    res.json({
      success: true,
      message: 'Password changed successfully',
    });
  } catch (error) {
    logger.error('Failed to change password', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to change password',
    });
  }
});

export default router;
