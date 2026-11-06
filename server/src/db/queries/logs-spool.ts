import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { getClient, query } from '../connection.js';
import { logger } from '../../logger.js';

export type LogsSpoolOrigin = 'fleet' | 'http' | 'sentry';
export type LogsStoreRow = Record<string, string>;

export interface LogsSpoolBatch {
  id: string;
  batchId: string;
  rows: LogsStoreRow[];
  attempts: number;
  uncertain: boolean;
}

export interface LogsSpoolStatus {
  queuedLines: number;
  queuedBytes: number;
  quarantinedBatches: number;
  quarantinedLines: number;
  quarantinedBytes: number;
  usedBytes: number;
  oldestQueuedAt: string | null;
  retryingBatches: number;
  uncertainBatches: number;
  uncertainDeliveries24h: number;
  droppedLines24h: number;
  rejectedLines24h: number;
  discardedLines24h: number;
  lastDeliveredAt: string | null;
  lastErrorAt: string | null;
  lastError: string | null;
}

export type EnqueueOutcome = 'queued' | 'duplicate' | 'full' | 'too_large';

type Executor = Pick<PoolClient, 'query'>;
const ADMISSION_LOCK_ID = 846_255_037;

function run<T extends QueryResultRow>(executor: Executor, text: string, params: unknown[]): Promise<QueryResult<T>> {
  return executor.query<T>(text, params);
}

/** Record the latest Fleet batch in its caller's transaction, serializing per service. */
export async function registerFleetLogBatch(executor: Executor, fleetServiceId: number, batchId: string): Promise<boolean> {
  const result = await run(
    executor,
    `INSERT INTO fleet_log_receipts (fleet_service_id, batch_id) VALUES ($1, $2)
     ON CONFLICT (fleet_service_id) DO UPDATE SET batch_id = EXCLUDED.batch_id
     WHERE fleet_log_receipts.batch_id <> EXCLUDED.batch_id
     RETURNING fleet_service_id`,
    [fleetServiceId, batchId],
  );
  return Boolean(result.rowCount);
}

/**
 * Store an accepted batch until the logs store confirms it. A repeated
 * idempotency key is reported as a duplicate. When the queue is full the batch
 * is refused. Rejected batches remain in the bounded spool capacity until an
 * administrator retries or discards them.
 */
interface EnqueueInput {
  origin: LogsSpoolOrigin;
  idempotencyKey?: string | null;
  rows: LogsStoreRow[];
  maxBytes: number;
}

export async function enqueueLogsBatch(input: EnqueueInput, executor?: Executor): Promise<EnqueueOutcome> {
  if (executor) return enqueueInTransaction(input, executor);
  const client = await getClient();
  try {
    await client.query('BEGIN');
    const outcome = await enqueueInTransaction(input, client);
    await client.query('COMMIT');
    return outcome;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error('Failed to roll back Logs queue admission', { error: (rollbackError as Error).message });
    }
    throw error;
  } finally {
    client.release();
  }
}

async function enqueueInTransaction(input: EnqueueInput, executor: Executor): Promise<EnqueueOutcome> {
  const payload = JSON.stringify(input.rows);
  const bytes = Buffer.byteLength(payload, 'utf8');
  const key = input.idempotencyKey || null;
  if (!key && input.rows.length === 0) return 'queued';
  // The capacity check and insert must see prior admissions, including those
  // from other replicas. A separate statement after acquiring the lock gets a
  // fresh READ COMMITTED snapshot.
  await run(executor, 'SELECT pg_advisory_xact_lock($1)', [ADMISSION_LOCK_ID]);
  if (key) {
    const existing = await run(executor, 'SELECT 1 FROM logs_ingest_spool WHERE origin = $1 AND idempotency_key = $2', [input.origin, key]);
    if (existing.rowCount) return 'duplicate';
  }
  if (input.rows.length > 0 && bytes > input.maxBytes) return 'too_large';
  const used = await run<{ bytes: string }>(executor, `SELECT COALESCE(SUM(bytes), 0)::bigint AS bytes FROM logs_ingest_spool WHERE status IN ('pending', 'rejected')`, []);
  const full = input.rows.length > 0 && Number(used.rows[0]?.bytes ?? 0) + bytes > input.maxBytes;
  if (full) return 'full';
  const pending = input.rows.length > 0;
  const inserted = await run(
    executor,
    `INSERT INTO logs_ingest_spool (origin, idempotency_key, status, entries, line_count, bytes, completed_at)
     VALUES ($1, $2, $3::varchar, $4::jsonb, $5, $6, CASE WHEN $3::varchar = 'pending' THEN NULL ELSE CURRENT_TIMESTAMP END)
     ON CONFLICT (origin, idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING id`,
    [input.origin, key, pending ? 'pending' : 'sent', pending ? payload : '[]', input.rows.length, pending ? bytes : 0],
  );
  if (!inserted.rowCount) return 'duplicate';
  return 'queued';
}

