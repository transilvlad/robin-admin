import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer, request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { closePool, query } from '../../db/connection.js';
import { initializeSchema } from '../../db/schema.js';
import { updateConfig } from '../../db/queries/config.js';
import { claimDueAlertDeliveries, createAlertWebhook, deleteAlertWebhook, listAlertDeliveries } from '../../db/queries/alerts.js';
import { createLogsAlertRule, listLogsAlertRules } from '../../db/queries/logs.js';
import { ingestExternalLogs, countLogs } from '../logs-store.js';
import { deliverQueuedLogs } from '../logs-delivery.js';
import { deleteLogsAlertRuleWithRecovery, runLogsAlertEvaluation } from './logs-rules.js';
import { processAlertDelivery } from './delivery-worker.js';
import { createAlertTransport, sendAlertWebhook } from './webhook-transport.js';

vi.mock('./webhook-transport.js', async (original) => ({
  ...await original<typeof import('./webhook-transport.js')>(),
  sendAlertWebhook: vi.fn(),
}));

const enabled = process.env.LOGS_IT_DB === '1' && Boolean(process.env.LOGS_STORE_URL);
const openssl = process.env.OPENSSL_BIN ?? 'openssl';

describe.skipIf(!enabled)('Logs alert delivery (PostgreSQL, VictoriaLogs and TLS webhook)', () => {
  let directory = '';
  const receiver = createServer();
  const received: Array<{ notificationId: string; payload: Record<string, unknown> }> = [];

  beforeAll(async () => {
    if (!/^robin_test_logs($|_)/.test(process.env.DB_NAME ?? '') || !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
      throw new Error('A disposable Logs test database on loopback is required');
    }
    if (spawnSync(openssl, ['version']).status !== 0) throw new Error('OpenSSL is required for the TLS webhook integration test');
    await initializeSchema();
    await updateConfig({ logsEnabled: true, alertsEnabled: true });
    await query('DELETE FROM logs_ingest_spool');
    await query('DELETE FROM alert_deliveries');
    await query(`
      UPDATE logs_pipeline_health_state
      SET degraded = false, failing_checks = 0, healthy_checks = 0, generation = 0,
          dropped_rows_total = NULL, dropped_observed_at = NULL, last_reason = NULL
      WHERE id = 1
    `);

    directory = await mkdtemp(join(tmpdir(), 'robin-logs-webhook-'));
    execFileSync(openssl, [
      'req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
      '-subj', '/CN=fixture.example.test', '-addext', 'subjectAltName=DNS:fixture.example.test',
      '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem'),
    ], { stdio: 'ignore' });
    const certificate = await readFile(join(directory, 'cert.pem'));
    receiver.setSecureContext({ key: await readFile(join(directory, 'key.pem')), cert: certificate });
    receiver.on('request', (req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk: Buffer) => chunks.push(chunk));
      req.on('end', () => {
        received.push({
          notificationId: String(req.headers['x-robin-notification-id']),
          payload: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
        });
        res.writeHead(200).end('ok');
      });
    });
    receiver.listen(0, '127.0.0.1');
    await once(receiver, 'listening');
    const send = createAlertTransport({
      resolve: async () => [{ address: '127.0.0.1', family: 4 }],
      addressAllowed: () => true,
      request: ((url, options, callback) => httpsRequest(url, { ...options, ca: certificate }, callback)) as typeof httpsRequest,
    });
    vi.mocked(sendAlertWebhook).mockImplementation((input) => send(input));
  }, 30_000);

  afterAll(async () => {
    receiver.closeAllConnections();
    if (receiver.listening) await new Promise<void>((resolve) => receiver.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true });
    await closePool();
  });

  it('ingests a line, fires a rule, delivers it over verified TLS, and sends recovery', async () => {
    const marker = `logsWebhook${randomUUID().replaceAll('-', '')}`;
    const webhook = await createAlertWebhook({
      name: marker,
      adapter: 'generic',
      webhookUrl: `https://fixture.example.test:${(receiver.address() as AddressInfo).port}/alerts`,
      enabled: true,
      notifyRecovery: true,
      subscriptions: [{ alertType: 'logs_rule', enabled: true }],
    });
    const rule = await createLogsAlertRule({
      name: marker, description: null, query: marker, comparator: '>=', threshold: 1,
      windowSeconds: 300, forSeconds: 60, enabled: true,
    });
    try {
      await ingestExternalLogs([{
        time: new Date(Date.now() - 1_000).toISOString(),
        message: marker,
        source: 'integration',
      }], { origin: 'http', idempotencyKey: marker });
      expect(await deliverQueuedLogs()).toBe(1);
      const deadline = Date.now() + 15_000;
      while (await countLogs(marker, 300) !== 1 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      expect(await countLogs(marker, 300)).toBe(1);

      const start = new Date();
      expect(await runLogsAlertEvaluation(start)).toBe(true);
      expect(await runLogsAlertEvaluation(new Date(start.getTime() + 61_000))).toBe(true);
      expect((await listLogsAlertRules()).find((item) => item.id === rule.id)?.status).toBe('firing');
      const [firing] = await claimDueAlertDeliveries(1);
      expect(firing).toMatchObject({ webhookId: webhook.id, eventKind: 'failure', alertType: 'logs_rule' });
      await processAlertDelivery(firing);
      expect((await listAlertDeliveries()).find((item) => item.id === firing.id)).toMatchObject({ status: 'accepted' });
      expect(received).toContainEqual(expect.objectContaining({
        notificationId: firing.notificationId,
        payload: expect.objectContaining({ alertType: 'logs_rule', eventKind: 'failure', count: 1 }),
      }));

      expect(await runLogsAlertEvaluation(new Date(start.getTime() + 301_000))).toBe(true);
      const [recovery] = await claimDueAlertDeliveries(1);
      expect(recovery).toMatchObject({ webhookId: webhook.id, eventKind: 'recovery' });
      await processAlertDelivery(recovery);
      expect((await listAlertDeliveries()).find((item) => item.id === recovery.id)).toMatchObject({ status: 'accepted' });
      expect(received).toContainEqual(expect.objectContaining({
        notificationId: recovery.notificationId,
        payload: expect.objectContaining({ alertType: 'logs_rule', eventKind: 'recovery', count: 0 }),
      }));
      expect(await claimDueAlertDeliveries(1)).toEqual([]);
    } finally {
      await deleteLogsAlertRuleWithRecovery(rule.id);
      await query('DELETE FROM alert_deliveries WHERE webhook_id = $1', [webhook.id]);
      await deleteAlertWebhook(webhook.id);
      await query('DELETE FROM logs_ingest_spool WHERE origin = $1 AND idempotency_key = $2', ['http', marker]);
    }
  }, 40_000);
});
