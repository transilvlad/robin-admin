import { enqueueEmailDelivery } from '../../db/queries/email.js';
import type { StatusPageSubscriber } from '../../types/email.js';
import type { MonitoringIssue } from '../../types/monitoring.js';
import type { StatusPageReport, StatusPageMaintenance } from '../../types/status-page.js';

export async function enqueueStatusSubscriptionConfirmation(input: {
  subscriber: StatusPageSubscriber;
  token: string;
  baseUrl: string;
}): Promise<void> {
  const url = `${input.baseUrl}/status?confirm=${encodeURIComponent(input.token)}`;
  await enqueueEmailDelivery({
    purpose: 'status_subscription_confirm',
    senderProfileKey: 'status',
    recipientEmail: input.subscriber.email,
    recipientKind: 'status_subscriber',
    subject: 'Confirm your status page subscription',
    textBody: `Confirm your status page subscription by opening this link:\n\n${url}\n\nIf you did not request this, you can ignore this message.`,
    htmlBody: `<p>Confirm your status page subscription by opening this link:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>If you did not request this, you can ignore this message.</p>`,
    metadata: { subscriberId: input.subscriber.id },
  });
}

export async function enqueuePasswordRecoveryEmail(input: {
  email: string;
  token: string;
  baseUrl: string;
}): Promise<void> {
  const url = `${input.baseUrl}/reset-password?token=${encodeURIComponent(input.token)}`;
  await enqueueEmailDelivery({
    purpose: 'password_recovery',
    senderProfileKey: 'system',
    recipientEmail: input.email,
    recipientKind: 'admin',
    subject: 'Reset your Robin Admin password',
    textBody: `Reset your Robin Admin password by opening this link:\n\n${url}\n\nThis link expires soon. If you did not request this, ignore this message.`,
    htmlBody: `<p>Reset your Robin Admin password by opening this link:</p><p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p><p>This link expires soon. If you did not request this, ignore this message.</p>`,
  });
}

export async function enqueueMonitoringIssueAdminEmail(input: {
  email: string;
  issue: MonitoringIssue;
  event: 'opened' | 'recovered';
}): Promise<void> {
  await enqueueEmailDelivery({
    purpose: `monitoring_issue_${input.event}`,
    senderProfileKey: 'alerts',
    recipientEmail: input.email,
    recipientKind: 'admin',
    subject: `${input.issue.summary} ${input.event === 'opened' ? 'failed' : 'recovered'}`,
    textBody: `${input.issue.summary}\n\nStatus: ${input.event}\nSeverity: ${input.issue.severity}\nOpened: ${input.issue.openedAt.toISOString()}`,
    metadata: { monitoringIssueId: input.issue.id, event: input.event },
  });
}

export async function enqueueStatusReportSubscriberEmail(input: {
  email: string;
  report: StatusPageReport;
  unsubscribeUrl?: string;
}): Promise<void> {
  const components = input.report.components.map((component) => component.publicName).join(', ') || 'Status page';
  const unsubscribe = input.unsubscribeUrl ? `\n\nUnsubscribe: ${input.unsubscribeUrl}` : '';
  await enqueueEmailDelivery({
    purpose: 'status_report_update',
    senderProfileKey: 'status',
    recipientEmail: input.email,
    recipientKind: 'status_subscriber',
    subject: `${input.report.title} (${input.report.status})`,
    textBody: `${input.report.title}\n\nImpact: ${input.report.impact}\nComponents: ${components}\nStatus: ${input.report.status}${unsubscribe}`,
    metadata: { statusPageReportId: input.report.id },
  });
}

export async function enqueueMaintenanceSubscriberEmail(input: {
  email: string;
  maintenance: StatusPageMaintenance;
  unsubscribeUrl?: string;
}): Promise<void> {
  const components = input.maintenance.components.map((component) => component.publicName).join(', ') || 'Status page';
  const unsubscribe = input.unsubscribeUrl ? `\n\nUnsubscribe: ${input.unsubscribeUrl}` : '';
  await enqueueEmailDelivery({
    purpose: 'status_maintenance',
    senderProfileKey: 'status',
    recipientEmail: input.email,
    recipientKind: 'status_subscriber',
    subject: `Maintenance: ${input.maintenance.title}`,
    textBody: `${input.maintenance.title}\n\n${input.maintenance.message}\n\nComponents: ${components}\nWindow: ${input.maintenance.startsAt.toISOString()} - ${input.maintenance.endsAt.toISOString()}${unsubscribe}`,
    metadata: { maintenanceId: input.maintenance.id },
  });
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
