import { beforeEach, expect, it, vi } from 'vitest';
vi.mock('./connection.js', () => ({ getStoreConnection: vi.fn() }));
vi.mock('./transport.js', () => ({ storeRequest: vi.fn() }));
import { getStoreConnection, type StoreConnection } from './connection.js';
import { storeRequest } from './transport.js';
import { createSnapshot, deleteSnapshot, listSnapshots, snapshotFromName, SnapshotUnavailableError } from './snapshots.js';

const bundled: StoreConnection = { revision: 'one', mode: 'bundled', url: '', auth: 'none', username: '', encryptedSecret: '', allowPrivate: false };
const reply = (status: number, body: unknown) => ({ status, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getStoreConnection).mockResolvedValue(bundled);
});

it('parses the creation time from a snapshot name and rejects anything else', () => {
  expect(snapshotFromName('20261007081055-18DC310563C98334')).toEqual({ name: '20261007081055-18DC310563C98334', createdAt: '2026-10-07T08:10:55Z' });
  for (const name of ['', '../data', '20261007081055', '20261007081055-18dc310563c98334']) expect(snapshotFromName(name)).toBeNull();
});

it('lists valid snapshots newest first', async () => {
  vi.mocked(storeRequest).mockResolvedValueOnce(reply(200, { status: 'ok', snapshots: ['20261001000000-0000000000000001', 'junk', '20261007000000-0000000000000002'] }));
  expect((await listSnapshots()).map(snapshot => snapshot.name)).toEqual(['20261007000000-0000000000000002', '20261001000000-0000000000000001']);
  expect(storeRequest).toHaveBeenCalledWith(bundled, '/snapshot/list', expect.any(Number), { method: 'GET' });
});

it('creates and deletes snapshots through the store API', async () => {
  vi.mocked(storeRequest)
    .mockResolvedValueOnce(reply(200, { status: 'ok', snapshot: '20261007081055-18DC310563C98334' }))
    .mockResolvedValueOnce(reply(200, { status: 'ok' }));
  expect((await createSnapshot()).name).toBe('20261007081055-18DC310563C98334');
  await deleteSnapshot('20261007081055-18DC310563C98334');
  expect(vi.mocked(storeRequest).mock.calls.map(call => [call[1], call[3]])).toEqual([
    ['/snapshot/create', { method: 'POST' }],
    ['/snapshot/delete?snapshot=20261007081055-18DC310563C98334', { method: 'POST' }],
  ]);
});

it('refuses snapshots for external and disabled stores', async () => {
  for (const mode of ['external', 'disabled'] as const) {
    vi.mocked(getStoreConnection).mockResolvedValueOnce({ ...bundled, mode });
    await expect(createSnapshot()).rejects.toBeInstanceOf(SnapshotUnavailableError);
  }
  expect(storeRequest).not.toHaveBeenCalled();
});

it('rejects invalid names before contacting the store and reports store failures', async () => {
  await expect(deleteSnapshot('../../data')).rejects.toBeInstanceOf(RangeError);
  expect(storeRequest).not.toHaveBeenCalled();
  vi.mocked(storeRequest).mockResolvedValueOnce({ status: 500, body: 'cannot find snapshot' });
  await expect(deleteSnapshot('20261007081055-18DC310563C98334')).rejects.toThrow('HTTP 500');
  vi.mocked(storeRequest).mockRejectedValueOnce(new Error('connect ECONNREFUSED'));
  await expect(listSnapshots()).rejects.toThrow('unreachable');
});
