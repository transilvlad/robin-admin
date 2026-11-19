import { createHash } from 'node:crypto';
import { config } from '../../config.js';
import { getClient } from '../../db/connection.js';
import { createAlertDelivery, listAlertWebhooks } from '../../db/queries/alerts.js';
import { getConfig } from '../../db/queries/config.js';
import type { AlertCatalogEntry, AlertWebhook, JsonRecord, ModuleAlertSource } from '../../types/alerts.js';
import { assertModuleRuntimeAccess, ModuleAccessError } from '../modules.js';
import { operationsPolicy } from '../operations-settings.js';
import {
  isModuleAlertSeverity, MODULE_ALERT_CATEGORY, MODULE_ALERT_LEVELS, MODULE_ALERT_SLUG, type ModuleAlertSeverity,
} from './module-alert-policy.js';
import { buildSentryAlertPayload } from './sentry.js';

const MAX_AGE_MS = 15 * 60_000;
const referenceValue = /^[A-Za-z0-9_.-]{1,96}$/;

export interface ModuleAlertEvent {
  id: string;
  category: string;
  severity: ModuleAlertSeverity;
  observedAt: string;
  resource: string;
  summary: string;
  reference: string;
}

export function moduleAlertPublisher(slug: string) {
  const publishers = config.moduleAlertPublishers ?? {};
  return Object.hasOwn(publishers, slug) ? publishers[slug] : undefined;
}

export function moduleAlertCatalog(): AlertCatalogEntry[] {
  return Object.entries(config.moduleAlertPublishers ?? {}).flatMap(([moduleSlug, publisher]) =>
    Object.entries(publisher.categories).map(([moduleCategory, definition]) => ({
      key: 'module_alert', moduleSlug, moduleCategory, label: definition.label,
      description: `Findings published by ${moduleSlug}.`,
      serviceTypes: ['monitoring'], unit: 'none', direction: 'boolean',
      defaultThreshold: null, minimum: null, maximum: null,
    })),
  );
}

export function parseModuleAlertEvent(input: unknown, now = Date.now()): ModuleAlertEvent | null {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const { id, category, severity, observedAt, resource, summary, reference } = input as Record<string, unknown>;
  if (
    Object.keys(input).length !== 7 || typeof id !== 'string' || !referenceValue.test(id)
    || typeof category !== 'string' || !MODULE_ALERT_CATEGORY.test(category) || !isModuleAlertSeverity(severity)
    || typeof resource !== 'string' || !/^[A-Za-z0-9_.:-]{1,64}$/.test(resource)
    || typeof summary !== 'string' || !summary.trim() || summary.length > 240
    || /[\p{Cc}\p{Cf}<>]|https?:\/\//iu.test(summary)
    || typeof reference !== 'string' || !referenceValue.test(reference)
    || typeof observedAt !== 'string'
    || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|\+00:00)$/.test(observedAt)
  ) return null;
  const time = Date.parse(observedAt);
  if (!Number.isFinite(time) || time < now - MAX_AGE_MS || time > now + 60_000) return null;
  return { id, category, severity, observedAt: new Date(time).toISOString(), resource, summary: summary.trim(), reference };
}

export async function authorizeModuleAlert(source: ModuleAlertSource) {
  const publisher = moduleAlertPublisher(source.slug);
  const category = publisher && Object.hasOwn(publisher.categories, source.category) ? publisher.categories[source.category] : null;
  if (
    !publisher || publisher.apiKeyId !== source.publisherKeyId || !category
    || !isModuleAlertSeverity(source.severity) || MODULE_ALERT_LEVELS[source.severity] > MODULE_ALERT_LEVELS[category.maxSeverity]
    || !(await getConfig()).modulesEnabled
  ) throw new ModuleAccessError('Module alert publisher is not authorized');
  const installed = await assertModuleRuntimeAccess(source.slug);
  if ((publisher.requirePaid && installed.tier !== 'paid') || !MODULE_ALERT_SLUG.test(installed.routeSlug)) {
    throw new ModuleAccessError('Module alert publisher is not authorized');
  }
  return { installed, link: publisher.link };
}

export function subscribesToModuleAlert(webhook: AlertWebhook, source: ModuleAlertSource, now = new Date()): boolean {
  return webhook.enabled && !(webhook.pausedAt && (!webhook.pausedUntil || webhook.pausedUntil > now))
    && webhook.subscriptions.some(item => item.alertType === 'module_alert'
      && item.enabled && item.moduleSlug === source.slug && item.moduleCategory === source.category);
}

function payloadFor(webhook: AlertWebhook, event: ModuleAlertEvent, id: string, path: string): JsonRecord | null {
  const url = config.publicBaseUrl + path;
  const summary = `${event.summary} · ${event.resource}`;
  if (webhook.adapter === 'sentry') {
    return buildSentryAlertPayload({
      alertKey: id, alertType: 'module_alert', eventKind: 'failure',
      title: summary, message: summary, severity: event.severity,
      context: { resource: event.resource, category: event.category }, linkPath: path, occurredAt: new Date(event.observedAt),
    });
  }
  if (webhook.adapter === 'slack') {
    return {
      text: summary.replaceAll('&', '&amp;'), mrkdwn: false,
      blocks: [
        { type: 'section', text: { type: 'plain_text', text: summary } },
        { type: 'actions', elements: [
          { type: 'button', text: { type: 'plain_text', text: 'Open investigation' }, url },
        ] },
      ],
    };
  }
  return {
    version: 1, eventKind: 'failure', alertType: 'module_alert', summary, category: event.category,
    observedAt: event.observedAt, resource: event.resource, investigationUrl: url, severity: event.severity,
  };
}

export async function acceptModuleAlertEvent(source: ModuleAlertSource, event: ModuleAlertEvent): Promise<void> {
  const { installed, link } = await authorizeModuleAlert(source);
  const path = `/modules/${installed.routeSlug}/${link.path}?${new URLSearchParams({ [link.parameter]: event.reference })}`;
  const id = createHash('sha256').update(JSON.stringify([source.slug, event.id])).digest('hex');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    // Receipts also cover events suppressed by current operator policy.
    await client.query("DELETE FROM module_alert_receipts WHERE received_at < CURRENT_TIMESTAMP - INTERVAL '1 day'");
    const receipt = await client.query(
      'INSERT INTO module_alert_receipts (module_slug,event_id) VALUES ($1,$2) ON CONFLICT DO NOTHING',
      [source.slug, event.id],
    );
    if (receipt.rowCount && operationsPolicy().alertsEnabled) {
      for (const webhook of await listAlertWebhooks(client)) {
        if (!subscribesToModuleAlert(webhook, source)) continue;
        const payload = payloadFor(webhook, event, id, path);
        if (!payload) continue;
        await createAlertDelivery({
          dedupeKey: `module:${id}:${webhook.id}`, webhookId: webhook.id, webhookName: webhook.name,
          fleetServiceId: null, serviceId: `module:${id}`, serviceName: event.resource, serviceType: 'monitoring',
          alertType: 'module_alert', eventKind: 'failure', adapter: webhook.adapter, payload,
          moduleAlertSource: source, client,
        });
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
