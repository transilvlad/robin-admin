import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './alerting.js';
import * as alerts from '../db/queries/alerts.js';
import * as rules from '../db/queries/telemetry-alert-rules.js';
import * as issues from '../db/queries/telemetry-alert-issues.js';
import * as telemetryRules from '../services/alerts/telemetry-rules.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
  getCurrentAdmin: () => ({ adminId: 1 }),
}));
vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../middleware/security.js', () => ({ validateOutboundUrl: vi.fn(() => null) }));
vi.mock('../middleware/audit.js', () => ({
  AuditActions: {
    ALERT_WEBHOOK_CREATE: 'alert_webhook.create',
    ALERT_WEBHOOK_UPDATE: 'alert_webhook.update',
    ALERT_WEBHOOK_DELETE: 'alert_webhook.delete',
    ALERT_WEBHOOK_TEST: 'alert_webhook.test',
    ALERT_WEBHOOK_PAUSE: 'alert_webhook.pause',
    ALERT_WEBHOOK_RESUME: 'alert_webhook.resume',
    TELEMETRY_ALERT_RULE_CREATE: 'telemetry_alert_rule.create',
    TELEMETRY_ALERT_RULE_UPDATE: 'telemetry_alert_rule.update',
    TELEMETRY_ALERT_RULE_DELETE: 'telemetry_alert_rule.delete',
    TELEMETRY_ALERT_ISSUE_DISMISS: 'telemetry_alert_issue.dismiss',
    TELEMETRY_ALERT_ISSUE_RESUME: 'telemetry_alert_issue.resume',
  },
  logAudit: vi.fn(),
}));
vi.mock('../db/queries/alerts.js', () => ({
  createAlertDelivery: vi.fn(),
  createAlertWebhook: vi.fn(),
  deleteAlertWebhook: vi.fn(),
  getAlertRuntimeSummary: vi.fn(),
  getAlertWebhook: vi.fn(),
  listAlertDeliveries: vi.fn(),
  listAlertWebhooks: vi.fn(),
  pauseAlertWebhook: vi.fn(),
  resumeAlertWebhook: vi.fn(),
  updateAlertWebhook: vi.fn(),
}));
vi.mock('../db/queries/telemetry-alert-rules.js', () => ({
  createTelemetryAlertRule: vi.fn(),
  listTelemetryAlertRules: vi.fn(),
  updateTelemetryAlertRule: vi.fn(),
}));
vi.mock('../db/queries/telemetry-alert-issues.js', () => ({
  getTelemetryAlertIssueById: vi.fn(),
  listTelemetryAlertIssues: vi.fn(),
}));
vi.mock('../services/alerts/telemetry-rules.js', () => ({
  changeTelemetryAlertIssueDismissal: vi.fn(),
  deleteTelemetryAlertRuleWithRecoveries: vi.fn(),
  previewTelemetryAlertRule: vi.fn(),
  updateTelemetryAlertRuleWithRecoveries: vi.fn(),
}));
vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(() => Promise.resolve({ alertDeliveryRetentionDays: 30 })),
}));
vi.mock('../logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

let server: Server;
let baseUrl: string;

const webhook = {
  id: 1,
  name: 'Operations',
  adapter: 'slack' as const,
  enabled: true,
  hasSecret: true,
  subscriptions: [],
  consecutiveFailures: 3,
  repeatIntervalSeconds: 14400,
  notifyRecovery: true,
  pausedAt: null,
  pausedUntil: null,
  pauseReason: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api', router);
  await new Promise<void>((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(alerts.listAlertWebhooks).mockResolvedValue([webhook]);
  vi.mocked(alerts.getAlertRuntimeSummary).mockResolvedValue({
    enabledWebhooks: 1,
    pausedWebhooks: 0,
    pendingDeliveries: 0,
    failedDeliveries: 0,
  });
  vi.mocked(alerts.getAlertWebhook).mockResolvedValue(webhook);
});

describe('alert webhook routes', () => {
  it('returns the fixed catalog and sanitized webhook records', async () => {
    const response = await fetch(`${baseUrl}/api/alert-webhooks`);
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.webhooks[0]).toMatchObject({ name: 'Operations', hasSecret: true });
    expect(body.data.catalog).toHaveLength(17);
    expect(JSON.stringify(body)).not.toContain('encrypted_url');
  });

  it('keeps preview network-free', async () => {
    const response = await fetch(`${baseUrl}/api/alert-webhooks/1/preview`, { method: 'POST' });
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.data.networkEffect).toBe(false);
    expect(alerts.createAlertDelivery).not.toHaveBeenCalled();
  });

  it('requires explicit live-send confirmation', async () => {
    const response = await fetch(`${baseUrl}/api/alert-webhooks/1/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(response.status).toBe(400);
    expect(alerts.createAlertDelivery).not.toHaveBeenCalled();
  });

  it('rejects non-HTTPS webhook URLs before persistence', async () => {
    const response = await fetch(`${baseUrl}/api/alert-webhooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Unsafe',
        adapter: 'generic',
        webhookUrl: 'http://example.com/hook',
      }),
    });
    expect(response.status).toBe(400);
    expect(alerts.createAlertWebhook).not.toHaveBeenCalled();
  });
});

