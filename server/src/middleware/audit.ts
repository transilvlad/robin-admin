/**
 * Audit logging middleware.
 */

import { Request, Response, NextFunction } from 'express';
import { createAuditEntry } from '../db/queries/audit.js';
import { getTrustedClientIp } from './security.js';
import { logger } from '../logger.js';

export interface AuditContext {
  entityType: string;
  entityId?: string;
  oldValues?: Record<string, unknown>;
  newValues?: Record<string, unknown>;
}

// Audit values are stored in the clear, so secrets never go in: any string
// field whose name looks like a credential is replaced, however deeply nested.
// Flags and counts (passwordChanged: true) are kept.
const SECRET_KEY_PATTERN = /password|passwd|secret|token(?!iz)|credential|api[-_]?key|private[-_]?key|dsn|webhook[-_]?url/i;
export const REDACTED = '[redacted]';

export function redactAuditValues(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(redactAuditValues);
  }
  if (!value || typeof value !== 'object') {
    return value;
  }
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, entry]) => {
    const holdsSecret = SECRET_KEY_PATTERN.test(key)
      && (typeof entry === 'string' ? entry !== '' : Boolean(entry) && typeof entry === 'object');
    return [key, holdsSecret ? REDACTED : redactAuditValues(entry)];
  }));
}

/**
 * Log an audit entry for the current request.
 */
export async function logAudit(
  req: Request,
  action: string,
  context: AuditContext
): Promise<void> {
  try {
    const adminId = req.session?.admin?.id ?? req.apiKey?.createdBy ?? null;
    // Uses the same trusted-CIDR IP resolution as rate limiting, IP
    // allowlisting, and ingestion auth so the audit trail can't disagree with
    // those decisions about who a request came from.
    const ipAddress = await getTrustedClientIp(req);

    await createAuditEntry(
      adminId,
      action,
      context.entityType,
      context.entityId ?? null,
      context.oldValues ? redactAuditValues(context.oldValues) as Record<string, unknown> : null,
      context.newValues ? redactAuditValues(context.newValues) as Record<string, unknown> : null,
      ipAddress
    );
  } catch (error) {
    logger.error('Failed to create audit log entry', {
      error: (error as Error).message,
      action,
      entityType: context.entityType,
    });
  }
}

/**
 * Audit actions
 */
