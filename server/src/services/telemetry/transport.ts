import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import ipaddr from 'ipaddr.js';
import { connectionHeaders, connectionUrl, type StoreConnection } from './connection.js';

const RESPONSE_LIMIT = 32 * 1024 * 1024;

export function allowedStoreAddress(address: string, allowPrivate: boolean): boolean {
  try {
    const parsed = ipaddr.process(address);
    const range = parsed.range();
    return range === 'unicast' || (allowPrivate && (range === 'private' || range === 'uniqueLocal'));
  } catch { return false; }
}

export function createStoreTransport(dependencies: { addressAllowed?: typeof allowedStoreAddress; resolve?: typeof lookup } = {}) {
  const addressAllowed = dependencies.addressAllowed ?? allowedStoreAddress;
  const resolveAddress = dependencies.resolve ?? lookup;
  return async function storeRequest(connection: StoreConnection, path: string, timeoutMs: number,
  options: { method?: 'GET' | 'POST'; headers?: Record<string, string>; body?: Buffer } = {},
): Promise<{ status: number; body: string }> {
  const base = connectionUrl(connection);
  if (!base) throw new Error('Store is not configured');
  const url = new URL(`${base}${path}`);
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  const signal = AbortSignal.timeout(timeoutMs);
  // Pin the socket to the validated answer; validate every request, including
  // ingestion, so a saved DNS name cannot later rebind to a forbidden address.
  const records = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await Promise.race([
    resolveAddress(hostname, { all: true, verbatim: true }),
    new Promise<never>((_, reject) => signal.addEventListener('abort', () => reject(new Error('Store DNS timed out')), { once: true })),
  ]);
  // The bundled store is a deployment coordinate (may be loopback on
  // host-networked installs); only operator-entered external URLs are guarded.
  const trusted = connection.mode === 'bundled';
  if (!records.length || (!trusted && records.some(record => !addressAllowed(record.address, connection.allowPrivate)))) throw new Error('Store destination is not permitted');
  const target = records[0];
  return new Promise((resolve, reject) => {
    const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, {
      method: options.method ?? 'GET', signal, agent: false, family: target.family,
      headers: { ...options.headers, ...connectionHeaders(connection) },
      lookup: (_host, _options, callback) => callback(null, target.address, target.family),
    }, response => {
      let size = 0;
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > RESPONSE_LIMIT) { response.destroy(new Error('Store response exceeds the safety limit')); return; }
        chunks.push(chunk);
      });
      response.on('error', reject);
      response.on('end', () => resolve({ status: response.statusCode ?? 502, body: Buffer.concat(chunks).toString('utf8') }));
    });
    request.on('error', reject);
    request.end(options.body);
  });
  };
}
export const storeRequest = createStoreTransport();
