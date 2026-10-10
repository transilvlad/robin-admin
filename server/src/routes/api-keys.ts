/**
 * Scoped API key management for automations.
 */

import { Router, Request, Response } from 'express';
import { createApiKey, deleteApiKey, listApiKeys, revokeApiKey } from '../db/queries/security.js';
import { getConfig } from '../db/queries/config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { parseList } from '../middleware/security.js';
import { logger } from '../logger.js';
import type { AdminRole } from '../types/index.js';
import { routeParam } from './params.js';

const router = Router();

const VALID_ROLES: AdminRole[] = ['viewer', 'editor', 'admin'];
const VALID_SCOPES = new Set([
  '*',
  'admin:*',
  'users:read',
  'users:write',
  'aliases:read',
  'aliases:write',
  'queue:read',
  'queue:write',
  'mail:send',
  'fleet:read',
  'fleet:write',
  'metrics:read',
  'reporting:read',
  'reporting:write',
  'reports:read',
  'reports:ingest',
  'telemetry:read',
  'telemetry:write',
  'telemetry:manage',
  'rspamd:read',
  'rspamd:write',
  'rspamd:scan',
  'audit:read',
  'api:read',
  'api:write',
]);

router.use(requireAuth);
router.use(requireAdmin);

router.get('/', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listApiKeys() });
  } catch (error) {
    logger.error('Failed to list API keys', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list API keys' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const { name, role, scopes, allowedCidrs, expiresAt } = req.body;
    if (!name || typeof name !== 'string') {
      res.status(400).json({ success: false, error: 'API key name is required' });
      return;
    }
    if (!VALID_ROLES.includes(role)) {
      res.status(400).json({ success: false, error: 'Invalid API key role' });
      return;
    }

    const requestedScopes = Array.isArray(scopes) ? scopes : [];
    if (requestedScopes.length === 0 || requestedScopes.some((scope) => typeof scope !== 'string' || !VALID_SCOPES.has(scope))) {
      res.status(400).json({ success: false, error: 'One or more API key scopes are invalid' });
      return;
    }

    const cfg = await getConfig();
    const maxLifetimeMs = cfg.apiKeyMaxLifetimeDays * 24 * 60 * 60 * 1000;
    let expiry: Date;
    if (expiresAt) {
      expiry = new Date(expiresAt);
      if (Number.isNaN(expiry.getTime())) {
        res.status(400).json({ success: false, error: 'Invalid expiration date' });
        return;
      }
      const maxExpiry = Date.now() + maxLifetimeMs;
      if (expiry.getTime() > maxExpiry) {
        res.status(400).json({
          success: false,
          error: `API key expiration cannot exceed ${cfg.apiKeyMaxLifetimeDays} days`,
        });
        return;
      }
    } else {
      // No expiry supplied: default to the configured maximum lifetime rather than
      // creating a key that never expires (SEC-13).
      expiry = new Date(Date.now() + maxLifetimeMs);
    }

    const result = await createApiKey({
      name: name.trim(),
      role,
      scopes: requestedScopes,
      allowedCidrs: parseList(allowedCidrs),
      createdBy: req.session.admin?.id ?? null,
      expiresAt: expiry,
    });

    await logAudit(req, AuditActions.API_KEY_CREATE, {
      entityType: 'api-key',
      entityId: String(result.key.id),
      newValues: { name: result.key.name, role: result.key.role, scopes: result.key.scopes },
    });

    res.status(201).json({
      success: true,
      data: {
        ...result.key,
        plainText: result.plainText,
      },
    });
  } catch (error) {
    logger.error('Failed to create API key', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to create API key' });
  }
});

router.post('/:id/revoke', async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid API key ID' });
      return;
    }
    const revoked = await revokeApiKey(id);
    if (!revoked) {
      res.status(404).json({ success: false, error: 'API key not found or already revoked' });
      return;
    }
    await logAudit(req, AuditActions.API_KEY_REVOKE, {
      entityType: 'api-key',
      entityId: String(id),
    });
    res.json({ success: true, message: 'API key revoked' });
  } catch (error) {
    logger.error('Failed to revoke API key', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to revoke API key' });
  }
});

router.delete('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid API key ID' });
      return;
    }
    const deleted = await deleteApiKey(id);
    if (!deleted) {
      res.status(404).json({ success: false, error: 'API key not found' });
      return;
    }
    await logAudit(req, AuditActions.API_KEY_DELETE, {
      entityType: 'api-key',
      entityId: String(id),
    });
    res.json({ success: true, message: 'API key deleted' });
  } catch (error) {
    logger.error('Failed to delete API key', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to delete API key' });
  }
});

export default router;