export const AuditActions = {
  // Admin actions
  ADMIN_LOGIN: 'admin.login',
  ADMIN_LOGOUT: 'admin.logout',
  ADMIN_LOGIN_FAILED: 'admin.login_failed',
  ADMIN_LOGIN_LOCKED: 'admin.login_locked',
  ADMIN_PASSWORD_RECOVERY_REQUESTED: 'admin.password_recovery_requested',
  ADMIN_PASSWORD_RECOVERY_COMPLETED: 'admin.password_recovery_completed',
  API_KEY_CREATE: 'api_key.create',
  API_KEY_REVOKE: 'api_key.revoke',
  API_KEY_DELETE: 'api_key.delete',
  IP_JAIL_CREATE: 'ip_jail.create',
  IP_JAIL_UPDATE: 'ip_jail.update',
  IP_JAIL_LIFT: 'ip_jail.lift',
  RSPAMD_SETTINGS_UPDATE: 'rspamd.settings_update',
  RSPAMD_CONFIG_UPDATE: 'rspamd.config_update',
  RSPAMD_RULES_UPDATE: 'rspamd.rules_update',
  RSPAMD_DKIM_DOMAIN_CREATE: 'rspamd.dkim_domain_create',
  RSPAMD_DKIM_DOMAIN_UPDATE: 'rspamd.dkim_domain_update',
  RSPAMD_DKIM_KEY_CREATE: 'rspamd.dkim_key_create',
  RSPAMD_DKIM_KEY_ROTATE: 'rspamd.dkim_key_rotate',
  RSPAMD_DKIM_KEY_REVOKE: 'rspamd.dkim_key_revoke',
  RSPAMD_TRAINING_IMPORT: 'rspamd.training_import',
  RSPAMD_TRAINING_LEARN: 'rspamd.training_learn',
  RSPAMD_TRAINING_RELABEL: 'rspamd.training_relabel',
  RSPAMD_TRAINING_DELETE: 'rspamd.training_delete',
  RSPAMD_SCAN_RUN: 'rspamd.scan_run',
  RSPAMD_SCAN_REPLAY: 'rspamd.scan_replay',
  RSPAMD_SCAN_LEARN: 'rspamd.scan_learn',
  RSPAMD_SCAN_FUZZY: 'rspamd.scan_fuzzy',
  RSPAMD_CLASSIFIERS_UPDATE: 'rspamd.classifiers_update',
  ADMIN_CREATE: 'admin.create',
  ADMIN_UPDATE: 'admin.update',
  ADMIN_DELETE: 'admin.delete',
  
  // User actions
  USER_CREATE: 'user.create',
  USER_UPDATE: 'user.update',
  USER_DELETE: 'user.delete',
  
  // Alias actions
  ALIAS_CREATE: 'alias.create',
  ALIAS_UPDATE: 'alias.update',
  ALIAS_DELETE: 'alias.delete',
  
  // Auto-alias actions
  AUTO_ALIAS_CREATE: 'auto_alias.create',
  AUTO_ALIAS_UPDATE: 'auto_alias.update',
  AUTO_ALIAS_DELETE: 'auto_alias.delete',
  
  // Queue actions
  QUEUE_RETRY: 'queue.retry',
  QUEUE_DELETE: 'queue.delete',
  QUEUE_BOUNCE: 'queue.bounce',
  QUEUE_BULK_RETRY: 'queue.bulk_retry',
  QUEUE_BULK_DELETE: 'queue.bulk_delete',
  QUEUE_BULK_BOUNCE: 'queue.bulk_bounce',
  
  // Config actions
  CONFIG_UPDATE: 'config.update',

  // Telemetry dashboard actions
  TELEMETRY_DASHBOARD_CREATE: 'telemetry_dashboard.create',
  TELEMETRY_DASHBOARD_UPDATE: 'telemetry_dashboard.update',
  TELEMETRY_DASHBOARD_DELETE: 'telemetry_dashboard.delete',
  TELEMETRY_DASHBOARD_RESTORE: 'telemetry_dashboard.restore',
  TELEMETRY_DASHBOARD_REORDER: 'telemetry_dashboard.reorder',
  TELEMETRY_DASHBOARD_KEEP: 'telemetry_dashboard.keep',
  
  // Email actions
  EMAIL_SEND: 'email.send',

  // Sheriff (module licensing) actions
  SHERIFF_LICENSE_CREATE: 'sheriff.license_create',
  SHERIFF_LICENSE_UPDATE: 'sheriff.license_update',
  SHERIFF_LICENSE_REVOKE: 'sheriff.license_revoke',
  SHERIFF_LICENSE_DELETE: 'sheriff.license_delete',

  // Alerting actions
  ALERT_WEBHOOK_CREATE: 'alert_webhook.create',
  ALERT_WEBHOOK_UPDATE: 'alert_webhook.update',
  ALERT_WEBHOOK_DELETE: 'alert_webhook.delete',
  ALERT_WEBHOOK_TEST: 'alert_webhook.test',
  ALERT_WEBHOOK_PAUSE: 'alert_webhook.pause',
  TELEMETRY_ALERT_RULE_CREATE: 'telemetry_alert_rule.create',
  TELEMETRY_ALERT_RULE_UPDATE: 'telemetry_alert_rule.update',
  TELEMETRY_ALERT_RULE_DELETE: 'telemetry_alert_rule.delete',
  TELEMETRY_ALERT_ISSUE_DISMISS: 'telemetry_alert_issue.dismiss',
  TELEMETRY_ALERT_ISSUE_RESUME: 'telemetry_alert_issue.resume',
  ALERT_WEBHOOK_RESUME: 'alert_webhook.resume',
} as const;
