import type { PoolClient } from 'pg';
import type { HostSecurityApprovalSummary, HostSecurityDiff, HostSecurityDiffItem, HostSecurityHeartbeat, HostSecuritySections, HostSecuritySnapshot } from '../types/host-security.js';
import { getClient, query } from '../db/connection.js';

export const hostSecuritySections = [
  'sshKeys', 'sshd', 'accounts', 'privilegedGroups', 'sudoers', 'cron',
  'systemd', 'listeners', 'firewall', 'patching', 'integrity',
] as const;

export function diffHostSecurity(
  snapshot: HostSecuritySnapshot,
  baseline: Partial<HostSecuritySections>,
  revision: number,
): HostSecurityDiff {
  const items: HostSecurityDiffItem[] = [];
  for (const section of hostSecuritySections) {
    const current = snapshot.sections[section];
    const previous = baseline[section];
    if (current.status !== 'ok' && current.items.length === 0) continue;
    const before = new Map(previous?.items.map(item => [item.id, item.value] as const));
    const after = new Map(current.items.map(item => [item.id, item.value] as const));
    for (const itemId of new Set([...before.keys(), ...after.keys()])) {
      const oldValue = before.get(itemId);
      const newValue = after.get(itemId);
      if (!newValue && !current.complete) continue;
      if (JSON.stringify(oldValue) === JSON.stringify(newValue)) continue;
      items.push({
        id: `${section}:${itemId}`, section, itemId,
        change: !oldValue ? 'added' : !newValue ? 'removed' : 'changed',
        before: oldValue ?? null, after: newValue ?? null,
      } as HostSecurityDiffItem);
    }
  }
  return { snapshotId: snapshot.id, baselineRevision: revision, baselinePending: revision === 0, items };
}

export function applyHostSecurityApproval(
  snapshot: HostSecuritySnapshot,
  baseline: Partial<HostSecuritySections>,
  diff: HostSecurityDiff,
  itemIds?: string[],
): Partial<HostSecuritySections> {
  const ids = itemIds && new Set(itemIds);
  const output = { ...baseline };
  for (const section of hostSecuritySections) {
    const current = snapshot.sections[section];
    if (current.status !== 'ok') continue;
    const eligible = diff.items.filter(item => item.section === section && (!ids || ids.has(item.id)));
    if (eligible.length === 0 && (ids || !current.complete)) continue;
    if (!ids && current.complete) {
      Object.assign(output, { [section]: current });
      continue;
    }
    const map = new Map(baseline[section]?.items.map(item => [item.id, item] as const));
    for (const item of eligible) {
      if (item.after === null) map.delete(item.itemId);
      else map.set(item.itemId, { id: item.itemId, value: item.after } as never);
    }
    Object.assign(output, { [section]: { status: 'ok', complete: false, items: [...map.values()] } });
  }
  return output;
}

export function undoHostSecurityApprovals(
  baseline: Partial<HostSecuritySections>,
  approvals: HostSecurityDiffItem[][],
): Partial<HostSecuritySections> {
  const output = { ...baseline };
  for (const section of hostSecuritySections) {
    const map = new Map(baseline[section]?.items.map(item => [item.id, item] as const));
    for (const approval of approvals) {
      for (const item of approval) {
        if (item.section !== section) continue;
        if (item.before === null) map.delete(item.itemId);
        else map.set(item.itemId, { id: item.itemId, value: item.before } as never);
      }
    }
    if (map.size || baseline[section]) Object.assign(output, { [section]: { status: 'ok', complete: false, items: [...map.values()] } });
  }
  return output;
}

export type HostSecurityRow = {
  name: string;
  hostId: string;
  snapshotId: string;
  baseline: Partial<HostSecuritySections>;
  baselineRevision: number;
  lastReceivedAt: Date;
  intervalSeconds: number;
};

type SnapshotRow = Omit<HostSecuritySnapshot, 'observedAt' | 'receivedAt'> & { observedAt: Date; receivedAt: Date };

export const hostSecuritySnapshotColumns = `id::text, agent_id AS "hostId", hash, observed_at AS "observedAt",
  received_at AS "receivedAt", sections`;

