import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer, type AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { config } from '../config.js';
import { closePool, getClient, query } from '../db/connection.js';
import { updateConfig } from '../db/queries/config.js';
import { getAgentServiceLogs } from '../db/queries/fleet-agent-logs.js';
import {
  claimLogsBatches,
  discardRejectedLogsBatch,
  enqueueLogsBatch,
  getRejectedLogsBatch,
  listRejectedLogsBatches,
  purgeLogsSpool,
  retryRejectedLogsBatch,
  type LogsStoreRow,
} from '../db/queries/logs-spool.js';
import { initializeSchema } from '../db/schema.js';
import { acceptFleetLogBatch, FleetLogsQueueFullError } from './fleet-logs.js';
import { deliverQueuedLogs } from './logs-delivery.js';
import { countLogs, getLogsStoreStatus, ingestExternalLogs, logsWriteStatus, LogsStoreUnavailableError, searchLogs, setLogsStoreFetchForTests, storedBatchSequences, writeStoreRows } from './logs-store.js';

const storeUrl = process.env.LOGS_STORE_URL ?? '';

function marker(): string {
  return `logsDelivery${randomUUID().replaceAll('-', '')}`;
}

function rows(text: string, count: number): LogsStoreRow[] {
  const now = Date.now();
  return Array.from({ length: count }, (_, index) => ({
    _time: new Date(now - (count - index) * 1_000).toISOString(),
    _msg: `${text} line ${index}`,
    source: 'integration',
    service_id: 'logs-delivery-it',
  }));
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    value = await read();
  }
  return value;
}

const stored = (text: string) => countLogs(text, 3_600, new Date(Date.now() + 60_000));

