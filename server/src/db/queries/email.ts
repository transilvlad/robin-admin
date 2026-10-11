import { randomBytes, randomUUID, createHash, createHmac, timingSafeEqual } from 'crypto';
import type { PoolClient } from 'pg';
import { getClient, query } from '../connection.js';
import { decryptStoredSecret, encryptStoredSecret } from './secret-crypto.js';
import type {
  AdminEmailSubscription,
  EmailDelivery,
  EmailDeliveryAttempt,
  EmailDeliveryStatus,
  EmailRelay,
  EmailRelayType,
  EmailSenderProfile,
  EmailSenderProfileKey,
  EmailSmtpSecurity,
  EmailTlsMode,
  EmailTransportAdminView,
  StatusPageSubscriber,
  StatusPageSubscriberStatus,
} from '../../types/email.js';

type DbValue = string | number | boolean | Date | null | number[];

interface RelayRow {
  id: number;
  name: string;
  relay_type: EmailRelayType;
  enabled: boolean;
  priority: number;
  smtp_host: string | null;
  smtp_port: number | null;
  smtp_security: EmailSmtpSecurity;
  tls_mode: EmailTlsMode;
  username: string | null;
  encrypted_password: string | null;
  robin_service_id: string | null;
  postfix_service_id: string | null;
  created_at: Date;
  updated_at: Date;
}

interface SenderProfileRow {
  profile_key: EmailSenderProfileKey;
  display_name: string;
  from_name: string;
  from_email: string;
  reply_to: string | null;
  envelope_from: string | null;
  enabled: boolean;
  relay_ids: number[] | null;
  created_at: Date;
  updated_at: Date;
}

interface AdminSubscriptionRow {
  admin_id: number;
  admin_name: string;
  admin_email: string;
  disabled: boolean;
  monitoring_issue_opened: boolean | null;
  monitoring_issue_recovered: boolean | null;
  status_page_reports: boolean | null;
  email_delivery_failure: boolean | null;
  created_at: Date | null;
  updated_at: Date | null;
}

interface SubscriberRow {
  id: number;
  email: string;
  status: StatusPageSubscriberStatus;
  all_components: boolean;
  confirmed_at: Date | null;
  unsubscribed_at: Date | null;
  last_notified_at: Date | null;
  confirmation_sent_at: Date | null;
  created_at: Date;
  updated_at: Date;
  component_ids: number[] | null;
}

interface DeliveryRow {
  id: number;
  purpose: string;
  sender_profile_key: EmailSenderProfileKey;
  recipient_email: string;
  recipient_kind: string;
  subject: string;
  text_body: string;
  html_body: string | null;
  metadata_json: unknown;
  status: EmailDeliveryStatus;
  attempts: number;
  next_attempt_at: Date | null;
  last_attempt_at: Date | null;
  claimed_at: Date | null;
  claim_token: string | null;
  last_relay_id: number | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
  completed_at: Date | null;
}

interface AttemptRow {
  id: number;
  delivery_id: number;
  relay_id: number | null;
  relay_name: string;
  attempt_number: number;
  accepted: boolean;
  response: string | null;
  error: string | null;
  created_at: Date;
}

export interface ClaimedEmailDelivery extends EmailDelivery {
  textBody: string;
  htmlBody: string | null;
  claimToken: string;
}

export interface ResolvedEmailRelay extends EmailRelay {
  password: string | null;
}

const RELAY_COLUMNS = `
  id, name, relay_type, enabled, priority, smtp_host, smtp_port, smtp_security,
  tls_mode, username, encrypted_password, robin_service_id, postfix_service_id,
  created_at, updated_at
`;
const PROFILE_COLUMNS = `
  profile_key, display_name, from_name, from_email, reply_to, envelope_from,
  enabled, relay_ids, created_at, updated_at
`;
const DELIVERY_COLUMNS = `
  id, purpose, sender_profile_key, recipient_email, recipient_kind, subject, text_body, html_body,
  metadata_json, status, attempts, next_attempt_at, last_attempt_at, claimed_at, claim_token,
  last_relay_id, error, created_at, updated_at, completed_at
`;

