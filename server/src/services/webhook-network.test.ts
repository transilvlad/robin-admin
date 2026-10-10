import { createServer } from 'node:http';
import { request as httpRequest } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';
import { createAlertTransport } from './alerts/webhook-transport.js';

// Test-only transport dependencies; production has no private-address bypass.
const sendAlertWebhook = createAlertTransport({ addressAllowed: () => true,
  request: ((url, options, callback) => httpRequest(new URL(url.toString().replace(/^https:/, 'http:')), options, callback)) as typeof import('node:https').request });

describe('webhook network failures', () => {
  it('classifies real responses and never follows redirects', async () => {
    const received: string[] = [];
    const server = createServer((request, response) => {
      received.push(`${request.url}:${request.headers['x-robin-notification-id']}`);
      const status = Number(request.url?.slice(1));
      response.writeHead(status, { location: '/200' });
      response.end('fixture');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    try {
      for (const status of [200, 400, 408, 429, 503, 302]) {
        const result = await sendAlertWebhook({ adapter: 'generic', notificationId: `fixture-${status}`,
          webhookUrl: `https://127.0.0.1:${address.port}/${status}`, payload: { fixture: true }, timeoutMs: 1000 });
        expect(result.status).toBe(status);
        expect(result.accepted).toBe(status === 200);
        expect(result.retryable).toBe([408, 429, 503].includes(status));
      }
      expect(received).toEqual([200, 400, 408, 429, 503, 302].map(status => `/${status}:fixture-${status}`));
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });

  it('bounds a stalled body and recovers after a disconnect', async () => {
    const server = createServer((request, response) => {
      if (request.url === '/disconnect') request.socket.destroy();
      else if (request.url === '/stall') { response.writeHead(200); response.write('partial'); }
      else response.end('ok');
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const address = server.address() as { port: number };
    try {
      for (const path of ['disconnect', 'stall', 'up']) {
        const started = Date.now();
        const result = await sendAlertWebhook({ adapter: 'generic', notificationId: 'fixture-recovery',
          webhookUrl: `https://127.0.0.1:${address.port}/${path}`, payload: {}, timeoutMs: 100 });
        expect(result.accepted).toBe(path === 'up');
        expect(result.retryable).toBe(path !== 'up');
        expect(Date.now() - started).toBeLessThan(1000);
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
