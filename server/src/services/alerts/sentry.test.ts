import { describe, expect, it, vi } from 'vitest';
import { makeDsn } from '@sentry/core';
import {
  buildSentryAlertPayload,
  isSentryCronCheckInUrl,
  parseSentryDsn,
  sendSentryAlert,
  sentryApiBase,
  sentryCronCheckIn,
  sentryDeliveryUrl,
  type SentryAlertSignal,
} from './sentry.js';

vi.mock('../operations-settings.js', () => ({ operationsPolicy: () => ({ alertInstanceName: 'Robin Admin' }) }));
vi.mock('../../config.js', () => ({ config: { publicBaseUrl: 'https://admin.example.test/admin' } }));

const DSN = 'https://abc123def456@o1001.ingest.us.sentry.io/4502';

const signal: SentryAlertSignal = {
  alertKey: 'monitoring:check:7',
  alertType: 'monitoring_issue',
  eventKind: 'failure',
  title: 'SMTP mx.example.test:25 is down',
  message: 'SMTP mx.example.test:25 is down',
  severity: 'critical',
  environment: 'staging',
  tags: { target: 'cube-main', check_type: 'smtp', empty: '' },
  context: { error: 'Probe timed out' },
  linkPath: '/monitoring',
  occurredAt: new Date('2026-10-08T12:00:00Z'),
};

describe('Sentry DSN and URLs', () => {
  it('accepts only https DSNs with a key and project', () => {
    expect(parseSentryDsn(DSN)).toMatchObject({ publicKey: 'abc123def456', projectId: '4502', host: 'o1001.ingest.us.sentry.io' });
    expect(parseSentryDsn('http://abc@o1.ingest.sentry.io/1')).toBeNull();
    expect(parseSentryDsn('https://o1.ingest.sentry.io/1')).toBeNull();
    expect(parseSentryDsn('not a url')).toBeNull();
  });

  it('derives the regional API host, or the DSN host when self-hosted', () => {
    expect(sentryApiBase(makeDsn(DSN)!)).toBe('https://us.sentry.io');
    expect(sentryApiBase(makeDsn('https://k@o1.ingest.sentry.io/1')!)).toBe('https://sentry.io');
    expect(sentryApiBase(makeDsn('https://k@o1.ingest.de.sentry.io/1')!)).toBe('https://de.sentry.io');
    expect(sentryApiBase(makeDsn('https://k@sentry.internal.example/5')!)).toBe('https://sentry.internal.example');
  });

  it('recognises Sentry Cron check-in URLs', () => {
    expect(isSentryCronCheckInUrl('https://o1.ingest.us.sentry.io/api/2/cron/robin-admin/abc123/')).toBe(true);
    expect(isSentryCronCheckInUrl('https://hc-ping.com/abc')).toBe(false);
    expect(isSentryCronCheckInUrl('http://o1.ingest.sentry.io/api/2/cron/x/abc/')).toBe(false);
  });

  it('builds an interval check-in whose monitor needs no extra thresholds', () => {
    expect(sentryCronCheckIn('error', 90)).toEqual({
      status: 'error',
      monitor_config: { schedule: { type: 'interval', value: 2, unit: 'minute' }, checkin_margin: 3, failure_issue_threshold: 1, recovery_threshold: 1 },
    });
  });
});

describe('buildSentryAlertPayload', () => {
  it('groups by the alert key and carries environment, tags and a link back', () => {
    const payload = buildSentryAlertPayload(signal) as { sentry: { action: string; event: Record<string, unknown> } };
    expect(payload.sentry.action).toBe('event');
    expect(payload.sentry.event).toMatchObject({
      level: 'error',
      message: 'SMTP mx.example.test:25 is down',
      fingerprint: ['robin-admin', 'monitoring:check:7'],
      environment: 'staging',
      tags: { target: 'cube-main', check_type: 'smtp', alert_type: 'monitoring_issue', alert_key: 'monitoring:check:7', instance: 'Robin Admin' },
      contexts: { robin_admin: { link: 'https://admin.example.test/admin/monitoring', error: 'Probe timed out', event: 'failure' } },
    });
    expect((payload.sentry.event.tags as Record<string, string>).empty).toBeUndefined();
  });

  it('resolves on recovery and sends nothing for repeats', () => {
    expect(buildSentryAlertPayload({ ...signal, eventKind: 'recovery' })).toEqual({ sentry: { action: 'resolve', alertKey: 'monitoring:check:7' } });
    expect(buildSentryAlertPayload({ ...signal, eventKind: 'repeat' })).toBeNull();
  });
});

describe('sendSentryAlert', () => {
  const destination = { dsn: DSN, org: 'example-org', apiToken: 'token-1', apiUrl: null };

  it('posts an event envelope to the DSN ingest endpoint', async () => {
    const send = vi.fn().mockResolvedValue({ accepted: true, retryable: false, status: 200, error: null });
    const payload = buildSentryAlertPayload(signal)!;
    await sendSentryAlert(destination, payload, 'n-1', send);
    const input = send.mock.calls[0][0];
    expect(input.webhookUrl).toMatch(/^https:\/\/o1001\.ingest\.us\.sentry\.io\/api\/4502\/envelope\/\?.*sentry_key=abc123def456/);
    expect(input.contentType).toBe('application/x-sentry-envelope');
    const [header, itemHeader, item] = String(input.body).split('\n');
    expect(JSON.parse(header)).toMatchObject({ sdk: { name: 'robin-admin.alerts' } });
    expect(JSON.parse(itemHeader)).toMatchObject({ type: 'event' });
    expect(JSON.parse(item)).toMatchObject({ fingerprint: ['robin-admin', 'monitoring:check:7'] });
    expect(sentryDeliveryUrl(destination, payload)).toBe(input.webhookUrl);
  });

  it('resolves the issue by its alert key through the REST API', async () => {
    const send = vi.fn().mockResolvedValue({ accepted: true, retryable: false, status: 200, error: null });
    await sendSentryAlert(destination, { sentry: { action: 'resolve', alertKey: 'monitoring:check:7' } }, 'n-2', send);
    const input = send.mock.calls[0][0];
    const url = new URL(input.webhookUrl);
    expect(url.origin + url.pathname).toBe('https://us.sentry.io/api/0/organizations/example-org/issues/');
    expect(url.searchParams.get('project')).toBe('4502');
    expect(url.searchParams.get('query')).toBe('is:unresolved alert_key:"monitoring:check:7"');
    expect(input).toMatchObject({ method: 'PUT', body: JSON.stringify({ status: 'resolved' }), headers: { Authorization: 'Bearer token-1' } });
  });

  it('skips resolving without an organization and token', async () => {
    const send = vi.fn();
    const result = await sendSentryAlert({ ...destination, apiToken: null }, { sentry: { action: 'resolve', alertKey: 'k' } }, 'n-3', send);
    expect(result).toMatchObject({ accepted: false, skipped: true });
    expect(send).not.toHaveBeenCalled();
  });

  it('rejects an invalid DSN without retrying', async () => {
    const result = await sendSentryAlert({ ...destination, dsn: 'https://example.test' }, { sentry: { action: 'resolve', alertKey: 'k' } }, 'n-4', vi.fn());
    expect(result).toMatchObject({ accepted: false, retryable: false, error: 'Sentry DSN is invalid' });
  });
});
