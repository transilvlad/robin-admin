import { lookup } from 'node:dns/promises';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import type { AlertWebhookAdapter, JsonRecord } from '../../types/alerts.js';

export interface AlertTransportResult {
  accepted: boolean;
  retryable: boolean;
  status: number | null;
  error: string | null;
}
export interface AlertTransportInput {
  adapter: AlertWebhookAdapter;
  webhookUrl: string;
  payload?: JsonRecord;
  // A pre-serialised body (for example a Sentry envelope) instead of JSON.
  body?: string;
  contentType?: string;
  method?: 'POST' | 'PUT';
  headers?: Record<string, string>;
  notificationId: string;
  timeoutMs?: number;
}
const RESPONSE_LIMIT = 64 * 1024;
class DestinationPolicyError extends Error {}

export function publicWebhookAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

export function createAlertTransport(dependencies: {
  resolve?: typeof lookup;
  request?: typeof httpsRequest;
  addressAllowed?: typeof publicWebhookAddress;
} = {}) {
  const resolveAddress = dependencies.resolve ?? lookup;
  const request = dependencies.request ?? httpsRequest;
  const addressAllowed = dependencies.addressAllowed ?? publicWebhookAddress;
  return async function send(input: AlertTransportInput): Promise<AlertTransportResult> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), Math.min(10000, Math.max(1, input.timeoutMs ?? 10000)));
    try {
      const url = new URL(input.webhookUrl);
      if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new DestinationPolicyError();
      const hostname = url.hostname.replace(/^\[|\]$/g, '');
      const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
        resolveAddress(hostname, { all: true, verbatim: true }),
        new Promise<never>((_, reject) => controller.signal.addEventListener('abort', () => reject(new Error('Deadline exceeded')), { once: true })),
      ]);
      if (!records.length || records.some(record => !addressAllowed(record.address))) throw new DestinationPolicyError();
      const target = records[0];
      // One validated DNS resolution owns the socket. Native HTTPS verifies the
      // original hostname/certificate, and does not follow redirects.
      const response = await new Promise<{ status: number; text: string }>((resolve, reject) => {
        const outgoing = request(url, { method: input.method ?? 'POST', signal: controller.signal, agent: false, family: target.family,
          lookup: (_host, _options, callback) => callback(null, target.address, target.family),
          headers: {
            ...input.headers,
            'Content-Type': input.contentType ?? 'application/json',
            'User-Agent': 'robin-admin-alerts',
            'X-Robin-Notification-Id': input.notificationId,
          },
        }, incoming => {
          let size = 0;
          const chunks: Buffer[] = [];
          incoming.on('data', (chunk: Buffer) => {
            size += chunk.length;
            if (size > RESPONSE_LIMIT) { incoming.destroy(new DestinationPolicyError()); return; }
            chunks.push(chunk);
          });
          incoming.on('error', reject);
          incoming.on('end', () => resolve({ status: incoming.statusCode ?? 502, text: Buffer.concat(chunks).toString('utf8') }));
        });
        outgoing.on('error', reject);
        outgoing.end(input.body ?? JSON.stringify(input.payload ?? {}));
      });
      const accepted = response.status >= 200 && response.status < 300
        && (input.adapter !== 'slack' || response.text.trim().toLowerCase() === 'ok');
      return { accepted, retryable: [408, 429].includes(response.status) || response.status >= 500,
        status: response.status, error: accepted ? null : `Webhook did not acknowledge delivery (HTTP ${response.status})` };
    } catch (error) {
      return { accepted: false, retryable: !(error instanceof DestinationPolicyError || error instanceof TypeError), status: null,
        error: error instanceof DestinationPolicyError ? 'Webhook destination or response violates the delivery safety policy' : 'Webhook transport failed or exceeded its deadline' };
    } finally { clearTimeout(timeout); }
  };
}
export const sendAlertWebhook = createAlertTransport();
