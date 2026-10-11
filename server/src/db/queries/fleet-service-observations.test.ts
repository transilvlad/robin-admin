import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../connection.js';
import { recordFleetServiceObservation } from './fleet-service-observations.js';

vi.mock('../connection.js', () => ({ query: vi.fn() }));

describe('fleet service observations', () => {
  beforeEach(() => vi.clearAllMocks());

  it('upserts the newest sanitized service observation', async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: 1, rows: [] } as never);
    const observedAt = new Date('2026-09-10T10:00:00Z');
    await recordFleetServiceObservation({
      fleetServiceId: 7,
      reachable: false,
      observedAt,
      errorCode: 'collection_failed',
    });
    expect(query).toHaveBeenCalledWith(
      expect.stringContaining('ON CONFLICT (fleet_service_id) DO UPDATE'),
      [7, `${observedAt.toISOString()}:down`, observedAt, false, 'collection_failed']
    );
  });

  it('bounds error codes before persistence', async () => {
    vi.mocked(query).mockResolvedValue({ rowCount: 1, rows: [] } as never);
    await recordFleetServiceObservation({
      fleetServiceId: 2,
      reachable: null,
      errorCode: 'x'.repeat(100),
    });
    expect(vi.mocked(query).mock.calls[0][1]?.[4]).toBe('x'.repeat(64));
  });
});
