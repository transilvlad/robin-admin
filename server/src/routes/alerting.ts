import { randomUUID } from 'crypto';
import { Router, type Request, type Response } from 'express';
import { config } from '../config.js';
import {
  createAlertDelivery,
  createAlertWebhook,
  deleteAlertWebhook,
  getAlertRuntimeSummary,
  getAlertWebhook,
  listAlertDeliveries,
  listAlertWebhooks,
  pauseAlertWebhook,
  resumeAlertWebhook,
  updateAlertWebhook,
} from '../db/queries/alerts.js';
import { getCurrentAdmin, requireAuth } from '../middleware/auth.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { requireAdmin } from '../middleware/rbac.js';
import { validateOutboundUrl } from '../middleware/security.js';
import { ALERT_CATALOG, defaultAlertSubscriptions, normalizeAlertSubscriptions } from '../services/alerts/alert-types.js';
import { alertDeliveryPolicy } from '../services/alerts/delivery-worker.js';
import { operationsPolicy } from '../services/operations-settings.js';
import type { AlertWebhookAdapter, JsonRecord } from '../types/alerts.js';
import { logger } from '../logger.js';
import { getConfig } from '../db/queries/config.js';
import { routeParam } from './params.js';
import {
  createTelemetryAlertRule,
  listTelemetryAlertRules,
  updateTelemetryAlertRule,
} from '../db/queries/telemetry-alert-rules.js';
import { deleteTelemetryAlertRuleWithRecoveries, previewTelemetryAlertRule } from '../services/alerts/telemetry-rules.js';
import { buildSentryAlertPayload, parseSentryDsn } from '../services/alerts/sentry.js';
import { TelemetryQueryError } from '../services/telemetry/store-client.js';
import {
  TELEMETRY_ALERT_COMPARATORS,
  type TelemetryAlertComparator,
  type TelemetryAlertRuleInput,
} from '../types/telemetry-alerts.js';

const router = Router();

function actorId(req: Request): number | null {
  const admin = getCurrentAdmin(req);
  return admin?.adminId && admin.adminId > 0 ? admin.adminId : null;
}

