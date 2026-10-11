import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../db/connection.js';
import * as serviceMetrics from '../db/queries/service-metrics.js';
import * as postfixService from './postfix.js';
import { getLivePostfixMetrics, getRawServiceMetrics, ingestPostfixLogLines } from './metrics-poller.js';

vi.mock('../db/connection.js');
vi.mock('../db/queries/service-metrics.js');
vi.mock('./postfix.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('./postfix.js')>(),
  getPostfixLiveMetrics: vi.fn(),
}));

describe('metrics-poller (postfix)', () => {
  beforeEach(() => {
    vi.mocked(connection.query).mockResolvedValue({ rows: [] } as never);
  });

  it('adds the stored log-agent message counters to a direct exporter snapshot', async () => {
    vi.mocked(serviceMetrics.getMetricsFleetServiceById).mockResolvedValue({
      id: 31, serviceId: 'mx-direct', serviceType: 'postfix', collectionMode: 'direct',
    } as never);
    vi.mocked(postfixService.getPostfixLiveMetrics).mockResolvedValue({
      serviceId: 'mx-direct', serviceType: 'postfix', reachable: true, queueTotal: 3,
      messagesDelivered: 0, messagesDeferred: 0, messagesBounced: 0, messagesRejected: 0,
    } as never);
    vi.mocked(connection.query).mockResolvedValue({
      rows: [{ messages_delivered: '7', messages_deferred: '2', messages_bounced: '0', messages_rejected: '1' }],
    } as never);

    const result = await getLivePostfixMetrics('mx-direct');

    expect(result).toMatchObject({ queueTotal: 3, messagesDelivered: 7, messagesDeferred: 2, messagesRejected: 1 });
  });

  it('records nothing for a log push without message outcomes', async () => {
    await ingestPostfixLogLines(31, ['postfix/smtpd[2]: connect from client.example.test[192.0.2.1]']);
    expect(connection.query).not.toHaveBeenCalled();
  });

  it('serves an agent-collected service its raw output from the stored snapshot', async () => {
    vi.mocked(serviceMetrics.getMetricsFleetServiceById).mockResolvedValue({
      id: 32, serviceId: 'mx-agent', serviceType: 'postfix', collectionMode: 'agent',
    } as never);

    expect(await getRawServiceMetrics('postfix', 'mx-agent')).toBe('# The agent has not pushed a snapshot yet');
    expect(postfixService.getPostfixLiveMetrics).not.toHaveBeenCalledWith('mx-agent');
  });
});
