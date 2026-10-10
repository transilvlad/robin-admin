import { describe, expect, it, vi } from 'vitest';
import { getClient } from '../../db/connection.js';
import { runAlertEvaluation } from './evaluator.js';

vi.mock('../../db/connection.js', () => ({ getClient: vi.fn() }));
vi.mock('../../db/queries/alerts.js', () => ({
  clearExpiredAlertPauses: vi.fn(),
  createAlertDelivery: vi.fn(),
}));

describe('alert evaluator concurrency', () => {
  it('skips a tick when another process owns the advisory lock', async () => {
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ locked: false }] })
      .mockResolvedValueOnce({ rows: [] });
    const release = vi.fn();
    vi.mocked(getClient).mockResolvedValue({ query, release } as never);

    await expect(runAlertEvaluation()).resolves.toBe(false);
    expect(query).toHaveBeenNthCalledWith(1, 'BEGIN');
    expect(query).toHaveBeenNthCalledWith(3, 'ROLLBACK');
    expect(release).toHaveBeenCalledOnce();
  });
});
