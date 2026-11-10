import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ServiceLogsPanel } from './ServiceLogsPanel';

const { logsGet, configGet, features } = vi.hoisted(() => ({
  logsGet: vi.fn(),
  configGet: vi.fn(),
  features: { logs: false },
}));

vi.mock('../../context/FeaturesContext', () => ({
  useFeatures: () => ({ features }),
}));

vi.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {},
  logsApi: { get: logsGet },
  configApi: { get: configGet },
}));

vi.mock('../ui/Button', () => ({
  Button: ({ children, onClick, disabled }: any) => (
    <button type="button" onClick={onClick} disabled={disabled}>{children}</button>
  ),
}));

describe('ServiceLogsPanel', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    configGet.mockResolvedValue({ data: { logDefaultLines: 200, logMaxLines: 1000 } });
    features.logs = false;
  });

  it('links to Logs search for the service when Logs is enabled', async () => {
    features.logs = true;
    logsGet.mockResolvedValue({ data: { serviceType: 'dovecot', serviceId: 'suite dovecot', available: true, source: 'agent', lines: ['x'] } });

    render(<MemoryRouter><ServiceLogsPanel serviceType="dovecot" serviceId="suite dovecot" /></MemoryRouter>);

    const link = await screen.findByRole('link', { name: /Search history/ });
    expect(link).toHaveAttribute('href', '/logs?service=suite%20dovecot');
  });

  it('shows log lines when logs are available', async () => {
    logsGet.mockResolvedValue({ data: {
      serviceType: 'postfix',
      serviceId: 's1',
      available: true,
      source: 'journalctl -u postfix@-',
      lines: ['line one', 'line two'],
    } });

    render(<ServiceLogsPanel serviceType="postfix" serviceId="s1" />);

    expect(await screen.findByText(/line one/)).toBeInTheDocument();
    expect(screen.getByText(/journalctl -u postfix@-/)).toBeInTheDocument();
  });

  it('shows the unavailable message when logs are not available', async () => {
    logsGet.mockResolvedValue({ data: {
      serviceType: 'postfix',
      serviceId: 's1',
      available: false,
      source: '',
      lines: [],
      error: 'robin-admin is not co-located with this service',
    } });

    render(<ServiceLogsPanel serviceType="postfix" serviceId="s1" />);

    expect(await screen.findByText(/co-located/)).toBeInTheDocument();
  });

  it('clears the warning when rate limiting has stopped', async () => {
    logsGet.mockResolvedValue({ data: {
      serviceType: 'postfix', serviceId: 's1', available: true, source: 'agent', lines: [],
      counters: { read: 10, excluded: 0, masked: 0, truncated: 0, rateLimited: 3, rateLimitedCurrent: 0, shipped: 7, bytesShipped: 50, readLagMs: 0 },
    } });

    render(<ServiceLogsPanel serviceType="postfix" serviceId="s1" />);

    expect(await screen.findByText('No recent log lines.')).toBeInTheDocument();
    expect(screen.queryByText(/agent dropped lines/)).not.toBeInTheDocument();
  });
});
