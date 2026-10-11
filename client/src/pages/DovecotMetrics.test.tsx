import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DovecotMetricsPage } from './DovecotMetrics';
import { denyCapabilities } from '../test/capabilities';

const { getMetricsStats, getMetricsHistory, getMetricsRaw, getSessions, kickUser } = vi.hoisted(() => ({
  getMetricsStats: vi.fn(),
  getMetricsHistory: vi.fn(),
  getMetricsRaw: vi.fn(),
  getSessions: vi.fn(),
  kickUser: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  dovecotApi: { getMetricsStats, getMetricsHistory, getMetricsRaw, getSessions, kickUser },
}));

vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => async () => true }));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedDovecotService: { serviceId: 'dc1', name: 'DC', serviceType: 'dovecot' },
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
  serviceType: 'dovecot' as const,
  serviceId: 'dc1',
  live: {
    reachable: true,
    authSuccess: 5,
    authFailure: 1,
    loginCount: 12,
    imapCommands: 33,
    mailDeliveries: 8,
    sessionCount: 7373,
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

describe('DovecotMetricsPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getMetricsStats.mockResolvedValue({ data: STATS });
    getMetricsHistory.mockResolvedValue({ data: [] });
    getMetricsRaw.mockResolvedValue('# stats');
    getSessions.mockResolvedValue({ data: [] });
    kickUser.mockResolvedValue({ data: { response: '' } });
  });

  it('renders live activity and hides agent tools and session counts without an agent', async () => {
    denyCapabilities('sessions', 'kick', 'quota');
    render(<MemoryRouter><DovecotMetricsPage /></MemoryRouter>);

    expect(await screen.findByText('Dovecot metrics')).toBeInTheDocument();
    expect((await screen.findAllByText('Logins (24h)')).length).toBeGreaterThan(0);
    // Session and user counts come from `doveadm who` through the agent.
    expect(screen.queryByText('7373')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Raw/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Sessions/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Users$/ })).not.toBeInTheDocument();
  });

  it('lists sessions and disconnects a user through the agent', async () => {
    getSessions.mockResolvedValue({ data: [{ user: 'alice@example.com', service: 'imap', pid: '100', ip: '10.0.0.1', destIp: '10.0.0.9' }] });
    render(<MemoryRouter><DovecotMetricsPage /></MemoryRouter>);

    fireEvent.click(await screen.findByRole('button', { name: /Sessions/ }));
    expect(await screen.findByText('alice@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Disconnect/ }));
    await vi.waitFor(() => expect(kickUser).toHaveBeenCalledWith('dc1', 'alice@example.com'));
  });
});
