import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../connection.js';
import { cancelUnavailableAlertDeliveries, expireStaleAlertDeliveries } from './alerts.js';

vi.mock('../connection.js', () => ({
  getClient: vi.fn(),
  query: vi.fn(),
}));

describe('alert delivery queries', () => {
  beforeEach(() => vi.clearAllMocks());

  it('cancels pending deliveries for deleted, disabled, or paused webhooks', async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: 3, rows: [] } as never);
    await cancelUnavailableAlertDeliveries();
    const statement = vi.mocked(query).mock.calls[0][0];
    expect(statement).toContain("status = 'cancelled'");
    expect(statement).toContain('w.id IS NULL');
    expect(statement).toContain('w.enabled = false');
    expect(statement).toContain('w.paused_at IS NOT NULL');
  });

  it('expires old pending notifications instead of delivering an obsolete backlog', async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: 2, rows: [] } as never);
    await expect(expireStaleAlertDeliveries(3600000)).resolves.toBe(2);
    expect(vi.mocked(query).mock.calls[0][0]).toContain("status = 'expired'");
    expect(vi.mocked(query).mock.calls[0][0]).toContain("status = 'pending'");
    expect(vi.mocked(query).mock.calls[0][0]).toContain('attempts = 0');
    expect(vi.mocked(query).mock.calls[0][1]).toEqual([3600000]);
  });
});
