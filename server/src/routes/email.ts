import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import {
  enqueueEmailDelivery,
  confirmStatusPageSubscriber,
  createOrUpdatePendingStatusSubscriber,
  deleteEmailRelay,
  deleteStatusPageSubscriber,
  getEmailTransportAdminView,
  listAdminEmailSubscriptions,
  listEmailDeliveries,
  listStatusPageSubscribers,
  unsubscribeStatusPageSubscriber,
  updateAdminEmailSubscription,
  updateEmailSenderProfile,
  upsertEmailRelay,
} from '../db/queries/email.js';
import {
  EMAIL_RELAY_TYPES,
  EMAIL_SENDER_PROFILE_KEYS,
  EMAIL_SMTP_SECURITY,
  EMAIL_TLS_MODES,
  type EmailRelayType,
  type EmailSenderProfileKey,
  type EmailSmtpSecurity,
  type EmailTlsMode,
} from '../types/email.js';
import { enqueueStatusSubscriptionConfirmation } from '../services/email/messages.js';
import { logger } from '../logger.js';
import { routeParam } from './params.js';
import { config } from '../config.js';
import { getStatusPageSettings } from '../db/queries/status-page.js';

const router = Router();

router.get('/admin/transport', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getEmailTransportAdminView() });
  } catch (error) {
    routeError(res, 'Failed to load email delivery settings', error);
  }
});

router.get('/admin/notification-recipients', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listAdminEmailSubscriptions() });
  } catch (error) {
    routeError(res, 'Failed to load notification recipients', error);
  }
});

router.get('/admin/status-subscribers', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listStatusPageSubscribers() });
  } catch (error) {
    routeError(res, 'Failed to load status page subscribers', error);
  }
});

router.get('/admin/deliveries', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listEmailDeliveries(100) });
  } catch (error) {
    routeError(res, 'Failed to load email delivery history', error);
  }
});

router.post('/admin/relays', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const relay = await upsertEmailRelay({
      id: req.body.id ?? null,
      name: parseRequiredString(req.body.name, 'name'),
      relayType: parseRelayType(req.body.relayType),
      enabled: parseBoolean(req.body.enabled, 'enabled') ?? true,
      priority: parseNumber(req.body.priority ?? 100, 'priority', 0, 10000),
      smtpHost: parseOptionalString(req.body.smtpHost, 'smtpHost') ?? null,
      smtpPort: parseOptionalNumber(req.body.smtpPort, 'smtpPort', 1, 65535) ?? null,
      smtpSecurity: parseSmtpSecurity(req.body.smtpSecurity ?? 'starttls'),
      tlsMode: parseTlsMode(req.body.tlsMode ?? 'strict'),
      username: parseOptionalString(req.body.username, 'username') ?? null,
      password: req.body.password === undefined ? undefined : parseOptionalString(req.body.password, 'password'),
      robinServiceId: parseOptionalString(req.body.robinServiceId, 'robinServiceId') ?? null,
      postfixServiceId: parseOptionalString(req.body.postfixServiceId, 'postfixServiceId') ?? null,
    });
    res.status(req.body.id ? 200 : 201).json({ success: true, data: relay });
  } catch (error) {
    routeError(res, 'Failed to save email relay', error);
  }
});

router.delete('/admin/relays/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteEmailRelay(Number(routeParam(req, 'id')));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Email relay not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete email relay', error);
  }
});

router.put('/admin/senders/:profileKey', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const profile = await updateEmailSenderProfile({
      profileKey: parseSenderProfileKey(routeParam(req, 'profileKey')),
      fromName: parseRequiredString(req.body.fromName, 'fromName'),
      fromEmail: parseEmail(req.body.fromEmail, 'fromEmail'),
      replyTo: parseOptionalEmail(req.body.replyTo, 'replyTo'),
      envelopeFrom: parseOptionalEmail(req.body.envelopeFrom, 'envelopeFrom'),
      enabled: parseBoolean(req.body.enabled, 'enabled') ?? true,
      relayIds: parseIdArray(req.body.relayIds, 'relayIds'),
    });
    res.json({ success: true, data: profile });
  } catch (error) {
    routeError(res, 'Failed to save sender profile', error);
  }
});

router.put('/admin/notification-recipients/:adminId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const subscription = await updateAdminEmailSubscription({
      adminId: parseNumber(routeParam(req, 'adminId'), 'adminId', 1, 2_147_483_647),
      monitoringIssueOpened: parseBoolean(req.body.monitoringIssueOpened, 'monitoringIssueOpened') ?? false,
      monitoringIssueRecovered: parseBoolean(req.body.monitoringIssueRecovered, 'monitoringIssueRecovered') ?? false,
      statusPageReports: parseBoolean(req.body.statusPageReports, 'statusPageReports') ?? false,
      emailDeliveryFailure: parseBoolean(req.body.emailDeliveryFailure, 'emailDeliveryFailure') ?? false,
    });
    res.json({ success: true, data: subscription });
  } catch (error) {
    routeError(res, 'Failed to save admin subscription', error);
  }
});

