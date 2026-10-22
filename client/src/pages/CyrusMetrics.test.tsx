import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { CyrusMetricsPage } from './CyrusMetrics';
import { denyCapabilities } from '../test/capabilities';

const { getMetricsStats, getMetricsHistory, getMetricsRaw, getSessions } = vi.hoisted(() => ({
  getMetricsStats: vi.fn(),
  getMetricsHistory: vi.fn(),
  getMetricsRaw: vi.fn(),
  getSessions: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error { },
  cyrusApi: { getMetricsStats, getMetricsHistory, getMetricsRaw, getSessions },
}));

vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => async () => true }));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedCyrusService: { serviceId: 'dc1', name: 'DC', serviceType: 'cyrus' },
    selectedPostfixService: null,
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
  serviceType: 'cyrus' as const,
  serviceId: 'dc1',
  live: {
    reachable: true,
    authSuccess: 5,
    authFailure: 1,
    loginCount: 12,
    imapCommands: 33,
    mailDeliveries: 8,
    sessionCount: 7373,
    activeConnections: 2,
    mailboxCount: 20,
    userCount: 4,
  },
  totals24h: {
    logins: 100,
    authSuccess: 90,
    authFailure: 10,
    imapCommands: 500,
    mailDeliveries: 60,
    peakSessions: 20,
    unreachableSamples: 0,
  },
  historyCount: 10,
};

describe('CyrusMetricsPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getMetricsStats.mockResolvedValue({ data: STATS });
    getMetricsHistory.mockResolvedValue({ data: [] });
    getMetricsRaw.mockResolvedValue('# stats');
    getSessions.mockResolvedValue({ data: [] });
  });

  it('renders live gauges and hides operational tabs whose tools are unavailable', async () => {
    denyCapabilities('sessions', 'kick', 'quota');
    render(<MemoryRouter><CyrusMetricsPage /></MemoryRouter>);

    expect(await screen.findByText('Cyrus metrics')).toBeInTheDocument();
    expect((await screen.findAllByText('IMAP logins OK (24h)')).length).toBeGreaterThan(0);
    expect(screen.queryByText('7373')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Raw/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sessions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Users$/ })).not.toBeInTheDocument();
  });

  it('lists sessions without offering disconnect', async () => {
    getSessions.mockResolvedValue({ data: [{ user: 'alice@example.com', service: 'imap', pid: '100', ip: '10.0.0.1', host: 'mail-proxy', mailbox: 'user.alice', state: 'Idle' }] });
    render(<MemoryRouter><CyrusMetricsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Sessions/ }));
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Disconnect/ })).not.toBeInTheDocument();
    expect(await screen.findByText('user.alice')).toBeInTheDocument();
  });
});
