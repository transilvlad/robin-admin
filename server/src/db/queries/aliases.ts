/**
 * Alias database queries (Postfix-style aliases).
 */

import { query } from '../connection.js';
import type { Alias } from '../../types/index.js';

interface AliasRow {
  id: number;
  source: string;
  destination: string;
}

function rowToAlias(row: AliasRow): Alias {
  return {
    id: row.id,
    source: row.source,
    destination: row.destination,
  };
}

// Standard aliases table

/**
 * Get all aliases with pagination.
 */
export async function getAllAliases(
  page: number = 1,
  limit: number = 50,
  search?: string
): Promise<{ aliases: Alias[]; total: number }> {
  const offset = (page - 1) * limit;
  
  let whereClause = '';
  const params: unknown[] = [];
  
  if (search) {
    whereClause = 'WHERE source ILIKE $1 OR destination ILIKE $1';
    params.push(`%${search}%`);
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM aliases ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const aliasesResult = await query<AliasRow>(
    `SELECT id, source, destination FROM aliases 
     ${whereClause} 
     ORDER BY source, destination 
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    aliases: aliasesResult.rows.map(rowToAlias),
    total,
  };
}

/**
 * Get alias by ID.
 */
export async function getAliasById(id: number): Promise<Alias | null> {
  const result = await query<AliasRow>(
    'SELECT id, source, destination FROM aliases WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToAlias(result.rows[0]) : null;
}

/**
 * Create a new alias.
 */
export async function createAlias(source: string, destination: string): Promise<Alias> {
  const result = await query<AliasRow>(
    `INSERT INTO aliases (source, destination) 
     VALUES ($1, $2) 
     RETURNING id, source, destination`,
    [source.toLowerCase(), destination.toLowerCase()]
  );
  return rowToAlias(result.rows[0]);
}

/**
 * Update an alias.
 */
export async function updateAlias(
  id: number,
  updates: { source?: string; destination?: string }
): Promise<Alias | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.source !== undefined) {
    setClauses.push(`source = $${paramIndex++}`);
    values.push(updates.source.toLowerCase());
  }
  if (updates.destination !== undefined) {
    setClauses.push(`destination = $${paramIndex++}`);
    values.push(updates.destination.toLowerCase());
  }

  if (setClauses.length === 0) {
    return getAliasById(id);
  }

  values.push(id);

  const result = await query<AliasRow>(
    `UPDATE aliases SET ${setClauses.join(', ')} 
     WHERE id = $${paramIndex} 
     RETURNING id, source, destination`,
    values
  );
  return result.rows[0] ? rowToAlias(result.rows[0]) : null;
}

/**
 * Delete an alias.
 */
export async function deleteAlias(id: number): Promise<boolean> {
  const result = await query('DELETE FROM aliases WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

// Auto-aliases table

/**
 * Get all auto-aliases with pagination.
 */
export async function getAllAutoAliases(
  page: number = 1,
  limit: number = 50,
  search?: string
): Promise<{ aliases: Alias[]; total: number }> {
  const offset = (page - 1) * limit;
  
  let whereClause = '';
  const params: unknown[] = [];
  
  if (search) {
    whereClause = 'WHERE source ILIKE $1 OR destination ILIKE $1';
    params.push(`%${search}%`);
  }

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM auto_aliases ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const aliasesResult = await query<AliasRow>(
    `SELECT id, source, destination FROM auto_aliases 
     ${whereClause} 
     ORDER BY source, destination 
     LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
    [...params, limit, offset]
  );

  return {
    aliases: aliasesResult.rows.map(rowToAlias),
    total,
  };
}

/**
 * Get auto-alias by ID.
 */
export async function getAutoAliasById(id: number): Promise<Alias | null> {
  const result = await query<AliasRow>(
    'SELECT id, source, destination FROM auto_aliases WHERE id = $1',
    [id]
  );
  return result.rows[0] ? rowToAlias(result.rows[0]) : null;
}

/**
 * Create a new auto-alias.
 */
export async function createAutoAlias(source: string, destination: string): Promise<Alias> {
  const result = await query<AliasRow>(
    `INSERT INTO auto_aliases (source, destination) 
     VALUES ($1, $2) 
     RETURNING id, source, destination`,
    [source.toLowerCase(), destination.toLowerCase()]
  );
  return rowToAlias(result.rows[0]);
}

/**
 * Update an auto-alias.
 */
export async function updateAutoAlias(
  id: number,
  updates: { source?: string; destination?: string }
): Promise<Alias | null> {
  const setClauses: string[] = [];
  const values: unknown[] = [];
  let paramIndex = 1;

  if (updates.source !== undefined) {
    setClauses.push(`source = $${paramIndex++}`);
    values.push(updates.source.toLowerCase());
  }
  if (updates.destination !== undefined) {
    setClauses.push(`destination = $${paramIndex++}`);
    values.push(updates.destination.toLowerCase());
  }

  if (setClauses.length === 0) {
    return getAutoAliasById(id);
  }

  values.push(id);

  const result = await query<AliasRow>(
    `UPDATE auto_aliases SET ${setClauses.join(', ')} 
     WHERE id = $${paramIndex} 
     RETURNING id, source, destination`,
    values
  );
  return result.rows[0] ? rowToAlias(result.rows[0]) : null;
}

/**
 * Delete an auto-alias.
 */
export async function deleteAutoAlias(id: number): Promise<boolean> {
  const result = await query('DELETE FROM auto_aliases WHERE id = $1', [id]);
  return (result.rowCount ?? 0) > 0;
}

/**
 * Count total aliases.
 */
export async function countAliases(): Promise<number> {
  const result = await query<{ count: string }>('SELECT COUNT(*) as count FROM aliases');
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Count total auto-aliases.
 */
export async function countAutoAliases(): Promise<number> {
  const result = await query<{ count: string }>('SELECT COUNT(*) as count FROM auto_aliases');
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Check that the alias table has the columns needed by its query contract.
 */
export async function aliasesTableExists(): Promise<boolean> {
  try {
    const result = await query<{ exists: boolean }>(
      `SELECT COUNT(*) = 3 AS exists FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'aliases'
         AND column_name IN ('id', 'source', 'destination')`
    );
    return result.rows[0]?.exists ?? false;
  } catch {
    return false;
  }
}

/**
 * Check if auto_aliases table exists.
 */
export async function autoAliasesTableExists(): Promise<boolean> {
  try {
    const result = await query<{ exists: boolean }>(
      `SELECT COUNT(*) = 3 AS exists FROM information_schema.columns
       WHERE table_schema = 'public' AND table_name = 'auto_aliases'
         AND column_name IN ('id', 'source', 'destination')`
    );
    return result.rows[0]?.exists ?? false;
  } catch {
    return false;
  }
}
