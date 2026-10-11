import { operationsPolicy } from '../operations-settings.js';
import { completeAlertDelivery, claimDueAlertDeliveries, expireStaleAlertDeliveries, type ClaimedAlertDelivery } from '../../db/queries/alerts.js';
import { logger } from '../../logger.js';
import { validateOutboundUrl } from '../../middleware/security.js';
import { sendAlertWebhook } from './webhook-transport.js';
import { sendSentryAlert, sentryDeliveryUrl } from './sentry.js';
import { reportError } from '../error-reporting.js';

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
      error: delivery.claimError ?? 'Destination webhook URL is unavailable',
    });
    return;
  }

  const destination = { dsn: delivery.webhookUrl, ...delivery.sentry };
  // A Sentry DSN carries its key as URL credentials; the URL actually sent to
  // (the envelope endpoint or the API) is the one that must pass the checks.
  const targetUrl = delivery.adapter === 'sentry' ? sentryDeliveryUrl(destination, delivery.payload) : delivery.webhookUrl;
  const urlError = targetUrl ? await validateWebhookUrl(targetUrl) : 'Sentry DSN is invalid';
  if (urlError) {
    await completeAlertDelivery({
      id: delivery.id,
      claimToken: delivery.claimToken,
      status: 'failed',
      error: urlError,
    });
    return;
  }

  const result = delivery.adapter === 'sentry'
    ? await sendSentryAlert(destination, delivery.payload, delivery.notificationId)
    : await sendAlertWebhook({
      adapter: delivery.adapter,
      webhookUrl: delivery.webhookUrl,
      payload: delivery.payload,
      notificationId: delivery.notificationId,
    });

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
