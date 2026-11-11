import { operationsPolicy } from '../operations-settings.js';
import { completeAlertDelivery, claimDueAlertDeliveries, expireStaleAlertDeliveries, type ClaimedAlertDelivery } from '../../db/queries/alerts.js';
import { logger } from '../../logger.js';
import { validateOutboundUrl } from '../../middleware/security.js';
import { sendAlertWebhook } from './webhook-transport.js';
import { sendSentryAlert, sentryDeliveryUrl } from './sentry.js';
import { reportError } from '../error-reporting.js';
import { getEmailSenderProfile } from '../../db/queries/email.js';
import { resolveEmailRelays, sendEmailViaRelay } from '../email/transport.js';
import {
  buildAlertEmail,
  buildPagerDutyAlert,
  buildTeamsAlert,
  PAGERDUTY_EVENTS_URL,
  validAlertEmail,
  validPagerDutyKey,
} from './channels.js';
import type { AlertTransportResult } from './webhook-transport.js';

export function alertDeliveryPolicy() {
  const policy = operationsPolicy();
  return { workerIntervalMs: policy.alertDeliveryIntervalMs, maxAttempts: policy.alertDeliveryMaxAttempts,
    baseRetryDelayMs: policy.alertRetryBaseMs, maxRetryDelayMs: policy.alertRetryMaxMs,
    deliveryExpiryMs: policy.alertDeliveryExpiryMs };
}

let timer: NodeJS.Timeout | null = null;
let running = false;
let lastSuccessfulCycleAt: number | null = null;
let lastCycleErrorAt: number | null = null;

export function getAlertDeliveryWorkerHealth(): { lastSuccessfulCycleAt: number | null; lastCycleErrorAt: number | null } {
  return { lastSuccessfulCycleAt, lastCycleErrorAt };
}

export function startAlertDeliveryWorker(): void {
  if (timer) {
    return;
  }

  if (!operationsPolicy().alertsEnabled) {
    logger.info('Alert delivery worker disabled');
    return;
  }

  logger.info('Alert delivery worker started', {
    intervalMs: operationsPolicy().alertDeliveryIntervalMs,
    concurrency: operationsPolicy().alertDeliveryConcurrency,
  });
  timer = setInterval(() => {
    void runOnce();
  }, operationsPolicy().alertDeliveryIntervalMs);
  timer.unref();
  void runOnce();
}

export function stopAlertDeliveryWorker(): void {
  if (!timer) {
    return;
  }
  clearInterval(timer);
  timer = null;
  logger.info('Alert delivery worker stopped');
}

async function runOnce(): Promise<void> {
  if (running || !operationsPolicy().alertsEnabled) {
    return;
  }
  running = true;
  try {
    await expireStaleAlertDeliveries(operationsPolicy().alertDeliveryExpiryMs);
    const deliveries = await claimDueAlertDeliveries(operationsPolicy().alertDeliveryConcurrency);
    if (deliveries.length === 0) {
      lastSuccessfulCycleAt = Date.now();
      return;
    }
    const results = await Promise.allSettled(deliveries.map(processAlertDelivery));
    for (const result of results) {
      if (result.status === 'rejected') logger.error('Alert delivery failed', { error: String(result.reason) });
    }
    lastSuccessfulCycleAt = Date.now();
  } catch (error) {
    lastCycleErrorAt = Date.now();
    logger.error('Alert delivery worker failed', { error: (error as Error).message });
    reportError(error, 'alert-delivery');
  } finally {
    running = false;
  }
}

