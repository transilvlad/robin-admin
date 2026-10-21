import { beforeEach, describe, expect, it, vi } from 'vitest';

const { client, databaseQuery } = vi.hoisted(() => ({
  client: { query: vi.fn(), release: vi.fn() },
  databaseQuery: vi.fn(),
}));
vi.mock('../connection.js', () => ({
  getClient: vi.fn(() => Promise.resolve(client)),
  query: databaseQuery,
}));

const { claimDueAlertDeliveries, completeAlertDelivery } = await import('./alerts.js');

beforeEach(() => {
  vi.clearAllMocks();
  databaseQuery.mockResolvedValue({ rows: [], rowCount: 1 });
  client.query.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('telemetry issue delivery fencing', () => {
  it('only retries an opening delivery while its issue revision is current and active', async () => {
    await completeAlertDelivery({
      id: 4,
      claimToken: 'claim-token',
      status: 'pending',
      error: 'temporary transport error',
      nextAttemptAt: new Date('2026-10-15T12:05:00Z'),
    });

    const [sql, values] = databaseQuery.mock.calls[0];
    expect(sql).toContain("THEN 'cancelled' ELSE $3::varchar END");
    expect(sql).toContain('i.status = \'active\' AND i.dismissed_at IS NULL');
    expect(sql).toContain("d.event_kind = 'dismissed'");
    expect(sql).toContain('d.telemetry_alert_issue_revision = i.revision');
    expect(values).toEqual([
      4,
      'claim-token',
      'pending',
      null,
      'temporary transport error',
      new Date('2026-10-15T12:05:00Z'),
      false,
    ]);
  });

  it('cancels a reclaimed in-flight opening delivery from an earlier revision', async () => {
    await claimDueAlertDeliveries(5);

    const staleProcessing = client.query.mock.calls.find(([sql]) => String(sql).includes("WHERE status = 'processing'"));
    const dueDeliveries = client.query.mock.calls.find(([sql]) => String(sql).includes('WITH due AS'));
    expect(staleProcessing?.[0]).toContain("THEN 'cancelled' ELSE 'pending' END");
    expect(staleProcessing?.[0]).toContain('alert_deliveries.telemetry_alert_issue_revision = i.revision');
    expect(staleProcessing?.[0]).toContain("i.status = 'resolved'");
    expect(dueDeliveries?.[0]).toContain("d.event_kind NOT IN ('failure', 'dismissed')");
    expect(client.release).toHaveBeenCalledOnce();
  });
});
