import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { ApiError } from '../api/client';
import { TelemetryIssuesPage } from './TelemetryIssues';

const api = vi.hoisted(() => ({
  listTelemetryIssues: vi.fn(),
  dismissTelemetryIssue: vi.fn(),
  resumeTelemetryIssue: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    status: number;
    constructor(message: string, status = 500) {
      super(message);
      this.status = status;
    }
  },
  alertsApi: api,
}));

const issue = {
  id: '11a00195-51c9-49a8-812a-31ae48541c23',
  ruleId: 3,
  ruleName: 'Telemetry load',
  query: 'max by (host) (node_load1)',
  comparator: '>',
  threshold: 6,
  forSeconds: 300,
  severity: 'warning',
  seriesKey: 'series',
  labels: { host: 'mail-1' },
  lastValue: 9,
  status: 'active',
  openedAt: '2026-10-15T12:00:00.000Z',
  lastSeenAt: '2026-10-15T12:05:00.000Z',
  dismissedAt: null,
  dismissedBy: null,
  dismissedUntil: null,
  dismissalReason: null,
  revision: 1,
  resolvedAt: null,
  resolutionReason: null,
  events: [],
} as const;

function renderPage() {
  return render(<MemoryRouter><TelemetryIssuesPage /></MemoryRouter>);
}

beforeEach(() => {
  vi.clearAllMocks();
  api.listTelemetryIssues.mockResolvedValue({ data: { issues: [issue], total: 1 } });
  api.dismissTelemetryIssue.mockResolvedValue({ data: { ...issue, status: 'dismissed', revision: 2 } });
});

afterEach(cleanup);

describe('TelemetryIssuesPage', () => {
  it('shows firing context and dismisses a specific occurrence with an optional reason', async () => {
    renderPage();

    expect(await screen.findByText('Telemetry load')).toBeInTheDocument();
    expect(screen.getByText('host=mail-1')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Dismiss Telemetry load/ }));
    expect(screen.getByRole('dialog', { name: 'Dismiss telemetry issue' })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Reason (optional)'), { target: { value: 'Reviewed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss issue' }));

    await waitFor(() => expect(api.dismissTelemetryIssue).toHaveBeenCalledWith(issue.id, {
      expectedRevision: 1,
      reason: 'Reviewed',
      until: null,
    }));
    expect(await screen.findByRole('status')).toHaveTextContent('Issue dismissed.');
  });

  it('refreshes stale issue state and surfaces the conflict', async () => {
    api.dismissTelemetryIssue.mockRejectedValueOnce(new ApiError('Issue changed', 409));
    renderPage();

    fireEvent.click(await screen.findByRole('button', { name: /Dismiss Telemetry load/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss issue' }));

    await waitFor(() => expect(api.dismissTelemetryIssue).toHaveBeenCalledOnce());
    expect(await screen.findByRole('alert')).toHaveTextContent('Issue changed');
    await waitFor(() => expect(api.listTelemetryIssues).toHaveBeenCalledTimes(2));
  });
});
