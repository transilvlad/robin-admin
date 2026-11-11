import {
  getResolvedEmailRelay,
  listEmailRelays,
  type ClaimedEmailDelivery,
  type ResolvedEmailRelay,
} from '../../db/queries/email.js';
import type { EmailSenderProfile } from '../../types/email.js';
import { queueRawEmail } from '../robin-api.js';
import { renderMessage, sendSmtpMail, type SmtpSendResult } from './smtp-client.js';

type EmailMessage = Pick<ClaimedEmailDelivery, 'recipientEmail' | 'subject' | 'textBody' | 'htmlBody'>;

export async function resolveEmailRelays(sender: EmailSenderProfile): Promise<ResolvedEmailRelay[]> {
  const relays = sender.relayIds.length > 0
    ? (await Promise.all(sender.relayIds.map((id) => getResolvedEmailRelay(id)))).filter((relay): relay is ResolvedEmailRelay => Boolean(relay?.enabled))
    : (await Promise.all((await listEmailRelays()).filter((relay) => relay.enabled).map((relay) => getResolvedEmailRelay(relay.id))))
      .filter((relay): relay is ResolvedEmailRelay => Boolean(relay?.enabled));
  return relays.sort((a, b) => a.priority - b.priority || a.id - b.id);
}

export async function sendEmailViaRelay(
  message: EmailMessage,
  sender: EmailSenderProfile,
  relay: ResolvedEmailRelay,
): Promise<SmtpSendResult> {
  if (relay.relayType === 'robin') {
    try {
      const response = await queueRawEmail({
        mail: sender.envelopeFrom || sender.fromEmail,
        rcpt: [message.recipientEmail],
        message: renderMessage({
          relay,
          sender,
          to: message.recipientEmail,
          subject: message.subject,
          text: message.textBody,
          html: message.htmlBody,
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
    to: message.recipientEmail,
    subject: message.subject,
    text: message.textBody,
    html: message.htmlBody,
  });
}
