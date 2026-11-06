import { createHmac, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../../config.js';
import { initializeSchema } from '../schema.js';
import { closePool, query } from '../connection.js';
import { updateConfig } from './config.js';
import { enqueueLogsBatch } from './logs-spool.js';
import { createApiKey, deleteApiKey } from './security.js';
import {
  createLogsAlertRule, createLogsSavedSearch, deleteLogsSavedSearch, listLogsAlertRules,
  listLogsSavedSearches, LogsCapacityError, updateLogsAlertRule, updateLogsSavedSearch,
} from './logs.js';
import { createAlertWebhook, deleteAlertWebhook, listAlertDeliveries } from './alerts.js';
import { deleteLogsAlertRuleWithRecovery, runLogsAlertEvaluation } from '../../services/alerts/logs-rules.js';
import { deliverQueuedLogs } from '../../services/logs-delivery.js';
import { countLogs, searchLogs } from '../../services/logs-store.js';
import { attachApiKey } from '../../middleware/security.js';
import logsRouter from '../../routes/logs.js';
import type { LogsAlertRuleInput } from '../../types/logs.js';

const input: LogsAlertRuleInput = {
  name: 'Errors', description: null, query: 'error', comparator: '>=',
  threshold: 1, windowSeconds: 300, forSeconds: 60, enabled: true,
};

describe.skipIf(process.env.LOGS_IT_DB !== '1')('Logs persistence and alert outbox (real PostgreSQL)', () => {
  beforeAll(async () => {
    if (!/^robin_test_logs($|_)/.test(process.env.DB_NAME ?? '') || !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
      throw new Error('A disposable Logs test database on loopback is required');
    }
    await initializeSchema();
    await updateConfig({ logsEnabled: true, alertsEnabled: true });
  }, 30000);
  beforeEach(async () => {
    await query('DELETE FROM logs_ingest_spool');
    await query(`
      UPDATE logs_pipeline_health_state
      SET degraded = false, failing_checks = 0, healthy_checks = 0, generation = 0,
          dropped_rows_total = NULL, dropped_observed_at = NULL, last_reason = NULL
      WHERE id = 1
    `);
  });
  afterAll(async () => { await closePool(); });

  it('round-trips saved searches, including relative ranges and filters', async () => {
    const saved = await createLogsSavedSearch({
      name: 'Errors', description: null,
      filters: { query: 'error', serviceId: 'database', sourceName: 'collector', rangePreset: '6h' },
    }, null);
    try {
      expect(saved.createdBy).toBeNull();
      const updated = await updateLogsSavedSearch(saved.id, { ...saved, name: 'Warnings', filters: { ...saved.filters, query: 'warn', rangePreset: '24h' } });
      expect(updated).toMatchObject({ name: 'Warnings', filters: { query: 'warn', rangePreset: '24h' } });
      expect(await listLogsSavedSearches()).toContainEqual(updated);
    } finally {
      await deleteLogsSavedSearch(saved.id);
    }
  });

  it('updates typed rule fields and restarts the pending hold only for condition changes', async () => {
    const rule = await createLogsAlertRule({ ...input, enabled: false });
    try {
      await query("UPDATE logs_alert_rules SET status='pending', pending_since=NOW() WHERE id=$1", [rule.id]);
      const renamed = await updateLogsAlertRule(rule.id, { ...input, enabled: false, name: 'Renamed' });
      expect(renamed?.pendingSince).not.toBeNull();
      const changed = await updateLogsAlertRule(rule.id, { ...input, enabled: false, comparator: '<=', threshold: 2 });
      expect(changed).toMatchObject({ comparator: '<=', threshold: 2, pendingSince: null });
    } finally {
      await deleteLogsAlertRuleWithRecovery(rule.id);
    }
  });

  it('persists firing and recovery once through the shared delivery outbox', async () => {
    const webhook = await createAlertWebhook({
      name: 'Logs destination', adapter: 'generic', webhookUrl: 'https://alerts.example.test/hook',
      enabled: true, notifyRecovery: true, subscriptions: [{ alertType: 'logs_rule', enabled: true }],
    });

    const rule = await createLogsAlertRule(input);
    const now = new Date();
    try {
      await runLogsAlertEvaluation(now, async () => 6);
      expect((await listLogsAlertRules()).find(item => item.id === rule.id)?.status).toBe('pending');
      await runLogsAlertEvaluation(new Date(now.getTime() + 61_000), async () => 6);
      await runLogsAlertEvaluation(new Date(now.getTime() + 121_000), async () => 6);
      await runLogsAlertEvaluation(new Date(now.getTime() + 181_000), async () => 0);
      const deliveries = (await listAlertDeliveries()).filter(item => item.webhookId === webhook.id);
      expect(deliveries.map(item => item.eventKind).sort()).toEqual(['failure', 'recovery']);
      expect(deliveries.every(item => item.alertType === 'logs_rule')).toBe(true);
      expect((await listLogsAlertRules()).find(item => item.id === rule.id)).toMatchObject({ status: 'ok', generation: 1 });
    } finally {
      await deleteLogsAlertRuleWithRecovery(rule.id);
      await query('DELETE FROM alert_deliveries WHERE webhook_id = $1', [webhook.id]);
      await deleteAlertWebhook(webhook.id);
    }
  });

  it('sends independent pipeline degradation and recovery notifications after confirmed health changes', async () => {
    const webhook = await createAlertWebhook({
      name: 'Logs pipeline destination',
      adapter: 'generic',
      webhookUrl: 'https://alerts.example.test/pipeline',
      enabled: true,
      notifyRecovery: true,
      subscriptions: [{ alertType: 'logs_pipeline_health', enabled: true }],
    });
    const marker = randomUUID();
    const queued = await enqueueLogsBatch({
      origin: 'http',
      rows: [{ _time: new Date().toISOString(), _msg: marker, source: 'integration', service_id: 'pipeline-test' }],
      maxBytes: config.logs.spoolMaxBytes,
    });
    expect(queued).toBe('queued');
    await query("UPDATE logs_ingest_spool SET created_at = CURRENT_TIMESTAMP - INTERVAL '6 minutes' WHERE status = 'pending'");
    const now = new Date();
    try {
      await runLogsAlertEvaluation(now, async () => 0);
      expect((await listAlertDeliveries()).filter(item => item.webhookId === webhook.id)).toHaveLength(0);
      await runLogsAlertEvaluation(new Date(now.getTime() + 60_000), async () => 0);
      expect((await listAlertDeliveries()).filter(item => item.webhookId === webhook.id).map(item => item.eventKind)).toEqual(['failure']);

      await query('DELETE FROM logs_ingest_spool WHERE origin = $1 AND entries @> $2::jsonb', ['http', JSON.stringify([{ _msg: marker }])]);
      await runLogsAlertEvaluation(new Date(now.getTime() + 120_000), async () => 0);
      expect((await listAlertDeliveries()).filter(item => item.webhookId === webhook.id).map(item => item.eventKind)).toEqual(['failure']);
      await runLogsAlertEvaluation(new Date(now.getTime() + 180_000), async () => 0);
      expect((await listAlertDeliveries()).filter(item => item.webhookId === webhook.id).map(item => item.eventKind).sort()).toEqual(['failure', 'recovery']);
    } finally {
      await query('DELETE FROM logs_ingest_spool WHERE entries @> $1::jsonb', [JSON.stringify([{ _msg: marker }])]);
      await query('DELETE FROM alert_deliveries WHERE webhook_id = $1', [webhook.id]);
      await deleteAlertWebhook(webhook.id);
    }
  });

  it('records query errors without firing on an unverified pending hold', async () => {
    const rule = await createLogsAlertRule(input);
    const now = new Date();
    try {
      await runLogsAlertEvaluation(now, async () => 6);
      await runLogsAlertEvaluation(new Date(now.getTime() + 61_000), async () => { throw new Error('Store unavailable'); });
      expect((await listLogsAlertRules()).find(item => item.id === rule.id)).toMatchObject({ status: 'pending', pendingSince: null, lastError: 'Store unavailable' });
      await runLogsAlertEvaluation(new Date(now.getTime() + 121_000), async () => 6);
      expect((await listLogsAlertRules()).find(item => item.id === rule.id)?.status).toBe('pending');
    } finally {
      await deleteLogsAlertRuleWithRecovery(rule.id);
    }
  });

  it('enforces the rule cap under concurrent requests', async () => {
    const results = await Promise.allSettled(Array.from({ length: 21 }, (_, index) =>
      createLogsAlertRule({ ...input, name: `Rule ${index}`, enabled: false })));
    try {
      expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(20);
      expect(results.filter(result => result.status === 'rejected')).toEqual([
        expect.objectContaining({ reason: expect.any(LogsCapacityError) }),
      ]);
    } finally {
      for (const result of results) {
        if (result.status === 'fulfilled') await deleteLogsAlertRuleWithRecovery(result.value.id);
      }
    }
  });

  it.skipIf(!process.env.LOGS_STORE_URL)('scopes source links by type while retaining legacy Fleet rows', async () => {
    const marker = `sourceScope${randomUUID().replaceAll('-', '')}`;
    const source = `collector, ${marker}`;
    const quotedType = 'external "quoted" | test\\host\u0001';
    const start = new Date(Date.now() - 60_000);
    const end = new Date(Date.now() + 1_000);
    const time = new Date().toISOString();
    const queued = await enqueueLogsBatch({
      origin: 'http',
      maxBytes: config.logs.spoolMaxBytes,
      rows: [
        { _time: time, _msg: `${marker} http`, source: 'http', service_type: 'external', service_id: source, source_type: 'http', source_name: source },
        { _time: time, _msg: `${marker} fleet`, source: 'file', service_type: 'external', service_id: source, source_type: 'fleet', source_name: source, agent_id: 'agent' },
        { _time: time, _msg: `${marker} legacy`, source: 'file', service_type: 'external', service_id: source, agent_id: 'agent' },
        { _time: time, _msg: `${marker} other`, source: 'http', service_type: 'sentry', service_id: source, source_type: 'http', source_name: source },
        { _time: time, _msg: `${marker} quoted`, source: 'http', service_type: quotedType, service_id: source, source_type: 'http', source_name: source },
        { _time: time, _msg: `${marker} unknown`, source: 'file' },
        { _time: time, _msg: `${marker} named unknown`, source: 'file', source_name: 'Unknown source' },
      ],
    });
    expect(queued).toBe('queued');
    let total = 0;
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      await deliverQueuedLogs();
      total = (await searchLogs({ start, end, query: marker })).rows.length;
      if (total === 7) break;
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    expect(total).toBe(7);

    const http = await searchLogs({
      start, end, serviceIds: [source], sourceNames: [source],
      query: `${marker} service_type:in("external") source_type:in("http")`,
    });
    const fleet = await searchLogs({
      start, end, serviceIds: [source], sourceNames: [source],
      query: `${marker} service_type:in("external") (source_type:in("fleet") OR (source_name:"" agent_id:* service_id:*))`,
    });
    const quoted = await searchLogs({
      start, end, serviceIds: [source], sourceNames: [source],
      query: `${marker} service_type:in(${JSON.stringify(quotedType)}) source_type:in("http")`,
    });
    const unknown = await searchLogs({
      start, end,
      query: `${marker} service_type:"" service_id:"" (source_type:"" NOT (source_name:"" agent_id:* service_id:*)) (source_name:"" OR source_name:in("Unknown source"))`,
    });
    expect(http.rows.map(row => row.message)).toEqual([`${marker} http`]);
    expect(fleet.rows.map(row => row.message).sort()).toEqual([`${marker} fleet`, `${marker} legacy`]);
    expect(quoted.rows.map(row => row.message)).toEqual([`${marker} quoted`]);
    expect(unknown.rows.map(row => row.message).sort()).toEqual([`${marker} named unknown`, `${marker} unknown`]);
  });

  it.skipIf(!process.env.LOGS_STORE_URL)('ingests generic, OTLP-shaped JSON, and Sentry events and searches them through the API', async () => {
    const sentrySecret = config.logs.sentryClientSecret;
    if (!sentrySecret) throw new Error('LOGS_SENTRY_CLIENT_SECRET is required for the Logs store integration test');
    const expiresAt = new Date(Date.now() + 60 * 60 * 1000);
    const writeKey = await createApiKey({
      name: 'logs, integration',
      role: 'admin',
      scopes: ['logs:write'],
      allowedCidrs: [],
      createdBy: null,
      expiresAt,
    });
    const readKey = await createApiKey({
      name: 'logs-integration-read',
      role: 'admin',
      scopes: ['logs:read'],
      allowedCidrs: [],
      createdBy: null,
      expiresAt,
    });
    const app = express();
    app.use(attachApiKey);
    app.use('/api/logs', logsRouter);
    const server: Server = app.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${address.port}/api/logs`;
    const marker = `logsIntegration${randomUUID().replaceAll('-', '')}`;
    const serviceType = '界'.repeat(100);
    const start = new Date(Date.now() - 60_000);

    try {
      await updateConfig({ logsEnabled: true });

      const generic = await fetch(`${baseUrl}/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${writeKey.plainText}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: marker, service: 'integration,generic', service_type: serviceType }),
      });
      expect(generic.status).toBe(204);
      const readCannotIngest = await fetch(`${baseUrl}/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${readKey.plainText}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: marker }),
      });
      expect(readCannotIngest.status).toBe(403);

      const otlpJson = await fetch(`${baseUrl}/ingest`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${writeKey.plainText}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          resourceLogs: [{
            resource: { attributes: [{ key: 'service.name', value: { stringValue: 'integration-otlp-json' } }] },
            scopeLogs: [{ logRecords: [{ body: { stringValue: marker } }] }],
          }],
        }),
      });
      expect(otlpJson.status).toBe(204);

      const sentryBody = JSON.stringify({
        action: 'triggered',
        data: { event: { message: marker, project: { slug: 'integration-sentry' } } },
      });
      const signature = createHmac('sha256', sentrySecret).update(sentryBody).digest('hex');
      const sentry = await fetch(`${baseUrl}/sentry`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Sentry-Hook-Resource': 'event_alert',
          'Sentry-Hook-Signature': signature,
        },
        body: sentryBody,
      });
      expect(sentry.status).toBe(204);

      const end = new Date(Date.now() + 1_000);
      let count = 0;
      let rows: unknown[] = [];
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await deliverQueuedLogs();
        count = await countLogs(marker, 60, end);
        const search = await fetch(`${baseUrl}/search?start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}&q=${encodeURIComponent(marker)}`, {
          headers: { Authorization: `Bearer ${readKey.plainText}` },
        });
        expect(search.status).toBe(200);
        rows = (await search.json()).data.rows;
        if (count === 3 && rows.length === 3) break;
        await new Promise(resolve => setTimeout(resolve, 250));
      }
      expect(count).toBe(3);
      expect(rows).toHaveLength(3);
      const exactFilters = new URLSearchParams({
        start: start.toISOString(),
        end: end.toISOString(),
        q: marker,
        serviceIds: 'integration,generic',
        sourceNames: 'logs, integration',
      });
      const exactSearch = await fetch(`${baseUrl}/search?${exactFilters}`, {
        headers: { Authorization: `Bearer ${readKey.plainText}` },
      });
      expect(exactSearch.status).toBe(200);
      const exactRows = (await exactSearch.json()).data.rows;
      expect(exactRows).toMatchObject([
        { serviceId: 'integration,generic', sourceName: 'logs, integration' },
      ]);
      expect(Buffer.byteLength(exactRows[0].serviceType, 'utf8')).toBeLessThanOrEqual(120);
      expect(exactRows[0].serviceType).toContain('…');
      exactFilters.set('q', `${marker} service_type:in(${JSON.stringify(exactRows[0].serviceType)}) source_type:in("http")`);
      const scopedSearch = await fetch(`${baseUrl}/search?${exactFilters}`, {
        headers: { Authorization: `Bearer ${readKey.plainText}` },
      });
      expect(scopedSearch.status).toBe(200);
      expect((await scopedSearch.json()).data.rows).toHaveLength(1);
      const writeCannotSearch = await fetch(`${baseUrl}/search`, {
        headers: { Authorization: `Bearer ${writeKey.plainText}` },
      });
      expect(writeCannotSearch.status).toBe(403);

      const webhook = await createAlertWebhook({
        name: `Logs integration ${marker}`,
        adapter: 'generic',
        webhookUrl: 'https://alerts.example.test/logs',
        enabled: true,
        notifyRecovery: true,
        subscriptions: [{ alertType: 'logs_rule', enabled: true }],
      });
      const rule = await createLogsAlertRule({
        ...input,
        name: `Logs integration ${marker}`,
        query: marker,
        threshold: 1,
        windowSeconds: 300,
      });
      try {
        const evaluatedAt = new Date();
        await runLogsAlertEvaluation(evaluatedAt);
        await runLogsAlertEvaluation(new Date(evaluatedAt.getTime() + 61_000));
        expect((await listLogsAlertRules()).find(item => item.id === rule.id)?.status).toBe('firing');
        expect((await listAlertDeliveries()).filter(item => item.webhookId === webhook.id).map(item => item.eventKind))
          .toContain('failure');
      } finally {
        await deleteLogsAlertRuleWithRecovery(rule.id);
        await query('DELETE FROM alert_deliveries WHERE webhook_id = $1', [webhook.id]);
        await deleteAlertWebhook(webhook.id);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
      await deleteApiKey(writeKey.key.id);
      await deleteApiKey(readKey.key.id);
    }
  });
});
