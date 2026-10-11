import { query } from '../connection.js';

export interface RobinClamavServiceLink {
  serverId: string;
  clamavServiceId: string;
  createdAt: Date;
  updatedAt: Date;
}

interface RobinClamavServiceLinkRow {
  server_id: string;
  clamav_service_id: string;
  created_at: Date;
  updated_at: Date;
}

function mapLink(row: RobinClamavServiceLinkRow): RobinClamavServiceLink {
  return {
    serverId: row.server_id,
    clamavServiceId: row.clamav_service_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function getRobinClamavServiceLink(serverId: string): Promise<RobinClamavServiceLink | null> {
  const result = await query<RobinClamavServiceLinkRow>(
    `SELECT server_id, clamav_service_id, created_at, updated_at
     FROM robin_clamav_service_links
     WHERE server_id = $1
     LIMIT 1`,
    [serverId]
  );

  return result.rows[0] ? mapLink(result.rows[0]) : null;
}

export async function getEffectiveRobinClamavServiceLink(serverId: string): Promise<{
  link: RobinClamavServiceLink | null;
  inherited: boolean;
}> {
  const direct = await getRobinClamavServiceLink(serverId);
  if (direct) {
    return { link: direct, inherited: false };
  }

  if (serverId === 'default') {
    return { link: null, inherited: false };
  }

  const inherited = await getRobinClamavServiceLink('default');
  return {
    link: inherited,
    inherited: inherited !== null,
  };
}

export async function upsertRobinClamavServiceLink(serverId: string, clamavServiceId: string): Promise<RobinClamavServiceLink> {
  const result = await query<RobinClamavServiceLinkRow>(
    `INSERT INTO robin_clamav_service_links (server_id, clamav_service_id)
     VALUES ($1, $2)
     ON CONFLICT (server_id)
     DO UPDATE SET clamav_service_id = EXCLUDED.clamav_service_id, updated_at = CURRENT_TIMESTAMP
     RETURNING server_id, clamav_service_id, created_at, updated_at`,
    [serverId, clamavServiceId]
  );

  return mapLink(result.rows[0]);
}

export async function deleteRobinClamavServiceLink(serverId: string): Promise<void> {
  await query(
    `DELETE FROM robin_clamav_service_links
     WHERE server_id = $1`,
    [serverId]
  );
}
