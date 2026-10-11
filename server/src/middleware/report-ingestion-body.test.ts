import { afterEach, describe, expect, it } from 'vitest';
import express, { type ErrorRequestHandler } from 'express';
import { request } from 'node:http';
import { gzipSync } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { reportIngestionBody } from './report-ingestion-body.js';
import { applyOperationsSettings, operationsDefaults } from '../services/operations-settings.js';

afterEach(() => applyOperationsSettings(operationsDefaults()));

describe('Live report payload policy', () => {
  it('keeps the bundled gateway transparent to the saved server limit', () => {
    // Caddy streams request bodies without a size limit unless told otherwise,
    // so the server's saved limit is the only one.
    const gateway = readFileSync(new URL('../../../caddy/Caddyfile', import.meta.url), 'utf8');
    const api = gateway.match(/handle \/api\/\* \{([^}]+)\}/)?.[1];
    expect(api).toMatch(/reverse_proxy\s+admin-backend:3001/);
    expect(gateway).not.toMatch(/request_body|request_buffers|max_size/);
  });
  it('bounds declared, chunked and decompressed bodies and applies updates without restart', async () => {
    const app = express();
    app.use(reportIngestionBody);
    app.post('/', (_req, res) => res.sendStatus(204));
    app.use(((error, _req, res, _next) => res.sendStatus(error.status ?? 500)) as ErrorRequestHandler);
    const server = app.listen(0, '127.0.0.1');
    await new Promise<void>(resolve => server.once('listening', resolve));
    const port = (server.address() as { port: number }).port;
    const payload = Buffer.from(JSON.stringify({ text: 'x'.repeat(1100000) }));
    const send = (body: Buffer, headers: Record<string, string> = {}) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port, method: 'POST', headers: { 'content-type': 'application/json', ...headers } }, res => {
        res.resume(); res.once('end', () => resolve(res.statusCode!));
      });
      req.on('error', reject);
      req.write(body.subarray(0, 100)); req.end(body.subarray(100));
    });
    try {
      applyOperationsSettings({ ...operationsDefaults(), reportingIngestMaxMiB: 1 });
      expect(await send(payload, { 'content-length': String(payload.length) })).toBe(413);
      expect(await send(payload)).toBe(413);
      expect(await send(gzipSync(payload), { 'content-encoding': 'gzip' })).toBe(413);
      applyOperationsSettings({ ...operationsDefaults(), reportingIngestMaxMiB: 2 });
      expect(await send(payload)).toBe(204);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  });
});