interface ClaimedRow {
  id: string;
  batch_id: string;
  entries: LogsStoreRow[];
  line_count: number;
  attempts: number;
  uncertain: boolean;
}

/**
 * Lease due batches, oldest first, up to `maxLines` (always at least one). A
 * batch whose previous lease expired may have reached the store, so it is
 * marked uncertain and checked before it is sent again.
 */
export async function claimLogsBatches(maxLines: number, leaseMs: number): Promise<LogsSpoolBatch[]> {
  const result = await query<ClaimedRow>(
    `WITH locked AS (
       SELECT id, line_count, next_attempt_at
       FROM logs_ingest_spool
       WHERE status = 'pending'
         AND next_attempt_at <= CURRENT_TIMESTAMP
         AND (claimed_until IS NULL OR claimed_until < CURRENT_TIMESTAMP)
       ORDER BY next_attempt_at, id
       LIMIT 500
       FOR UPDATE SKIP LOCKED
     ), picked AS (
       SELECT id FROM (
         SELECT id, line_count, SUM(line_count) OVER (ORDER BY next_attempt_at, id) AS running
         FROM locked
       ) due
       WHERE running - line_count < $1
     )
     UPDATE logs_ingest_spool s
     SET claimed_until = CURRENT_TIMESTAMP + ($2::int * INTERVAL '1 millisecond'),
         uncertain = s.uncertain OR s.claimed_until IS NOT NULL
     FROM picked
     WHERE s.id = picked.id
     RETURNING s.id::text AS id, s.batch_id::text AS batch_id, s.entries, s.line_count, s.attempts, s.uncertain`,
    [maxLines, leaseMs],
  );
  return result.rows
    .sort((a, b) => Number(a.id) - Number(b.id))
    .map((row) => ({ id: row.id, batchId: row.batch_id, rows: row.entries, attempts: row.attempts, uncertain: row.uncertain }));
}

/** Keep receipts and uncertain deliveries briefly; other delivered batches are removed. */
export async function markLogsBatchesSent(ids: string[]): Promise<void> {
  if (!ids.length) return;
  await query(
    `WITH done AS (
       DELETE FROM logs_ingest_spool
       WHERE id = ANY($1::bigint[]) AND idempotency_key IS NULL AND NOT uncertain RETURNING id
     )
     UPDATE logs_ingest_spool
     SET status = 'sent', entries = '[]'::jsonb, bytes = 0, claimed_until = NULL, completed_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::bigint[]) AND (idempotency_key IS NOT NULL OR uncertain)`,
    [ids],
  );
  await query(
    `INSERT INTO logs_ingest_delivery_marker (id, delivered_at) VALUES (1, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET delivered_at = EXCLUDED.delivered_at`,
    [],
  );
}