describe('telemetry alert rule routes', () => {
  const body = { name: 'SMTP egress down', query: 'min by (host) (smtp_egress_ok)', comparator: '<', threshold: 1, forSeconds: 300 };
  const post = (path: string, payload: unknown, method = 'POST') => fetch(`${baseUrl}/api${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });

  it('creates a rule with defaults for severity and enabled', async () => {
    vi.mocked(rules.createTelemetryAlertRule).mockResolvedValue({ id: 7 } as never);
    const response = await post('/telemetry-alert-rules', body);
    expect(response.status).toBe(201);
    expect(rules.createTelemetryAlertRule).toHaveBeenCalledWith({ ...body, description: null, severity: 'critical', enabled: true });
  });

  it('rejects an unknown comparator, a non-numeric threshold and an out-of-range duration', async () => {
    for (const bad of [{ ...body, comparator: '=>' }, { ...body, threshold: '1' }, { ...body, forSeconds: 90000 }, { ...body, query: '' }]) {
      const response = await post('/telemetry-alert-rules', bad);
      expect(response.status).toBe(400);
    }
    expect(rules.createTelemetryAlertRule).not.toHaveBeenCalled();
  });

  it('returns 404 when updating or deleting a missing rule', async () => {
    vi.mocked(telemetryRules.updateTelemetryAlertRuleWithRecoveries).mockResolvedValue(null);
    vi.mocked(telemetryRules.deleteTelemetryAlertRuleWithRecoveries).mockResolvedValue(false);
    expect((await post('/telemetry-alert-rules/99', body, 'PUT')).status).toBe(404);
    expect((await fetch(`${baseUrl}/api/telemetry-alert-rules/99`, { method: 'DELETE' })).status).toBe(404);
  });

  it('previews which series match', async () => {
    vi.mocked(telemetryRules.previewTelemetryAlertRule).mockResolvedValue({ series: [{ labels: { host: 'a' }, value: 0, matches: true }], truncated: false });
    const response = await post('/telemetry-alert-rules/preview', { query: body.query, comparator: '<', threshold: 1 });
    expect(response.status).toBe(200);
    expect((await response.json()).data.series[0].matches).toBe(true);
  });

  it('validates issue filters and returns a paginated issue list', async () => {
    vi.mocked(issues.listTelemetryAlertIssues).mockResolvedValue({ issues: [], total: 0 });
    expect((await fetch(`${baseUrl}/api/telemetry-alert-issues?status=unknown`)).status).toBe(400);
    const response = await fetch(`${baseUrl}/api/telemetry-alert-issues?status=active&limit=10&offset=0`);
    expect(response.status).toBe(200);
    expect(issues.listTelemetryAlertIssues).toHaveBeenCalledWith({ status: 'active', limit: 10, offset: 0 });
  });

  it('rejects invalid dismissal input and returns conflicts for stale issue actions', async () => {
    const invalid = await post('/telemetry-alert-issues/11a00195-51c9-49a8-812a-31ae48541c23/dismiss', {
      expectedRevision: 0,
    });
    expect(invalid.status).toBe(400);
    expect(telemetryRules.changeTelemetryAlertIssueDismissal).not.toHaveBeenCalled();

    vi.mocked(telemetryRules.changeTelemetryAlertIssueDismissal).mockResolvedValue('conflict');
    const stale = await post('/telemetry-alert-issues/11a00195-51c9-49a8-812a-31ae48541c23/dismiss', {
      expectedRevision: 1,
      reason: 'Reviewed',
    });
    expect(stale.status).toBe(409);
    expect(telemetryRules.changeTelemetryAlertIssueDismissal).toHaveBeenCalledWith(expect.objectContaining({
      action: 'dismiss',
      expectedRevision: 1,
      reason: 'Reviewed',
      actorAdminId: 1,
    }));
  });
});