function parseId(value: string): number | null {
  const id = Number.parseInt(value, 10);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

function requiredString(value: unknown, field: string, maximum = 120): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${field} is required`);
  }
  const result = value.trim();
  if (result.length > maximum) {
    throw new Error(`${field} must be ${maximum} characters or fewer`);
  }
  return result;
}

function optionalString(value: unknown, field: string, maximum: number): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === '') return null;
  if (typeof value !== 'string') throw new Error(`${field} must be a string`);
  const result = value.trim();
  if (result.length > maximum) throw new Error(`${field} must be ${maximum} characters or fewer`);
  return result || null;
}

function booleanValue(value: unknown, field: string, fallback?: boolean): boolean {
  if (value === undefined && fallback !== undefined) return fallback;
  if (typeof value !== 'boolean') throw new Error(`${field} must be boolean`);
  return value;
}

function integerValue(value: unknown, field: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(`${field} must be an integer from ${minimum} to ${maximum}`);
  }
  return value;
}

function parseAdapter(value: unknown): AlertWebhookAdapter {
  if (value === 'slack' || value === 'generic' || value === 'sentry') return value;
  throw new Error('adapter must be slack, generic or sentry');
}

/** A Sentry destination's URL is its DSN; the other destinations use a webhook URL. */
function validateDestinationUrl(adapter: AlertWebhookAdapter, value: string): void {
  if (adapter === 'sentry') {
    if (!parseSentryDsn(value)) throw new Error('webhookUrl must be a Sentry DSN (https://<key>@<host>/<project>)');
    return;
  }
  validateWebhookUrl(value);
}

function parseSentrySettings(body: Record<string, unknown>): {
  sentryOrg?: string | null;
  sentryApiUrl?: string | null;
  sentryApiToken?: string | null;
} {
  const sentryOrg = optionalString(body.sentryOrg, 'sentryOrg', 100);
  if (sentryOrg && !/^[a-z0-9][a-z0-9_-]*$/i.test(sentryOrg)) throw new Error('sentryOrg must be a Sentry organization slug');
  const sentryApiUrl = optionalString(body.sentryApiUrl, 'sentryApiUrl', 200);
  if (sentryApiUrl) {
    let url: URL;
    try {
      url = new URL(sentryApiUrl);
    } catch {
      throw new Error('sentryApiUrl must be an https URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) {
      throw new Error('sentryApiUrl must be an https URL without credentials or query');
    }
    const urlError = validateOutboundUrl(sentryApiUrl, false);
    if (urlError) throw new Error(`sentryApiUrl is invalid: ${urlError}`);
  }
  const sentryApiToken = optionalString(body.sentryApiToken, 'sentryApiToken', 500);
  return {
    sentryOrg,
    sentryApiUrl: sentryApiUrl === undefined ? undefined : sentryApiUrl?.replace(/\/$/, '') ?? null,
    sentryApiToken,
  };
}

function validateWebhookUrl(rawUrl: string): void {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('webhookUrl must be a valid URL');
  }
  if (url.protocol !== 'https:') throw new Error('webhookUrl must use HTTPS');
  if (url.username || url.password) throw new Error('webhookUrl must not contain credentials');
  const error = validateOutboundUrl(rawUrl, false);
  if (error) throw new Error(error);
}

function parseRepeatInterval(value: unknown, fallback?: number | null): number | null | undefined {
  if (value === undefined) return fallback;
  if (value === null) return null;
  return integerValue(value, 'repeatIntervalSeconds', 300, 2592000);
}

function parsePauseEnd(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  const date = new Date(String(value));
  if (Number.isNaN(date.getTime()) || date <= new Date()) {
    throw new Error('pausedUntil must be a future date');
  }
  return date;
}

function samplePayload(webhook: { id: number; name: string; adapter: AlertWebhookAdapter }): JsonRecord {
  if (webhook.adapter === 'sentry') {
    return buildSentryAlertPayload({
      alertKey: `test:${webhook.id}`,
      alertType: 'availability',
      eventKind: 'test',
      title: 'Robin Admin test alert',
      message: `A test alert from Robin Admin destination "${webhook.name}"`,
      severity: 'info',
      tags: { service: 'sample-service' },
      context: { destination: webhook.name },
      linkPath: '/administration/alerts',
      occurredAt: new Date(),
    })!;
  }
  const detail = {
    version: 1,
    notificationId: `preview-${webhook.id}`,
    instance: operationsPolicy().alertInstanceName,
    eventKind: 'test',
    alertType: 'availability',
    summary: 'Robin Admin webhook test',
    service: { id: 'sample-service', name: 'Sample service', type: 'robin' },
    evidence: { value: false, threshold: null, unit: 'none', observedAt: new Date().toISOString() },
    webhook: { id: webhook.id, name: webhook.name },
  };
  return webhook.adapter === 'slack'
    ? {
        text: detail.summary,
        blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${detail.summary}*\nSample service is unreachable.` } }],
        robin_alert: detail,
      }
    : detail;
}

function routeError(res: Response, message: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : message;
  if (/(required|must|invalid|outside|future|subscriptions)/i.test(detail)) {
    res.status(400).json({ success: false, error: detail });
    return;
  }
  logger.error(message, { error: detail });
  res.status(500).json({ success: false, error: message });
}

router.get('/alert-webhooks', requireAuth, requireAdmin, async (_req, res) => {
  try {
    const [webhooks, runtime, adminConfig] = await Promise.all([listAlertWebhooks(), getAlertRuntimeSummary(), getConfig()]);
    res.json({
      success: true,
      data: {
        webhooks,
        catalog: ALERT_CATALOG,
        runtime: {
          ...runtime,
          enabled: adminConfig.alertsEnabled,
          monitoringEnabled: adminConfig.monitoringEnabled,
          evaluationIntervalMs: adminConfig.alertEvaluationIntervalMs,
          deliveryConcurrency: adminConfig.alertDeliveryConcurrency,
          instanceName: adminConfig.alertInstanceName,
          encryptionKeyConfigured: config.encryptionKeyConfigured,
          deliveryRetentionDays: adminConfig.alertDeliveryRetentionDays,
          ...alertDeliveryPolicy(),
        },
      },
    });
  } catch (error) {
    routeError(res, 'Failed to load alert webhooks', error);
  }
});

