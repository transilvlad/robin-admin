import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireViewer } from '../middleware/rbac.js';
import { requireMailboxBackend } from '../middleware/mailboxes.js';
import { logAudit } from '../middleware/audit.js';
import {
  mailPolicyAvailable, listMailDomains, saveMailDomain, listSenderGrants,
  saveSenderGrant, revokeSenderGrant, MailPolicyInputError,
} from '../db/queries/mail-policy.js';
import { logger } from '../logger.js';

const router = Router();
router.use(requireAuth, requireMailboxBackend('users'));

router.get('/status', requireViewer, async (_req, res, next) => {
  try {
    res.json({ success: true, data: { available: await mailPolicyAvailable() } });
  } catch (error) { next(error); }
});

router.use(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!await mailPolicyAvailable()) {
      res.status(503).json({ success: false, error: 'Mail policy schema is not installed. Apply the suite mail-control migration first.' });
      return;
    }
    next();
  } catch (error) { next(error); }
});

function pagination(req: Request) {
  const page = Math.max(1, Number.parseInt(String(req.query.page), 10) || 1);
  const limit = Math.min(100, Math.max(1, Number.parseInt(String(req.query.limit), 10) || 50));
  return { page, limit };
}

router.get('/domains', requireViewer, async (req, res, next) => {
  try {
    const { page, limit } = pagination(req);
    const { rows, total } = await listMailDomains(page, limit);
    res.json({ success: true, data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.put('/domains', requireAdmin, async (req, res, next) => {
  try {
    const domain = await saveMailDomain(req.body);
    await logAudit(req, 'mail_policy.domain_save', { entityType: 'mail_domain', entityId: domain.domain, newValues: { ...domain } });
    res.json({ success: true, data: domain });
  } catch (error) { next(error); }
});

router.get('/grants', requireViewer, async (req, res, next) => {
  try {
    const { page, limit } = pagination(req);
    const { rows, total } = await listSenderGrants(page, limit);
    res.json({ success: true, data: rows, pagination: { page, limit, total, totalPages: Math.ceil(total / limit) } });
  } catch (error) { next(error); }
});

router.put('/grants', requireAdmin, async (req, res, next) => {
  try {
    const grant = await saveSenderGrant(req.body);
    await logAudit(req, 'mail_policy.sender_grant', { entityType: 'mail_sender_grant', entityId: `${grant.account}:${grant.address}`, newValues: { ...grant } });
    res.json({ success: true, data: grant });
  } catch (error) { next(error); }
});

router.delete('/grants', requireAdmin, async (req, res, next) => {
  try {
    if (!await revokeSenderGrant(req.body?.account, req.body?.address)) {
      res.status(404).json({ success: false, error: 'Sender grant not found' });
      return;
    }
    await logAudit(req, 'mail_policy.sender_revoke', { entityType: 'mail_sender_grant', oldValues: { account: req.body.account, address: req.body.address } });
    res.json({ success: true });
  } catch (error) { next(error); }
});

router.use((error: unknown, _req: Request, res: Response, next: NextFunction) => {
  if (error instanceof MailPolicyInputError) {
    logger.warn('Invalid mail policy request', { error: error.message });
    res.status(400).json({ success: false, error: error.message });
    return;
  }
  next(error);
});

export default router;
