import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('../../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../../db/queries/config.js', () => ({ ensureConfigTable: vi.fn(async () => undefined) }));
const telemetryConfig = vi.hoisted(() => ({ storeUrl: 'http://metrics-backend:8428' }));
vi.mock('../../config.js', () => ({ config: { telemetry: telemetryConfig } }));
import { query } from '../../db/connection.js';
import { bundledStoreUrl, ConnectionConflictError, connectionHeaders, connectionUrl, getStoreConnection, parseConnectionUpdate, publicConnection, resetStoreConnectionCacheForTests, saveStoreConnection, type StoreConnection } from './connection.js';
const current: StoreConnection = { revision: 'one', mode: 'disabled', url: '', auth: 'none', username: '', allowPrivate: false, encryptedSecret: '' };
const update = { revision: 'one', mode: 'external', url: 'https://store.example.test', auth: 'basic', username: 'fixture', secret: 'fixture-secret', allowPrivate: false };
beforeEach(() => { vi.clearAllMocks(); resetStoreConnectionCacheForTests(); vi.stubEnv('ROBIN_ADMIN_ENCRYPTION_KEY', 'fixture-only-encryption-key-at-least-32'); });
it('encrypts credentials, retains an unchanged credential and never returns the envelope', () => {
  const next = parseConnectionUpdate(update, current);
  expect(next.encryptedSecret).not.toContain('fixture-secret');
  expect(connectionHeaders(next)).toEqual({ authorization: `Basic ${Buffer.from('fixture:fixture-secret').toString('base64')}` });
  expect(publicConnection(next)).toMatchObject({ secretConfigured: true });
  expect(publicConnection(next)).not.toHaveProperty('encryptedSecret');
  expect(parseConnectionUpdate({ ...update, secret: '' }, next).encryptedSecret).toBe(next.encryptedSecret);
  expect(parseConnectionUpdate({ ...update, mode: 'bundled', secret: '' }, next).encryptedSecret).toBe('');
});
it.each([{ url: 'http://store.test' }, { url: 'https://user:password@store.test' }, { url: 'https://store.test?token=secret' }, { url: 'file:///tmp/store' }, { secret: 'bad\nheader' }, { username: 'bad:user' }, { auth: 'invalid' }, { extra: 'docker' }])('rejects invalid external credentials and fields: %s', bad => {
  expect(() => parseConnectionUpdate({ ...update, ...bad }, current)).toThrow();
});
it('detects stale revisions both before a test and at the conditional database write', async () => {
  expect(() => parseConnectionUpdate({ ...update, revision: 'stale' }, current)).toThrow(ConnectionConflictError);
  vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
  await expect(saveStoreConnection(current)).rejects.toThrow(ConnectionConflictError);
  expect(query).toHaveBeenCalledWith(expect.stringContaining("value::jsonb->>'revision' = $3"), expect.arrayContaining(['one']));
});
it('never forwards a retained credential to a different store origin', () => {
  const saved = parseConnectionUpdate(update, current);
  expect(() => parseConnectionUpdate({ ...update, url: 'https://different.example.test', secret: '' }, saved)).toThrow('Re-enter');
  expect(parseConnectionUpdate({ ...update, url: 'https://store.example.test/metrics', secret: '' }, saved).encryptedSecret).toBe(saved.encryptedSecret);
  expect(parseConnectionUpdate({ ...update, url: 'https://different.example.test', secret: 'replacement' }, saved).url).toBe('https://different.example.test');
});
it('loads saved settings and reuses a bounded read cache', async () => {
  vi.mocked(query).mockResolvedValue({ rows: [{ value: JSON.stringify(current) }] } as never);
  expect(await getStoreConnection()).toEqual(current);
  expect(await getStoreConnection()).toEqual(current);
  expect(query).toHaveBeenCalledTimes(1);
});

it('starts on the bundled store when no connection is saved', async () => {
  const bundled: StoreConnection = { ...current, revision: 'seeded', mode: 'bundled' };
  vi.mocked(query)
    .mockResolvedValueOnce({ rows: [] } as never)
    .mockResolvedValueOnce({ rowCount: 1 } as never)
    .mockResolvedValueOnce({ rows: [{ value: JSON.stringify(bundled) }] } as never);
  await expect(getStoreConnection()).resolves.toEqual(bundled);
  expect(query).toHaveBeenNthCalledWith(2, expect.stringContaining('ON CONFLICT (key) DO NOTHING'),
    ['telemetryConnection', expect.stringContaining('"mode":"bundled"')]);
});

it('resolves the bundled store from TELEMETRY_STORE_URL and rejects unusable values', () => {
  expect(connectionUrl({ ...current, mode: 'bundled' })).toBe('http://metrics-backend:8428');
  telemetryConfig.storeUrl = 'http://127.0.0.1:8428';
  expect(bundledStoreUrl()).toBe('http://127.0.0.1:8428');
  for (const bad of ['metrics-backend:8428', 'ftp://store.test', 'http://user:pass@store.test', 'http://store.test?x=1']) {
    telemetryConfig.storeUrl = bad;
    expect(() => bundledStoreUrl()).toThrow('TELEMETRY_STORE_URL');
  }
  telemetryConfig.storeUrl = 'http://metrics-backend:8428';
  expect(connectionUrl(current)).toBe('');
});

it('clears external fields when switching to the bundled store', () => {
  const external = parseConnectionUpdate(update, current);
  const bundled = parseConnectionUpdate({ ...update, revision: external.revision, mode: 'bundled', secret: '' }, external);
  expect(bundled).toMatchObject({ mode: 'bundled', url: '', auth: 'none', username: '', encryptedSecret: '', allowPrivate: false });
});
