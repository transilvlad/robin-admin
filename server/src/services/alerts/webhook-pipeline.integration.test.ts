import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createServer } from 'node:https';
import { request as httpsRequest } from 'node:https';
import { once } from 'node:events';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initializeSchema } from '../../db/schema.js';
import { query, closePool } from '../../db/connection.js';
import { createAlertWebhook, createAlertDelivery, claimDueAlertDeliveries, listAlertDeliveries } from '../../db/queries/alerts.js';
import { updateConfig } from '../../db/queries/config.js';
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
});
