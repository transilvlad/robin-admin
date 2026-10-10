/**
 * Audit log database queries.
 */

import { query } from '../connection.js';
import type { AuditLogEntry } from '../../types/index.js';

interface AuditRow {
  id: number;
  admin_id: number | null;
  action: string;
  entity_type: string;
  entity_id: string | null;
  old_values: Record<string, unknown> | null;
  new_values: Record<string, unknown> | null;
  ip_address: string | null;
  created_at: Date;
}

function rowToAuditEntry(row: AuditRow): AuditLogEntry {
  return {
    id: row.id,
    adminId: row.admin_id,
    action: row.action,
    entityType: row.entity_type,
    entityId: row.entity_id,
    oldValues: row.old_values,
    newValues: row.new_values,
    ipAddress: row.ip_address,
    createdAt: row.created_at,
  };
}

/**
 * Create an audit log entry.
 */
export async function createAuditEntry(
  adminId: number | null,
  action: string,
  entityType: string,
  entityId: string | null,
  oldValues: Record<string, unknown> | null,
  newValues: Record<string, unknown> | null,
  ipAddress: string | null
): Promise<AuditLogEntry> {
  const result = await query<AuditRow>(
    `INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, old_values, new_values, ip_address)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     RETURNING id, admin_id, action, entity_type, entity_id, old_values, new_values, ip_address, created_at`,
    [
      adminId,
      action,
      entityType,
      entityId,
      oldValues ? JSON.stringify(oldValues) : null,
      newValues ? JSON.stringify(newValues) : null,
      ipAddress,
    ]
  );
  return rowToAuditEntry(result.rows[0]);
}

/**
 * Get audit log entries with pagination and filtering.
 */
export async function getAuditEntries(
  page: number = 1,
  limit: number = 50,
  filters?: {
    adminId?: number;
    entityType?: string;
    entityId?: string;
    action?: string;
    startDate?: Date;
    endDate?: Date;
  }
): Promise<{ entries: AuditLogEntry[]; total: number }> {
  const offset = (page - 1) * limit;
  
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;
  
  if (filters?.adminId !== undefined) {
    whereClauses.push(`admin_id = $${paramIndex++}`);
    params.push(filters.adminId);
  }
  if (filters?.entityType) {
    whereClauses.push(`entity_type = $${paramIndex++}`);
    params.push(filters.entityType);
  }
  if (filters?.entityId) {
    whereClauses.push(`entity_id = $${paramIndex++}`);
    params.push(filters.entityId);
  }
  if (filters?.action) {
    whereClauses.push(`action = $${paramIndex++}`);
    params.push(filters.action);
  }
  if (filters?.startDate) {
    whereClauses.push(`created_at >= $${paramIndex++}`);
    params.push(filters.startDate);
  }
  if (filters?.endDate) {
    whereClauses.push(`created_at <= $${paramIndex++}`);
    params.push(filters.endDate);
  }

  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM admin_audit_log ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const entriesResult = await query<AuditRow>(
    `SELECT id, admin_id, action, entity_type, entity_id, old_values, new_values, ip_address, created_at
     FROM admin_audit_log 
     ${whereClause} 
     ORDER BY created_at DESC 
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, limit, offset]
  );

  return {
    entries: entriesResult.rows.map(rowToAuditEntry),
    total,
  };
}
