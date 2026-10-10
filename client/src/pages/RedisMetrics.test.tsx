import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { RedisMetricsPage } from './RedisMetrics';
import { ConfirmProvider } from '../context/ConfirmContext';

function renderPage() {
  return render(<MemoryRouter><ConfirmProvider><RedisMetricsPage /></ConfirmProvider></MemoryRouter>);
}

const {
  getMetricsStats,
  getMetricsHistory,
  getMetricsRaw,
  getSlowlog,
  resetSlowlog,
  getClients,
  killClient,
  bgsave,
  bgrewriteaof,
  resetStats,
} = vi.hoisted(() => ({
  getMetricsStats: vi.fn(),
  getMetricsHistory: vi.fn(),
  getMetricsRaw: vi.fn(),
  getSlowlog: vi.fn(),
  resetSlowlog: vi.fn(),
  getClients: vi.fn(),
  killClient: vi.fn(),
  bgsave: vi.fn(),
  bgrewriteaof: vi.fn(),
  resetStats: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  redisApi: {
    getMetricsStats,
    getMetricsHistory,
    getMetricsRaw,
    getSlowlog,
    resetSlowlog,
    getClients,
    killClient,
    bgsave,
    bgrewriteaof,
    resetStats,
  },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedRedisService: { serviceId: 'redis1', name: 'Redis 1', serviceType: 'redis' },
  }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));

vi.mock('../components/charts', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  downsampleData: () => [],
  formatChartLabels: () => [],
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const STATS = {
  serviceType: 'redis' as const,
  serviceId: 'redis1',
  live: {
    reachable: true,
    role: 'master',
    connectedClients: 42,
    blockedClients: 0,
    memoryUsedBytes: 1048576,
    memoryPeakBytes: 2097152,
    hitRatio: 95,
    instantaneousOpsPerSec: 1200,
    evictedKeys: 3,
    expiredKeys: 10,
    dbKeys: 500,
    dbExpires: 20,
    connectedSlaves: 1,
  },
  totals24h: {
    opsProcessed: 999999,
    evictedKeys: 10,
    expiredKeys: 50,
    peakMemoryUsedBytes: 3145728,
    peakConnectedClients: 60,
    unreachableSamples: 0,
  },
  historyCount: 24,
};

describe('RedisMetricsPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getMetricsStats.mockResolvedValue({ data: STATS });
    getMetricsHistory.mockResolvedValue({ data: [] });
    getMetricsRaw.mockResolvedValue('# info');
    getSlowlog.mockResolvedValue({ data: [] });
    resetSlowlog.mockResolvedValue({ data: { response: 'OK' } });
    getClients.mockResolvedValue({ data: [] });
    killClient.mockResolvedValue({ data: { response: 'OK' } });
    bgsave.mockResolvedValue({ data: { response: 'Background saving started' } });
    bgrewriteaof.mockResolvedValue({ data: { response: 'Background append only file rewriting started' } });
    resetStats.mockResolvedValue({ data: { response: 'OK' } });
  });

  it('renders the metrics workspace with live client and memory activity', async () => {
    renderPage();

    expect(await screen.findByText('Redis metrics')).toBeInTheDocument();
    expect((await screen.findAllByText('42')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: /Slowlog/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Clients/ })).toBeInTheDocument();
  });

  it('triggers BGSAVE after confirmation', async () => {
    renderPage();

    await screen.findByText('Redis metrics');
    fireEvent.click(screen.getByRole('button', { name: 'BGSAVE' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(bgsave).toHaveBeenCalledWith('redis1'));
  });

  it('kills a client after confirmation', async () => {
    getClients.mockResolvedValue({
      data: [{ id: 5, addr: '127.0.0.1:1234', name: '', ageSecs: 10, idleSecs: 0, db: 0, cmd: 'get', user: 'default' }],
    });

    renderPage();

    await screen.findByText('Redis metrics');
    fireEvent.click(screen.getByRole('button', { name: /Clients/ }));

    await waitFor(() => expect(getClients).toHaveBeenCalledWith('redis1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Kill' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(killClient).toHaveBeenCalledWith('redis1', 5));
  });
});