router.post('/alert-webhooks', requireAuth, requireAdmin, async (req, res) => {
  try {
    const webhookUrl = requiredString(req.body.webhookUrl, 'webhookUrl', 4096);
    const adapter = parseAdapter(req.body.adapter);
    validateDestinationUrl(adapter, webhookUrl);
    const sentrySettings = adapter === 'sentry' ? parseSentrySettings(req.body) : {};
    const webhook = await createAlertWebhook({
      name: requiredString(req.body.name, 'name'),
      adapter,
      webhookUrl,
      sentryOrg: sentrySettings.sentryOrg ?? null,
      sentryApiUrl: sentrySettings.sentryApiUrl ?? null,
      sentryApiToken: sentrySettings.sentryApiToken ?? null,
      enabled: booleanValue(req.body.enabled, 'enabled', false),
      subscriptions: req.body.subscriptions === undefined
        ? defaultAlertSubscriptions()
        : normalizeAlertSubscriptions(req.body.subscriptions),
      consecutiveFailures: req.body.consecutiveFailures === undefined
        ? 3
        : integerValue(req.body.consecutiveFailures, 'consecutiveFailures', 1, 20),
      repeatIntervalSeconds: parseRepeatInterval(req.body.repeatIntervalSeconds, 14400),
      notifyRecovery: booleanValue(req.body.notifyRecovery, 'notifyRecovery', true),
      actorId: actorId(req),
    });
    await logAudit(req, AuditActions.ALERT_WEBHOOK_CREATE, {
      entityType: 'alert_webhook',
      entityId: String(webhook.id),
      newValues: { ...webhook },
    });
    res.status(201).json({ success: true, data: webhook });
  } catch (error) {
    routeError(res, 'Failed to create alert webhook', error);
  }
});

router.patch('/alert-webhooks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseId(routeParam(req, 'id'));
    if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook ID' });
    const existing = await getAlertWebhook(id);
    if (!existing) return res.status(404).json({ success: false, error: 'Webhook not found' });
    const adapter = req.body.adapter === undefined ? existing.adapter : parseAdapter(req.body.adapter);
    const webhookUrl = optionalString(req.body.webhookUrl, 'webhookUrl', 4096);
    if (webhookUrl) validateDestinationUrl(adapter, webhookUrl);
    else if (adapter !== existing.adapter) throw new Error('webhookUrl is required when changing the destination type');
    const sentrySettings = adapter === 'sentry' ? parseSentrySettings(req.body) : {};
    const webhook = await updateAlertWebhook(id, {
      name: optionalString(req.body.name, 'name', 120) ?? undefined,
      adapter: req.body.adapter === undefined ? undefined : adapter,
      webhookUrl: webhookUrl ?? undefined,
      ...sentrySettings,
      enabled: req.body.enabled === undefined ? undefined : booleanValue(req.body.enabled, 'enabled'),
      subscriptions: req.body.subscriptions === undefined ? undefined : normalizeAlertSubscriptions(req.body.subscriptions),
      consecutiveFailures: req.body.consecutiveFailures === undefined
        ? undefined
        : integerValue(req.body.consecutiveFailures, 'consecutiveFailures', 1, 20),
      repeatIntervalSeconds: parseRepeatInterval(req.body.repeatIntervalSeconds),
      notifyRecovery: req.body.notifyRecovery === undefined
        ? undefined
        : booleanValue(req.body.notifyRecovery, 'notifyRecovery'),
      actorId: actorId(req),
    });
    if (!webhook) return res.status(404).json({ success: false, error: 'Webhook not found' });
    await logAudit(req, AuditActions.ALERT_WEBHOOK_UPDATE, {
      entityType: 'alert_webhook',
      entityId: String(id),
      newValues: { ...webhook },
    });
    res.json({ success: true, data: webhook });
  } catch (error) {
    routeError(res, 'Failed to update alert webhook', error);
  }
});

