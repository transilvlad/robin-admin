import { getStoreConnection } from './connection.js';
import { storeRequest } from './transport.js';

// VictoriaMetrics names snapshots `<UTC yyyymmddhhmmss>-<16 hex>`.
const SNAPSHOT_NAME = /^(\d{14})-[0-9A-F]{16}$/;
// Snapshots are hard links, so creation is fast; allow for a busy disk.
const SNAPSHOT_TIMEOUT_MS = 60_000;

export class SnapshotUnavailableError extends Error {
  constructor(message: string) { super(message); this.name = 'SnapshotUnavailableError'; }
}

export interface TelemetrySnapshot { name: string; createdAt: string }

async function bundledConnection() {
  const connection = await getStoreConnection();
  // Snapshots live inside the store's data volume, so only the bundled store,
  // whose volume this deployment owns, is backed up from Robin Admin.
  if (connection.mode !== 'bundled') throw new SnapshotUnavailableError('Snapshots are available for the bundled store only');
  return connection;
}

async function snapshotCall(path: string, method: 'GET' | 'POST' = 'GET'): Promise<Record<string, unknown>> {
  const connection = await bundledConnection();
  let response;
  try { response = await storeRequest(connection, path, SNAPSHOT_TIMEOUT_MS, { method }); }
  catch { throw new SnapshotUnavailableError('Telemetry store is unreachable'); }
  let body: unknown;
  try { body = JSON.parse(response.body); } catch { body = null; }
  const result = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : {};
  if (response.status < 200 || response.status >= 300 || result.status !== 'ok') {
    throw new SnapshotUnavailableError(`Telemetry store refused the snapshot request (HTTP ${response.status})`);
  }
  return result;
}

export function snapshotFromName(name: string): TelemetrySnapshot | null {
  const match = SNAPSHOT_NAME.exec(name);
  if (!match) return null;
  const s = match[1];
  return { name, createdAt: `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6, 8)}T${s.slice(8, 10)}:${s.slice(10, 12)}:${s.slice(12, 14)}Z` };
}

export async function listSnapshots(): Promise<TelemetrySnapshot[]> {
  const { snapshots } = await snapshotCall('/snapshot/list');
  return (Array.isArray(snapshots) ? snapshots : [])
    .map(name => typeof name === 'string' ? snapshotFromName(name) : null)
    .filter((snapshot): snapshot is TelemetrySnapshot => snapshot !== null)
    .sort((a, b) => b.name.localeCompare(a.name));
}

export async function createSnapshot(): Promise<TelemetrySnapshot> {
  const { snapshot } = await snapshotCall('/snapshot/create', 'POST');
  const created = typeof snapshot === 'string' ? snapshotFromName(snapshot) : null;
  if (!created) throw new SnapshotUnavailableError('Telemetry store returned an unexpected snapshot name');
  return created;
}

export async function deleteSnapshot(name: string): Promise<void> {
  if (!SNAPSHOT_NAME.test(name)) throw new RangeError('Invalid snapshot name');
  await snapshotCall(`/snapshot/delete?${new URLSearchParams({ snapshot: name })}`, 'POST');
}
