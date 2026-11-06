import { beforeEach, describe, expect, it, vi } from 'vitest';
import { acceptFleetLogBatch, FleetLogsBatchTooLargeError } from './fleet-logs.js';
import { getClient } from '../db/connection.js';
import { getConfig } from '../db/queries/config.js';
import { enqueueLogsBatch, registerFleetLogBatch } from '../db/queries/logs-spool.js';
import { ingestPostfixLogLines } from './metrics-poller.js';
import { ingestAgentLogs } from './service-logs.js';

vi.mock('../config.js', () => ({ config: { logs: { storeUrl: 'http://logs-backend:9428', retentionDays: 14, spoolMaxBytes: 1_000 } } }));
vi.mock('../db/connection.js', () => ({ getClient: vi.fn() }));
vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../db/queries/logs-spool.js', () => ({ enqueueLogsBatch: vi.fn(), registerFleetLogBatch: vi.fn() }));
vi.mock('./metrics-poller.js', () => ({ ingestPostfixLogLines: vi.fn() }));
vi.mock('./service-logs.js', () => ({ ingestAgentLogs: vi.fn() }));
vi.mock('../logger.js', () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn() } }));

const client = { query: vi.fn(), release: vi.fn() };
const mockEnqueue = vi.mocked(enqueueLogsBatch);
const mockPostfix = vi.mocked(ingestPostfixLogLines);
const mockBuffer = vi.mocked(ingestAgentLogs);
const batch = {
  fleetServiceId: 4,
  serviceType: 'postfix',
  serviceId: 'mx-1',
  agentId: 'agent-1',
  source: 'journalctl -u postfix@-',
  lines: ['postfix/smtp[1]: status=sent'],
  times: ['2020-01-01T00:00:00Z'],
  batchId: 'b-1',
  reset: false,
};

function statements(): string[] {
  return client.query.mock.calls.map(([sql]) => sql as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  client.query.mockResolvedValue({ rows: [], rowCount: 0 });
  vi.mocked(getClient).mockResolvedValue(client as never);
  vi.mocked(getConfig).mockResolvedValue({ logsEnabled: true } as never);
  mockEnqueue.mockResolvedValue('queued');
  vi.mocked(registerFleetLogBatch).mockResolvedValue(true);
  mockBuffer.mockResolvedValue(1);
});

describe('acceptFleetLogBatch', () => {
  it('queues history and counts Postfix lines in one transaction, then updates the buffer', async () => {
    await expect(acceptFleetLogBatch(batch)).resolves.toEqual({ stored: 1, duplicate: false });
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({
      origin: 'fleet', idempotencyKey: 'mx-1:b-1', maxBytes: 1_000,
      rows: [expect.objectContaining({ _msg: batch.lines[0], service_id: 'mx-1', agent_id: 'agent-1' })],
    }), client);
    expect(mockPostfix).toHaveBeenCalledWith(4, batch.lines, client);
    expect(registerFleetLogBatch).toHaveBeenCalledWith(client, 4, 'b-1');
    expect(statements()).toEqual(['BEGIN', 'COMMIT']);
    expect(mockBuffer).toHaveBeenCalledWith('mx-1', batch.source, batch.lines, false);
    expect(client.release).toHaveBeenCalled();
  });

  it('recognises the latest Fleet receipt without relying on spool retention', async () => {
    vi.mocked(registerFleetLogBatch).mockResolvedValue(false);
    await expect(acceptFleetLogBatch(batch)).resolves.toEqual({ stored: 0, duplicate: true });
    expect(mockEnqueue).not.toHaveBeenCalled();
    expect(mockPostfix).not.toHaveBeenCalled();
    expect(statements()).toEqual(['BEGIN', 'COMMIT']);
    expect(mockBuffer).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it('acknowledges a repeated batch without counting or buffering it again', async () => {
    mockEnqueue.mockResolvedValue('duplicate');
    await expect(acceptFleetLogBatch(batch)).resolves.toEqual({ stored: 0, duplicate: true });
    expect(mockPostfix).not.toHaveBeenCalled();
    expect(mockBuffer).not.toHaveBeenCalled();
    expect(statements()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('rolls back a full-queue batch so the agent can retry without losing counters or tail', async () => {
    mockEnqueue.mockResolvedValue('full');
    await expect(acceptFleetLogBatch(batch)).rejects.toThrow('Logs ingestion queue is full');
    expect(mockPostfix).not.toHaveBeenCalled();
    expect(mockBuffer).not.toHaveBeenCalled();
    expect(statements()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('rolls back an oversized batch so the agent can split and retry it', async () => {
    mockEnqueue.mockResolvedValue('too_large');
    await expect(acceptFleetLogBatch(batch)).rejects.toBeInstanceOf(FleetLogsBatchTooLargeError);
    expect(mockPostfix).not.toHaveBeenCalled();
    expect(mockBuffer).not.toHaveBeenCalled();
    expect(statements()).toEqual(['BEGIN', 'ROLLBACK']);
  });

  it('records only a receipt while Logs is disabled', async () => {
    vi.mocked(getConfig).mockResolvedValue({ logsEnabled: false } as never);
    await acceptFleetLogBatch(batch);
    expect(mockEnqueue).toHaveBeenCalledWith(expect.objectContaining({ idempotencyKey: 'mx-1:b-1', rows: [] }), client);
  });

  it('rolls back so the agent can retry the whole batch', async () => {
    mockPostfix.mockRejectedValueOnce(new Error('deadlock detected'));
    await expect(acceptFleetLogBatch(batch)).rejects.toThrow('deadlock detected');
    expect(statements()).toEqual(['BEGIN', 'ROLLBACK']);
    expect(mockBuffer).not.toHaveBeenCalled();
    expect(client.release).toHaveBeenCalled();
  });

  it('does not fail an accepted batch when the recent buffer cannot be updated', async () => {
    mockBuffer.mockRejectedValueOnce(new Error('buffer unavailable'));
    await expect(acceptFleetLogBatch(batch)).resolves.toEqual({ stored: 0, duplicate: false });
  });

  it('only refreshes the buffer for a reset batch', async () => {
    await acceptFleetLogBatch({ ...batch, reset: true });
    expect(getClient).not.toHaveBeenCalled();
    expect(mockPostfix).not.toHaveBeenCalled();
    expect(mockBuffer).toHaveBeenCalledWith('mx-1', batch.source, batch.lines, true);
  });
});
