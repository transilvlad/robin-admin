import { config as appConfig } from '../config.js';
import { getClient } from '../db/connection.js';
import { getConfig } from '../db/queries/config.js';
import { enqueueLogsBatch, registerFleetLogBatch } from '../db/queries/logs-spool.js';
import { logger } from '../logger.js';
import { fleetLogRows } from './logs-store.js';
import { ingestPostfixLogLines } from './metrics-poller.js';
import { ingestAgentLogs } from './service-logs.js';

export interface FleetLogBatch {
  fleetServiceId: number;
  serviceType: string;
  serviceId: string;
  agentId?: string;
  source: string;
  lines: string[];
  times?: unknown[];
  batchId?: string | null;
  reset: boolean;
  resetAppend?: boolean;
  counters?: Record<string, number | string>;
}

export interface FleetLogBatchResult {
  stored: number;
  duplicate: boolean;
}

export class FleetLogsQueueFullError extends Error {
  readonly status = 503;
}

export class FleetLogsBatchTooLargeError extends Error {
  readonly status = 413;
}

/**
 * Accept a log batch an agent read. A reset batch (the recent tail after the
 * agent starts without a saved position) only refreshes the rolling buffer.
 * New lines are queued for searchable history and counted for Postfix in one
 * transaction keyed by the agent's batch id. The most recent batch receipt
 * remains available while that agent is waiting for an acknowledgement.
 */
export async function acceptFleetLogBatch(batch: FleetLogBatch): Promise<FleetLogBatchResult> {
  if (batch.reset && batch.resetAppend) {
    if (!batch.batchId) throw new Error('A reset append requires a batch id');
    const config = await getConfig();
    const client = await getClient();
    try {
      await client.query('BEGIN');
      if (batch.batchId && !(await registerFleetLogBatch(client, batch.fleetServiceId, batch.batchId))) {
        await client.query('COMMIT');
        return { stored: 0, duplicate: true };
      }
      const stored = await ingestAgentLogs(batch.serviceId, batch.source, batch.lines, false, batch.counters, client, config.logMaxLines);
      await client.query('COMMIT');
      return { stored, duplicate: false };
    } catch (error) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Failed to roll back Fleet reset tail', { error: (rollbackError as Error).message });
      }
      throw error;
    } finally {
      client.release();
    }
  }
  if (batch.reset) {
    const stored = batch.counters
      ? await ingestAgentLogs(batch.serviceId, batch.source, batch.lines, true, batch.counters)
      : await ingestAgentLogs(batch.serviceId, batch.source, batch.lines, true);
    return { stored, duplicate: false };
  }
  const historyEnabled = Boolean(appConfig.logs.storeUrl) && (await getConfig()).logsEnabled;
  const client = await getClient();
  try {
    await client.query('BEGIN');
    if (batch.batchId && !(await registerFleetLogBatch(client, batch.fleetServiceId, batch.batchId))) {
      await client.query('COMMIT');
      return { stored: 0, duplicate: true };
    }
    const outcome = await enqueueLogsBatch({
      origin: 'fleet',
      idempotencyKey: batch.batchId ? `${batch.serviceId}:${batch.batchId}` : null,
      rows: historyEnabled
        ? fleetLogRows({ serviceType: batch.serviceType, serviceId: batch.serviceId, source: batch.source, agentId: batch.agentId }, batch.lines, batch.times)
        : [],
      maxBytes: appConfig.logs.spoolMaxBytes,
    }, client);
    if (outcome === 'full') {
      throw new FleetLogsQueueFullError('Logs ingestion queue is full; retry this batch');
    }
    if (outcome === 'too_large') {
      throw new FleetLogsBatchTooLargeError('Logs batch exceeds the configured queue capacity; split this batch and retry');
    }
    if (outcome === 'duplicate') {
      // Do not replace the latest receipt when an older batch is replayed.
      await client.query('ROLLBACK');
      return { stored: 0, duplicate: true };
    }
    if (batch.serviceType === 'postfix') await ingestPostfixLogLines(batch.fleetServiceId, batch.lines, client);
    await client.query('COMMIT');
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      logger.error('Failed to roll back Fleet Logs ingestion', { error: (rollbackError as Error).message });
    }
    throw error;
  } finally {
    client.release();
  }
  let stored = 0;
  try {
    stored = batch.counters
      ? await ingestAgentLogs(batch.serviceId, batch.source, batch.lines, false, batch.counters)
      : await ingestAgentLogs(batch.serviceId, batch.source, batch.lines, false);
  } catch (error) {
    logger.warn('Recent log buffer update failed', { serviceId: batch.serviceId, error: (error as Error).message });
  }
  return { stored, duplicate: false };
}
