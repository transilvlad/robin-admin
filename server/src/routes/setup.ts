/**
 * First-time setup route.
 */

import { Router, Request, Response } from 'express';
import { getSetupSessionId, clearSetupSessionId, needsSetup } from '../db/schema.js';
import { createAdmin } from '../db/queries/admins.js';
import { setConfigValue, SETUP_GUIDE_PENDING_KEY } from '../db/queries/config.js';
import { hashAdminPassword, validatePasswordStrength } from '../services/password.js';
import { logger } from '../logger.js';

const router = Router();

/**
 * GET /api/setup/status
 * Check if first-time setup is needed.
 */
router.get('/status', async (_req: Request, res: Response) => {
  try {
    const setupRequired = await needsSetup();
    res.json({
      success: true,
      data: { setupRequired },
    });
  } catch (error) {
    logger.error('Failed to check setup status', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to check setup status',
    });
  }
});

/**
 * POST /api/setup
 * Create the first admin user.
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    // Check if setup is still needed
    const setupRequired = await needsSetup();
    if (!setupRequired) {
      res.status(400).json({
        success: false,
        error: 'Setup has already been completed',
      });
      return;
    }

    const { setupId, name, email, password } = req.body;

    // Validate required fields
    if (!setupId || !name || !email || !password) {
      res.status(400).json({
        success: false,
        error: 'Setup ID, name, email, and password are required',
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

    // Verify setup ID
    const expectedSetupId = getSetupSessionId();
    if (!expectedSetupId || setupId !== expectedSetupId) {
      logger.warn('Invalid setup ID attempt');
      res.status(403).json({
        success: false,
        error: 'Invalid setup ID. Retrieve the current setup ID from the server.',
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
    const admin = await createAdmin(name, email, passwordHash, 'admin');

    // Clear setup ID (no longer needed)
    await clearSetupSessionId();
    await setConfigValue(SETUP_GUIDE_PENDING_KEY, 'true');

    logger.info('First admin created successfully', { email: admin.email });

    res.status(201).json({
      success: true,
      message: 'Admin account created successfully. You can now log in.',
      data: {
        id: admin.id,
        uid: admin.uid,
        name: admin.name,
        email: admin.email,
        role: admin.role,
      },
    });
  } catch (error) {
    logger.error('Setup failed', { error: (error as Error).message });
    
    // Check for duplicate email
    if ((error as Error).message.includes('duplicate key')) {
      res.status(400).json({
        success: false,
        error: 'An admin with this email already exists',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Setup failed',
    });
  }
});

export default router;
