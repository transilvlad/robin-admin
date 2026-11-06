import { beforeEach, describe, expect, it, vi } from 'vitest';
import { deliverQueuedLogs } from './logs-delivery.js';
import {
  claimLogsBatches,
  markLogsBatchesSent,
  rejectLogsBatch,
  releaseLogsBatches,
  type LogsSpoolBatch,
} from '../db/queries/logs-spool.js';
import { LogsStoreWriteError, storedBatchSequences, writeStoreRows } from './logs-store.js';

vi.mock('../config.js', () => ({ config: { logs: { storeUrl: 'http://logs-backend:9428' } } }));
vi.mock('../db/queries/logs-spool.js', () => ({
  claimLogsBatches: vi.fn(),
  markLogsBatchesSent: vi.fn(),
  purgeLogsSpool: vi.fn(),
  rejectLogsBatch: vi.fn(),
  releaseLogsBatches: vi.fn(),
}));
vi.mock('./logs-store.js', () => ({
  LogsStoreWriteError: class extends Error {
    constructor(message: string, readonly uncertain: boolean, readonly rejected = false) { super(message); }
  },
  MAX_BATCH_LINES: 2_000,
  storedBatchSequences: vi.fn(),
  writeStoreRows: vi.fn(),
}));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const mockClaim = vi.mocked(claimLogsBatches);
const mockWrite = vi.mocked(writeStoreRows);
const mockStored = vi.mocked(storedBatchSequences);

function batch(id: string, messages: string[], extra: Partial<LogsSpoolBatch> = {}): LogsSpoolBatch {
  return { id, batchId: `uuid-${id}`, rows: messages.map((message) => ({ _time: '1', _msg: message })), attempts: 0, uncertain: false, ...extra };
}

function written(call = 0): string[] {
  return mockWrite.mock.calls[call][0].map((row) => `${row._msg}@${row.ingest_batch}#${row.ingest_seq}`);
}

beforeEach(() => {
  vi.clearAllMocks();
  mockWrite.mockResolvedValue();
});

describe('deliverQueuedLogs', () => {
  it('does nothing when the queue is empty', async () => {
    mockClaim.mockResolvedValue([]);
    await expect(deliverQueuedLogs()).resolves.toBe(0);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it('writes claimed batches together, tagged with their batch and position', async () => {
    mockClaim.mockResolvedValue([batch('1', ['a', 'b']), batch('2', ['c'])]);
    await expect(deliverQueuedLogs()).resolves.toBe(2);
    expect(written()).toEqual(['a@uuid-1#0', 'b@uuid-1#1', 'c@uuid-2#0']);
    expect(markLogsBatchesSent).toHaveBeenCalledWith(['1', '2']);
  });

  it('sends only the missing lines of a batch whose earlier write is unknown', async () => {
    mockClaim.mockResolvedValue([batch('1', ['a', 'b', 'c'], { uncertain: true }), batch('2', ['d'], { uncertain: true })]);
    mockStored.mockResolvedValueOnce(new Set([0, 2])).mockResolvedValueOnce(new Set([0]));
    await deliverQueuedLogs();
    expect(written()).toEqual(['b@uuid-1#1']);
    expect(markLogsBatchesSent).toHaveBeenCalledWith(['2', '1']);
  });

  it('keeps batches queued and waits before checking an uncertain write', async () => {
    mockClaim.mockResolvedValue([batch('1', ['a'], { attempts: 2 })]);
    mockWrite.mockRejectedValue(new LogsStoreWriteError('timed out', true));
    await deliverQueuedLogs();
    expect(releaseLogsBatches).toHaveBeenCalledWith(['1'], { error: 'timed out', uncertain: true, delayMs: 15_000 });
    expect(markLogsBatchesSent).toHaveBeenCalledWith([]);
  });

  it('backs off without verification when the store was not reached', async () => {
    mockClaim.mockResolvedValue([batch('1', ['a'], { attempts: 3 })]);
    mockWrite.mockRejectedValue(new LogsStoreWriteError('refused', false));
    await deliverQueuedLogs();
    expect(releaseLogsBatches).toHaveBeenCalledWith(['1'], { error: 'refused', uncertain: false, delayMs: 8_000 });
  });

  it('retries a postponed verification later', async () => {
    mockClaim.mockResolvedValue([batch('1', ['a'], { uncertain: true })]);
    mockStored.mockRejectedValue(new LogsStoreWriteError('verification failed', true));
    await deliverQueuedLogs();
    expect(mockWrite).not.toHaveBeenCalled();
    expect(releaseLogsBatches).toHaveBeenCalledWith(['1'], expect.objectContaining({ uncertain: true }));
  });

  it('isolates a batch the store rejects so the others are delivered', async () => {
    mockClaim.mockResolvedValue([batch('1', ['good']), batch('2', ['bad']), batch('3', ['also good'])]);
    mockWrite.mockImplementation(async (rows) => {
      if (rows.some((row) => row._msg === 'bad')) throw new LogsStoreWriteError('HTTP 400', false, true);
    });
    await deliverQueuedLogs();
    expect(rejectLogsBatch).toHaveBeenCalledWith('2', 'HTTP 400');
    expect(markLogsBatchesSent).toHaveBeenCalledWith(['1', '3']);
  });
});