/** Return leased batches for a later attempt. */
export async function releaseLogsBatches(ids: string[], input: { error: string; uncertain: boolean; delayMs: number }): Promise<void> {
  if (!ids.length) return;
  await query(
    `UPDATE logs_ingest_spool
     SET attempts = attempts + 1,
         uncertain = uncertain OR $2,
         next_attempt_at = CURRENT_TIMESTAMP + ($3::int * INTERVAL '1 millisecond'),
         claimed_until = NULL,
         last_error = $4,
         last_error_at = CURRENT_TIMESTAMP
     WHERE id = ANY($1::bigint[])`,
    [ids, input.uncertain, input.delayMs, input.error.slice(0, 500)],
  );
}

/** The store refused a batch as invalid; retain its lines in bounded quarantine. */
export async function rejectLogsBatch(id: string, error: string): Promise<void> {
  await query(
    `UPDATE logs_ingest_spool
     SET status = 'rejected', claimed_until = NULL,
         last_error = $2, last_error_at = CURRENT_TIMESTAMP, completed_at = CURRENT_TIMESTAMP
     WHERE id = $1::bigint`,
    [id, error.slice(0, 500)],
  );
}

export interface RejectedLogsBatch {
  id: string;
  origin: LogsSpoolOrigin;
  lineCount: number;
  bytes: number;
  error: string | null;
  createdAt: string;
}

export async function listRejectedLogsBatches(limit = 50): Promise<RejectedLogsBatch[]> {
  const result = await query<{
    id: string;
    origin: LogsSpoolOrigin;
    line_count: number;
    bytes: number;
    last_error: string | null;
    created_at: Date;
  }>(
    `SELECT id::text, origin, line_count, bytes, last_error, created_at
       FROM logs_ingest_spool
      WHERE status = 'rejected'
      ORDER BY completed_at, id
      LIMIT $1`,
    [Math.max(1, Math.min(100, Math.floor(limit)))],
  );
  return result.rows.map((row) => ({
    id: row.id,
    origin: row.origin,
    lineCount: row.line_count,
    bytes: row.bytes,
    error: row.last_error,
    createdAt: row.created_at.toISOString(),
  }));
}

export async function getRejectedLogsBatch(id: string): Promise<LogsStoreRow[] | null> {
  const result = await query<{ entries: LogsStoreRow[] }>(
    `SELECT entries FROM logs_ingest_spool WHERE id = $1::bigint AND status = 'rejected'`,
    [id],
  );
  return result.rows[0]?.entries ?? null;
}

export async function retryRejectedLogsBatch(id: string): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADMISSION_LOCK_ID]);
    const result = await client.query(
      `UPDATE logs_ingest_spool
          SET status = 'pending', attempts = 0,
              next_attempt_at = CURRENT_TIMESTAMP, claimed_until = NULL,
              last_error = NULL, last_error_at = NULL, completed_at = NULL
        WHERE id = $1::bigint AND status = 'rejected'`,
      [id],
    );
    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function discardRejectedLogsBatch(id: string): Promise<boolean> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [ADMISSION_LOCK_ID]);
    const result = await client.query(
      `UPDATE logs_ingest_spool
          SET status = 'discarded', entries = '[]'::jsonb, completed_at = CURRENT_TIMESTAMP
        WHERE id = $1::bigint AND status = 'rejected'`,
      [id],
    );
    await client.query('COMMIT');
    return (result.rowCount ?? 0) > 0;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Remove expired receipts, but never silently purge quarantined log lines. */
export async function purgeLogsSpool(retentionMs: number): Promise<number> {
  const result = await query(
    `DELETE FROM logs_ingest_spool
     WHERE status IN ('sent', 'dropped', 'discarded') AND completed_at < CURRENT_TIMESTAMP - ($1::bigint * INTERVAL '1 millisecond')`,
    [retentionMs],
  );
  return result.rowCount ?? 0;
}

interface StatusRow {
  queued_lines: string;
  queued_bytes: string;
  quarantined_batches: string;
  quarantined_lines: string;
  quarantined_bytes: string;
  used_bytes: string;
  oldest_queued_at: Date | null;
  retrying_batches: string;
  uncertain_batches: string;
  uncertain_deliveries: string;
  dropped_lines: string;
  rejected_lines: string;
  discarded_lines: string;
  last_delivered_at: Date | null;
  last_error_at: Date | null;
  last_error: string | null;
}