export async function processAlertDelivery(delivery: ClaimedAlertDelivery): Promise<void> {
  if (delivery.claimError || !delivery.webhookUrl) {
    await completeAlertDelivery({
      id: delivery.id,
      claimToken: delivery.claimToken,
      status: 'failed',
      error: delivery.claimError ?? 'Destination secret is unavailable',
    });
    return;
  }

  let result: AlertTransportResult & { skipped?: boolean };
  if (delivery.adapter === 'email') {
    result = await sendAlertEmail(delivery);
  } else {
    const destination = { dsn: delivery.webhookUrl, ...delivery.sentry };
    const targetUrl = delivery.adapter === 'sentry' ? sentryDeliveryUrl(destination, delivery.payload)
      : delivery.adapter === 'pagerduty' ? PAGERDUTY_EVENTS_URL : delivery.webhookUrl;
    const urlError = targetUrl ? await validateWebhookUrl(targetUrl) : 'Sentry DSN is invalid';
    if (urlError || !targetUrl) {
      await completeAlertDelivery({
        id: delivery.id,
        claimToken: delivery.claimToken,
        status: 'failed',
        error: urlError ?? 'Destination URL is unavailable',
      });
      return;
    }
    if (delivery.adapter === 'pagerduty' && !validPagerDutyKey(delivery.webhookUrl)) {
      result = { accepted: false, retryable: false, status: null, error: 'PagerDuty integration key is invalid' };
    } else if (delivery.adapter === 'sentry') {
      result = await sendSentryAlert(destination, delivery.payload, delivery.notificationId);
    } else {
      const payload = delivery.adapter === 'teams' ? buildTeamsAlert(delivery)
        : delivery.adapter === 'pagerduty' ? buildPagerDutyAlert(delivery, delivery.webhookUrl)
          : delivery.payload;
      result = await sendAlertWebhook({
        adapter: delivery.adapter,
        webhookUrl: targetUrl,
        payload,
        notificationId: delivery.notificationId,
      });
    }
  }

  if ('skipped' in result && result.skipped) {
    await completeAlertDelivery({
      id: delivery.id,
      claimToken: delivery.claimToken,
      status: 'cancelled',
      error: result.error,
    });
    return;
  }

  if (result.accepted) {
    await completeAlertDelivery({
      id: delivery.id,
      claimToken: delivery.claimToken,
      status: 'accepted',
      responseStatus: result.status,
    });
    return;
  }

  const shouldRetry = result.retryable && delivery.attempts < operationsPolicy().alertDeliveryMaxAttempts;
  await completeAlertDelivery({
    id: delivery.id,
    claimToken: delivery.claimToken,
    status: shouldRetry ? 'pending' : 'failed',
    responseStatus: result.status,
    error: result.error,
    nextAttemptAt: shouldRetry ? nextAlertRetryAt(delivery.attempts) : null,
  });
}

async function sendAlertEmail(delivery: ClaimedAlertDelivery): Promise<AlertTransportResult> {
  if (!delivery.webhookUrl || !validAlertEmail(delivery.webhookUrl)) {
    return { accepted: false, retryable: false, status: null, error: 'Alert email recipient is invalid' };
  }
  const sender = await getEmailSenderProfile('alerts');
  if (!sender?.enabled) {
    return { accepted: false, retryable: false, status: null, error: 'Alerts email sender profile is disabled or missing' };
  }
  if ([sender.fromName, sender.fromEmail, sender.replyTo, sender.envelopeFrom].some(value => value && /[\r\n\x00]/.test(value))) {
    return { accepted: false, retryable: false, status: null, error: 'Alerts email sender profile contains invalid header characters' };
  }
  const relays = await resolveEmailRelays(sender);
  if (relays.length === 0) {
    return { accepted: false, retryable: false, status: null, error: 'No enabled relays are configured for the alerts email sender' };
  }
  const message = buildAlertEmail(delivery);
  let retryable = false;
  for (const relay of relays) {
    const result = await sendEmailViaRelay({
      recipientEmail: delivery.webhookUrl,
      subject: message.subject,
      textBody: message.text,
      htmlBody: null,
    }, sender, relay);
    if (result.accepted) return { accepted: true, retryable: false, status: null, error: null };
    retryable ||= result.retryable;
  }
  return { accepted: false, retryable, status: null, error: 'All configured alert email relays rejected delivery' };
}

async function validateWebhookUrl(rawUrl: string): Promise<string | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return 'Destination webhook URL is invalid';
  }
  if (url.protocol !== 'https:') {
    return 'Destination webhook URL must use HTTPS';
  }
  if (url.username || url.password) {
    return 'Destination webhook URL must not include credentials';
  }
  // The transport resolves, validates and pins DNS within its delivery deadline.
  return validateOutboundUrl(rawUrl, false);
}

export function nextAlertRetryAt(attempts: number): Date {
  const exponent = Math.max(attempts - 1, 0);
  const policy = operationsPolicy();
  const delayMs = Math.min(policy.alertRetryBaseMs * 2 ** exponent, policy.alertRetryMaxMs);
  return new Date(Date.now() + delayMs);
}
