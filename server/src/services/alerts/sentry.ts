/**
 * Sentry as an alert destination and heartbeat target, through Sentry's
 * standard interfaces only: events sent as envelopes to the DSN's ingest
 * endpoint (built with Sentry's own @sentry/core helpers), issues resolved
 * through the documented REST API, and Crons check-ins.
 *
 * Robin Admin decides when something is down; Sentry receives that decision.
 * One alert subject (a check, a telemetry rule series, a service alert) is one
 * Sentry issue, grouped by a stable fingerprint and opened and resolved with
 * the matching Robin Admin alert.
 */
import { randomUUID } from 'crypto';
import {
  createEventEnvelope,
  getEnvelopeEndpointWithUrlEncodedAuth,
  makeDsn,
  serializeEnvelope,
  type DsnComponents,
  type Event,
} from '@sentry/core';
import { config } from '../../config.js';
import type { AlertEventKind, AlertType, JsonRecord } from '../../types/alerts.js';
import { operationsPolicy } from '../operations-settings.js';
import { sendAlertWebhook, type AlertTransportResult } from './webhook-transport.js';

/** The HTTP check-in URL Sentry shows for a Cron monitor. */
const SENTRY_CRON_PATH = /^\/api\/\d+\/cron\/[A-Za-z0-9_-]+\/[A-Za-z0-9]+\/?$/;
const TAG_VALUE_MAX = 200;

export function parseSentryDsn(value: string): DsnComponents | null {
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || !url.username || url.password) return null;
  } catch {
    return null;
  }
  const dsn = makeDsn(value);
  return dsn && dsn.publicKey && dsn.projectId ? dsn : null;
}

export function isSentryCronCheckInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && SENTRY_CRON_PATH.test(url.pathname);
  } catch {
    return false;
  }
}

/** sentry.io hosts the API per region (us.sentry.io, de.sentry.io); self-hosted serves it on the DSN host. */
export function sentryApiBase(dsn: DsnComponents): string {
  const region = /^o\d+\.ingest\.(?:([a-z]+)\.)?sentry\.io$/.exec(dsn.host);
  if (region) return region[1] ? `https://${region[1]}.sentry.io` : 'https://sentry.io';
  return `https://${dsn.host}${dsn.port ? `:${dsn.port}` : ''}`;
}

/**
 * A heartbeat check-in that creates or updates the Cron monitor on first use,
 * with no extra failure or recovery thresholds: Robin Admin already decided
 * whether it is healthy. Sentry measures the margin from the minute the last
 * check-in fell in, and check-ins go out a few seconds after each interval, so
 * the margin carries one spare minute to keep that drift from counting as missed.
 */
export function sentryCronCheckIn(status: 'ok' | 'error', intervalSeconds: number): JsonRecord {
  const minutes = Math.max(1, Math.ceil(intervalSeconds / 60));
  return {
    status,
    monitor_config: {
      schedule: { type: 'interval', value: minutes, unit: 'minute' },
      checkin_margin: minutes + 1,
      failure_issue_threshold: 1,
      recovery_threshold: 1,
    },
  };
}

export interface SentryAlertSignal {
  /** Stable per alert subject: one subject is one Sentry issue. */
  alertKey: string;
  alertType: AlertType;
  eventKind: AlertEventKind;
  /** The issue title; stable for the subject (for example "SMTP mx.example.com:25 is down"). */
  title: string;
  /** What happened at this event. */
  message: string;
  severity: 'critical' | 'warning' | 'info';
  environment?: string | null;
  tags?: Record<string, string | number | boolean | null | undefined>;
  context: JsonRecord;
  /** A path under Robin Admin's public URL with the detail, for example "/monitoring". */
  linkPath?: string | null;
  occurredAt: Date;
}

function tagValue(value: string | number | boolean): string {
  return String(value).replace(/[\r\n]+/g, ' ').slice(0, TAG_VALUE_MAX);
}

/**
 * What a Sentry delivery stores: an event for failures and tests, a resolve
 * request for recoveries or operator dismissals. Repeats are not sent; Sentry's
 * alert rules handle re-notification.
 */
