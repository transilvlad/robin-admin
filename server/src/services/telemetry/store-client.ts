import { getConfig } from '../../db/queries/config.js';
import { getStoreConnection, type StoreConnection } from './connection.js';
import { storeRequest } from './transport.js';

export type TelemetryIngestFormat = 'remote-write' | 'prometheus-text';
const INGEST_PATHS: Record<TelemetryIngestFormat, string> = {
  'remote-write': '/api/v1/write', 'prometheus-text': '/api/v1/import/prometheus',
};
const FORWARDED_HEADERS = ['content-type', 'content-encoding', 'x-prometheus-remote-write-version'];

export class TelemetryStoreUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'TelemetryStoreUnavailableError'; }
}
export class TelemetryQueryError extends Error {
  constructor(message: string) { super(message); this.name = 'TelemetryQueryError'; }
}
const MAX_STORE_QUERY_ERROR_LENGTH = 400;

function storeQueryError(status: number, error: unknown): string {
  const detail = status === 400 || status === 422
    ? typeof error === 'string'
      ? error.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAX_STORE_QUERY_ERROR_LENGTH)
      : ''
    : '';
  return `Telemetry query rejected (HTTP ${status})${detail ? `: ${detail}` : ''}`;
}

export async function telemetryStoreConfigured(): Promise<boolean> {
  return (await getStoreConnection()).mode !== 'disabled';
}
async function request(path: string, options?: Parameters<typeof storeRequest>[3], connection?: StoreConnection) {
  const settings = await getConfig();
  const resolved = connection ?? await getStoreConnection();
  if (resolved.mode === 'disabled') throw new TelemetryStoreUnavailableError('Telemetry store is not configured');
  try { return await storeRequest(resolved, path, settings.telemetryRequestTimeoutMs, options); }
  catch { throw new TelemetryStoreUnavailableError('Telemetry store request failed. Check the connection, credentials and destination policy.'); }
}
export async function checkTelemetryStore(connection?: StoreConnection): Promise<void> {
  const response = await request('/health', undefined, connection);
  if (response.status < 200 || response.status >= 300) throw new TelemetryStoreUnavailableError(`Telemetry store returned HTTP ${response.status}`);
}
export interface TelemetryIngestResult { status: number; error?: string }
export async function forwardTelemetryIngest(format: TelemetryIngestFormat, body: Buffer, headers: Record<string, string | string[] | undefined>): Promise<TelemetryIngestResult> {
  const forwarded: Record<string, string> = {};
  for (const name of FORWARDED_HEADERS) {
    const value = headers[name];
    if (typeof value === 'string' && value) forwarded[name] = value;
  }
  const response = await request(INGEST_PATHS[format], { method: 'POST', body, headers: forwarded });
  if (response.status >= 500) throw new TelemetryStoreUnavailableError(`Telemetry store returned HTTP ${response.status}`);
  // A store error can echo credentials or metric contents. Never expose it.
  return { status: response.status, ...(response.status >= 300 ? { error: `Telemetry store returned HTTP ${response.status}` } : {}) };
}
export async function readTelemetryStoreText(path: string): Promise<string | null> {
  const response = await request(path);
  return response.status >= 200 && response.status < 300 ? response.body : null;
}
export async function readTelemetryStore<T>(path: string, params: URLSearchParams): Promise<T> {
  const response = await request(`${path}?${params}`);
  if (response.status >= 500) throw new TelemetryStoreUnavailableError(`Telemetry store returned HTTP ${response.status}`);
  let body: unknown;
  try { body = JSON.parse(response.body); }
  catch { throw new TelemetryStoreUnavailableError('Telemetry store returned an unreadable response'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new TelemetryStoreUnavailableError('Telemetry store returned an unreadable response');
  const result = body as { status?: unknown; data?: T; error?: unknown };
  if (response.status < 200 || response.status >= 300 || result.status !== 'success' || result.data === undefined) {
    throw new TelemetryQueryError(storeQueryError(response.status, result.error));
  }
  return result.data;
}
