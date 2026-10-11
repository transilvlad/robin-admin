import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PostfixMetricsPage } from './PostfixMetrics';
import { denyCapabilities } from '../test/capabilities';

const { getMetricsStats, getMetricsHistory, getMetricsRaw, flushQueue, getQueue } = vi.hoisted(() => ({
  getMetricsStats: vi.fn(),
  getMetricsHistory: vi.fn(),
  getMetricsRaw: vi.fn(),
  flushQueue: vi.fn(),
  getQueue: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  postfixApi: { getMetricsStats, getMetricsHistory, getMetricsRaw, flushQueue, getQueue },
}));

vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => async () => true }));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedPostfixService: { serviceId: 'pf1', name: 'PF', serviceType: 'postfix' },
    selectedDovecotService: null,
    selectedClamavService: null,
  }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));

vi.mock('../components/fleet/ServiceLogsPanel', () => ({
  ServiceLogsPanel: () => <div data-testid="logs-panel" />,
}));

vi.mock('../components/charts', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  downsampleData: () => [],
  formatChartLabels: () => [],
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const STATS = {
  serviceType: 'postfix' as const,
  serviceId: 'pf1',
  live: {
    reachable: true,
    queueActive: 3,
    queueDeferred: 7,
    queueHold: 1,
    queueIncoming: 2,
    queueTotal: 4242,
    oldestDeferredAgeSecs: 90,
  },
  totals24h: {
    peakQueue: 50,
    peakDeferred: 20,
    maxDeferredAgeSecs: 300,
    unreachableSamples: 0,
    delivered: 1234,
    deferred: 5,
    bounced: 2,
    rejected: 99,
  },
  historyCount: 10,
};

describe('PostfixMetricsPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getMetricsStats.mockResolvedValue({ data: STATS });
    getMetricsHistory.mockResolvedValue({ data: [] });
    getMetricsRaw.mockResolvedValue('# stats');
    flushQueue.mockResolvedValue({ data: null });
    getQueue.mockResolvedValue({ data: [] });
  });

  it('shows queue depth only when the deployment has no agent-backed features', async () => {
    denyCapabilities('messageCounters', 'deferredAge');
    render(<MemoryRouter><PostfixMetricsPage /></MemoryRouter>);

    expect(await screen.findByText('Postfix metrics')).toBeInTheDocument();
    expect((await screen.findAllByText('4242')).length).toBeGreaterThan(0);
    expect(screen.queryByText('Oldest deferred')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Raw/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Queue$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Flush queue/ })).not.toBeInTheDocument();
    expect(screen.queryByText('Message flow')).not.toBeInTheDocument();
  });

  it('shows message flow when the agent streams the Postfix log', async () => {
    render(<MemoryRouter><PostfixMetricsPage /></MemoryRouter>);

    expect(await screen.findByText('Message flow')).toBeInTheDocument();
    expect(screen.getByText('1234')).toBeInTheDocument();
    // Queue control lives on its own Postfix → Queue page, like Robin's.
    expect(screen.queryByRole('button', { name: /Queue$/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Flush queue/ })).not.toBeInTheDocument();
  });
});
