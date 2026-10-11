/**
 * Queue database queries (Robin's relay queue).
 */

import { query } from '../connection.js';
import type { QueueItem } from '../../types/index.js';

const QUEUE_TABLE = 'robin_queue';

interface QueueRow {
  id: number;
  queue_uid: string;
  state: string;
  next_attempt_at: string;
  claimed_until: string;
  claim_owner: string | null;
  created_epoch: string;
  updated_epoch: string;
  retry_count: number;
  protocol: string | null;
  session_uid: string | null;
  last_error: string | null;
}

function rowToQueueItem(row: QueueRow): QueueItem {
  return {
    id: row.id,
    queueUid: row.queue_uid,
    state: row.state,
    nextAttemptAt: parseInt(row.next_attempt_at, 10),
    claimedUntil: parseInt(row.claimed_until, 10),
    claimOwner: row.claim_owner,
    createdEpoch: parseInt(row.created_epoch, 10),
    updatedEpoch: parseInt(row.updated_epoch, 10),
    retryCount: row.retry_count,
    protocol: row.protocol,
    sessionUid: row.session_uid,
    lastError: row.last_error,
  };
}

/**
 * Check if the queue table exists.
 */
export async function queueTableExists(): Promise<boolean> {
  const result = await query<{ exists: boolean }>(
    `SELECT EXISTS (
      SELECT FROM information_schema.tables 
      WHERE table_schema = 'public' 
      AND table_name = '${QUEUE_TABLE}'
    )`
  );
  return result.rows[0]?.exists ?? false;
}

/**
 * Get all queue items with pagination and filtering.
 */
export async function getAllQueueItems(
  page: number = 1,
  limit: number = 50,
  filters?: {
    state?: string;
    protocol?: string;
    search?: string;
  }
): Promise<{ items: QueueItem[]; total: number }> {
  const offset = (page - 1) * limit;
  
  const whereClauses: string[] = [];
  const params: unknown[] = [];
  let paramIndex = 1;
  
  if (filters?.state) {
    whereClauses.push(`state = $${paramIndex++}`);
    params.push(filters.state);
  }
  if (filters?.protocol) {
    whereClauses.push(`protocol = $${paramIndex++}`);
    params.push(filters.protocol);
  }
  if (filters?.search) {
    whereClauses.push(`(queue_uid ILIKE $${paramIndex} OR session_uid ILIKE $${paramIndex})`);
    params.push(`%${filters.search}%`);
    paramIndex++;
  }

  const whereClause = whereClauses.length > 0 ? `WHERE ${whereClauses.join(' AND ')}` : '';

  const countResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${QUEUE_TABLE} ${whereClause}`,
    params
  );
  const total = parseInt(countResult.rows[0]?.count ?? '0', 10);

  const queueResult = await query<QueueRow>(
     `SELECT id, queue_uid, state, next_attempt_at, claimed_until, claim_owner,
             created_epoch, updated_epoch, retry_count, protocol, session_uid, last_error
     FROM ${QUEUE_TABLE} 
     ${whereClause} 
     ORDER BY created_epoch DESC 
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, limit, offset]
  );

  return {
    items: queueResult.rows.map(rowToQueueItem),
    total,
  };
}

/**
 * Get queue item by UID.
 */
export async function getQueueItemByUid(queueUid: string): Promise<QueueItem | null> {
  const result = await query<QueueRow>(
     `SELECT id, queue_uid, state, next_attempt_at, claimed_until, claim_owner,
             created_epoch, updated_epoch, retry_count, protocol, session_uid, last_error
     FROM ${QUEUE_TABLE} WHERE queue_uid = $1`,
    [queueUid]
  );
  return result.rows[0] ? rowToQueueItem(result.rows[0]) : null;
}

/**
 * Get queue statistics.
 */
export async function getQueueStats(): Promise<{
  total: number;
  byState: Record<string, number>;
  byProtocol: Record<string, number>;
}> {
  const exists = await queueTableExists();
  if (!exists) {
    return { total: 0, byState: {}, byProtocol: {} };
  }

  const totalResult = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${QUEUE_TABLE}`
  );
  const total = parseInt(totalResult.rows[0]?.count ?? '0', 10);

  const byStateResult = await query<{ state: string; count: string }>(
    `SELECT state, COUNT(*) as count FROM ${QUEUE_TABLE} GROUP BY state`
  );
  const byState: Record<string, number> = {};
  for (const row of byStateResult.rows) {
    byState[row.state] = parseInt(row.count, 10);
  }

  const byProtocolResult = await query<{ protocol: string; count: string }>(
    `SELECT COALESCE(protocol, 'unknown') as protocol, COUNT(*) as count FROM ${QUEUE_TABLE} GROUP BY protocol`
  );
  const byProtocol: Record<string, number> = {};
  for (const row of byProtocolResult.rows) {
    byProtocol[row.protocol] = parseInt(row.count, 10);
  }

  return { total, byState, byProtocol };
}

/**
 * Count queue items by state.
 */
export async function countQueueByState(state: string): Promise<number> {
  const exists = await queueTableExists();
  if (!exists) return 0;
  
  const result = await query<{ count: string }>(
    `SELECT COUNT(*) as count FROM ${QUEUE_TABLE} WHERE state = $1`,
    [state]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}