function mapRelay(row: RelayRow): EmailRelay {
  return {
    id: row.id,
    name: row.name,
    relayType: row.relay_type,
    enabled: row.enabled,
    priority: row.priority,
    smtpHost: row.smtp_host,
    smtpPort: row.smtp_port,
    smtpSecurity: row.smtp_security,
    tlsMode: row.tls_mode,
    username: row.username,
    hasPassword: Boolean(row.encrypted_password),
    robinServiceId: row.robin_service_id,
    postfixServiceId: row.postfix_service_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapProfile(row: SenderProfileRow): EmailSenderProfile {
  return {
    profileKey: row.profile_key,
    displayName: row.display_name,
    fromName: row.from_name,
    fromEmail: row.from_email,
    replyTo: row.reply_to,
    envelopeFrom: row.envelope_from,
    enabled: row.enabled,
    relayIds: row.relay_ids ?? [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAdminSubscription(row: AdminSubscriptionRow): AdminEmailSubscription {
  return {
    adminId: row.admin_id,
    adminName: row.admin_name,
    adminEmail: row.admin_email,
    disabled: row.disabled,
    monitoringIssueOpened: row.monitoring_issue_opened ?? false,
    monitoringIssueRecovered: row.monitoring_issue_recovered ?? false,
    statusPageReports: row.status_page_reports ?? false,
    emailDeliveryFailure: row.email_delivery_failure ?? false,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapSubscriber(row: SubscriberRow): StatusPageSubscriber {
  return {
    id: row.id,
    email: row.email,
    status: row.status,
    allComponents: row.all_components,
    componentIds: row.component_ids ?? [],
    confirmedAt: row.confirmed_at,
    unsubscribedAt: row.unsubscribed_at,
    lastNotifiedAt: row.last_notified_at,
    confirmationSentAt: row.confirmation_sent_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapAttempt(row: AttemptRow): EmailDeliveryAttempt {
  return {
    id: row.id,
    deliveryId: row.delivery_id,
    relayId: row.relay_id,
    relayName: row.relay_name,
    attemptNumber: row.attempt_number,
    accepted: row.accepted,
    response: row.response,
    error: row.error,
    createdAt: row.created_at,
  };
}

function mapDelivery(row: DeliveryRow, attempts: EmailDeliveryAttempt[] = []): EmailDelivery {
  return {
    id: row.id,
    purpose: row.purpose,
    senderProfileKey: row.sender_profile_key,
    recipientEmail: row.recipient_email,
    recipientKind: row.recipient_kind,
    subject: row.subject,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    lastAttemptAt: row.last_attempt_at,
    lastRelayId: row.last_relay_id,
    error: row.error,
    metadata: row.metadata_json && typeof row.metadata_json === 'object' ? row.metadata_json as Record<string, unknown> : {},
    createdAt: row.created_at,
    completedAt: row.completed_at,
    deliveryAttempts: attempts,
  };
}

export function createEmailToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashEmailToken(token) };
}

export function hashEmailToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

export function createStatusPageUnsubscribeToken(subscriberId: number, unsubscribeHash: string): string {
  const id = String(subscriberId);
  const signature = createHmac('sha256', unsubscribeHash).update(id).digest('base64url');
  return `v1.${id}.${signature}`;
}

function parseStatusPageUnsubscribeToken(token: string): { subscriberId: number; signature: string } | null {
  const [version, rawId, signature, extra] = token.trim().split('.');
  if (extra !== undefined || version !== 'v1' || !rawId || !signature) return null;
  const subscriberId = Number(rawId);
  if (!Number.isSafeInteger(subscriberId) || subscriberId < 1 || String(subscriberId) !== rawId) return null;
  return { subscriberId, signature };
}

function secureEqualString(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

export async function listEmailRelays(): Promise<EmailRelay[]> {
  const result = await query<RelayRow>(`SELECT ${RELAY_COLUMNS} FROM email_relays ORDER BY priority ASC, name ASC, id ASC`);
  return result.rows.map(mapRelay);
}

export async function getResolvedEmailRelay(id: number): Promise<ResolvedEmailRelay | null> {
  const result = await query<RelayRow>(`SELECT ${RELAY_COLUMNS} FROM email_relays WHERE id = $1`, [id]);
  const row = result.rows[0];
  if (!row) return null;
  return {
    ...mapRelay(row),
    password: row.encrypted_password ? decryptStoredSecret(row.encrypted_password) : null,
  };
}

export async function upsertEmailRelay(input: {
  id?: number | null;
  name: string;
  relayType: EmailRelayType;
  enabled: boolean;
  priority: number;
  smtpHost: string | null;
  smtpPort: number | null;
  smtpSecurity: EmailSmtpSecurity;
  tlsMode: EmailTlsMode;
  username: string | null;
  password?: string | null;
  robinServiceId: string | null;
  postfixServiceId: string | null;
}): Promise<EmailRelay> {
  const encryptedPassword = input.password === undefined
    ? undefined
    : input.password ? encryptStoredSecret(input.password) : null;
  if (input.id) {
    const sets = [
      'name = $2', 'relay_type = $3', 'enabled = $4', 'priority = $5',
      'smtp_host = $6', 'smtp_port = $7', 'smtp_security = $8', 'tls_mode = $9',
      'username = $10', 'robin_service_id = $11', 'postfix_service_id = $12',
      'updated_at = CURRENT_TIMESTAMP',
    ];
    const values: DbValue[] = [
      input.id, input.name, input.relayType, input.enabled, input.priority,
      input.smtpHost, input.smtpPort, input.smtpSecurity, input.tlsMode,
      input.username, input.robinServiceId, input.postfixServiceId,
    ];
    if (encryptedPassword !== undefined) {
      sets.push('encrypted_password = $13');
      values.push(encryptedPassword);
    }
    const result = await query<RelayRow>(
      `UPDATE email_relays SET ${sets.join(', ')} WHERE id = $1 RETURNING ${RELAY_COLUMNS}`,
      values
    );
    return mapRelay(result.rows[0]);
  }
  const result = await query<RelayRow>(
    `INSERT INTO email_relays (
       name, relay_type, enabled, priority, smtp_host, smtp_port, smtp_security, tls_mode,
       username, encrypted_password, robin_service_id, postfix_service_id
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
     RETURNING ${RELAY_COLUMNS}`,
    [
      input.name, input.relayType, input.enabled, input.priority, input.smtpHost, input.smtpPort,
      input.smtpSecurity, input.tlsMode, input.username, encryptedPassword ?? null,
      input.robinServiceId, input.postfixServiceId,
    ]
  );
  return mapRelay(result.rows[0]);
}

export async function deleteEmailRelay(id: number): Promise<boolean> {
  const result = await query('DELETE FROM email_relays WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

export async function listEmailSenderProfiles(): Promise<EmailSenderProfile[]> {
  const result = await query<SenderProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM email_sender_profiles ORDER BY profile_key ASC`);
  return result.rows.map(mapProfile);
}

export async function getEmailSenderProfile(key: EmailSenderProfileKey): Promise<EmailSenderProfile | null> {
  const result = await query<SenderProfileRow>(`SELECT ${PROFILE_COLUMNS} FROM email_sender_profiles WHERE profile_key = $1`, [key]);
  return result.rows[0] ? mapProfile(result.rows[0]) : null;
}

export async function updateEmailSenderProfile(input: {
  profileKey: EmailSenderProfileKey;
  fromName: string;
  fromEmail: string;
  replyTo: string | null;
  envelopeFrom: string | null;
  enabled: boolean;
  relayIds: number[];
}): Promise<EmailSenderProfile> {
  const result = await query<SenderProfileRow>(
    `UPDATE email_sender_profiles
     SET from_name = $2, from_email = $3, reply_to = $4, envelope_from = $5,
         enabled = $6, relay_ids = $7::int[], updated_at = CURRENT_TIMESTAMP
     WHERE profile_key = $1
     RETURNING ${PROFILE_COLUMNS}`,
    [input.profileKey, input.fromName, input.fromEmail, input.replyTo, input.envelopeFrom, input.enabled, input.relayIds]
  );
  return mapProfile(result.rows[0]);
}

export async function listAdminEmailSubscriptions(): Promise<AdminEmailSubscription[]> {
  const result = await query<AdminSubscriptionRow>(
    `SELECT a.id AS admin_id, a.name AS admin_name, a.email AS admin_email, a.disabled,
            s.monitoring_issue_opened, s.monitoring_issue_recovered, s.status_page_reports,
            s.email_delivery_failure, s.created_at, s.updated_at
     FROM admins a
     LEFT JOIN admin_email_subscriptions s ON s.admin_id = a.id
     ORDER BY a.email ASC`
  );
  return result.rows.map(mapAdminSubscription);
}

export async function updateAdminEmailSubscription(input: {
  adminId: number;
  monitoringIssueOpened: boolean;
  monitoringIssueRecovered: boolean;
  statusPageReports: boolean;
  emailDeliveryFailure: boolean;
}): Promise<AdminEmailSubscription> {
  await query(
    `INSERT INTO admin_email_subscriptions (
       admin_id, monitoring_issue_opened, monitoring_issue_recovered,
       status_page_reports, email_delivery_failure
     )
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (admin_id) DO UPDATE
       SET monitoring_issue_opened = EXCLUDED.monitoring_issue_opened,
           monitoring_issue_recovered = EXCLUDED.monitoring_issue_recovered,
           status_page_reports = EXCLUDED.status_page_reports,
           email_delivery_failure = EXCLUDED.email_delivery_failure,
           updated_at = CURRENT_TIMESTAMP`,
    [input.adminId, input.monitoringIssueOpened, input.monitoringIssueRecovered, input.statusPageReports, input.emailDeliveryFailure]
  );
  return (await listAdminEmailSubscriptions()).find((entry) => entry.adminId === input.adminId)!;
}

export async function listStatusPageSubscribers(): Promise<StatusPageSubscriber[]> {
  const result = await query<SubscriberRow>(
    `SELECT s.id, s.email, s.status, s.all_components, s.confirmed_at, s.unsubscribed_at,
            s.last_notified_at, s.confirmation_sent_at, s.created_at, s.updated_at,
            COALESCE(array_remove(array_agg(sc.component_id ORDER BY sc.component_id), NULL), '{}')::int[] AS component_ids
     FROM status_page_subscribers s
     LEFT JOIN status_page_subscriber_components sc ON sc.subscriber_id = s.id
     GROUP BY s.id
     ORDER BY s.created_at DESC, s.id DESC`
  );
  return result.rows.map(mapSubscriber);
}

export async function createOrUpdatePendingStatusSubscriber(input: {
  email: string;
  allComponents: boolean;
  componentIds: number[];
}): Promise<{ subscriber: StatusPageSubscriber; token: string | null; sendConfirmation: boolean }> {
  const normalized = input.email.trim().toLowerCase();
  const confirmToken = createEmailToken();
  const unsubscribeToken = createEmailToken();
  const result = await query<SubscriberRow>(
    `INSERT INTO status_page_subscribers (
       email, status, all_components, token_hash, unsubscribe_hash, confirmed_at, unsubscribed_at, confirmation_sent_at
     )
     VALUES ($1, 'pending', $2, $3, $4, NULL, NULL, CURRENT_TIMESTAMP)
     ON CONFLICT (email) DO UPDATE
       SET status = 'pending',
           all_components = EXCLUDED.all_components,
           token_hash = EXCLUDED.token_hash,
           unsubscribe_hash = EXCLUDED.unsubscribe_hash,
           unsubscribed_at = NULL,
           confirmation_sent_at = CURRENT_TIMESTAMP,
           updated_at = CURRENT_TIMESTAMP
       WHERE status_page_subscribers.status <> 'confirmed'
         AND (
           status_page_subscribers.confirmation_sent_at IS NULL
           OR status_page_subscribers.confirmation_sent_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
         )
     RETURNING id, email, status, all_components, confirmed_at, unsubscribed_at, last_notified_at,
               confirmation_sent_at, created_at, updated_at, '{}'::int[] AS component_ids`,
    [normalized, input.allComponents, confirmToken.hash, unsubscribeToken.hash]
  );
  if (result.rows.length === 0) {
    const subscriber = await getStatusPageSubscriberByEmail(normalized);
    if (!subscriber) throw new Error('Failed to load status page subscriber');
    return { subscriber, token: null, sendConfirmation: false };
  }
  await setSubscriberComponents(result.rows[0].id, input.allComponents ? [] : input.componentIds);
  return { subscriber: (await getStatusPageSubscriber(result.rows[0].id))!, token: confirmToken.token, sendConfirmation: true };
}

async function getStatusPageSubscriber(id: number): Promise<StatusPageSubscriber | null> {
  return (await listStatusPageSubscribers()).find((subscriber) => subscriber.id === id) ?? null;
}

async function getStatusPageSubscriberByEmail(email: string): Promise<StatusPageSubscriber | null> {
  return (await listStatusPageSubscribers()).find((subscriber) => subscriber.email === email) ?? null;
}

export async function confirmStatusPageSubscriber(token: string): Promise<boolean> {
  const hash = hashEmailToken(token);
  const result = await query(
    `UPDATE status_page_subscribers
     SET status = 'confirmed', confirmed_at = COALESCE(confirmed_at, CURRENT_TIMESTAMP),
         token_hash = NULL, unsubscribed_at = NULL, updated_at = CURRENT_TIMESTAMP
     WHERE token_hash = $1
       AND status <> 'unsubscribed'
       AND confirmation_sent_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'`,
    [hash]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function unsubscribeStatusPageSubscriber(token: string): Promise<boolean> {
  const signed = parseStatusPageUnsubscribeToken(token);
  if (!signed) return false;
  const secret = await query<{ unsubscribe_hash: string }>(
    `SELECT unsubscribe_hash
     FROM status_page_subscribers
     WHERE id = $1`,
    [signed.subscriberId]
  );
  const row = secret.rows[0];
  if (!row) return false;
  const expected = createStatusPageUnsubscribeToken(signed.subscriberId, row.unsubscribe_hash).split('.')[2];
  if (!secureEqualString(signed.signature, expected)) return false;
  const result = await query(
    `UPDATE status_page_subscribers
     SET status = 'unsubscribed', unsubscribed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND unsubscribe_hash = $2`,
    [signed.subscriberId, row.unsubscribe_hash]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function listConfirmedStatusSubscribersForComponents(componentIds: number[]): Promise<Array<StatusPageSubscriber & { unsubscribeToken: string }>> {
  const result = await query<SubscriberRow & { unsubscribe_hash: string }>(
    `SELECT s.id, s.email, s.status, s.all_components, s.confirmed_at, s.unsubscribed_at,
            s.last_notified_at, s.created_at, s.updated_at, s.unsubscribe_hash,
            s.confirmation_sent_at,
            COALESCE(array_remove(array_agg(sc.component_id ORDER BY sc.component_id), NULL), '{}')::int[] AS component_ids
     FROM status_page_subscribers s
     LEFT JOIN status_page_subscriber_components sc ON sc.subscriber_id = s.id
     WHERE s.status = 'confirmed'
       AND s.unsubscribed_at IS NULL
     GROUP BY s.id
     HAVING s.all_components = true
        OR COALESCE(array_remove(array_agg(sc.component_id), NULL), '{}')::int[] && $1::int[]
     ORDER BY s.email ASC`,
    [componentIds]
  );
  return result.rows.map((row) => ({
    ...mapSubscriber(row),
    unsubscribeToken: createStatusPageUnsubscribeToken(row.id, row.unsubscribe_hash),
  }));
}

export async function deleteStatusPageSubscriber(id: number): Promise<boolean> {
  const result = await query('DELETE FROM status_page_subscribers WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

async function setSubscriberComponents(subscriberId: number, componentIds: number[]): Promise<void> {
  await query('DELETE FROM status_page_subscriber_components WHERE subscriber_id = $1', [subscriberId]);
  for (const componentId of Array.from(new Set(componentIds))) {
    await query(
      `INSERT INTO status_page_subscriber_components (subscriber_id, component_id)
       VALUES ($1, $2)
       ON CONFLICT DO NOTHING`,
      [subscriberId, componentId]
    );
  }
}

export async function enqueueEmailDelivery(input: {
  purpose: string;
  senderProfileKey: EmailSenderProfileKey;
  recipientEmail: string;
  recipientKind: string;
  subject: string;
  textBody: string;
  htmlBody?: string | null;
  metadata?: Record<string, unknown>;
  client?: PoolClient;
}): Promise<EmailDelivery> {
  const text = 
    `INSERT INTO email_deliveries (
       purpose, sender_profile_key, recipient_email, recipient_kind, subject, text_body, html_body, metadata_json
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
     RETURNING ${DELIVERY_COLUMNS}`;
  const values = [
      input.purpose,
      input.senderProfileKey,
      input.recipientEmail.trim().toLowerCase(),
      input.recipientKind,
      input.subject,
      input.textBody,
      input.htmlBody ?? null,
      JSON.stringify(input.metadata ?? {}),
  ];
  const result = input.client
    ? await input.client.query<DeliveryRow>(text, values)
    : await query<DeliveryRow>(text, values);
  return mapDelivery(result.rows[0]);
}

export async function listEmailDeliveries(limit = 100): Promise<EmailDelivery[]> {
  const deliveries = await query<DeliveryRow>(
    `SELECT ${DELIVERY_COLUMNS}
     FROM email_deliveries
     ORDER BY created_at DESC, id DESC
     LIMIT $1`,
    [Math.max(1, Math.min(limit, 250))]
  );
  return attachAttempts(deliveries.rows.map((row) => mapDelivery(row)));
}

async function attachAttempts(deliveries: EmailDelivery[]): Promise<EmailDelivery[]> {
  if (deliveries.length === 0) return deliveries;
  const result = await query<AttemptRow>(
    `SELECT id, delivery_id, relay_id, relay_name, attempt_number, accepted, response, error, created_at
     FROM email_delivery_attempts
     WHERE delivery_id = ANY($1::bigint[])
     ORDER BY created_at ASC, id ASC`,
    [deliveries.map((delivery) => delivery.id)]
  );
  const byDelivery = new Map<number, EmailDeliveryAttempt[]>();
  for (const row of result.rows) {
    const attempts = byDelivery.get(row.delivery_id) ?? [];
    attempts.push(mapAttempt(row));
    byDelivery.set(row.delivery_id, attempts);
  }
  for (const delivery of deliveries) {
    delivery.deliveryAttempts = byDelivery.get(delivery.id) ?? [];
  }
  return deliveries;
}

export async function claimDueEmailDeliveries(limit: number): Promise<ClaimedEmailDelivery[]> {
  const client = await getClient();
  const claimToken = randomUUID();
  try {
    await client.query('BEGIN');
    await client.query(`
      UPDATE email_deliveries
      SET status = 'pending', claim_token = NULL, claimed_at = NULL,
          next_attempt_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE status = 'processing' AND claimed_at < CURRENT_TIMESTAMP - INTERVAL '15 minutes'
    `);
    const result = await client.query<DeliveryRow>(
      `WITH due AS (
         SELECT id FROM email_deliveries
         WHERE status = 'pending'
           AND (next_attempt_at IS NULL OR next_attempt_at <= CURRENT_TIMESTAMP)
         ORDER BY created_at ASC, id ASC
         LIMIT $1
         FOR UPDATE SKIP LOCKED
       )
       UPDATE email_deliveries d
       SET status = 'processing', attempts = attempts + 1, last_attempt_at = CURRENT_TIMESTAMP,
           claimed_at = CURRENT_TIMESTAMP, claim_token = $2, updated_at = CURRENT_TIMESTAMP
       FROM due
       WHERE d.id = due.id
       RETURNING ${DELIVERY_COLUMNS.split(',').map((column) => `d.${column.trim()}`).join(', ')}`,
      [Math.max(1, Math.min(limit, 25)), claimToken]
    );
    await client.query('COMMIT');
    return result.rows.map((row) => ({
      ...mapDelivery(row),
      textBody: row.text_body,
      htmlBody: row.html_body,
      claimToken,
    }));
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function recordEmailDeliveryAttempt(input: {
  deliveryId: number;
  relayId: number | null;
  relayName: string;
  attemptNumber: number;
  accepted: boolean;
  response?: string | null;
  error?: string | null;
}): Promise<void> {
  await query(
    `INSERT INTO email_delivery_attempts (
       delivery_id, relay_id, relay_name, attempt_number, accepted, response, error
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      input.deliveryId,
      input.relayId,
      input.relayName,
      input.attemptNumber,
      input.accepted,
      input.response?.slice(0, 500) ?? null,
      input.error?.slice(0, 500) ?? null,
    ]
  );
}

export async function completeEmailDelivery(input: {
  id: number;
  claimToken: string;
  status: EmailDeliveryStatus;
  relayId?: number | null;
  error?: string | null;
  nextAttemptAt?: Date | null;
}): Promise<boolean> {
  const terminal = input.status === 'accepted' || input.status === 'failed' || input.status === 'cancelled';
  const result = await query(
    `UPDATE email_deliveries
     SET status = $3, last_relay_id = $4, error = $5, next_attempt_at = $6,
         claim_token = NULL, claimed_at = NULL,
         completed_at = CASE WHEN $7 THEN CURRENT_TIMESTAMP ELSE NULL END,
         updated_at = CURRENT_TIMESTAMP
     WHERE id = $1 AND claim_token = $2 AND status = 'processing'`,
    [
      input.id,
      input.claimToken,
      input.status,
      input.relayId ?? null,
      input.error?.slice(0, 500) ?? null,
      input.nextAttemptAt ?? null,
      terminal,
    ]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function getEmailTransportAdminView(): Promise<EmailTransportAdminView> {
  const [relays, senderProfiles, deliveries] = await Promise.all([
    listEmailRelays(),
    listEmailSenderProfiles(),
    listEmailDeliveries(100),
  ]);
  return { relays, senderProfiles, deliveries };
}
