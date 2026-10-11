import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { ServiceLogsPanel } from './ServiceLogsPanel';

const { logsGet, configGet } = vi.hoisted(() => ({
  logsGet: vi.fn(),
  configGet: vi.fn(),
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
});