async function closedPort(): Promise<number> {
  const server = createServer().listen(0, '127.0.0.1');
  await once(server, 'listening');
  const { port } = server.address() as AddressInfo;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

async function spoolRows(): Promise<Array<{ status: string; attempts: number; uncertain: boolean; last_error: string | null }>> {
  return (await query('SELECT status, attempts, uncertain, last_error FROM logs_ingest_spool ORDER BY id')).rows;
}

async function waitForAdmissionLock(pid: number): Promise<void> {
  const event = await eventually(async () => (
    await query<{ wait_event: string | null }>('SELECT wait_event FROM pg_stat_activity WHERE pid = $1', [pid])
  ).rows[0]?.wait_event, (value) => value === 'advisory', 5_000);
  expect(event).toBe('advisory');
}

describe.skipIf(process.env.LOGS_IT_DB !== '1' || !storeUrl)('Logs ingestion queue (real PostgreSQL and VictoriaLogs)', () => {
  const spoolMaxBytes = config.logs.spoolMaxBytes;
  let initialized = false;

  beforeAll(async () => {
    if (!/^robin_test_logs($|_)/.test(process.env.DB_NAME ?? '') || !['127.0.0.1', 'localhost'].includes(process.env.DB_HOST ?? '')) {
      throw new Error('A disposable Logs test database on loopback is required');
    }
    await initializeSchema();
    initialized = true;
    await updateConfig({ logsEnabled: true });
  }, 30_000);

  beforeEach(async () => {
    config.logs.storeUrl = storeUrl;
    config.logs.spoolMaxBytes = spoolMaxBytes;
    await query('DELETE FROM logs_ingest_spool');
  });

  afterAll(async () => {
    config.logs.storeUrl = storeUrl;
    config.logs.spoolMaxBytes = spoolMaxBytes;
    try {
      if (initialized) await query('DELETE FROM logs_ingest_spool');
    } finally {
      await closePool();
    }
  });

  it('keeps accepted lines through a store outage and delivers them once it returns', async () => {
    const text = marker();
    config.logs.storeUrl = `http://127.0.0.1:${await closedPort()}`;
    const entry = { time: new Date().toISOString(), message: text, source: 'integration', serviceId: 'logs-delivery-it' };
    await ingestExternalLogs([entry], { origin: 'http', idempotencyKey: `it:${text}` });
    await ingestExternalLogs([entry], { origin: 'http', idempotencyKey: `it:${text}` });

    expect(await deliverQueuedLogs()).toBe(1);
    expect(await spoolRows()).toEqual([expect.objectContaining({ status: 'pending', attempts: 1, uncertain: false, last_error: expect.any(String) })]);
    expect(await logsWriteStatus()).toMatchObject({ queuedLines: 1, retryingBatches: 1 });

    config.logs.storeUrl = storeUrl;
    await query('UPDATE logs_ingest_spool SET next_attempt_at = CURRENT_TIMESTAMP');
    expect(await deliverQueuedLogs()).toBe(1);
    expect(await eventually(() => stored(text), (count) => count === 1)).toBe(1);
    expect(await spoolRows()).toEqual([expect.objectContaining({ status: 'sent' })]);
    expect(await logsWriteStatus()).toMatchObject({ queuedLines: 0, retryingBatches: 0, lastDeliveredAt: expect.any(String) });

    // The receipt outlives delivery, so a late retry is still recognised.
    await ingestExternalLogs([entry], { origin: 'http', idempotencyKey: `it:${text}` });
    expect(await deliverQueuedLogs()).toBe(0);
    expect(await stored(text)).toBe(1);
  }, 40_000);

  it('stores external messages and metadata containing unsupported characters', async () => {
    const text = marker();
    await ingestExternalLogs([{
      time: new Date().toISOString(),
      message: `${text} \u0000\uD800`,
      source: 'external\u0000\uD800',
      sourceType: 'http',
      sourceName: 'collector\u0000\uDC00',
      serviceId: 'logs-delivery-it',
    }], { origin: 'http' });
    expect(await deliverQueuedLogs()).toBe(1);
    const result = await eventually(
      () => searchLogs({ start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 60_000), query: text, limit: 10 }),
      (value) => value.rows.length === 1,
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      message: `${text} \uFFFD\uFFFD`,
      source: 'external\uFFFD\uFFFD',
      sourceName: 'collector\uFFFD\uFFFD',
    });
  }, 40_000);

  it('accepts unsupported characters in both Fleet reset tails and new history', async () => {
    const text = marker();
    const serviceId = `cyrus-${text.slice(-12)}`;
    const service = await query<{ id: number }>(
      `INSERT INTO fleet_services (service_id, service_type, name) VALUES ($1, 'cyrus', $1) RETURNING id`,
      [serviceId],
    );
    const source = 'file\u0000\uD800';
    const line = `${text} \u0000\uD800-\uDC00`;
    const expectedLine = `${text} \uFFFD\uFFFD-\uFFFD`;
    const batch = {
      fleetServiceId: service.rows[0].id,
      serviceType: 'cyrus',
      serviceId,
      source,
      lines: [line],
      times: [new Date().toISOString()],
      batchId: randomUUID().replaceAll('-', ''),
      reset: true,
    };
    try {
      expect(await acceptFleetLogBatch(batch)).toMatchObject({ stored: 1 });
      expect(await getAgentServiceLogs(serviceId)).toMatchObject({ source: 'file\uFFFD\uFFFD', lines: [expectedLine] });
      expect(await acceptFleetLogBatch({ ...batch, batchId: randomUUID().replaceAll('-', ''), reset: false }))
        .toMatchObject({ stored: 1, duplicate: false });
      expect(await getAgentServiceLogs(serviceId)).toMatchObject({ lines: [expectedLine, expectedLine] });
      expect(await deliverQueuedLogs()).toBe(1);
      const result = await eventually(
        () => searchLogs({ start: new Date(Date.now() - 3_600_000), end: new Date(Date.now() + 60_000), serviceIds: [serviceId], query: text, limit: 10 }),
        (value) => value.rows.length === 1,
      );
      expect(result.rows).toHaveLength(1);
      expect(result.rows[0]).toMatchObject({ message: expectedLine, source: 'file\uFFFD\uFFFD' });
    } finally {
      await query('DELETE FROM fleet_services WHERE service_id = $1', [serviceId]);
    }
  }, 40_000);

  it('sends only the missing lines of a batch whose earlier write outcome was unknown', async () => {
    const text = marker();
    await enqueueLogsBatch({ origin: 'http', rows: rows(text, 3), maxBytes: spoolMaxBytes });
    const [batch] = await claimLogsBatches(2_000, 1);
    expect(batch.uncertain).toBe(false);
    // Two lines reached the store before the first attempt lost its lease.
    await writeStoreRows(batch.rows.slice(0, 2).map((row, index) => ({ ...row, ingest_batch: batch.batchId, ingest_seq: String(index) })));
    expect(await eventually(() => stored(text), (count) => count === 2)).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const [reclaimed] = await claimLogsBatches(2_000, 1);
    expect(reclaimed).toMatchObject({ id: batch.id, uncertain: true });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await deliverQueuedLogs()).toBe(1);

    expect(await eventually(() => stored(text), (count) => count === 3)).toBe(3);
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    expect(await stored(text)).toBe(3);
    expect(await spoolRows()).toEqual([expect.objectContaining({ status: 'sent', uncertain: true })]);
    expect(await logsWriteStatus()).toMatchObject({ uncertainBatches: 0, uncertainDeliveries24h: 1 });
  }, 40_000);

  it('preserves uncertainty when retrying a quarantined partial write', async () => {
    const text = marker();
    await enqueueLogsBatch({ origin: 'http', rows: rows(text, 3), maxBytes: spoolMaxBytes });
    const [batch] = await claimLogsBatches(2_000, 1);
    await writeStoreRows(batch.rows.slice(0, 2).map((row, index) => ({ ...row, ingest_batch: batch.batchId, ingest_seq: String(index) })));
    expect(await eventually(() => stored(text), (count) => count === 2)).toBe(2);
    await new Promise((resolve) => setTimeout(resolve, 20));

    let rejectWrites = true;
    setLogsStoreFetchForTests(async (input, init) => {
      if (rejectWrites && typeof input === 'string' && input.includes('/insert/jsonline')) {
        return new Response('invalid test batch', { status: 400 });
      }
      return fetch(input, init);
    });
    try {
      expect(await deliverQueuedLogs()).toBe(1);
      expect(await spoolRows()).toEqual([expect.objectContaining({ status: 'rejected', uncertain: true })]);
      rejectWrites = false;
      expect(await retryRejectedLogsBatch(batch.id)).toBe(true);
      expect(await spoolRows()).toEqual([expect.objectContaining({ status: 'pending', uncertain: true })]);
      expect(await deliverQueuedLogs()).toBe(1);
      expect(await eventually(() => stored(text), (count) => count === 3)).toBe(3);
      expect(await spoolRows()).toEqual([expect.objectContaining({ status: 'sent', uncertain: true })]);
    } finally {
      setLogsStoreFetchForTests(null);
    }
  }, 40_000);

  it('finds every stored position even when a batch already has duplicates', async () => {
    const text = marker();
    await enqueueLogsBatch({ origin: 'http', rows: rows(text, 3), maxBytes: spoolMaxBytes });
    const [batch] = await claimLogsBatches(2_000, 1);
    const tagged = batch.rows.map((row, index) => ({ ...row, ingest_batch: batch.batchId, ingest_seq: String(index) }));
    await writeStoreRows([...Array.from({ length: 10 }, () => tagged[0]), tagged[1]]);
    expect(await eventually(() => stored(text), (count) => count === 11)).toBe(11);
    expect(await storedBatchSequences(batch.batchId, batch.rows)).toEqual(new Set([0, 1]));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await deliverQueuedLogs()).toBe(1);
    expect(await eventually(() => stored(text), (count) => count === 12)).toBe(12);
    expect(await spoolRows()).toEqual([expect.objectContaining({ status: 'sent', uncertain: true })]);
  }, 40_000);

  it('reports the duplicate risk when an earlier timed-out write finishes after a retry', async () => {
    const text = marker();
    await enqueueLogsBatch({ origin: 'http', rows: rows(text, 1), maxBytes: spoolMaxBytes });
    let releaseFirstWrite = () => {};
    const gate = new Promise<void>((resolve) => { releaseFirstWrite = resolve; });
    const delayedWrites: Array<Promise<Response>> = [];
    let intercepted = false;
    setLogsStoreFetchForTests(async (input, init) => {
      if (!intercepted && typeof input === 'string' && input.includes('/insert/jsonline')) {
        intercepted = true;
        // The first request remains in flight while its caller sees a timeout.
        delayedWrites.push(gate.then(() => fetch(input, { ...init, signal: undefined })));
        throw new DOMException('Injected timeout', 'TimeoutError');
      }
      return fetch(input, init);
    });
    try {
      await deliverQueuedLogs();
      expect(await logsWriteStatus()).toMatchObject({ uncertainBatches: 1 });
      await query('UPDATE logs_ingest_spool SET next_attempt_at = CURRENT_TIMESTAMP');
      await deliverQueuedLogs();
      expect(await eventually(() => stored(text), (count) => count === 1)).toBe(1);
      expect(await logsWriteStatus()).toMatchObject({ uncertainBatches: 0, uncertainDeliveries24h: 1 });
      expect(delayedWrites).toHaveLength(1);
      releaseFirstWrite();
      expect((await delayedWrites[0]).ok).toBe(true);
      expect(await eventually(() => stored(text), (count) => count === 2)).toBe(2);
    } finally {
      releaseFirstWrite();
      await Promise.allSettled(delayedWrites);
      setLogsStoreFetchForTests(null);
    }
  }, 40_000);

  it('surfaces rows dropped by VictoriaLogs despite a successful write response', async () => {
    const before = (await getLogsStoreStatus()).metrics.rowsDroppedTotal;
    expect(before).not.toBeNull();
    await ingestExternalLogs([{
      time: '2000-01-01T00:00:00Z',
      message: marker(),
      source: 'integration',
    }], { origin: 'http' });
    expect(await deliverQueuedLogs()).toBe(1);
    const status = await eventually(
      () => getLogsStoreStatus(),
      (value) => value.metrics.rowsDroppedTotal !== null && value.metrics.rowsDroppedTotal > (before ?? 0),
    );
    expect(status.metrics.rowsDroppedTotal).toBeGreaterThan(before ?? 0);
    expect(status.write.queuedLines).toBe(0);
  }, 40_000);

  it('retains a store-rejected batch for inspection and retry, then delivers it', async () => {
    const text = marker();
    await ingestExternalLogs([{
      time: new Date().toISOString(),
      message: text,
      source: 'integration',
    }], { origin: 'http' });
    let allowWrites = false;
    setLogsStoreFetchForTests(async (input, init) => {
      if (!allowWrites && typeof input === 'string' && input.includes('/insert/jsonline')) {
        return new Response('invalid test batch', { status: 400 });
      }
      return fetch(input, init);
    });
    try {
      expect(await deliverQueuedLogs()).toBe(1);
      const batches = await listRejectedLogsBatches();
      expect(batches).toHaveLength(1);
      const [batch] = batches;
      expect(batch).toMatchObject({ origin: 'http', lineCount: 1, error: expect.stringContaining('400') });
      expect(await getRejectedLogsBatch(batch.id)).toMatchObject([{ _msg: text }]);
      expect(await logsWriteStatus()).toMatchObject({
        queuedLines: 0,
        quarantinedBatches: 1,
        quarantinedLines: 1,
        rejectedLines24h: 1,
        usedBytes: batch.bytes,
      });

      allowWrites = true;
      expect(await retryRejectedLogsBatch(batch.id)).toBe(true);
      expect(await logsWriteStatus()).toMatchObject({ queuedLines: 1, quarantinedBatches: 0, usedBytes: batch.bytes });
      expect(await deliverQueuedLogs()).toBe(1);
      expect(await eventually(() => stored(text), (count) => count === 1)).toBe(1);
      expect(await getRejectedLogsBatch(batch.id)).toBeNull();
    } finally {
      setLogsStoreFetchForTests(null);
    }
  }, 40_000);

  it('keeps discarded receipts through retention, reports discarded lines, then expires the receipt', async () => {
    const text = marker();
    const idempotencyKey = `discard:${text}`;
    await enqueueLogsBatch({ origin: 'http', idempotencyKey, rows: rows(text, 1), maxBytes: spoolMaxBytes });
    const [batch] = await claimLogsBatches(2_000, 1);
    await query("UPDATE logs_ingest_spool SET status = 'rejected', completed_at = CURRENT_TIMESTAMP - INTERVAL '25 hours' WHERE id = $1", [batch.id]);

    expect(await purgeLogsSpool(24 * 60 * 60 * 1_000)).toBe(0);
    expect(await listRejectedLogsBatches()).toHaveLength(1);
    expect(await discardRejectedLogsBatch(batch.id)).toBe(true);
    expect(await logsWriteStatus()).toMatchObject({ quarantinedBatches: 0, usedBytes: 0, discardedLines24h: 1 });
    expect(await enqueueLogsBatch({ origin: 'http', idempotencyKey, rows: rows(text, 1), maxBytes: spoolMaxBytes })).toBe('duplicate');
    await query("UPDATE logs_ingest_spool SET completed_at = CURRENT_TIMESTAMP - INTERVAL '25 hours' WHERE id = $1", [batch.id]);
    await purgeLogsSpool(24 * 60 * 60 * 1_000);
    expect(await query('SELECT id FROM logs_ingest_spool WHERE origin = $1 AND idempotency_key = $2', ['http', idempotencyKey]))
      .toMatchObject({ rowCount: 0 });
    expect(await enqueueLogsBatch({ origin: 'http', idempotencyKey, rows: rows(text, 1), maxBytes: spoolMaxBytes })).toBe('queued');
  });

  it('returns too_large when one batch is bigger than the configured capacity', async () => {
    expect(await enqueueLogsBatch({ origin: 'http', rows: rows(marker(), 1), maxBytes: 1 })).toBe('too_large');
  });

  it('stores and counts a retried Fleet batch once, at the time the agent read', async () => {
    const text = marker();
    const serviceId = `postfix-${text.slice(-12)}`;
    const service = await query<{ id: number }>(
      `INSERT INTO fleet_services (service_id, service_type, name) VALUES ($1, 'postfix', $1) RETURNING id`,
      [serviceId],
    );
    const fleetServiceId = service.rows[0].id;
    const readAt = new Date(Date.now() - 10 * 60 * 1000);
    const batch = {
      fleetServiceId,
      serviceType: 'postfix',
      serviceId,
      source: 'journald:postfix',
      lines: [`postfix/smtp[123]: 4F1A2B3C4D: to=<a@example.org>, relay=mx.example.org[1.2.3.4]:25, delay=1, status=sent (250 2.0.0 OK ${text})`],
      times: [readAt.toISOString()],
      batchId: randomUUID().replaceAll('-', ''),
      reset: false,
    };
    try {
      const results = await Promise.all([acceptFleetLogBatch(batch), acceptFleetLogBatch(batch)]);
      expect(results.map((result) => result.duplicate).sort()).toEqual([false, true]);
      const counters = await query<{ messages_delivered: string }>('SELECT messages_delivered FROM postfix_message_counters WHERE fleet_service_id = $1', [fleetServiceId]);
      expect(Number(counters.rows[0]?.messages_delivered)).toBe(1);

      await deliverQueuedLogs();
      expect(await eventually(() => stored(text), (count) => count === 1)).toBe(1);
      const params = new URLSearchParams({ query: `${text} | fields _time`, start: new Date(readAt.getTime() - 60_000).toISOString(), end: new Date().toISOString() });
      const body = await (await fetch(`${storeUrl}/select/logsql/query?${params}`)).text();
      expect(Date.parse(JSON.parse(body.trim())._time)).toBe(readAt.getTime());

      await query("UPDATE logs_ingest_spool SET completed_at = CURRENT_TIMESTAMP - INTERVAL '25 hours' WHERE origin = 'fleet'");
      await purgeLogsSpool(24 * 60 * 60 * 1_000);
      expect(await spoolRows()).toEqual([]);
      expect(await acceptFleetLogBatch(batch)).toMatchObject({ duplicate: true });
      expect(await deliverQueuedLogs()).toBe(0);
      const afterRetry = await query<{ messages_delivered: string }>('SELECT messages_delivered FROM postfix_message_counters WHERE fleet_service_id = $1', [fleetServiceId]);
      expect(Number(afterRetry.rows[0]?.messages_delivered)).toBe(1);
    } finally {
      await query('DELETE FROM fleet_services WHERE id = $1', [fleetServiceId]);
    }
  }, 40_000);

  it('asks Fleet to retry a full-queue batch and accepts it exactly once when capacity returns', async () => {
    const text = marker();
    const serviceId = `postfix-${text.slice(-12)}`;
    const service = await query<{ id: number }>(
      `INSERT INTO fleet_services (service_id, service_type, name) VALUES ($1, 'postfix', $1) RETURNING id`,
      [serviceId],
    );
    const fleetServiceId = service.rows[0].id;
    const capacity = 8 * 1024;
    const blocker = rows(marker(), 1);
    const emptyMessageBytes = Buffer.byteLength(JSON.stringify([{ ...blocker[0], _msg: '' }]));
    blocker[0]._msg = 'x'.repeat(capacity - emptyMessageBytes);
    expect(Buffer.byteLength(JSON.stringify(blocker))).toBe(capacity);
    config.logs.spoolMaxBytes = capacity;
    const batch = {
      fleetServiceId,
      serviceType: 'postfix',
      serviceId,
      source: 'journald:postfix',
      lines: [`postfix/smtp[123]: 4F1A2B3C4D: to=<a@example.org>, relay=mx.example.org[1.2.3.4]:25, delay=1, status=sent (250 2.0.0 OK ${text})`],
      times: [new Date().toISOString()],
      batchId: randomUUID().replaceAll('-', ''),
      reset: false,
    };
    try {
      expect(await enqueueLogsBatch({ origin: 'http', rows: blocker, maxBytes: capacity })).toBe('queued');
      await expect(acceptFleetLogBatch(batch)).rejects.toBeInstanceOf(FleetLogsQueueFullError);
      const counters = await query<{ messages_delivered: string }>('SELECT messages_delivered FROM postfix_message_counters WHERE fleet_service_id = $1', [fleetServiceId]);
      expect(Number(counters.rows[0]?.messages_delivered ?? 0)).toBe(0);
      expect((await query('SELECT batch_id FROM fleet_log_receipts WHERE fleet_service_id = $1', [fleetServiceId])).rows).toHaveLength(0);
      expect(await logsWriteStatus()).toMatchObject({ queuedLines: 1, droppedLines24h: 0 });

      await expect(ingestExternalLogs([{ time: new Date().toISOString(), message: text, source: 'integration' }], { origin: 'http' }))
        .rejects.toBeInstanceOf(LogsStoreUnavailableError);

      await query("DELETE FROM logs_ingest_spool WHERE origin = 'http'");
      expect(await acceptFleetLogBatch(batch)).toMatchObject({ duplicate: false });
      expect(await logsWriteStatus()).toMatchObject({ queuedLines: 1, droppedLines24h: 0 });
      const afterRetry = await query<{ messages_delivered: string }>('SELECT messages_delivered FROM postfix_message_counters WHERE fleet_service_id = $1', [fleetServiceId]);
      expect(Number(afterRetry.rows[0]?.messages_delivered)).toBe(1);
      await deliverQueuedLogs();
      expect(await eventually(() => stored(text), (count) => count === 1)).toBe(1);
      expect(await acceptFleetLogBatch(batch)).toMatchObject({ duplicate: true });
      const afterDuplicate = await query<{ messages_delivered: string }>('SELECT messages_delivered FROM postfix_message_counters WHERE fleet_service_id = $1', [fleetServiceId]);
      expect(Number(afterDuplicate.rows[0]?.messages_delivered)).toBe(1);
    } finally {
      await query('DELETE FROM fleet_services WHERE id = $1', [fleetServiceId]);
    }
  });

  it('enforces the capacity across concurrent transactions', async () => {
    const batch = rows(marker(), 1);
    const maxBytes = Buffer.byteLength(JSON.stringify(batch));
    const first = await getClient();
    const second = await getClient();
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
      expect(await enqueueLogsBatch({ origin: 'http', rows: batch, maxBytes }, first)).toBe('queued');
      const { pid } = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0];
      const competing = enqueueLogsBatch({ origin: 'http', rows: batch, maxBytes }, second);
      await waitForAdmissionLock(pid);
      await first.query('COMMIT');
      expect(await competing).toBe('full');
      await second.query('COMMIT');

      expect(await logsWriteStatus()).toMatchObject({ queuedLines: 1, queuedBytes: maxBytes });
    } finally {
      await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]);
      first.release();
      second.release();
    }
  });

  it('recognises a concurrent retry even when the first batch fills the queue', async () => {
    const batch = rows(marker(), 1);
    const maxBytes = Buffer.byteLength(JSON.stringify(batch));
    const input = { origin: 'http' as const, idempotencyKey: marker(), rows: batch, maxBytes };
    const first = await getClient();
    const second = await getClient();
    try {
      await Promise.all([first.query('BEGIN'), second.query('BEGIN')]);
      expect(await enqueueLogsBatch(input, first)).toBe('queued');
      const { pid } = (await second.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0];
      const retry = enqueueLogsBatch(input, second);
      await waitForAdmissionLock(pid);
      await first.query('COMMIT');
      expect(await retry).toBe('duplicate');
      await second.query('COMMIT');
      expect(await logsWriteStatus()).toMatchObject({ queuedLines: 1, queuedBytes: maxBytes });
    } finally {
      await Promise.all([first.query('ROLLBACK'), second.query('ROLLBACK')]);
      first.release();
      second.release();
    }
  });
});
