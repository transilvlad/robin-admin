/**
 * IP jail management routes.
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { validateCidrOrIp } from '../middleware/security.js';
import { requireAdmin } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { createIpJailEntry, liftIpJailEntry, listIpJailEntries, updateIpJailExpiry } from '../db/queries/security.js';
import { logger } from '../logger.js';
import { routeParam } from './params.js';

const router = Router();

router.use(requireAuth);
router.use(requireAdmin);

router.get('/', async (req: Request, res: Response) => {
  try {
    const includeInactive = String(req.query.includeInactive ?? 'false') === 'true';
    res.json({ success: true, data: await listIpJailEntries(includeInactive) });
  } catch (error) {
    logger.error('Failed to list IP jail entries', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list IP jail entries' });
  }
});

router.post('/', async (req: Request, res: Response) => {
  try {
    const cidr = String(req.body?.cidr ?? '').trim();
    const reason = String(req.body?.reason ?? '').trim();
    const expiresAtInput = req.body?.expiresAt;

    if (!cidr || !validateCidrOrIp(cidr)) {
      res.status(400).json({ success: false, error: 'A valid IP or CIDR is required' });
      return;
    }

    let expiresAt: Date | null = null;
    if (expiresAtInput) {
      expiresAt = new Date(expiresAtInput);
      if (Number.isNaN(expiresAt.getTime())) {
        res.status(400).json({ success: false, error: 'Invalid expiry date' });
        return;
      }
      if (expiresAt <= new Date()) {
        res.status(400).json({ success: false, error: 'Expiry date must be in the future' });
        return;
      }
    }

    const created = await createIpJailEntry({
      cidr,
      reason: reason || undefined,
      createdBy: req.session.admin?.id ?? null,
      expiresAt,
    });

    await logAudit(req, AuditActions.IP_JAIL_CREATE, {
      entityType: 'ip-jail',
      entityId: String(created.id),
      newValues: { cidr: created.cidr, expiresAt: created.expiresAt, reason: created.reason },
    });

    res.status(201).json({ success: true, data: created });
  } catch (error) {
    logger.error('Failed to create IP jail entry', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to create IP jail entry' });
  }
});

router.post('/:id/lift', async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid entry ID' });
      return;
    }
    const lifted = await liftIpJailEntry(id, req.session.admin?.id ?? null);
    if (!lifted) {
      res.status(404).json({ success: false, error: 'IP jail entry not found or already lifted' });
      return;
    }
    await logAudit(req, AuditActions.IP_JAIL_LIFT, {
      entityType: 'ip-jail',
      entityId: String(id),
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to lift IP jail entry', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to lift IP jail entry' });
  }
});

router.put('/:id', async (req: Request, res: Response) => {
  try {
    const id = parseInt(routeParam(req, 'id'), 10);
    if (Number.isNaN(id)) {
      res.status(400).json({ success: false, error: 'Invalid entry ID' });
      return;
    }

    const expiresAtInput = req.body?.expiresAt;
    let expiresAt: Date | null = null;
    if (expiresAtInput) {
      expiresAt = new Date(expiresAtInput);
      if (Number.isNaN(expiresAt.getTime())) {
        res.status(400).json({ success: false, error: 'Invalid expiry date' });
        return;
      }
      if (expiresAt <= new Date()) {
        res.status(400).json({ success: false, error: 'Expiry date must be in the future' });
        return;
      }
    }

    const updated = await updateIpJailExpiry(id, expiresAt);
    if (!updated) {
      res.status(404).json({ success: false, error: 'IP jail entry not found' });
      return;
    }
    await logAudit(req, AuditActions.IP_JAIL_UPDATE, {
      entityType: 'ip-jail',
      entityId: String(id),
      newValues: { expiresAt },
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to update IP jail entry', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to update IP jail entry' });
  }
});

export default router;
