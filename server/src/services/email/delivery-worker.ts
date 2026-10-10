import { operationsPolicy } from '../operations-settings.js';
import {
  claimDueEmailDeliveries,
  completeEmailDelivery,
  getEmailSenderProfile,
  getResolvedEmailRelay,
  listEmailRelays,
  recordEmailDeliveryAttempt,
  type ClaimedEmailDelivery,
  type ResolvedEmailRelay,
} from '../../db/queries/email.js';
import { createAlertDelivery, listAlertWebhooks } from '../../db/queries/alerts.js';
import { queueRawEmail } from '../robin-api.js';
import { logger } from '../../logger.js';
import { renderMessage, sendSmtpMail } from './smtp-client.js';
import type { EmailSenderProfile } from '../../types/email.js';
import { buildSentryAlertPayload } from '../alerts/sentry.js';

const WORKER_INTERVAL_MS = 5000;
const MAX_ATTEMPTS = 5;
const BASE_RETRY_DELAY_MS = 30000;
const MAX_RETRY_DELAY_MS = 15 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let running = false;

export function startEmailDeliveryWorker(): void {
  if (timer) return;
  logger.info('Email delivery worker started', { intervalMs: WORKER_INTERVAL_MS });
  timer = setInterval(() => {
    void runOnce();
  }, WORKER_INTERVAL_MS);
  timer.unref();
  void runOnce();
}

export function stopEmailDeliveryWorker(): void {
  if (!timer) return;
  clearInterval(timer);
  timer = null;
  logger.info('Email delivery worker stopped');
}

async function runOnce(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const deliveries = await claimDueEmailDeliveries(4);
    const results = await Promise.allSettled(deliveries.map(processEmailDelivery));
    for (const result of results) {
      if (result.status === 'rejected') logger.error('Email delivery failed', { error: String(result.reason) });
    }
  } catch (error) {
    logger.error('Email delivery worker failed', { error: (error as Error).message });
  } finally {
    running = false;
  }
}

export async function processEmailDelivery(delivery: ClaimedEmailDelivery): Promise<void> {
  const sender = await getEmailSenderProfile(delivery.senderProfileKey);
  if (!sender || !sender.enabled) {
    await failDelivery(delivery, null, 'Sender profile is disabled or missing', false);
    return;
  }
  const relays = await resolveRelayPolicy(sender);
  if (relays.length === 0) {
    await failDelivery(delivery, null, 'No enabled email relays are configured for this sender profile', false);
    return;
  }

  const errors: string[] = [];
  for (const relay of relays) {
    const result = await sendViaRelay(delivery, sender, relay);
    await recordEmailDeliveryAttempt({
      deliveryId: delivery.id,
      relayId: relay.id,
      relayName: relay.name,
      attemptNumber: delivery.attempts,
      accepted: result.accepted,
      response: result.response,
      error: result.error,
    });
    if (result.accepted) {
      await completeEmailDelivery({
        id: delivery.id,
        claimToken: delivery.claimToken,
        status: 'accepted',
        relayId: relay.id,
      });
      return;
    }
    errors.push(`${relay.name}: ${result.error ?? 'delivery failed'}`);
  }

  const error = errors.join('; ').slice(0, 500);
  const shouldRetry = delivery.attempts < MAX_ATTEMPTS;
  await completeEmailDelivery({
    id: delivery.id,
    claimToken: delivery.claimToken,
    status: shouldRetry ? 'pending' : 'failed',
    relayId: relays.at(-1)?.id ?? null,
    error,
    nextAttemptAt: shouldRetry ? nextEmailRetryAt(delivery.attempts) : null,
  });
  if (!shouldRetry) {
    await enqueueEmailDeliveryFailureAlert(delivery, error);
  }
}

async function resolveRelayPolicy(sender: EmailSenderProfile): Promise<ResolvedEmailRelay[]> {
  const ids = sender.relayIds;
  const relays = ids.length > 0
    ? (await Promise.all(ids.map((id) => getResolvedEmailRelay(id)))).filter((relay): relay is ResolvedEmailRelay => Boolean(relay?.enabled))
    : (await Promise.all((await listEmailRelays()).filter((relay) => relay.enabled).map((relay) => getResolvedEmailRelay(relay.id))))
      .filter((relay): relay is ResolvedEmailRelay => Boolean(relay?.enabled));
  return relays.sort((a, b) => a.priority - b.priority || a.id - b.id);
}

