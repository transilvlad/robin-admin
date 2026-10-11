import { createAlertDelivery } from '../../db/queries/alerts.js';
import { listAdminEmailSubscriptions } from '../../db/queries/email.js';
import { query } from '../../db/connection.js';
import { enqueueMonitoringIssueAdminEmail } from '../email/messages.js';
import type { AlertWebhookAdapter, JsonRecord } from '../../types/alerts.js';
import type { MonitoringIssue } from '../../types/monitoring.js';
import { buildSentryAlertPayload } from '../alerts/sentry.js';

interface WebhookRow {
  id: number;
  name: string;
  adapter: AlertWebhookAdapter;
  subscriptions_json: unknown;
  notify_recovery: boolean;
}

export async function deliverMonitoringLocationIssue(input: {
  issueId: number;
  locationId: number;
  locationName: string;
  summary: string;
  openedAt: Date;
  eventKind: 'failure' | 'recovery';
}): Promise<void> {
  const enabled = await query<{ value: string }>(
    `SELECT value FROM admin_config WHERE key = 'alertsEnabled'`,
  );
  if (enabled.rows[0]?.value !== 'true') return;
  const webhooks = await query<WebhookRow>(
    `SELECT id, name, adapter, subscriptions_json, notify_recovery
     FROM alert_webhooks
     WHERE enabled = true AND encrypted_url IS NOT NULL
       AND (paused_at IS NULL OR (paused_until IS NOT NULL AND paused_until <= CURRENT_TIMESTAMP))
     ORDER BY id`,
  );
  const subscribed = webhooks.rows.filter(webhook =>
    (input.eventKind !== 'recovery' || webhook.notify_recovery)
    && Array.isArray(webhook.subscriptions_json)
    && webhook.subscriptions_json.some(value => value && typeof value === 'object'
      && (value as { alertType?: unknown }).alertType === 'monitoring_issue'
      && (value as { enabled?: unknown }).enabled === true));
  const payload = {
    version: 1,
    eventKind: input.eventKind,
    alertType: 'monitoring_issue',
    summary: input.summary,
    issue: { id: input.issueId, status: input.eventKind === 'recovery' ? 'closed' : 'open' },
    service: {
      id: `monitoring-location-${input.locationId}`,
      name: input.locationName,
      type: 'monitoring',
    },
    monitoring: {
      locationId: input.locationId,
      locationName: input.locationName,
      status: input.eventKind === 'recovery' ? 'up' : 'down',
      error: input.eventKind === 'recovery' ? null : input.summary,
      observedAt: input.openedAt.toISOString(),
    },
  };
  const payloadFor = (adapter: AlertWebhookAdapter): JsonRecord | null => {
    if (adapter === 'sentry') {
      return buildSentryAlertPayload({
        alertKey: `monitoring:location:${input.locationId}`,
        alertType: 'monitoring_issue',
        eventKind: input.eventKind,
        title: `Probe location ${input.locationName} is not reporting`,
        message: input.summary,
        severity: 'critical',
        tags: { location: input.locationName },
        context: { locationId: input.locationId, issueId: input.issueId, openedAt: input.openedAt.toISOString() },
        linkPath: '/monitoring',
        occurredAt: new Date(),
      });
    }
    return adapter === 'slack'
      ? { text: input.summary, blocks: [{ type: 'section', text: { type: 'mrkdwn', text: `*${input.summary}*` } }], robin_alert: payload }
      : payload;
  };
  await Promise.all(subscribed
    .map(webhook => ({ webhook, body: payloadFor(webhook.adapter) }))
    .filter((item): item is { webhook: WebhookRow; body: JsonRecord } => item.body !== null)
    .map(({ webhook, body }) => createAlertDelivery({
    dedupeKey: `monitoring-location:${input.issueId}:${input.eventKind}:${webhook.id}`,
    webhookId: webhook.id,
    webhookName: webhook.name,
    fleetServiceId: null,
    monitoringIssueId: null,
    serviceId: `monitoring-location-${input.locationId}`,
    serviceName: input.locationName,
    serviceType: 'monitoring',
    alertType: 'monitoring_issue',
    eventKind: input.eventKind,
    adapter: webhook.adapter,
    payload: body,
  })));
  const admins = await listAdminEmailSubscriptions();
  const subscribedAdmins = admins.filter(admin => !admin.disabled && (
    input.eventKind === 'failure' ? admin.monitoringIssueOpened : admin.monitoringIssueRecovered
  ));
  const issue: MonitoringIssue = {
    id: input.issueId,
    checkId: 0,
    checkName: input.locationName,
    targetName: 'Probe locations',
    status: input.eventKind === 'recovery' ? 'closed' : 'open',
    severity: 'critical',
    summary: input.summary,
    details: { locationId: input.locationId },
    openedAt: input.openedAt,
    closedAt: input.eventKind === 'recovery' ? input.openedAt : null,
    updatedAt: input.openedAt,
    deliveries: [],
  };
  await Promise.all(subscribedAdmins.map(admin => enqueueMonitoringIssueAdminEmail({
    email: admin.adminEmail,
    issue,
    event: input.eventKind === 'recovery' ? 'recovered' : 'opened',
  })));
}