router.delete('/alert-webhooks/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseId(routeParam(req, 'id'));
    if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook ID' });
    if (!(await deleteAlertWebhook(id))) {
      return res.status(404).json({ success: false, error: 'Webhook not found' });
    }
    await logAudit(req, AuditActions.ALERT_WEBHOOK_DELETE, {
      entityType: 'alert_webhook',
      entityId: String(id),
    });
    res.status(204).end();
  } catch (error) {
    routeError(res, 'Failed to delete alert webhook', error);
  }
});

router.post('/alert-webhooks/:id/pause', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseId(routeParam(req, 'id'));
    if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook ID' });
    const webhook = await pauseAlertWebhook(
      id,
      parsePauseEnd(req.body.pausedUntil),
      optionalString(req.body.reason, 'reason', 500) ?? null
    );
    if (!webhook) return res.status(404).json({ success: false, error: 'Webhook not found' });
    await logAudit(req, AuditActions.ALERT_WEBHOOK_PAUSE, {
      entityType: 'alert_webhook',
      entityId: String(id),
      newValues: { pausedUntil: webhook.pausedUntil, pauseReason: webhook.pauseReason },
    });
    res.json({ success: true, data: webhook });
  } catch (error) {
    routeError(res, 'Failed to pause alert webhook', error);
  }
});

router.post('/alert-webhooks/:id/resume', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseId(routeParam(req, 'id'));
    if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook ID' });
    const webhook = await resumeAlertWebhook(id);
    if (!webhook) return res.status(404).json({ success: false, error: 'Webhook not found' });
    await logAudit(req, AuditActions.ALERT_WEBHOOK_RESUME, {
      entityType: 'alert_webhook',
      entityId: String(id),
    });
    res.json({ success: true, data: webhook });
  } catch (error) {
    routeError(res, 'Failed to resume alert webhook', error);
  }
});

router.post('/alert-webhooks/:id/preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseId(routeParam(req, 'id'));
    if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook ID' });
    const webhook = await getAlertWebhook(id);
    if (!webhook) return res.status(404).json({ success: false, error: 'Webhook not found' });
    res.json({ success: true, data: { payload: samplePayload(webhook), networkEffect: false } });
  } catch (error) {
    routeError(res, 'Failed to preview alert webhook', error);
  }
});

router.post('/alert-webhooks/:id/test', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseId(routeParam(req, 'id'));
    if (!id) return res.status(400).json({ success: false, error: 'Invalid webhook ID' });
    if (req.body.confirmLiveSend !== true) {
      return res.status(400).json({ success: false, error: 'confirmLiveSend must be true' });
    }
    if (!operationsPolicy().alertsEnabled) {
      return res.status(409).json({ success: false, error: 'Alert delivery is disabled' });
    }
    const webhook = await getAlertWebhook(id);
    if (!webhook) return res.status(404).json({ success: false, error: 'Webhook not found' });
    if (!webhook.enabled || !webhook.hasSecret) {
      return res.status(409).json({ success: false, error: 'Webhook must be enabled and have a URL before testing' });
    }
    const paused = webhook.pausedAt && (!webhook.pausedUntil || webhook.pausedUntil > new Date());
    if (paused) return res.status(409).json({ success: false, error: 'Resume the webhook before testing' });
    const delivery = await createAlertDelivery({
      dedupeKey: `test:${webhook.id}:${randomUUID()}`,
      webhookId: webhook.id,
      webhookName: webhook.name,
      fleetServiceId: null,
      serviceId: 'sample-service',
      serviceName: 'Sample service',
      serviceType: 'robin',
      alertType: 'availability',
      eventKind: 'test',
      adapter: webhook.adapter,
      payload: samplePayload(webhook),
    });
    await logAudit(req, AuditActions.ALERT_WEBHOOK_TEST, {
      entityType: 'alert_delivery',
      entityId: String(delivery.id),
      newValues: { webhookId: webhook.id, status: delivery.status },
    });
    res.status(202).json({ success: true, data: delivery });
  } catch (error) {
    routeError(res, 'Failed to queue alert webhook test', error);
  }
});