async function sendViaRelay(
  delivery: ClaimedEmailDelivery,
  sender: EmailSenderProfile,
  relay: ResolvedEmailRelay,
): Promise<{ accepted: boolean; response?: string; error?: string; retryable: boolean }> {
  if (relay.relayType === 'robin') {
    try {
      const response = await queueRawEmail({
        mail: sender.envelopeFrom || sender.fromEmail,
        rcpt: [delivery.recipientEmail],
        message: renderMessage({
          relay,
          sender,
          to: delivery.recipientEmail,
          subject: delivery.subject,
          text: delivery.textBody,
          html: delivery.htmlBody,
        }),
      }, relay.robinServiceId ?? undefined);
      if (response.success === false) {
        return { accepted: false, error: String(response.error ?? 'Robin queue rejected message'), retryable: true };
      }
      return { accepted: true, response: JSON.stringify(response).slice(0, 500), retryable: false };
    } catch (error) {
      return { accepted: false, error: (error as Error).message, retryable: true };
    }
  }
  return sendSmtpMail({
    relay,
    sender,
    to: delivery.recipientEmail,
    subject: delivery.subject,
    text: delivery.textBody,
    html: delivery.htmlBody,
  });
}

async function failDelivery(
  delivery: ClaimedEmailDelivery,
  relayId: number | null,
  error: string,
  retryable: boolean,
): Promise<void> {
  const shouldRetry = retryable && delivery.attempts < MAX_ATTEMPTS;
  await completeEmailDelivery({
    id: delivery.id,
    claimToken: delivery.claimToken,
    status: shouldRetry ? 'pending' : 'failed',
    relayId,
    error,
    nextAttemptAt: shouldRetry ? nextEmailRetryAt(delivery.attempts) : null,
  });
  if (!shouldRetry) {
    await enqueueEmailDeliveryFailureAlert(delivery, error);
  }
}

async function enqueueEmailDeliveryFailureAlert(delivery: ClaimedEmailDelivery, error: string): Promise<void> {
  if (!operationsPolicy().alertsEnabled) return;
  const webhooks = await listAlertWebhooks();
  const subscribers = webhooks.filter((webhook) => webhook.enabled && webhook.subscriptions.some((subscription) => (
    subscription.alertType === 'email_delivery_failure' && subscription.enabled
  )));
  const genericPayload = {
    text: `Robin Admin could not deliver ${delivery.purpose} email to ${delivery.recipientEmail}`,
    title: '[EMAIL DELIVERY FAILURE] Robin Admin outbound email',
    purpose: delivery.purpose,
    recipientKind: delivery.recipientKind,
    recipientEmail: delivery.recipientEmail,
    senderProfile: delivery.senderProfileKey,
    subject: delivery.subject,
    error,
    deliveryId: delivery.id,
  };
  for (const webhook of subscribers) {
    // Sentry gets no recipient address: events stay free of personal data.
    const payload = webhook.adapter === 'sentry'
      ? buildSentryAlertPayload({
        alertKey: `email-delivery:${delivery.purpose}`,
        alertType: 'email_delivery_failure',
        eventKind: 'failure',
        title: `Robin Admin could not deliver ${delivery.purpose} email`,
        message: `All configured relays failed for a ${delivery.purpose} email (${delivery.recipientKind})`,
        severity: 'warning',
        tags: { purpose: delivery.purpose, sender_profile: delivery.senderProfileKey },
        context: { error, deliveryId: delivery.id, attempts: delivery.attempts },
        linkPath: '/administration/email',
        occurredAt: new Date(),
      })
      : genericPayload;
    if (!payload) continue;
    await createAlertDelivery({
      dedupeKey: `email-delivery:${delivery.id}:failure:${delivery.attempts}`,
      webhookId: webhook.id,
      webhookName: webhook.name,
      fleetServiceId: null,
      serviceId: 'email-delivery',
      serviceName: 'Robin Admin outbound email',
      serviceType: 'monitoring',
      alertType: 'email_delivery_failure',
      eventKind: 'failure',
      adapter: webhook.adapter,
      payload,
    });
  }
}

export function nextEmailRetryAt(attempts: number): Date {
  const exponent = Math.max(attempts - 1, 0);
  const delayMs = Math.min(BASE_RETRY_DELAY_MS * 2 ** exponent, MAX_RETRY_DELAY_MS);
  return new Date(Date.now() + delayMs);
}