export async function getLogsSpoolStatus(): Promise<LogsSpoolStatus> {
  const result = await query<StatusRow>(
    `SELECT
       pending.queued_lines, pending.queued_bytes, pending.oldest_queued_at, pending.retrying_batches, pending.uncertain_batches,
       pending.quarantined_batches, pending.quarantined_lines, pending.quarantined_bytes, pending.used_bytes,
       completed.uncertain_deliveries, completed.dropped_lines, completed.rejected_lines, completed.discarded_lines,
       (SELECT delivered_at FROM logs_ingest_delivery_marker WHERE id = 1) AS last_delivered_at,
       latest.last_error_at, latest.last_error
     FROM (
       SELECT COALESCE(SUM(line_count) FILTER (WHERE status = 'pending'), 0)::bigint AS queued_lines,
              COALESCE(SUM(bytes) FILTER (WHERE status = 'pending'), 0)::bigint AS queued_bytes,
              MIN(created_at) FILTER (WHERE status = 'pending') AS oldest_queued_at,
              COUNT(*) FILTER (WHERE status = 'pending' AND attempts > 0)::bigint AS retrying_batches,
              COUNT(*) FILTER (WHERE status = 'pending' AND uncertain)::bigint AS uncertain_batches,
              COUNT(*) FILTER (WHERE status = 'rejected')::bigint AS quarantined_batches,
              COALESCE(SUM(line_count) FILTER (WHERE status = 'rejected'), 0)::bigint AS quarantined_lines,
              COALESCE(SUM(bytes) FILTER (WHERE status = 'rejected'), 0)::bigint AS quarantined_bytes,
              COALESCE(SUM(bytes), 0)::bigint AS used_bytes
       FROM logs_ingest_spool WHERE status IN ('pending', 'rejected')
     ) pending
     CROSS JOIN (
       SELECT COALESCE(SUM(line_count) FILTER (WHERE status = 'dropped'), 0)::bigint AS dropped_lines,
              COALESCE(SUM(line_count) FILTER (WHERE status = 'rejected'), 0)::bigint AS rejected_lines,
       COALESCE(SUM(line_count) FILTER (WHERE status = 'discarded'), 0)::bigint AS discarded_lines,
              COUNT(*) FILTER (WHERE status = 'sent' AND uncertain)::bigint AS uncertain_deliveries
       FROM logs_ingest_spool
       WHERE status IN ('sent', 'dropped', 'rejected', 'discarded') AND completed_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'
     ) completed
     LEFT JOIN LATERAL (
       SELECT last_error, last_error_at FROM logs_ingest_spool
       WHERE last_error_at IS NOT NULL AND status IN ('pending', 'rejected')
       ORDER BY last_error_at DESC
       LIMIT 1
     ) latest ON true`,
    [],
  );
  const row = result.rows[0];
  return {
    queuedLines: Number(row?.queued_lines ?? 0),
    queuedBytes: Number(row?.queued_bytes ?? 0),
    quarantinedBatches: Number(row?.quarantined_batches ?? 0),
    quarantinedLines: Number(row?.quarantined_lines ?? 0),
    quarantinedBytes: Number(row?.quarantined_bytes ?? 0),
    usedBytes: Number(row?.used_bytes ?? 0),
    oldestQueuedAt: row?.oldest_queued_at?.toISOString() ?? null,
    retryingBatches: Number(row?.retrying_batches ?? 0),
    uncertainBatches: Number(row?.uncertain_batches ?? 0),
    uncertainDeliveries24h: Number(row?.uncertain_deliveries ?? 0),
    droppedLines24h: Number(row?.dropped_lines ?? 0),
    rejectedLines24h: Number(row?.rejected_lines ?? 0),
    discardedLines24h: Number(row?.discarded_lines ?? 0),
    lastDeliveredAt: row?.last_delivered_at?.toISOString() ?? null,
    lastErrorAt: row?.last_error_at?.toISOString() ?? null,
    lastError: row?.last_error ?? null,
  };
}
