import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { createServer as createSmtpServer } from 'node:net';
import { once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSchema } from '../../db/schema.js';
import { query, closePool } from '../../db/connection.js';
import {
  createAlertWebhook,
  createAlertDelivery,
  claimDueAlertDeliveries,
  completeAlertDelivery,
  expireStaleAlertDeliveries,
  listAlertDeliveries,
  updateAlertWebhook,
} from '../../db/queries/alerts.js';
import { updateConfig } from '../../db/queries/config.js';
import { updateEmailSenderProfile, upsertEmailRelay } from '../../db/queries/email.js';
import { processAlertDelivery } from './delivery-worker.js';
import { createAlertTransport, sendAlertWebhook } from './webhook-transport.js';

vi.mock('./webhook-transport.js', async original => ({ ...await original<typeof import('./webhook-transport.js')>(), sendAlertWebhook: vi.fn() }));
const openssl = process.env.OPENSSL_BIN ?? 'openssl';
const run = process.env.ROLLUP_IT_DB === '1' && spawnSync(openssl, ['version']).status === 0;

describe.skipIf(!run)('Encrypted queue to verified TLS receiver', () => {
  let directory: string, mode = 'retry', webhookId: number;
  const received: string[] = [];
  const server = createServer();
  beforeAll(async () => {
    if (!/^(robin_test($|_)|robin_release_reporting_)/.test(process.env.DB_NAME ?? '') || !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) throw new Error('Fresh disposable reporting DB required');
    await initializeSchema();
    directory = await mkdtemp(join(tmpdir(), 'robin-webhook-tls-'));
    execFileSync(openssl, ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=fixture.example.test',
      '-addext', 'subjectAltName=DNS:fixture.example.test', '-keyout', join(directory, 'key.pem'), '-out', join(directory, 'cert.pem')], { stdio: 'ignore' });
    const certificate = await readFile(join(directory, 'cert.pem'));
    server.setSecureContext({ key: await readFile(join(directory, 'key.pem')), cert: certificate });
    server.on('request', (req, res) => {
      received.push(String(req.headers['x-robin-notification-id'])); req.resume();
      if (mode === 'stall') { res.writeHead(200); res.write('partial'); }
      else if (mode === 'large') res.end('x'.repeat(65537));
      else { res.writeHead(mode === 'retry' ? 503 : 200); res.end(mode === 'retry' ? 'secret-bearing remote error' : 'ok'); }
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    // Test-only DNS/address wiring points a valid hostname at this receiver.
    // The real HTTPS socket still verifies its CA and original hostname.
    const send = createAlertTransport({ resolve: vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]) as never,
      addressAllowed: () => true, request: ((url, options, callback) => httpsRequest(url, { ...options, ca: certificate }, callback)) as typeof httpsRequest });
    vi.mocked(sendAlertWebhook).mockImplementation(input => send({ ...input, timeoutMs: 200 }));
    await updateConfig({ alertsEnabled: true, alertRetryBaseMs: 1000, alertRetryMaxMs: 1000, alertDeliveryMaxAttempts: 3 });
    const webhook = await createAlertWebhook({ name: 'Disposable TLS receiver', adapter: 'slack', enabled: true,
      webhookUrl: `https://fixture.example.test:${(server.address() as { port: number }).port}/private-fixture-token` });
    webhookId = webhook.id;
    expect((await query('SELECT encrypted_url FROM alert_webhooks WHERE id=$1', [webhook.id])).rows[0].encrypted_url).not.toContain('private-fixture-token');
  }, 120000);
  afterAll(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
    if (directory) await rm(directory, { recursive: true, force: true }); await closePool(); });

  const enqueue = (key: string) => createAlertDelivery({ dedupeKey: key, webhookId, webhookName: 'Disposable TLS receiver', fleetServiceId: null,
    serviceId: 'fixture', serviceName: 'Fixture', serviceType: 'robin', alertType: 'availability', eventKind: 'test', adapter: 'slack', payload: { text: 'fixture-only' } });

  it('persists retry then acceptance under one notification ID without replaying completed work', async () => {
    const item = await enqueue('tls-retry');
    const [first] = await claimDueAlertDeliveries(1); await processAlertDelivery(first);
    expect((await listAlertDeliveries()).find(value => value.id === item.id)).toMatchObject({ status: 'pending', attempts: 1, responseStatus: 503 });
    expect((await listAlertDeliveries()).find(value => value.id === item.id)?.error).not.toContain('secret-bearing');
    await query('UPDATE alert_deliveries SET next_attempt_at=NOW() WHERE id=$1', [item.id]); mode = 'up';
    const [second] = await claimDueAlertDeliveries(1); await processAlertDelivery(second);
    expect((await listAlertDeliveries()).find(value => value.id === item.id)).toMatchObject({ status: 'accepted', attempts: 2, notificationId: item.notificationId });
    expect(await claimDueAlertDeliveries(1)).toEqual([]); expect(received).toEqual([item.notificationId, item.notificationId]);
  });
  it('releases a stalled response for retry and rejects an oversized acknowledgement', async () => {
    const item = await enqueue('tls-stall'); mode = 'stall';
    const [first] = await claimDueAlertDeliveries(1); const start = Date.now(); await processAlertDelivery(first);
    expect(Date.now() - start).toBeLessThan(2000);
    expect((await listAlertDeliveries()).find(value => value.id === item.id)?.status).toBe('pending');
    await query('UPDATE alert_deliveries SET next_attempt_at=NOW() WHERE id=$1', [item.id]); mode = 'large';
    const [second] = await claimDueAlertDeliveries(1); await processAlertDelivery(second);
    expect((await listAlertDeliveries()).find(value => value.id === item.id)).toMatchObject({ status: 'failed', attempts: 2 });
    expect(await claimDueAlertDeliveries(1)).toEqual([]);
  });

  it('cancels old firing deliveries after dismissal, including after a later undo', async () => {
    const issueId = randomUUID();
    const suffix = randomUUID();
    await query(
      `INSERT INTO telemetry_alert_issues
         (id, rule_id, rule_name, query, comparator, threshold, for_seconds, severity, series_key,
          labels_json, last_value, opened_at, last_seen_at)
       VALUES ($1, 900001, 'Fixture rule', 'up', '>', 0, 0, 'critical', 'fixture-series',
          '{"host":"fixture"}'::jsonb, 1, NOW(), NOW())`,
      [issueId],
    );
    const delivery = await createAlertDelivery({
      dedupeKey: `telemetry-dismissal-revision-fixture:${suffix}`,
      webhookId,
      webhookName: 'Disposable TLS receiver',
      fleetServiceId: null,
      serviceId: 'telemetry-rule-900001',
      serviceName: 'Fixture rule · host=fixture',
      serviceType: 'monitoring',
      alertType: 'telemetry_rule',
      eventKind: 'failure',
      telemetryAlertIssueId: issueId,
      telemetryAlertIssueRevision: 1,
      adapter: 'slack',
      payload: { text: 'fixture-only' },
    });
    const [claimed] = await claimDueAlertDeliveries(1);
    expect(claimed?.id).toBe(delivery.id);

    await query(
      `UPDATE telemetry_alert_issues
       SET status = 'dismissed', dismissed_at = NOW(), revision = revision + 1 WHERE id = $1`,
      [issueId],
    );
    expect(await completeAlertDelivery({
      id: delivery.id,
      claimToken: claimed.claimToken,
      status: 'pending',
      error: 'fixture retry',
      nextAttemptAt: new Date(),
    })).toBe(true);
    expect((await listAlertDeliveries()).find((item) => item.id === delivery.id)).toMatchObject({
      status: 'cancelled',
      error: 'Telemetry alert issue changed before delivery',
    });

    await query(
      `UPDATE telemetry_alert_issues
       SET status = 'active', dismissed_at = NULL, revision = revision + 1 WHERE id = $1`,
      [issueId],
    );
    expect(await claimDueAlertDeliveries(1)).toEqual([]);

    const stale = await createAlertDelivery({
      dedupeKey: `telemetry-dismissal-revision-stale-worker-fixture:${suffix}`,
      webhookId,
      webhookName: 'Disposable TLS receiver',
      fleetServiceId: null,
      serviceId: 'telemetry-rule-900001',
      serviceName: 'Fixture rule · host=fixture',
      serviceType: 'monitoring',
      alertType: 'telemetry_rule',
      eventKind: 'failure',
      telemetryAlertIssueId: issueId,
      telemetryAlertIssueRevision: 3,
      adapter: 'slack',
      payload: { text: 'fixture-only' },
    });
    const [staleClaim] = await claimDueAlertDeliveries(1);
    expect(staleClaim?.id).toBe(stale.id);
    await query(
      `UPDATE telemetry_alert_issues
       SET status = 'dismissed', dismissed_at = NOW(), revision = revision + 1
       WHERE id = $1`,
      [issueId],
    );
    await query(
      `UPDATE alert_deliveries
       SET claimed_at = CURRENT_TIMESTAMP - INTERVAL '16 minutes'
       WHERE id = $1`,
      [stale.id],
    );
    expect(await claimDueAlertDeliveries(1)).toEqual([]);
    expect((await listAlertDeliveries()).find((item) => item.id === stale.id)?.status).toBe('cancelled');
  });

  it('orders PagerDuty events for the same subject across retries without blocking other subjects', async () => {
    const destination = await createAlertWebhook({
      name: 'PagerDuty fixture', adapter: 'pagerduty', enabled: true, webhookUrl: 'a'.repeat(32),
    });
    const make = (subject: string, eventKind: 'failure' | 'recovery') => createAlertDelivery({
      dedupeKey: `pager-order:${randomUUID()}`, webhookId: destination.id, webhookName: destination.name,
      fleetServiceId: null, serviceId: subject, serviceName: subject, serviceType: 'robin',
      alertType: 'availability', eventKind, adapter: 'pagerduty', payload: { summary: subject },
    });
    const firing = await make('server-a', 'failure');
    const recovery = await make('server-a', 'recovery');
    const other = await make('server-b', 'failure');
    const batch = await claimDueAlertDeliveries(10);
    expect(batch.map(item => item.id)).toEqual([firing.id, other.id]);
    for (const item of batch) {
      await completeAlertDelivery({
        id: item.id, claimToken: item.claimToken, status: item.id === firing.id ? 'pending' : 'accepted',
        nextAttemptAt: item.id === firing.id ? new Date(Date.now() + 60_000) : null,
      });
    }
    expect(await claimDueAlertDeliveries(10)).toEqual([]);
    await query('UPDATE alert_deliveries SET next_attempt_at = NOW() WHERE id = $1', [firing.id]);
    const [retry] = await claimDueAlertDeliveries(10);
    expect(retry.id).toBe(firing.id);
    await completeAlertDelivery({ id: retry.id, claimToken: retry.claimToken, status: 'accepted' });
    const [resolved] = await claimDueAlertDeliveries(10);
    expect(resolved.id).toBe(recovery.id);
    await completeAlertDelivery({ id: resolved.id, claimToken: resolved.claimToken, status: 'accepted' });
  });

  it('cancels deliveries queued under an old destination format', async () => {
    const destination = await createAlertWebhook({
      name: 'Changing destination', adapter: 'slack', enabled: true, webhookUrl: 'https://example.com/fixture',
    });

    const item = await createAlertDelivery({
      dedupeKey: `destination-change:${randomUUID()}`, webhookId: destination.id, webhookName: destination.name,
      fleetServiceId: null, serviceId: 'fixture', serviceName: 'Fixture', serviceType: 'robin',
      alertType: 'availability', eventKind: 'failure', adapter: 'slack', payload: { text: 'old format' },
    });
    await updateAlertWebhook(destination.id, { adapter: 'email', webhookUrl: 'ops@example.com' });
    expect(await claimDueAlertDeliveries(10)).toEqual([]);
    expect((await listAlertDeliveries()).find(value => value.id === item.id)).toMatchObject({
      status: 'cancelled', error: 'Destination type changed',
    });
  });

  it('retains stale PagerDuty resolves while expiring old unattempted openings', async () => {
    const destination = await createAlertWebhook({
      name: 'PagerDuty expiry fixture', adapter: 'pagerduty', enabled: true, webhookUrl: 'b'.repeat(32),
    });
    const make = (eventKind: 'failure' | 'recovery') => createAlertDelivery({
      dedupeKey: `pager-expiry:${randomUUID()}`, webhookId: destination.id, webhookName: destination.name,
      fleetServiceId: null, serviceId: 'stale-subject', serviceName: 'Fixture', serviceType: 'robin',
      alertType: 'availability', eventKind, adapter: 'pagerduty', payload: { summary: 'Fixture' },
    });
    const failure = await make('failure');
    const recovery = await make('recovery');
    await query("UPDATE alert_deliveries SET created_at = NOW() - INTERVAL '2 hours' WHERE id = ANY($1::bigint[])", [[failure.id, recovery.id]]);
    await expireStaleAlertDeliveries(60 * 60 * 1000);
    const history = await listAlertDeliveries();
    expect(history.find(value => value.id === failure.id)?.status).toBe('expired');
    expect(history.find(value => value.id === recovery.id)?.status).toBe('pending');
    const [claimed] = await claimDueAlertDeliveries(1);
    expect(claimed.id).toBe(recovery.id);
    await completeAlertDelivery({ id: claimed.id, claimToken: claimed.claimToken, status: 'accepted' });
  });

  it('delivers an encrypted email destination through the configured SMTP relay', async () => {
    let message = '';
    const smtp = createSmtpServer(socket => {
      let buffer = '';
      let data = false;
      socket.write('220 fixture ESMTP\r\n');
      socket.on('data', chunk => {
        buffer += chunk.toString();
        let end: number;
        while ((end = buffer.indexOf('\r\n')) !== -1) {
          const line = buffer.slice(0, end);
          buffer = buffer.slice(end + 2);
          if (data) {
            if (line === '.') { data = false; socket.write('250 queued\r\n'); }
            else message += `${line}\n`;
          } else if (line.startsWith('EHLO ')) socket.write('250 fixture\r\n');
          else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) socket.write('250 ok\r\n');
          else if (line === 'DATA') { data = true; socket.write('354 send data\r\n'); }
          else if (line === 'QUIT') socket.end('221 bye\r\n');
          else socket.write('500 unsupported\r\n');
        }
      });
    });
    smtp.listen(0, '127.0.0.1');
    await once(smtp, 'listening');
    try {
      const relay = await upsertEmailRelay({
        name: 'SMTP fixture', relayType: 'smtp', enabled: true, priority: 1, smtpHost: '127.0.0.1',
        smtpPort: (smtp.address() as { port: number }).port, smtpSecurity: 'none', tlsMode: 'strict',
        username: null, robinServiceId: null, postfixServiceId: null,
      });
      await updateEmailSenderProfile({
        profileKey: 'alerts', fromName: 'Fixture alerts', fromEmail: 'alerts@example.com',
        replyTo: null, envelopeFrom: null, enabled: true, relayIds: [relay.id],
      });
      const destination = await createAlertWebhook({
        name: 'Email fixture', adapter: 'email', enabled: true, webhookUrl: 'ops@example.com',
      });
      const stored = await query('SELECT encrypted_url FROM alert_webhooks WHERE id=$1', [destination.id]);
      expect(stored.rows[0].encrypted_url).not.toContain('ops@example.com');
      const item = await createAlertDelivery({
        dedupeKey: `smtp:${randomUUID()}`, webhookId: destination.id, webhookName: destination.name,
        fleetServiceId: null, serviceId: 'fixture', serviceName: 'Fixture', serviceType: 'robin',
        alertType: 'availability', eventKind: 'failure', adapter: 'email', payload: { summary: 'Fixture is down' },
      });
      const [claimed] = await claimDueAlertDeliveries(1);
      expect(claimed.id).toBe(item.id);
      await processAlertDelivery(claimed);
      expect((await listAlertDeliveries()).find(value => value.id === item.id)?.status).toBe('accepted');
      expect(message).toContain('To: ops@example.com');
      expect(message).toContain('Subject: [FAILURE] Fixture is down');
      expect(message).toContain(item.notificationId);
    } finally {
      await new Promise<void>(resolve => smtp.close(() => resolve()));
    }
  });
});