export function buildSentryAlertPayload(signal: SentryAlertSignal): JsonRecord | null {
  if (signal.eventKind === 'repeat') return null;
  if (signal.eventKind === 'recovery' || signal.eventKind === 'dismissed') {
    return { sentry: { action: 'resolve', alertKey: signal.alertKey } };
  }
  const tags: Record<string, string> = {};
  for (const [name, value] of Object.entries(signal.tags ?? {})) {
    if (value !== null && value !== undefined && value !== '') tags[name.slice(0, 32)] = tagValue(value);
  }
  tags.alert_type = signal.alertType;
  tags.alert_key = tagValue(signal.alertKey);
  tags.instance = tagValue(operationsPolicy().alertInstanceName);
  const event: Event = {
    event_id: randomUUID().replace(/-/g, ''),
    timestamp: signal.occurredAt.getTime() / 1000,
    platform: 'other',
    level: signal.severity === 'critical' ? 'error' : signal.severity === 'warning' ? 'warning' : 'info',
    logger: 'robin-admin.alerts',
    message: signal.title,
    fingerprint: ['robin-admin', signal.alertKey],
    environment: signal.environment || 'production',
    tags,
    contexts: {
      robin_admin: {
        summary: signal.message,
        event: signal.eventKind,
        ...(signal.linkPath ? { link: `${config.publicBaseUrl}${signal.linkPath}` } : {}),
        ...signal.context,
      },
    },
  };
  return { sentry: { action: 'event', alertKey: signal.alertKey, event: event as unknown as JsonRecord } };
}

export interface SentryDestination {
  dsn: string;
  org: string | null;
  apiToken: string | null;
  apiUrl: string | null;
}

export type SentryDeliveryResult = AlertTransportResult & { skipped?: boolean };

/** The URL a destination actually sends to, for safety checks before sending. */
export function sentryDeliveryUrl(destination: SentryDestination, payload: JsonRecord): string | null {
  const dsn = parseSentryDsn(destination.dsn);
  if (!dsn) return null;
  const sentry = payload.sentry as { action?: string } | undefined;
  if (sentry?.action === 'resolve') {
    return `${(destination.apiUrl || sentryApiBase(dsn)).replace(/\/$/, '')}/api/0/`;
  }
  return getEnvelopeEndpointWithUrlEncodedAuth(dsn);
}

export async function sendSentryAlert(
  destination: SentryDestination,
  payload: JsonRecord,
  notificationId: string,
  send = sendAlertWebhook,
): Promise<SentryDeliveryResult> {
  const dsn = parseSentryDsn(destination.dsn);
  if (!dsn) return { accepted: false, retryable: false, status: null, error: 'Sentry DSN is invalid' };
  const sentry = payload.sentry as { action?: string; alertKey?: string; event?: Event } | undefined;
  if (sentry?.action === 'event' && sentry.event) {
    const envelope = serializeEnvelope(createEventEnvelope(sentry.event, dsn, { sdk: { name: 'robin-admin.alerts', version: '1.0.0' } }));
    return send({
      adapter: 'sentry',
      webhookUrl: getEnvelopeEndpointWithUrlEncodedAuth(dsn),
      body: typeof envelope === 'string' ? envelope : Buffer.from(envelope).toString('utf8'),
      contentType: 'application/x-sentry-envelope',
      notificationId,
    });
  }
  if (sentry?.action === 'resolve' && sentry.alertKey) {
    if (!destination.org || !destination.apiToken) {
      return {
        accepted: false,
        retryable: false,
        status: null,
        error: 'No Sentry organization and API token are set, so the issue is left to Sentry auto-resolve',
        skipped: true,
      };
    }
    const params = new URLSearchParams({
      project: dsn.projectId,
      query: `is:unresolved alert_key:"${sentry.alertKey}"`,
      limit: '10',
    });
    const base = (destination.apiUrl || sentryApiBase(dsn)).replace(/\/$/, '');
    return send({
      adapter: 'sentry',
      webhookUrl: `${base}/api/0/organizations/${encodeURIComponent(destination.org)}/issues/?${params.toString()}`,
      method: 'PUT',
      body: JSON.stringify({ status: 'resolved' }),
      headers: { Authorization: `Bearer ${destination.apiToken}` },
      notificationId,
    });
  }
  return { accepted: false, retryable: false, status: null, error: 'Sentry delivery payload is invalid' };
}
