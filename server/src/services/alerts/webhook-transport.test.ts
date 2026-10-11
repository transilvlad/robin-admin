import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { createAlertTransport, publicWebhookAddress, sendAlertWebhook } from './webhook-transport.js';

const input = { adapter: 'slack' as const, webhookUrl: 'https://hooks.example.test/token', notificationId: 'notification-1', payload: { text: 'Example' } };
function fixture(status: number, text: string) {
  const request = vi.fn((_url, options, callback) => {
    const outgoing = new EventEmitter() as EventEmitter & { end: (value: string) => void };
    outgoing.end = () => {
      const incoming = new PassThrough() as PassThrough & { statusCode: number };
      incoming.statusCode = status; callback(incoming); incoming.end(text);
    };
    return outgoing;
  });
  const resolve = vi.fn(async () => [{ address: '8.8.8.8', family: 4 }]);
  return { send: createAlertTransport({ request: request as never, resolve: resolve as never }), request, resolve };
}
describe('Pinned alert transport', () => {
  it('pins one validated answer, keeps hostname verification and includes the delivery ID', async () => {
    const value = fixture(200, 'ok');
    expect((await value.send(input)).accepted).toBe(true);
    expect(value.resolve).toHaveBeenCalledOnce();
    const options = value.request.mock.calls[0][1];
    expect(options.headers['X-Robin-Notification-Id']).toBe('notification-1');
    expect(options.rejectUnauthorized).not.toBe(false);
    const callback = vi.fn(); options.lookup('hooks.example.test', {}, callback);
    expect(callback).toHaveBeenCalledWith(null, '8.8.8.8', 4);
  });
  it('never returns server-echoed credentials and classifies statuses', async () => {
    for (const status of [302, 400, 408, 429, 503]) {
      const value = fixture(status, 'secret token https://secret.example/path');
      const result = await value.send(input);
      expect(result.retryable).toBe([408, 429, 503].includes(status));
      expect(result.error).not.toContain('secret'); expect(value.request).toHaveBeenCalledOnce();
    }
  });
  it('rejects oversized acknowledgements, credentials, HTTP and private DNS answers before delivery', async () => {
    expect((await fixture(200, 'x'.repeat(65537)).send(input)).retryable).toBe(false);
    for (const url of ['http://example.test', 'https://user:secret@example.test', 'https://127.0.0.1', 'https://[::ffff:127.0.0.1]']) {
      expect((await sendAlertWebhook({ ...input, webhookUrl: url })).accepted).toBe(false);
    }
    const request = vi.fn();
    const send = createAlertTransport({ resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]) as never, request: request as never });
    expect((await send(input)).retryable).toBe(false); expect(request).not.toHaveBeenCalled();
    expect(publicWebhookAddress('::ffff:10.0.0.1')).toBe(false);
  });
});
