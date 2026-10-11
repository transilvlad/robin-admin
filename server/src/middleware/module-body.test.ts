import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { moduleRequestBody, getModuleRequestBody } from './module-body.js';
vi.mock('../services/module-host-policy.js', () => ({ getModuleHostPolicy: vi.fn(async () => ({ maxBodyMiB: 1 })) }));

let server: Server;
let url: string;
beforeAll(async () => {
  const app = express();
  app.use('/api/modules', moduleRequestBody);
  app.post('/api/modules/:slug/upload', (req, res) => res.json({ raw: getModuleRequestBody(req).toString(), parsed: req.body }));
  app.use((error: { status?: number }, _req: express.Request, res: express.Response, _next: express.NextFunction) => res.status(error.status ?? 500).end());
  server = app.listen(0);
  await new Promise<void>(resolve => server.once('listening', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/modules/example/upload`;
});
afterAll(async () => { await new Promise<void>(resolve => server.close(() => resolve())); });
describe('module body policy', () => {
  it.each([
    ['application/json', '{ "a": 1 }\n'],
    ['text/csv', 'name,value\r\na,1\r\n'],
    ['text/plain', '$ORIGIN example.test.\n@ IN A 192.0.2.1\n'],
    ['multipart/form-data; boundary=fixture', '--fixture\r\nContent-Disposition: form-data; name="file"; filename="zone.txt"\r\n\r\nzone\r\n--fixture--\r\n'],
  ])('preserves %s bytes', async (type, body) => {
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': type }, body });
    expect(response.status).toBe(200);
    expect((await response.json() as { raw: string }).raw).toBe(body);
  });
  it('enforces the saved limit with and without content-length', async () => {
    const oversized = 'x'.repeat(1024 * 1024 + 1);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/csv' }, body: oversized })).status).toBe(413);
    const response = await fetch(url, { method: 'POST', headers: { 'content-type': 'text/csv' },
      body: new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(oversized)); controller.close(); } }),
      duplex: 'half',
    } as RequestInit);
    expect(response.status).toBe(413);
  });
  it('rejects unsupported content types and compressed uploads', async () => {
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'image/png' }, body: 'fake' })).status).toBe(415);
    expect((await fetch(url, { method: 'POST', headers: { 'content-type': 'text/csv', 'content-encoding': 'gzip' }, body: 'fake' })).status).toBe(415);
  });
});
