import { randomUUID } from 'node:crypto';
import { config } from '../../config.js';
import { query } from '../../db/connection.js';
import { ensureConfigTable } from '../../db/queries/config.js';
import { decryptStoredSecret, encryptStoredSecret } from '../../db/queries/secret-crypto.js';

export interface StoreConnection {
  revision: string;
  /**
   * `bundled` is the deployment's own store at TELEMETRY_STORE_URL (trusted
   * infrastructure); `external` is an operator-entered URL with address guards.
   */
  mode: 'disabled' | 'bundled' | 'external';
  url: string;
  auth: 'none' | 'basic' | 'bearer';
  username: string;
  encryptedSecret: string;
  allowPrivate: boolean;
}
export type PublicStoreConnection = Omit<StoreConnection, 'encryptedSecret'> & { secretConfigured: boolean };
const KEY = 'telemetryConnection';

/** The bundled store's address from the deployment (TELEMETRY_STORE_URL). */
export function bundledStoreUrl(): string {
  const value = config.telemetry.storeUrl;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error('TELEMETRY_STORE_URL must be an absolute HTTP(S) URL'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error('TELEMETRY_STORE_URL must use HTTP(S) without credentials, query or fragment');
  }
  return value;
}
let cached: { value: StoreConnection; at: number } | null = null;
let loading: Promise<StoreConnection> | null = null;
export function resetStoreConnectionCacheForTests() { cached = null; loading = null; }

export function publicConnection(value: StoreConnection): PublicStoreConnection {
  const { encryptedSecret, ...publicValue } = value;
  return { ...publicValue, secretConfigured: Boolean(encryptedSecret) };
}

export async function getStoreConnection(): Promise<StoreConnection> {
  if (cached && Date.now() - cached.at < 1000) return { ...cached.value };
  if (loading) return { ...await loading };
  loading = loadConnection().then(value => { cached = { value, at: Date.now() }; return value; }).finally(() => { loading = null; });
  return { ...await loading };
}

async function loadConnection(): Promise<StoreConnection> {
  await ensureConfigTable();
  const result = await query<{ value: string }>('SELECT value FROM admin_config WHERE key = $1', [KEY]);
  if (result.rows[0]) return JSON.parse(result.rows[0].value) as StoreConnection;
  // The bundled store ships with every deployment, so enabling Telemetry needs
  // no connection setup.
  const initial: StoreConnection = {
    revision: randomUUID(),
    mode: 'bundled',
    url: '',
    auth: 'none',
    username: '',
    encryptedSecret: '',
    allowPrivate: false,
  };
  await query('INSERT INTO admin_config (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING', [KEY, JSON.stringify(initial)]);
  const stored = await query<{ value: string }>('SELECT value FROM admin_config WHERE key = $1', [KEY]);
  return JSON.parse(stored.rows[0].value) as StoreConnection;
}

export function parseConnectionUpdate(raw: unknown, current: StoreConnection): StoreConnection {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Connection must be an object');
  const value = raw as Record<string, unknown>;
  const allowed = new Set(['revision', 'mode', 'url', 'auth', 'username', 'secret', 'clearSecret', 'allowPrivate']);
  if (Object.keys(value).some(key => !allowed.has(key))) throw new Error('Unsupported connection field');
  if (value.revision !== current.revision) throw new ConnectionConflictError();
  if (!['disabled', 'bundled', 'external'].includes(String(value.mode))) throw new Error('Invalid store mode');
  if (!['none', 'basic', 'bearer'].includes(String(value.auth))) throw new Error('Invalid authentication mode');
  if (typeof value.url !== 'string' || typeof value.username !== 'string' || typeof value.allowPrivate !== 'boolean') throw new Error('Invalid connection fields');
  if (value.clearSecret !== undefined && typeof value.clearSecret !== 'boolean') throw new Error('Invalid clear credential choice');
  if (value.secret !== undefined && (typeof value.secret !== 'string' || value.secret.length > 8192 || /[\r\n\0]/.test(value.secret))) throw new Error('Invalid credential');
  if (value.username.length > 256 || /[:\r\n\0]/.test(value.username)) throw new Error('Invalid username');
  if (value.clearSecret && value.secret) throw new Error('Choose either replacing or clearing the credential');
  const next: StoreConnection = { ...current, mode: value.mode as StoreConnection['mode'], auth: value.auth as StoreConnection['auth'],
    url: value.url.trim().replace(/\/+$/, ''), username: value.username, allowPrivate: value.allowPrivate,
    encryptedSecret: value.clearSecret ? '' : value.secret ? encryptStoredSecret(String(value.secret)) : current.encryptedSecret };
  if (next.mode !== 'external') return { ...next, url: '', auth: 'none', username: '', encryptedSecret: '', allowPrivate: false };
  if (next.url.length > 2048) throw new Error('Store URL is too long');
  let url: URL;
  try { url = new URL(next.url); } catch { throw new Error('A valid store URL is required'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Store URL must use HTTP(S) without credentials, query or fragment');
  if (next.auth !== 'none' && url.protocol !== 'https:') throw new Error('Store credentials require HTTPS');
  if (next.auth !== 'none' && current.mode === 'external' && current.encryptedSecret
    && url.origin !== new URL(current.url).origin && !value.secret) throw new Error('Re-enter the credential when changing the store origin');
  if (next.auth !== current.auth && !value.secret && !value.clearSecret) next.encryptedSecret = '';
  if (next.auth !== 'none' && !next.encryptedSecret) throw new Error('A store credential is required');
  if (next.auth === 'basic' && !next.username) throw new Error('A username is required');
  if (next.auth === 'none') { next.encryptedSecret = ''; next.username = ''; }
  return next;
}

export class ConnectionConflictError extends Error {
  constructor() { super('Connection changed. Reload before saving.'); }
}

export async function saveStoreConnection(next: StoreConnection): Promise<PublicStoreConnection> {
  const saved = { ...next, revision: randomUUID() };
  const result = await query('UPDATE admin_config SET value = $1, updated_at = CURRENT_TIMESTAMP WHERE key = $2 AND value::jsonb->>\'revision\' = $3', [JSON.stringify(saved), KEY, next.revision]);
  if (!result.rowCount) throw new ConnectionConflictError();
  cached = { value: saved, at: Date.now() };
  return publicConnection(saved);
}

export function connectionUrl(value: StoreConnection): string {
  return value.mode === 'bundled' ? bundledStoreUrl() : value.mode === 'external' ? value.url : '';
}

export function connectionHeaders(value: StoreConnection): Record<string, string> {
  if (value.auth === 'none') return {};
  const secret = decryptStoredSecret(value.encryptedSecret);
  return { authorization: value.auth === 'basic' ? `Basic ${Buffer.from(`${value.username}:${secret}`).toString('base64')}` : `Bearer ${secret}` };
}
