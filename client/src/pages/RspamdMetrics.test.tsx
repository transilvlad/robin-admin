import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RspamdMetricsPage } from './RspamdMetrics';

const {
  getStats,
  getHistory,
  getRaw,
  useServicesMock,
} = vi.hoisted(() => ({
  getStats: vi.fn(),
  getHistory: vi.fn(),
  getRaw: vi.fn(),
  useServicesMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  metricsApi: {
    getStats,
    getHistory,
    getRaw,
  },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => useServicesMock(),
}));

vi.mock('../components/charts', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  downsampleData: <T,>(data: T[]) => data,
  formatChartLabels: (labels: string[]) => labels,
}));

function buildServicesState(selectedRspamdService: Record<string, unknown> | null) {
  const rspamdServices = selectedRspamdService ? [selectedRspamdService] : [];
  return {
    isLoading: false,
    services: rspamdServices,
    robinServices: [],
    rspamdServices,
    selectedRobinService: null,
    selectedRspamdService,
    setSelectedService: vi.fn(),
    setSelectedRobinService: vi.fn(),
    setSelectedRspamdService: vi.fn(),
    refreshServices: vi.fn(),
  };
}

describe('RspamdMetricsPage', () => {
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    vi.clearAllMocks();
  });

  it('shows the empty-state gate when no enabled Rspamd service is selected', () => {
    useServicesMock.mockReturnValue(buildServicesState(null));

    render(<RspamdMetricsPage />);

    expect(screen.getByText('No enabled Rspamd service is currently selected.')).toBeInTheDocument();
    expect(getStats).not.toHaveBeenCalled();
    expect(getHistory).not.toHaveBeenCalled();
    expect(getRaw).not.toHaveBeenCalled();
  });

  it('loads overview and raw metrics using the selected Rspamd service scope', async () => {
    useServicesMock.mockReturnValue(buildServicesState({
      id: 2,
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
      name: 'Rspamd Core',
      description: null,
      apiUrl: 'https://rspamd.example.test',
      healthUrl: null,
      metricsUrl: null,
      enabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    }));
    getStats.mockResolvedValueOnce({
      data: {
        serviceType: 'rspamd',
        serviceId: 'rspamd-core',
        live: {
          controllerReachable: true,
          controllerAuthenticated: true,
          normalWorkerPingOk: true,
          scannedMessages: 100,
          spamMessages: 12,
          hamMessages: 88,
          learnedSpam: 4,
          learnedHam: 8,
          connections: 9,
          uptimeSeconds: 3600,
          memoryAllocatedMB: 10,
          memoryResidentMB: 5,
          totalActions: 7,
        },
        totals24h: {
          scanned: 40,
          spam: 5,
          ham: 35,
          learnedSpam: 1,
          learnedHam: 2,
          actions: {
            addHeader: 2,
            reject: 1,
            softReject: 1,
            greylist: 1,
            noAction: 1,
            rewriteSubject: 1,
            discard: 0,
            quarantine: 0,
          },
          totalActions: 6,
        },
        historyCount: 1,
      },
    });
    getHistory.mockResolvedValueOnce({
      data: [{
        timestamp: '2024-01-01T00:00:00.000Z',
        scannedMessages: 100,
        spamMessages: 12,
        hamMessages: 88,
      }],
    });
    getRaw.mockResolvedValueOnce('rspamd_stats_scanned 100');

    render(<RspamdMetricsPage />);

    await waitFor(() => {
      expect(getStats).toHaveBeenCalledWith({
        serviceType: 'rspamd',
        serviceId: 'rspamd-core',
      });
      expect(getHistory).toHaveBeenCalledWith(24, {
        serviceType: 'rspamd',
        serviceId: 'rspamd-core',
      });
    });
    expect(screen.getAllByText('Rspamd Core')).toHaveLength(2);

    fireEvent.click(screen.getByRole('button', { name: /Raw/ }));

    await waitFor(() => {
      expect(getRaw).toHaveBeenCalledWith({
        serviceType: 'rspamd',
        serviceId: 'rspamd-core',
      });
    });
    expect(await screen.findByText('rspamd_stats_scanned 100')).toBeInTheDocument();
  });
});
