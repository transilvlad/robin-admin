import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClamavMetricsPage } from './ClamavMetrics';

const { getMetricsStats, getMetricsHistory, getMetricsRaw } = vi.hoisted(() => ({
  getMetricsStats: vi.fn(),
  getMetricsHistory: vi.fn(),
  getMetricsRaw: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  clamavApi: { getMetricsStats, getMetricsHistory, getMetricsRaw },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedClamavService: { serviceId: 'cl1', name: 'CL', serviceType: 'clamav' },
    selectedPostfixService: null,
    selectedDovecotService: null,
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
  serviceType: 'clamav' as const,
  serviceId: 'cl1',
  live: {
    pingOk: true,
    engineVersion: '1.4.3',
    databaseVersion: 123456,
    databaseUpdatedAt: '2025-01-01T00:00:00Z',
    statusText: 'ready',
    pools: 2,
    queueItems: 5151,
    threadsLive: 4,
    threadsIdle: 2,
    threadsMax: 6,
    memoryUsedMB: 42,
    memoryHeapMB: 16,
    memoryMmapMB: 10,
    memoryFreeMB: 12,
    memoryReleasableMB: 3,
    memoryPoolsUsedMB: 20,
    memoryPoolsTotalMB: 24,
  },
  totals24h: {
    queueDelta: 1,
    peakQueue: 9,
    peakMemoryMB: 48,
    unhealthySamples: 0,
  },
  historyCount: 10,
};

describe('ClamavMetricsPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getMetricsStats.mockResolvedValue({ data: STATS });
    getMetricsHistory.mockResolvedValue({ data: [] });
    getMetricsRaw.mockResolvedValue('# stats');
  });

  it('renders the metrics workspace with live daemon state', async () => {
    render(<MemoryRouter><ClamavMetricsPage /></MemoryRouter>);

    expect(await screen.findByText('ClamAV Metrics')).toBeInTheDocument();
    expect((await screen.findAllByText('5151')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Raw/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Logs/ })).not.toBeInTheDocument();
  });
});
