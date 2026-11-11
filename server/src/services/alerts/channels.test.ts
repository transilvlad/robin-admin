import { describe, expect, it } from 'vitest';
import { buildAlertEmail, buildPagerDutyAlert, buildTeamsAlert, validAlertEmail, validPagerDutyKey, type ChannelNotification } from './channels.js';

const notification: ChannelNotification = {
  notificationId: 'notification-1',
  destinationUid: 'destination-1',
  eventKind: 'failure',
  alertType: 'telemetry_rule',
  serviceId: 'telemetry-rule-1',
  serviceName: 'Database',
  telemetryAlertIssueId: 'series-a',
  payload: { summary: 'Database down', rule: { severity: 'critical' } },
};

describe('alert channel formats', () => {
  it('creates a Teams Workflows Adaptive Card and bounds its size', () => {
    const body = buildTeamsAlert({ ...notification, payload: { summary: 'Database down', details: 'x'.repeat(100000) } });
    expect(body).toMatchObject({
      type: 'message',
      attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard', version: '1.2' } }],
    });
    expect(JSON.stringify(body)).toContain('Database down');
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(28 * 1024);
  });

  it('correlates PagerDuty recovery and dismissal with the same issue but separates other series and destinations', () => {
    const trigger = buildPagerDutyAlert(notification, 'key');
    const recovery = buildPagerDutyAlert({ ...notification, eventKind: 'recovery' }, 'key');
    const dismissed = buildPagerDutyAlert({ ...notification, eventKind: 'dismissed' }, 'key');
    expect(trigger).toMatchObject({
      routing_key: 'key', event_action: 'trigger', payload: { summary: 'Database down', source: 'telemetry-rule-1', severity: 'critical' },
    });
    expect(recovery).toMatchObject({ event_action: 'resolve', dedup_key: trigger.dedup_key });
    expect(dismissed).toMatchObject({ event_action: 'resolve', dedup_key: trigger.dedup_key });
    expect(buildPagerDutyAlert({ ...notification, telemetryAlertIssueId: 'series-b' }, 'key').dedup_key).not.toBe(trigger.dedup_key);
    expect(buildPagerDutyAlert({ ...notification, destinationUid: 'destination-2' }, 'key').dedup_key).not.toBe(trigger.dedup_key);
    expect(buildPagerDutyAlert({ ...notification, eventKind: 'test' }, 'key').dedup_key).not.toBe(trigger.dedup_key);
  });

  it('prevents email header injection and rejects unsafe destination values', () => {
    const email = buildAlertEmail({ ...notification, payload: { summary: 'Down\r\nBcc: other@example.com' } });
    expect(email.subject).not.toMatch(/[\r\n]/);
    expect(email.text).toContain('notification-1');
    expect(validAlertEmail('alerts+ops@example.com')).toBe(true);
    for (const address of ['one@example.com\r\nRCPT TO:<other@example.com>', 'one@example.com,other@example.com', '<one@example.com>']) {
      expect(validAlertEmail(address)).toBe(false);
    }
    expect(validPagerDutyKey('a'.repeat(32))).toBe(true);
    expect(validPagerDutyKey('a'.repeat(31))).toBe(false);
  });
});
