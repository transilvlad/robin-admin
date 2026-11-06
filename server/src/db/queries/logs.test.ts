import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getClient, query } from '../connection.js';
import { createLogsAlertRule, createLogsSavedSearch, listAllLogsAlertRules, LogsCapacityError, updateLogsAlertRule } from './logs.js';
import type { LogsAlertRuleInput } from '../../types/logs.js';

vi.mock('../connection.js', () => ({ getClient: vi.fn(), query: vi.fn() }));

const input: LogsAlertRuleInput = {
  name: 'Errors', description: null, query: 'error', comparator: '>=',
  threshold: 1, windowSeconds: 300, forSeconds: 60, enabled: true,
};
const row = {
  id: 1, name: 'Errors', description: null, query: 'error', comparator: '>=',
  threshold: 1, window_seconds: 300, for_seconds: 60, enabled: true, status: 'ok',
  generation: 0, last_value: null, pending_since: null, firing_since: null,
  last_evaluated_at: null, last_error: null, created_at: new Date(), updated_at: new Date(),
};

beforeEach(() => vi.clearAllMocks());

describe('Logs persistence', () => {
  it('creates alert rules under a transaction-scoped capacity lock', async () => {
    const client = {
      query: vi.fn(async (sql: string) => ({ rows: sql.includes('count(*)') ? [{ count: '19' }] : [row] })),
      release: vi.fn(),
    };
    vi.mocked(getClient).mockResolvedValue(client as never);
    await expect(createLogsAlertRule(input)).resolves.toMatchObject({ name: 'Errors', status: 'ok' });
    expect(client.query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(client.query).toHaveBeenNthCalledWith(2, 'SELECT pg_advisory_xact_lock($1)', [846_255_036]);
    expect(client.query).toHaveBeenLastCalledWith('COMMIT');
    expect(client.release).toHaveBeenCalledOnce();
  });

  it.each(['saved searches', 'alert rules'])('enforces the %s capacity before insertion', async (kind) => {
    const client = {
      query: vi.fn(async () => ({ rows: [{ count: '100' }] })),
      release: vi.fn(),
    };
    vi.mocked(getClient).mockResolvedValue(client as never);
    const create = kind === 'alert rules' ? createLogsAlertRule(input) : createLogsSavedSearch({
      name: 'Errors', description: null, filters: { query: 'error', serviceId: '', sourceName: '', rangePreset: '1h' },
    }, null);
    await expect(create).rejects.toBeInstanceOf(LogsCapacityError);
    expect(client.query).toHaveBeenLastCalledWith('ROLLBACK');
    expect(client.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO'))).toBe(false);
    expect(client.release).toHaveBeenCalledOnce();
  });

  it('loads evaluation candidates without holding row locks during store queries', async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };
    await listAllLogsAlertRules(client as never);
    expect(client.query.mock.calls[0][0]).not.toContain('FOR UPDATE');
  });

  it('resets the pending hold only when the condition changes', async () => {
    vi.mocked(query).mockResolvedValue({ rows: [row] } as never);
    await updateLogsAlertRule(1, input);
    expect(query).toHaveBeenCalledWith(expect.stringContaining('IS DISTINCT FROM'), [
      1, input.name, null, input.query, 300, '>=', 1, 60, true,
    ]);
  });
});
