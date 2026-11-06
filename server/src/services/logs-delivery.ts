import { config as appConfig } from '../config.js';
import {
  claimLogsBatches,
  markLogsBatchesSent,
  purgeLogsSpool,
  rejectLogsBatch,
  releaseLogsBatches,
  type LogsSpoolBatch,
  type LogsStoreRow,
} from '../db/queries/logs-spool.js';
import { logger } from '../logger.js';
import { LogsStoreWriteError, MAX_BATCH_LINES, storedBatchSequences, writeStoreRows } from './logs-store.js';

const LEASE_MS = 2 * 60 * 1000;
const IDLE_MS = 1_000;
const ERROR_DELAY_MS = 5_000;
// Allow normal indexing delay before checking. This cannot prove a timed-out
// write has finished, so retries remain at-least-once.
const VERIFY_DELAY_MS = 15_000;
const MAX_BACKOFF_MS = 5 * 60 * 1000;
const RECEIPT_RETENTION_MS = 24 * 60 * 60 * 1000;
const PURGE_INTERVAL_MS = 10 * 60 * 1000;

let timer: NodeJS.Timeout | null = null;
let started = false;
let running = false;
let lastPurgeAt = 0;

function backoffMs(attempts: number): number {
  return Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(attempts, 12));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface Outgoing {
  batch: LogsSpoolBatch;
  rows: LogsStoreRow[];
}

// Every stored line carries its batch id and position, so a batch whose write
// outcome is unknown can be checked and only its currently missing lines sent
// again. A delayed earlier request can still create duplicate rows.
function tag(batch: LogsSpoolBatch): LogsStoreRow[] {
  return batch.rows.map((row, index) => ({ ...row, ingest_batch: batch.batchId, ingest_seq: String(index) }));
}

async function release(batches: LogsSpoolBatch[], error: unknown): Promise<void> {
  const uncertain = error instanceof LogsStoreWriteError ? error.uncertain : true;
  const attempts = Math.max(0, ...batches.map((batch) => batch.attempts));
  const delayMs = uncertain ? Math.max(VERIFY_DELAY_MS, backoffMs(attempts)) : backoffMs(attempts);
  await releaseLogsBatches(batches.map((batch) => batch.id), { error: errorMessage(error), uncertain, delayMs });
}

async function sendIndividually(outgoing: Outgoing[], delivered: string[]): Promise<void> {
  for (const item of outgoing) {
    try {
      await writeStoreRows(item.rows);
      delivered.push(item.batch.id);
    } catch (error) {
      if (error instanceof LogsStoreWriteError && error.rejected) {
        logger.error('Logs store rejected a queued batch; its lines were retained in quarantine', { lines: item.rows.length, error: error.message });
        await rejectLogsBatch(item.batch.id, error.message);
      } else {
        await release([item.batch], error);
      }
    }
  }
}

/** Deliver one claim of due batches. Returns how many batches were claimed. */
export async function deliverQueuedLogs(): Promise<number> {
  const batches = await claimLogsBatches(MAX_BATCH_LINES, LEASE_MS);
  if (!batches.length) return 0;
  const delivered: string[] = [];
  const outgoing: Outgoing[] = [];
  for (const batch of batches) {
    let rows = tag(batch);
    if (batch.uncertain) {
      try {
        const stored = await storedBatchSequences(batch.batchId, rows);
        rows = rows.filter((_, index) => !stored.has(index));
      } catch (error) {
        await release([batch], error);
        continue;
      }
      if (!rows.length) {
        delivered.push(batch.id);
        continue;
      }
    }
    outgoing.push({ batch, rows });
  }
  if (outgoing.length) {
    try {
      await writeStoreRows(outgoing.flatMap((item) => item.rows));
      delivered.push(...outgoing.map((item) => item.batch.id));
    } catch (error) {
      if (error instanceof LogsStoreWriteError && error.rejected) {
        // Find the offending batch so valid batches are not held back by it.
        await sendIndividually(outgoing, delivered);
      } else {
        logger.warn('Logs store write failed; batches stay queued', {
          batches: outgoing.length,
          uncertain: error instanceof LogsStoreWriteError ? error.uncertain : true,
          error: errorMessage(error),
        });
        await release(outgoing.map((item) => item.batch), error);
      }
    }
  }
  await markLogsBatchesSent(delivered);
  return batches.length;
}

async function tick(): Promise<void> {
  timer = null;
  if (running) return;
  running = true;
  let delayMs = IDLE_MS;
  try {
    if (appConfig.logs.storeUrl) {
      const claimed = await deliverQueuedLogs();
      if (claimed) delayMs = 0;
    }
    if (Date.now() - lastPurgeAt > PURGE_INTERVAL_MS) {
      lastPurgeAt = Date.now();
      await purgeLogsSpool(RECEIPT_RETENTION_MS);
    }
  } catch (error) {
    logger.error('Logs delivery failed', { error: errorMessage(error) });
    delayMs = ERROR_DELAY_MS;
  } finally {
    running = false;
  }
  if (started) schedule(delayMs);
}

function schedule(delayMs: number): void {
  if (timer) return;
  timer = setTimeout(() => void tick(), delayMs);
  timer.unref?.();
}

export function startLogsDeliveryWorker(): void {
  if (started) return;
  started = true;
  schedule(0);
  logger.info('Logs delivery worker started');
}

export function stopLogsDeliveryWorker(): void {
  started = false;
  if (timer) clearTimeout(timer);
  timer = null;
}