router.delete('/admin/status-subscribers/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteStatusPageSubscriber(Number(routeParam(req, 'id')));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Subscriber not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete subscriber', error);
  }
});

router.post('/admin/test', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const recipientEmail = parseOptionalEmail(req.body.recipientEmail, 'recipientEmail') ?? req.session.admin?.email;
    if (!recipientEmail) throw new Error('recipientEmail is required');
    const delivery = await enqueueEmailDelivery({
      purpose: 'test',
      senderProfileKey: parseSenderProfileKey(req.body.profileKey ?? 'system'),
      recipientEmail,
      recipientKind: 'admin',
      subject: parseOptionalString(req.body.subject, 'subject') ?? 'Robin Admin test email',
      textBody: 'This is a Robin Admin outbound email delivery test.',
      metadata: { requestedByAdminId: req.session.admin?.id ?? null },
    });
    res.status(202).json({ success: true, data: delivery });
  } catch (error) {
    routeError(res, 'Failed to enqueue test email', error);
  }
});

router.post('/public/status-subscriptions', async (req: Request, res: Response) => {
  try {
    const settings = await getStatusPageSettings();
    if (!settings.published || !settings.subscribable) {
      res.status(403).json({ success: false, error: 'Status page subscriptions are not enabled.' });
      return;
    }
    const email = parseEmail(req.body.email, 'email');
    const allComponents = parseBoolean(req.body.allComponents, 'allComponents') ?? true;
    const componentIds = parseIdArray(req.body.componentIds, 'componentIds');
    const { subscriber, token, sendConfirmation } = await createOrUpdatePendingStatusSubscriber({ email, allComponents, componentIds });
    if (sendConfirmation && token) {
      await enqueueStatusSubscriptionConfirmation({
        subscriber,
        token,
        baseUrl: config.publicBaseUrl,
      });
    }
    res.status(202).json({ success: true, message: 'If confirmation is needed, check your email.' });
  } catch (error) {
    routeError(res, 'Failed to create status page subscription', error);
  }
});

router.post('/public/status-subscriptions/confirm', async (req: Request, res: Response) => {
  try {
    const confirmed = await confirmStatusPageSubscriber(parseRequiredString(req.body.token, 'token'));
    res.json({ success: true, data: { confirmed } });
  } catch (error) {
    routeError(res, 'Failed to confirm subscription', error);
  }
});

router.post('/public/status-subscriptions/unsubscribe', async (req: Request, res: Response) => {
  try {
    const unsubscribed = await unsubscribeStatusPageSubscriber(parseRequiredString(req.body.token, 'token'));
    res.json({ success: true, data: { unsubscribed } });
  } catch (error) {
    routeError(res, 'Failed to unsubscribe', error);
  }
});

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${fieldName} is required`);
  return value.trim();
}

function parseOptionalString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseEmail(value: unknown, fieldName: string): string {
  const email = parseRequiredString(value, fieldName).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`${fieldName} must be a valid email address`);
  return email;
}

function parseOptionalEmail(value: unknown, fieldName: string): string | null {
  const parsed = parseOptionalString(value, fieldName);
  if (!parsed) return null;
  return parseEmail(parsed, fieldName);
}

function parseBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`${fieldName} must be true or false`);
}

function parseNumber(value: unknown, fieldName: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseOptionalNumber(value: unknown, fieldName: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseNumber(value, fieldName, min, max);
}

function parseIdArray(value: unknown, fieldName: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  return value.map((entry) => parseNumber(entry, fieldName, 1, 2_147_483_647));
}

function parseRelayType(value: unknown): EmailRelayType {
  if (EMAIL_RELAY_TYPES.includes(value as EmailRelayType)) return value as EmailRelayType;
  throw new Error(`relayType must be one of: ${EMAIL_RELAY_TYPES.join(', ')}`);
}

function parseSmtpSecurity(value: unknown): EmailSmtpSecurity {
  if (EMAIL_SMTP_SECURITY.includes(value as EmailSmtpSecurity)) return value as EmailSmtpSecurity;
  throw new Error(`smtpSecurity must be one of: ${EMAIL_SMTP_SECURITY.join(', ')}`);
}

function parseTlsMode(value: unknown): EmailTlsMode {
  if (EMAIL_TLS_MODES.includes(value as EmailTlsMode)) return value as EmailTlsMode;
  throw new Error(`tlsMode must be one of: ${EMAIL_TLS_MODES.join(', ')}`);
}

function parseSenderProfileKey(value: unknown): EmailSenderProfileKey {
  if (EMAIL_SENDER_PROFILE_KEYS.includes(value as EmailSenderProfileKey)) return value as EmailSenderProfileKey;
  throw new Error(`profileKey must be one of: ${EMAIL_SENDER_PROFILE_KEYS.join(', ')}`);
}

function routeError(res: Response, message: string, error: unknown): void {
  const detail = (error as Error).message;
  if (detail.includes('required') || detail.includes('must be') || detail.includes('one of')) {
    res.status(400).json({ success: false, error: detail });
    return;
  }
  logger.error(message, { error: detail });
  res.status(500).json({ success: false, error: message });
}

export default router;
