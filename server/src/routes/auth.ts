/**
 * Authentication routes.
 */

import { Router, Request, Response } from 'express';
import { getAdminByEmail, resetAdminPasswordWithRecoveryToken, updateLastLogin } from '../db/queries/admins.js';
import { updateAdmin } from '../db/queries/admins.js';
import { query } from '../db/connection.js';
import { hashAdminPassword, validatePasswordStrength, verifyAdminPassword } from '../services/password.js';
import { requireAuth } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { needsSetup } from '../db/schema.js';
import { getConfig } from '../db/queries/config.js';
import {
  countRecentFailedLogins,
  getActiveLoginLock,
  recordLoginAttempt,
} from '../db/queries/security.js';
import { getCsrfToken, getTrustedClientIp } from '../middleware/security.js';
import { logger } from '../logger.js';
import rateLimit from 'express-rate-limit';
import { config } from '../config.js';
import { createEmailToken, hashEmailToken } from '../db/queries/email.js';
import { enqueuePasswordRecoveryEmail } from '../services/email/messages.js';

const router = Router();

// Rate limit for login attempts
const loginLimiter = rateLimit({
  // The same client IP as every other security decision, not Express's req.ip,
  // which trusts one X-Forwarded-For hop even when nothing proxies the request.
  keyGenerator: (req) => getTrustedClientIp(req),
  windowMs: config.rateLimit.windowMs,
  max: config.rateLimit.loginMaxRequests,
  message: {
    success: false,
    error: 'Too many login attempts. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const recoveryLimiter = rateLimit({
  keyGenerator: (req) => getTrustedClientIp(req),
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: {
    success: false,
    error: 'Too many recovery attempts. Please try again later.',
  },
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * GET /api/setup/status
 * Check if first-time setup is needed.
 */
router.get('/setup/status', async (_req: Request, res: Response) => {
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
 * POST /api/auth/login
 * Authenticate an admin user.
 */
router.post('/login', loginLimiter, async (req: Request, res: Response) => {
  try {
    const { email, password } = req.body;
    const normalizedEmail = String(email ?? '').toLowerCase().trim();
    const ipAddress = await getTrustedClientIp(req);
    const userAgent = req.headers['user-agent'];
    const cfg = await getConfig();

    if (!email || !password) {
      res.status(400).json({
        success: false,
        error: 'Email and password are required',
      });
      return;
    }

    if (cfg.loginProtectionEnabled) {
      const activeLock = await getActiveLoginLock(normalizedEmail, ipAddress);
      if (activeLock) {
        await recordLoginAttempt({
          email: normalizedEmail,
          ipAddress,
          userAgent,
          success: false,
          failureReason: 'locked',
          lockedUntil: activeLock,
        });
        await logAudit(req, AuditActions.ADMIN_LOGIN_LOCKED, {
          entityType: 'admin',
          entityId: normalizedEmail,
          newValues: { ipAddress, lockedUntil: activeLock.toISOString() },
        });
        res.status(429).json({
          success: false,
          error: 'Too many login attempts. Please try again later.',
        });
        return;
      }
    }

    const admin = await getAdminByEmail(normalizedEmail);
    if (!admin) {
      await handleFailedLogin(req, normalizedEmail, ipAddress, userAgent, 'invalid_credentials');
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    if (admin.disabled) {
      await handleFailedLogin(req, normalizedEmail, ipAddress, userAgent, 'disabled');
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    const isValid = await verifyAdminPassword(password, admin.passwordHash);
    if (!isValid) {
      await handleFailedLogin(req, normalizedEmail, ipAddress, userAgent, 'invalid_credentials');
      res.status(401).json({
        success: false,
        error: 'Invalid email or password',
      });
      return;
    }

    // Update last login
    await updateLastLogin(admin.id);

    await new Promise<void>((resolve, reject) => {
      req.session.regenerate((err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    const now = Date.now();
    req.session.admin = {
      id: admin.id,
      uid: admin.uid,
      name: admin.name,
      email: admin.email,
      role: admin.role,
      allowedCidrs: admin.allowedCidrs,
    };
    req.session.authenticatedAt = now;
    req.session.lastSeenAt = now;
    getCsrfToken(req);

    await recordLoginAttempt({
      email: normalizedEmail,
      ipAddress,
      userAgent,
      success: true,
    });

    // Audit log
    await logAudit(req, AuditActions.ADMIN_LOGIN, {
      entityType: 'admin',
      entityId: admin.id.toString(),
    });

    logger.info('Admin login successful', { email: admin.email, ip: ipAddress });

    res.json({
      success: true,
      data: {
        id: admin.id,
        uid: admin.uid,
        name: admin.name,
        email: admin.email,
        role: admin.role,
        allowedCidrs: admin.allowedCidrs,
        csrfToken: req.session.csrfToken,
      },
    });
  } catch (error) {
    logger.error('Login failed', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Login failed',
    });
  }
});

router.post('/recovery/request', recoveryLimiter, async (req: Request, res: Response) => {
  const normalizedEmail = String(req.body?.email ?? '').toLowerCase().trim();
  try {
    if (normalizedEmail) {
      const admin = await getAdminByEmail(normalizedEmail);
      if (admin && !admin.disabled) {
        const token = createEmailToken();
        await query(
          `INSERT INTO admin_password_recovery_tokens (admin_id, token_hash, requested_ip, expires_at)
           VALUES ($1, $2, $3, CURRENT_TIMESTAMP + INTERVAL '30 minutes')`,
          [admin.id, token.hash, await getTrustedClientIp(req)]
        );
        await enqueuePasswordRecoveryEmail({
          email: admin.email,
          token: token.token,
          baseUrl: config.publicBaseUrl,
        });
        await logAudit(req, AuditActions.ADMIN_PASSWORD_RECOVERY_REQUESTED, {
          entityType: 'admin',
          entityId: String(admin.id),
          newValues: { email: admin.email },
        });
      }
    }
    res.status(202).json({ success: true, message: 'If the account exists, recovery instructions will be emailed.' });
  } catch (error) {
    logger.error('Password recovery request failed', { error: (error as Error).message });
    res.status(202).json({ success: true, message: 'If the account exists, recovery instructions will be emailed.' });
  }
});

router.post('/recovery/reset', recoveryLimiter, async (req: Request, res: Response) => {
  try {
    const token = String(req.body?.token ?? '');
    const password = String(req.body?.password ?? '');
    const validation = validatePasswordStrength(password);
    if (!token || !validation.valid) {
      res.status(400).json({ success: false, error: validation.valid ? 'Recovery token is required' : validation.errors.join('; ') });
      return;
    }
    const admin = await resetAdminPasswordWithRecoveryToken(hashEmailToken(token), await hashAdminPassword(password));
    if (!admin) {
      res.status(400).json({ success: false, error: 'Recovery token is invalid or expired' });
      return;
    }
    await logAudit(req, AuditActions.ADMIN_PASSWORD_RECOVERY_COMPLETED, {
      entityType: 'admin',
      entityId: String(admin.id),
      newValues: { email: admin.email },
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('Password recovery reset failed', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Password reset failed' });
  }
});

async function handleFailedLogin(
  req: Request,
  email: string,
  ipAddress: string,
  userAgent: string | undefined,
  reason: string
): Promise<void> {
  const cfg = await getConfig();
  let lockedUntil: Date | null = null;

  if (cfg.loginProtectionEnabled) {
    const counts = await countRecentFailedLogins({
      email,
      ipAddress,
      windowMinutes: cfg.loginLockoutMinutes,
    });
    const nextEmailFailures = counts.byEmail + 1;
    const nextIpFailures = counts.byIp + 1;
    if (
      nextEmailFailures >= cfg.loginMaxAttemptsPerEmail ||
      nextIpFailures >= cfg.loginMaxAttemptsPerIp ||
      nextEmailFailures >= cfg.maxLoginAttempts
    ) {
      lockedUntil = new Date(Date.now() + cfg.loginLockoutMinutes * 60 * 1000);
    }
  }

  await recordLoginAttempt({
    email,
    ipAddress,
    userAgent,
    success: false,
    failureReason: reason,
    lockedUntil,
  });

  await logAudit(req, lockedUntil ? AuditActions.ADMIN_LOGIN_LOCKED : AuditActions.ADMIN_LOGIN_FAILED, {
    entityType: 'admin',
    entityId: email,
    newValues: {
      reason,
      ipAddress,
      lockedUntil: lockedUntil?.toISOString(),
    },
  });
}

/**
 * POST /api/auth/logout
 * End the current session.
 */
router.post('/logout', requireAuth, async (req: Request, res: Response) => {
  try {
    const adminId = req.session.admin?.id;

    // Audit log
    await logAudit(req, AuditActions.ADMIN_LOGOUT, {
      entityType: 'admin',
      entityId: adminId?.toString(),
    });

    req.session.destroy((err) => {
      if (err) {
        logger.error('Session destruction failed', { error: err.message });
        res.status(500).json({
          success: false,
          error: 'Logout failed',
        });
        return;
      }

      res.clearCookie('robin.admin.sid', {
        domain: config.nodeEnv === 'production' ? config.cookieDomain : undefined,
        path: config.cookiePath,
        secure: config.cookieSecure,
        sameSite: 'lax',
      });
      res.json({
        success: true,
        message: 'Logged out successfully',
      });
    });
  } catch (error) {
    logger.error('Logout failed', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Logout failed',
    });
  }
});

/**
 * GET /api/auth/csrf
 * Return the current session CSRF token.
 */
router.get('/csrf', requireAuth, (req: Request, res: Response) => {
  res.json({
    success: true,
    data: { csrfToken: getCsrfToken(req) },
  });
});

/**
 * GET /api/auth/me
 * Get current authenticated admin info.
 */
router.get('/me', requireAuth, (req: Request, res: Response) => {
  res.json({
    success: true,
    data: req.session.admin,
  });
});

export default router;