router.get('/alert-deliveries', requireAuth, requireAdmin, async (req, res) => {
  try {
    const requested = Number(req.query.limit ?? 50);
    const limit = Number.isFinite(requested) ? Math.trunc(requested) : 50;
    res.json({ success: true, data: await listAlertDeliveries(limit) });
  } catch (error) {
    routeError(res, 'Failed to load alert deliveries', error);
  }
});

// ── Telemetry alert rules ───────────────────────────────────────────────

function parseComparator(value: unknown): TelemetryAlertComparator {
  if (TELEMETRY_ALERT_COMPARATORS.includes(value as TelemetryAlertComparator)) return value as TelemetryAlertComparator;
  throw new Error(`comparator must be one of ${TELEMETRY_ALERT_COMPARATORS.join(' ')}`);
}

function parseThreshold(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error('threshold must be a number');
  return value;
}

function parseRuleQuery(value: unknown): string {
  return requiredString(value, 'query', 4000);
}

function parseRuleInput(body: Record<string, unknown>): TelemetryAlertRuleInput {
  const severity = body.severity ?? 'critical';
  if (severity !== 'warning' && severity !== 'critical') throw new Error('severity must be warning or critical');
  return {
    name: requiredString(body.name, 'name'),
    description: optionalString(body.description, 'description', 500) ?? null,
    query: parseRuleQuery(body.query),
    comparator: parseComparator(body.comparator),
    threshold: parseThreshold(body.threshold),
    forSeconds: body.forSeconds === undefined ? 300 : integerValue(body.forSeconds, 'forSeconds', 0, 86400),
    severity,
    enabled: booleanValue(body.enabled, 'enabled', true),
  };
}

router.get('/telemetry-alert-rules', requireAuth, requireAdmin, async (_req, res) => {
  try {
    res.json({ success: true, data: await listTelemetryAlertRules() });
  } catch (error) {
    routeError(res, 'Failed to load telemetry alert rules', error);
  }
});

router.post('/telemetry-alert-rules/preview', requireAuth, requireAdmin, async (req, res) => {
  try {
    const preview = await previewTelemetryAlertRule({
      query: parseRuleQuery(req.body.query),
      comparator: parseComparator(req.body.comparator),
      threshold: parseThreshold(req.body.threshold),
    });
    res.json({ success: true, data: preview });
  } catch (error) {
    if (error instanceof TelemetryQueryError) {
      res.status(400).json({ success: false, error: error.message });
      return;
    }
    routeError(res, 'Failed to preview telemetry alert rule', error);
  }
});

router.post('/telemetry-alert-rules', requireAuth, requireAdmin, async (req, res) => {
  try {
    const rule = await createTelemetryAlertRule(parseRuleInput(req.body));
    await logAudit(req, AuditActions.TELEMETRY_ALERT_RULE_CREATE, {
      entityType: 'telemetry_alert_rule',
      entityId: String(rule.id),
      newValues: { ...rule },
    });
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    routeError(res, 'Failed to create telemetry alert rule', error);
  }
});

router.put('/telemetry-alert-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseId(routeParam(req, 'id'));
    if (!id) return res.status(400).json({ success: false, error: 'Invalid rule ID' });
    const rule = await updateTelemetryAlertRule(id, parseRuleInput(req.body));
    if (!rule) return res.status(404).json({ success: false, error: 'Rule not found' });
    await logAudit(req, AuditActions.TELEMETRY_ALERT_RULE_UPDATE, {
      entityType: 'telemetry_alert_rule',
      entityId: String(id),
      newValues: { ...rule },
    });
    res.json({ success: true, data: rule });
  } catch (error) {
    routeError(res, 'Failed to update telemetry alert rule', error);
  }
});

router.delete('/telemetry-alert-rules/:id', requireAuth, requireAdmin, async (req, res) => {
  try {
    const id = parseId(routeParam(req, 'id'));
    if (!id) return res.status(400).json({ success: false, error: 'Invalid rule ID' });
    if (!(await deleteTelemetryAlertRuleWithRecoveries(id))) return res.status(404).json({ success: false, error: 'Rule not found' });
    await logAudit(req, AuditActions.TELEMETRY_ALERT_RULE_DELETE, { entityType: 'telemetry_alert_rule', entityId: String(id) });
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete telemetry alert rule', error);
  }
});

export default router;
