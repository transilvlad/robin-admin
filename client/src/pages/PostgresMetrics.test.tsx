import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PostgresMetricsPage } from './PostgresMetrics';
import { ConfirmProvider } from '../context/ConfirmContext';

function renderPage() {
  return render(<MemoryRouter><ConfirmProvider><PostgresMetricsPage /></ConfirmProvider></MemoryRouter>);
}
const auth = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth }) }));

const {
  getMetricsStats,
  getMetricsHistory,
  getMetricsRaw,
  getActivity,
  cancelBackend,
  terminateBackend,
  getLocks,
  getTableSizes,
  getStatStatements,
  vacuum,
  analyze,
  resetStats,
} = vi.hoisted(() => ({
  getMetricsStats: vi.fn(),
  getMetricsHistory: vi.fn(),
  getMetricsRaw: vi.fn(),
  getActivity: vi.fn(),
  cancelBackend: vi.fn(),
  terminateBackend: vi.fn(),
  getLocks: vi.fn(),
  getTableSizes: vi.fn(),
  getStatStatements: vi.fn(),
  vacuum: vi.fn(),
  analyze: vi.fn(),
  resetStats: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  postgresApi: {
    getMetricsStats,
    getMetricsHistory,
    getMetricsRaw,
    getActivity,
    cancelBackend,
    terminateBackend,
    getLocks,
    getTableSizes,
    getStatStatements,
    vacuum,
    analyze,
    resetStats,
  },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedPostgresService: { serviceId: 'pg1', name: 'Postgres 1', serviceType: 'postgres' },
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
  serviceType: 'postgres' as const,
  serviceId: 'pg1',
  live: {
    reachable: true,
    connectionsTotal: 20,
    connectionsActive: 12,
    connectionsIdle: 8,
    maxConnections: 100,
    connectionSaturationPct: 20,
    cacheHitRatio: 0.9981860054911877,
    commitRatio: 0.98,
    deadTuplesTotal: 5,
    blockedQueries: 0,
    databaseSizeBytes: 104857600,
  },
  totals24h: {
    xactCommit: 5000,
    xactRollback: 20,
    deadlocks: 0,
    tempFiles: 0,
    tempBytes: 0,
    peakConnectionsTotal: 30,
    peakConnectionSaturationPct: 30,
    unreachableSamples: 0,
  },
  historyCount: 24,
};

describe('PostgresMetricsPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    auth.role = 'admin';
    getMetricsStats.mockResolvedValue({ data: STATS });
    getMetricsHistory.mockResolvedValue({ data: [] });
    getMetricsRaw.mockResolvedValue('# stats');
    getActivity.mockResolvedValue({ data: [] });
    cancelBackend.mockResolvedValue({ data: { cancelled: true } });
    terminateBackend.mockResolvedValue({ data: { terminated: true } });
    getLocks.mockResolvedValue({ data: [] });
    getTableSizes.mockResolvedValue({ data: [] });
    getStatStatements.mockResolvedValue({ data: { available: true, rows: [] } });
    vacuum.mockResolvedValue({ data: { response: 'VACUUM' } });
    analyze.mockResolvedValue({ data: { response: 'ANALYZE' } });
    resetStats.mockResolvedValue({ data: { response: 'OK' } });
  });

  it('renders the metrics workspace with live connection activity', async () => {
    const { container } = renderPage();

    expect(await screen.findByText('Postgres metrics')).toBeInTheDocument();
    expect((await screen.findAllByText('12')).length).toBeGreaterThan(0);
    // The server reports both as 0..1 ratios.
    expect(screen.getAllByText('99.82%').length).toBeGreaterThan(0);
    expect(screen.getAllByText('98%').length).toBeGreaterThan(0);
    expect(screen.queryByText('1%')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Activity' }).querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByRole('button', { name: 'Locks' })).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/[📊📄📈⚡🔒🗄️]/u);
  });

  it.each(['viewer', 'editor'])('hides administrative tools from %s', async (role) => {
    auth.role = role;
    renderPage();
    await screen.findByText('Postgres metrics');
    for (const name of ['Activity', 'Locks', 'Tables', 'Statements', 'Reset statistics']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(getActivity).not.toHaveBeenCalled();
  });

  it('cancels a backend after confirmation', async () => {
    getActivity.mockResolvedValue({
      data: [{ pid: 123, state: 'active', waitEventType: null, waitEvent: null, query: 'SELECT 1', ageSecs: 5, usename: 'app' }],
    });

    renderPage();

    await screen.findByText('Postgres metrics');
    fireEvent.click(screen.getByRole('button', { name: /Activity/ }));

    await waitFor(() => expect(getActivity).toHaveBeenCalledWith('pg1'));
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(cancelBackend).toHaveBeenCalledWith('pg1', 123));
  });

  it('runs VACUUM ANALYZE on the database after confirmation', async () => {
    renderPage();

    await screen.findByText('Postgres metrics');
    fireEvent.click(screen.getByRole('button', { name: 'VACUUM ANALYZE database' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => expect(vacuum).toHaveBeenCalledWith('pg1', undefined, true));
  });
});
