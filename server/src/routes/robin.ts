/**
 * Robin email sending routes.
 */

import { Router, Request, Response } from 'express';
import { queueEmail, robinApiFailure, sendEmail } from '../services/robin-api.js';
import { requireAuth } from '../middleware/auth.js';
import { requireEditor } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { logger } from '../logger.js';

const router = Router();

// All routes require authentication and editor role
router.use(requireAuth);
router.use(requireEditor);

/**
 * POST /api/robin/send
 * Queue an email for delivery via Robin.
 */
router.post('/send', async (req: Request, res: Response) => {
  try {
    const { serviceId, ...casePayload } = req.body ?? {};
    const targetServiceId = typeof serviceId === 'string' && serviceId.trim() !== ''
      ? serviceId.trim()
      : undefined;
    
    // Log the action
    logAudit(req, AuditActions.EMAIL_SEND, {
      entityType: 'email',
      entityId: 'queued',
      newValues: {
        mail: casePayload.envelopes?.[0]?.mail,
        rcpt: casePayload.envelopes?.[0]?.rcpt,
        subject: casePayload.envelopes?.[0]?.subject,
      },
    });
    
    logger.info('Sending email via Robin', {
      mail: casePayload.envelopes?.[0]?.mail,
      rcptCount: casePayload.envelopes?.[0]?.rcpt?.length,
    });
    
    // Queue the email via Robin
    const result = await queueEmail(casePayload, targetServiceId);
    
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to send email', { error: (error as Error).message });
    const failure = robinApiFailure(error, 'Robin MTA API is unavailable. Email delivery is not available on this deployment.');
    res.status(failure?.status ?? 500).json({
      success: false,
      error: failure?.error ?? 'Failed to send email',
    });
  }
});

/**
 * POST /api/robin/send-direct
 * Send an email immediately (synchronously) via Robin.
 */
router.post('/send-direct', async (req: Request, res: Response) => {
  try {
    const { serviceId, ...casePayload } = req.body ?? {};
    const targetServiceId = typeof serviceId === 'string' && serviceId.trim() !== ''
      ? serviceId.trim()
      : undefined;
    
    // Log the action
    logAudit(req, AuditActions.EMAIL_SEND, {
      entityType: 'email',
      entityId: 'direct',
      newValues: {
        mail: casePayload.envelopes?.[0]?.mail,
        rcpt: casePayload.envelopes?.[0]?.rcpt,
        subject: casePayload.envelopes?.[0]?.subject,
      },
    });
    
    logger.info('Sending email directly via Robin', {
      mail: casePayload.envelopes?.[0]?.mail,
      rcptCount: casePayload.envelopes?.[0]?.rcpt?.length,
    });
    
    // Send immediately
    const result = await sendEmail(casePayload, targetServiceId);
    
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to send email directly', { error: (error as Error).message });
    const failure = robinApiFailure(error, 'Robin MTA API is unavailable. Email delivery is not available on this deployment.');
    res.status(failure?.status ?? 500).json({
      success: false,
      error: failure?.error ?? 'Failed to send email',
    });
  }
});

export default router;
