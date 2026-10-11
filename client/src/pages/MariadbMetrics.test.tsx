import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MariadbMetricsPage } from './MariadbMetrics';
import { ConfirmProvider } from '../context/ConfirmContext';

const api = vi.hoisted(() => ({
  getMetricsStats: vi.fn(),
  getMetricsHistory: vi.fn(),
  getMetricsRaw: vi.fn(),
  getProcesses: vi.fn(),
  getTransactions: vi.fn(),
  getSchemas: vi.fn(),
  getTables: vi.fn(),
  getStatements: vi.fn(),
  kill: vi.fn(),
  analyze: vi.fn(),
  resetStats: vi.fn(),
}));
const auth = vi.hoisted(() => ({ role: 'admin' }));
vi.mock('../context/AuthContext', () => ({ useAuth: () => ({ user: auth }) }));

vi.mock('../api/client', () => ({ ApiError: class ApiError extends Error {}, mariadbApi: api }));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({ selectedMariadbService: { serviceId: 'db1', name: 'Application DB', serviceType: 'mariadb' } }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({ PageServiceSelector: () => <div data-testid="selector" /> }));

vi.mock('../components/charts', () => ({
  LineChart: () => <div data-testid="line-chart" />,
  downsampleData: () => [],
  formatChartLabels: () => [],
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const STATS = {
  serviceType: 'mariadb' as const,
  serviceId: 'db1',
  live: {
    reachable: true,
    version: '10.11.9-MariaDB',
    threadsConnected: 35,
    threadsRunning: 3,
    maxConnections: 350,
    connectionSaturationPct: 10,
    bufferPoolHitRatio: 0.99,
    trxActive: 2,
    oldestTrxAgeSecs: 900,
    trxLockWaits: 1,
    databaseSizeBytes: 52428800,
    schemaCount: 21,
    isReplica: false,
    secondsBehindSource: null,
  },
  totals24h: {
    questions: 100000, comCommit: 900, comRollback: 10, comInsert: 1, comUpdate: 2, comDelete: 3, slowQueries: 4,
    deadlocks: 1, rowLockWaits: 7, abortedConnects: 0, createdTmpDiskTables: 0, peakThreadsConnected: 60,
    peakConnectionSaturationPct: 17, peakOldestTrxAgeSecs: 900, unreachableSamples: 0,
  },
  historyCount: 12,
};

function renderPage() {
  return render(<MemoryRouter><ConfirmProvider><MariadbMetricsPage /></ConfirmProvider></MemoryRouter>);
}

describe('MariadbMetricsPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    auth.role = 'admin';
    api.getMetricsStats.mockResolvedValue({ data: STATS });
    api.getMetricsHistory.mockResolvedValue({ data: [] });
    api.getTransactions.mockResolvedValue({
      data: [
        { trxId: '1', state: 'RUNNING', startedAt: '', ageSecs: 900, threadId: 41, user: 'app', host: 'h', db: 'app', command: 'Sleep', query: null, rowsLocked: 1, tablesLocked: 1, blockedByThreadIds: [] },
        { trxId: '2', state: 'LOCK WAIT', startedAt: '', ageSecs: 30, threadId: 42, user: 'app', host: 'h', db: 'app', command: 'Query', query: 'UPDATE queued_messages', rowsLocked: 0, tablesLocked: 1, blockedByThreadIds: [41] },
      ],
    });
    api.kill.mockResolvedValue({ data: { killed: true, scope: 'connection' } });
  });

  it('shows the transaction health and the buffer pool ratio as a percentage', async () => {
    renderPage();
    expect(await screen.findByText('Oldest transaction')).toBeInTheDocument();
    expect(screen.getAllByText('15m').length).toBeGreaterThan(0);
    expect(screen.getByText('99%')).toBeInTheDocument();
    expect(screen.getByText('35 / 350')).toBeInTheDocument();
  });

  it.each(['viewer', 'editor'])('hides administrative tools from %s', async (role) => {
    auth.role = role;
    renderPage();
    await screen.findByText('Oldest transaction');
    for (const name of ['Processes', 'Transactions', 'Schemas', 'Statements', 'Reset statistics']) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument();
    }
    expect(api.getProcesses).not.toHaveBeenCalled();
  });

  it('lists the blocker of a waiting transaction and kills its connection after confirming', async () => {
    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Transactions/ }));
    expect(await screen.findByText('LOCK WAIT')).toBeInTheDocument();
    expect(screen.getByText('idle in transaction')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Kill connection' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: /confirm/i }));
    await waitFor(() => expect(api.kill).toHaveBeenCalledWith('db1', 41, 'connection'));
  });
});
