import { createServer } from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import { expect, it, vi } from 'vitest';
const telemetryConfig = vi.hoisted(() => ({ storeUrl: 'http://metrics-backend:8428' }));
vi.mock('../../config.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../config.js')>();
  return { config: { ...original.config, telemetry: telemetryConfig } };
});
import { allowedStoreAddress, createStoreTransport, storeRequest } from './transport.js';
import type { StoreConnection } from './connection.js';
const connection: StoreConnection = { revision: 'fixture', mode: 'external', url: 'http://fixture.test', auth: 'none', username: '', encryptedSecret: '', allowPrivate: false };
it.each(['127.0.0.1', '::1', '169.254.169.254', '0.0.0.0', '224.0.0.1', '::ffff:127.0.0.1', 'fe80::1'])('blocks special destination %s even with private networking enabled', address => {
  expect(allowedStoreAddress(address, true)).toBe(false);
});
it('requires explicit private access and normalizes IPv4-mapped IPv6', () => {
  expect(allowedStoreAddress('10.0.0.2', false)).toBe(false);
  expect(allowedStoreAddress('::ffff:10.0.0.2', true)).toBe(true);
  expect(allowedStoreAddress('fd00::1', true)).toBe(true);
  expect(allowedStoreAddress('8.8.8.8', false)).toBe(true);
});
it('rejects a saved loopback endpoint before sending a request', async () => {
  await expect(storeRequest({ ...connection, url: 'http://127.0.0.1:1', allowPrivate: true }, '/health', 100)).rejects.toThrow('not permitted');
});
it('trusts the bundled store address, including loopback on host-networked installs', async () => {
  const server = createServer((_request, response) => response.end('ok'));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  telemetryConfig.storeUrl = `http://127.0.0.1:${port}`;
  try {
    await expect(storeRequest({ ...connection, mode: 'bundled', url: '' }, '/health', 2000)).resolves.toMatchObject({ status: 200, body: 'ok' });
  } finally {
    telemetryConfig.storeUrl = 'http://metrics-backend:8428';
    await new Promise(resolve => server.close(resolve));
  }
});

it('pins the actual socket to the validated DNS answer, never follows redirects and bounds stalled bodies', async () => {
  const received: string[] = [];
  const server = createServer((req, res) => {
    received.push(req.url!);
    if (req.url === '/redirect') { res.writeHead(302, { location: '/secret' }); res.end('moved'); }
    else if (req.url === '/stall') { res.writeHead(200); res.write('partial'); }
    else res.end('ok');
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 }]);
  const transport = createStoreTransport({ resolve: resolve as never, addressAllowed: () => true });
  const value = { ...connection, url: `http://fixture.invalid:${(server.address() as AddressInfo).port}` };
  try {
    expect((await transport(value, '/redirect', 1000)).status).toBe(302);
    await expect(transport(value, '/stall', 50)).rejects.toThrow();
    expect((await transport(value, '/health', 1000)).body).toBe('ok');
    expect(received).toEqual(['/redirect', '/stall', '/health']);
    expect(resolve).toHaveBeenCalledTimes(3);
    const rebind = createStoreTransport({ resolve: vi.fn(async () => [{ address: '8.8.8.8', family: 4 }, { address: '169.254.169.254', family: 4 }]) as never });
    await expect(rebind(value, '/health', 1000)).rejects.toThrow('not permitted');
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