export function serializeHostSnapshot(row: SnapshotRow): HostSecuritySnapshot {
  return { ...row, observedAt: row.observedAt.toISOString(), receivedAt: row.receivedAt.toISOString() };
}

export class HostSecurityError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

export async function hostSecurityTransaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function acceptHostSecuritySnapshot(agentId: string, input: HostSecurityHeartbeat): Promise<string> {
  return hostSecurityTransaction(async client => {
    await client.query('SELECT agent_id FROM fleet_agents WHERE agent_id = $1 FOR UPDATE', [agentId]);
    const current = await client.query<{ id: string; hash: string; observedAt: Date }>(`
      SELECT s.id::text, s.hash, s.observed_at AS "observedAt"
      FROM host_security_hosts h JOIN host_security_snapshots s ON s.id = h.snapshot_id
      WHERE h.agent_id = $1`, [agentId]);
    const previous = current.rows[0];
    let id = previous?.id;
    if (!previous || previous.hash !== input.hash) {
      if (!input.sections) throw new HostSecurityError(409, 'Full snapshot required');
      if (previous && Date.parse(input.observedAt) < previous.observedAt.getTime()) {
        throw new HostSecurityError(409, 'Snapshot is older than the current observation');
      }
      const { rows } = await client.query<{ id: string }>(`
        INSERT INTO host_security_snapshots (agent_id, hash, observed_at, sections)
        VALUES ($1, $2, $3, $4) RETURNING id::text`,
      [agentId, input.hash, input.observedAt, JSON.stringify(input.sections)]);
      id = rows[0].id;
    }
    await client.query(`
      INSERT INTO host_security_hosts (agent_id, snapshot_id, interval_seconds)
      VALUES ($1, $2, $3)
      ON CONFLICT (agent_id) DO UPDATE SET snapshot_id = EXCLUDED.snapshot_id,
          interval_seconds = EXCLUDED.interval_seconds, last_received_at = CURRENT_TIMESTAMP`,
    [agentId, id, input.intervalSeconds]);
    const pending = input.sections?.patching.items[0]?.value.security;
    if (pending != null) {
      await client.query(`
        UPDATE host_security_hosts SET security_upgrades_since = CASE WHEN $2::int > 0
          THEN COALESCE(security_upgrades_since, CURRENT_TIMESTAMP) ELSE NULL END WHERE agent_id = $1`,
      [agentId, pending]);
    }
    return id!;
  });
}

export async function getHostSecurityState(agentId: string, client?: PoolClient) {
  const run = client ? client.query.bind(client) : query;
  const { rows } = await run<HostSecurityRow & SnapshotRow & { lastApproval: HostSecurityApprovalSummary | null }>(`
    SELECT a.name, h.snapshot_id::text AS "snapshotId", h.baseline,
        h.baseline_revision AS "baselineRevision", h.last_received_at AS "lastReceivedAt",
        h.interval_seconds AS "intervalSeconds",
        s.id::text, h.agent_id AS "hostId", s.hash, s.observed_at AS "observedAt",
        s.received_at AS "receivedAt", s.sections,
        CASE WHEN approval.revision IS NOT NULL THEN jsonb_build_object(
          'revision', approval.revision, 'approvedAt', approval.approved_at,
          'approver', approval.approver, 'reason', approval.reason
        ) END AS "lastApproval"
    FROM host_security_hosts h JOIN fleet_agents a ON a.agent_id = h.agent_id
    JOIN host_security_snapshots s ON s.id = h.snapshot_id
    LEFT JOIN host_security_approvals approval ON approval.agent_id = h.agent_id AND approval.revision = h.baseline_revision
    WHERE h.agent_id = $1 ${client ? 'FOR UPDATE OF h' : ''}`, [agentId]);
  const row = rows[0];
  if (!row) throw new HostSecurityError(404, 'Host security telemetry not found');
  const snapshot = serializeHostSnapshot({
    id: row.id, hostId: row.hostId, hash: row.hash, observedAt: row.observedAt,
    receivedAt: row.receivedAt, sections: row.sections,
  });
  return { row, snapshot, diff: diffHostSecurity(snapshot, row.baseline, row.baselineRevision) };
}
