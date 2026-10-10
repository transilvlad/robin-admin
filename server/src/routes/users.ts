/**
 * Mail user management routes.
 */

import { Router, Request, Response } from 'express';
import {
  getAllUsers,
  getUserById,
  getUserByEmail,
  createUser,
  updateUser,
  deleteUser,
  getUsersSchema,
  MailboxInputError,
} from '../db/queries/users.js';
import { hashMailUserPassword } from '../services/password.js';
import { requireAuth } from '../middleware/auth.js';
import { requireEditor, requireViewer } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { logger } from '../logger.js';
import { routeParam } from './params.js';
import { requireMailboxBackend } from '../middleware/mailboxes.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);
router.use(requireMailboxBackend('users'));

/**
 * GET /api/users/schema
 * Return the available columns on the host's `users` table so the UI
 * can adapt forms / tables to whatever Dovecot schema is in use.
 */
router.get('/schema', requireViewer, async (_req: Request, res: Response) => {
  try {
    const schema = await getUsersSchema();
    if (!schema) {
      res.status(404).json({ success: false, error: 'users table not found' });
      return;
    }
    res.json({ success: true, data: schema });
  } catch (error) {
    logger.error('Failed to read users schema', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to read users schema' });
  }
});

/**
 * GET /api/users
 * List all users with pagination.
 */
router.get('/', requireViewer, async (req: Request, res: Response) => {
  try {
    logger.info('Users list request', { query: req.query });
    const page = Math.max(1, parseInt(req.query.page as string, 10) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit as string, 10) || 50));
    const search = req.query.search as string | undefined;

    const { users, total } = await getAllUsers(page, limit, search);
    logger.info('Users fetched', { count: users.length, total });

    res.json({
      success: true,
      data: users,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  } catch (error) {
    logger.error('Failed to list users', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to list users',
    });
  }
});

/**
 * GET /api/users/:id
 * Get user by ID.
 */
router.get('/:id', requireViewer, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID',
      });
      return;
    }

    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    logger.error('Failed to get user', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get user',
    });
  }
});

/**
 * POST /api/users
 * Create a new mail user.
 */
router.post('/', requireEditor, async (req: Request, res: Response) => {
  try {
    // Additional fields must be supported by the selected mailbox schema.
    const { email, password, uid, gid, extra } = req.body;

    // Validate required fields
    if (!email || !password) {
      res.status(400).json({
        success: false,
        error: 'Email and password are required',
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

    // Check if user already exists
    const existing = await getUserByEmail(email);
    if (existing) {
      res.status(400).json({
        success: false,
        error: 'A user with this email already exists',
      });
      return;
    }

    // Hash password (SHA512-CRYPT for Dovecot)
    const passwordHash = hashMailUserPassword(password);

    // Create user
    const user = await createUser(
      email,
      passwordHash,
      uid,
      gid,
      extra
    );

    // Audit log
    await logAudit(req, AuditActions.USER_CREATE, {
      entityType: 'user',
      entityId: user.id.toString(),
      newValues: { email: user.email },
    });

    logger.info('User created', { email: user.email });

    res.status(201).json({
      success: true,
      data: user,
    });
  } catch (error) {
    logger.error('Failed to create user', { error: (error as Error).message });

    if (error instanceof MailboxInputError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }

    if ((error as Error).message.includes('duplicate key')) {
      res.status(400).json({
        success: false,
        error: 'A user with this email already exists',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to create user',
    });
  }
});

/**
 * PUT /api/users/:id
 * Update a mail user.
 */
router.put('/:id', requireEditor, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID',
      });
      return;
    }

    const oldUser = await getUserById(id);
    if (!oldUser) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    const { email, password, uid, gid, extra } = req.body;
    const updates: {
      email?: string;
      passwordHash?: string;
      uid?: number;
      gid?: number;
      extra?: Record<string, unknown>;
    } = {};

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

      // Check if email is taken by another user
      if (email.toLowerCase() !== oldUser.email.toLowerCase()) {
        const existing = await getUserByEmail(email);
        if (existing) {
          res.status(400).json({
            success: false,
            error: 'A user with this email already exists',
          });
          return;
        }
      }

      updates.email = email;
    }

    // Hash new password if provided
    if (password !== undefined) {
      updates.passwordHash = hashMailUserPassword(password);
    }

    // Set uid/gid
    if (uid !== undefined) {
      updates.uid = uid;
    }
    if (gid !== undefined) {
      updates.gid = gid;
    }
    if (extra !== undefined) {
      updates.extra = extra as Record<string, unknown>;
    }

    const user = await updateUser(id, updates);

    // Audit log
    await logAudit(req, AuditActions.USER_UPDATE, {
      entityType: 'user',
      entityId: id.toString(),
      oldValues: { email: oldUser.email },
      newValues: { email: user?.email },
    });

    res.json({
      success: true,
      data: user,
    });
  } catch (error) {
    logger.error('Failed to update user', { error: (error as Error).message });

    if (error instanceof MailboxInputError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }

    if ((error as Error).message.includes('duplicate key')) {
      res.status(400).json({
        success: false,
        error: 'A user with this email already exists',
      });
      return;
    }

    res.status(500).json({
      success: false,
      error: 'Failed to update user',
    });
  }
});

/**
 * DELETE /api/users/:id
 * Delete a mail user.
 */
router.delete('/:id', requireEditor, async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (isNaN(id)) {
      res.status(400).json({
        success: false,
        error: 'Invalid user ID',
      });
      return;
    }

    const user = await getUserById(id);
    if (!user) {
      res.status(404).json({
        success: false,
        error: 'User not found',
      });
      return;
    }

    await deleteUser(id);

    // Audit log
    await logAudit(req, AuditActions.USER_DELETE, {
      entityType: 'user',
      entityId: id.toString(),
      oldValues: { email: user.email },
    });

    logger.info('User deleted', { id, email: user.email });

    res.json({
      success: true,
      message: 'User deleted successfully',
    });
  } catch (error) {
    logger.error('Failed to delete user', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to delete user',
    });
  }
});

export default router;
