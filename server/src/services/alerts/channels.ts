import { createHash } from 'node:crypto';
import type { AlertEventKind, AlertType, JsonRecord } from '../../types/alerts.js';

export const PAGERDUTY_EVENTS_URL = 'https://events.pagerduty.com/v2/enqueue';

export interface ChannelNotification {
  notificationId: string;
  destinationUid: string;
  eventKind: AlertEventKind;
  alertType: AlertType;
  serviceId: string;
  serviceName: string;
  monitoringIssueId?: number | null;
  telemetryAlertIssueId?: string | null;
  payload: JsonRecord;
}

export function validAlertEmail(value: string): boolean {
  return value.length <= 254
    && !value.includes('..')
    && /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?\.[A-Za-z0-9-]+$/.test(value);
}

export function validPagerDutyKey(value: string): boolean {
  return /^[A-Za-z0-9]{32}$/.test(value);
}

function singleLine(value: string, limit: number): string {
  return value.replace(/[\x00-\x1f\x7f]+/g, ' ').trim().slice(0, limit);
}

function summary(notification: ChannelNotification): string {
  const { payload } = notification;
  const value = typeof payload.summary === 'string' ? payload.summary
    : typeof payload.text === 'string' ? payload.text
      : typeof payload.title === 'string' ? payload.title
        : `${notification.serviceName}: ${notification.alertType}`;
  return singleLine(value, 900) || `${notification.serviceName}: ${notification.alertType}`;
}

function details(notification: ChannelNotification, limit: number): string {
  return JSON.stringify(notification.payload, null, 2).slice(0, limit);
}

export function buildAlertEmail(notification: ChannelNotification): { subject: string; text: string } {
  const title = summary(notification);
  return {
    subject: `[${notification.eventKind.toUpperCase()}] ${title}`.slice(0, 998),
    text: `${title}\n\n${details(notification, 12000)}\n\nNotification ID: ${notification.notificationId}`,
  };
}

export function buildTeamsAlert(notification: ChannelNotification): JsonRecord {
  return {
    type: 'message',
    attachments: [{
      contentType: 'application/vnd.microsoft.card.adaptive',
      contentUrl: null,
      content: {
        $schema: 'http://adaptivecards.io/schemas/adaptive-card.json',
        type: 'AdaptiveCard',
        version: '1.2',
        body: [
          { type: 'TextBlock', text: summary(notification), weight: 'Bolder', wrap: true },
          { type: 'FactSet', facts: [
            { title: 'Event', value: notification.eventKind },
            { title: 'Alert', value: notification.alertType },
            { title: 'Service', value: singleLine(notification.serviceName, 160) },
            { title: 'Notification', value: notification.notificationId },
          ] },
          { type: 'TextBlock', text: details(notification, 3000), wrap: true },
        ],
      },
    }],
  };
}

export function buildPagerDutyAlert(notification: ChannelNotification, routingKey: string): JsonRecord {
  const identity = notification.eventKind === 'test' ? `test:${notification.notificationId}`
    : notification.telemetryAlertIssueId ? `telemetry:${notification.telemetryAlertIssueId}`
      : notification.monitoringIssueId ? `monitoring:${notification.monitoringIssueId}`
        : `service:${notification.serviceId}`;
  const dedupKey = createHash('sha256')
    .update(JSON.stringify([notification.destinationUid, notification.alertType, identity]))
    .digest('hex');
  const eventAction = notification.eventKind === 'recovery' || notification.eventKind === 'dismissed' ? 'resolve' : 'trigger';
  const rule = notification.payload.rule;
  const ruleSeverity = rule && typeof rule === 'object' && 'severity' in rule ? rule.severity : null;
  const monitoring = notification.payload.monitoring;
  const monitoringStatus = monitoring && typeof monitoring === 'object' && 'status' in monitoring ? monitoring.status : null;
  const severity = notification.eventKind === 'test' ? 'info'
    : ruleSeverity === 'warning' || monitoringStatus === 'warning' || notification.alertType.startsWith('logs_')
      || notification.alertType === 'email_delivery_failure' ? 'warning' : 'critical';
  return {
    routing_key: routingKey,
    event_action: eventAction,
    dedup_key: `robin-admin:${dedupKey}`,
    ...(eventAction === 'trigger' ? {
      client: 'Robin Admin',
      payload: {
        summary: summary(notification),
        source: singleLine(notification.serviceId, 255),
        severity,
        class: notification.alertType,
        custom_details: {
          notification_id: notification.notificationId,
          service: notification.serviceName,
          details: details(notification, 12000),
        },
      },
    } : {}),
  };
}
