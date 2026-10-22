import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../db/connection.js';
import { getMetricsFleetServiceById } from '../db/queries/service-metrics.js';
import { setFleetServiceSoftwareVersion } from '../db/queries/fleet-services.js';
import { getCyrusMetricsHistory, getLiveCyrusMetrics, getRawServiceMetrics, ingestAgentMetrics } from './metrics-poller.js';
vi.mock('../db/connection.js', () => ({ query: vi.fn() }));
vi.mock('../db/queries/service-metrics.js', () => ({ getMetricsFleetServiceById: vi.fn(), getPrimaryMetricsFleetService: vi.fn() }));
vi.mock('../db/queries/fleet-services.js', () => ({ setFleetServiceSoftwareVersion: vi.fn() }));
const service = { id: 7, serviceId: 'imap', serviceType: 'cyrus', collectionMode: 'agent' } as const;
beforeEach(() => { vi.resetAllMocks(); vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 1 } as never); });
describe('Cyrus agent metrics history', () => {
  it('persists Prometheus counters, process counts and the reported daemon version', async () => {
    const snapshot = await ingestAgentMetrics(service, { prometheus: 'cyrus_imap_active_connections 2 1761140000000', proc: '101 imap proxy [127.0.0.1] happy user.happy Idle', version: 'cyrus-imapd 3.6.1-Debian-3.6.1-4+deb12u5\n' });
    expect(snapshot).toMatchObject({ activeConnections: 2, sessionCount: 1 });
    expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO cyrus_metrics_history'), expect.arrayContaining([7, 'imap', 2]));
    expect(setFleetServiceSoftwareVersion).toHaveBeenCalledWith(7, '3.6.1-Debian-3.6.1-4+deb12u5');
  });
  it('requires the primary collector but allows an empty process list', async () => {
    await expect(ingestAgentMetrics(service, { proc: '' })).rejects.toThrow('prometheus is required');
    expect(query).not.toHaveBeenCalled();
    expect(await ingestAgentMetrics(service, { prometheus: '# no metrics yet', proc: '' })).toMatchObject({ sessionCount: 0, reachable: true });
  });
  it('loads fresh agent snapshots and raw stats, with renamed service IDs', async () => {
    vi.mocked(getMetricsFleetServiceById).mockResolvedValue(service as never);
    vi.mocked(query).mockResolvedValue({ rows: [{ timestamp: new Date(), current_service_id: 'imap', service_id: 'old', reachable: true, active_connections: '3', user_count: '4', raw_stats: '# cyrus report' }] } as never);
    expect(await getLiveCyrusMetrics('imap')).toMatchObject({ serviceId: 'imap', serviceType: 'cyrus', activeConnections: 3, userCount: 4 });
    expect(await getRawServiceMetrics('cyrus', 'imap')).toBe('# cyrus report');
    vi.mocked(query).mockResolvedValue({ rows: [{ timestamp: new Date(0) }] } as never);
    expect(await getLiveCyrusMetrics('imap')).toBeNull();
  });
  it('never polls Cyrus directly and reads history for one service only', async () => {
    vi.mocked(getMetricsFleetServiceById).mockResolvedValue({ ...service, collectionMode: 'direct' } as never);
    expect(await getLiveCyrusMetrics('imap')).toBeNull();
    expect(query).not.toHaveBeenCalled();
    vi.mocked(query).mockResolvedValueOnce({ rows: [{ count: '1' }] } as never).mockResolvedValueOnce({ rows: [{ timestamp: new Date(), service_id: 'imap', user_count: '4' }] } as never);
    expect(await getCyrusMetricsHistory(24, 500, 'imap')).toMatchObject([{ serviceId: 'imap', userCount: 4 }]);
    expect(query).toHaveBeenLastCalledWith(expect.stringContaining('cyrus_metrics_history'), expect.arrayContaining([7]));
  });
});
