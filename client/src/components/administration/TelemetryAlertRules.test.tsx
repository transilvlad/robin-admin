import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { TelemetryAlertRules, formatLabels } from './TelemetryAlertRules';

const { alertsApi } = vi.hoisted(() => ({
  alertsApi: {
    listTelemetryRules: vi.fn(),
    createTelemetryRule: vi.fn(),
    updateTelemetryRule: vi.fn(),
    deleteTelemetryRule: vi.fn(),
    previewTelemetryRule: vi.fn(),
  },
}));

vi.mock('../../api/client', () => ({
  alertsApi,
  ApiError: class ApiError extends Error {},
}));

const rule = {
  id: 3,
  name: 'SMTP egress down',
  description: null,
  query: 'min by (host) (smtp_egress_ok)',
  comparator: '<',
  threshold: 1,
  forSeconds: 300,
  severity: 'critical',
  enabled: true,
  lastEvaluatedAt: '2026-10-08T12:00:00Z',
  lastError: null,
  createdAt: '2026-10-08T11:00:00Z',
  updatedAt: '2026-10-08T11:00:00Z',
  states: [{
    ruleId: 3, seriesKey: 'k1', labels: { host: 'mail-1' }, status: 'firing',
    pendingSince: '2026-10-08T11:50:00Z', firingSince: '2026-10-08T11:55:00Z', lastValue: 0, lastSeenAt: '2026-10-08T12:00:00Z',
  }],
};

describe('TelemetryAlertRules', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    alertsApi.listTelemetryRules.mockResolvedValue({ data: [rule] });
  });

  afterEach(cleanup);

  it('shows each rule with its condition and firing series', async () => {
    render(<MemoryRouter><TelemetryAlertRules /></MemoryRouter>);
    expect(await screen.findByText('SMTP egress down')).toBeInTheDocument();
    expect(screen.getByText('Firing (1)')).toBeInTheDocument();
    expect(screen.getByText(/< 1 for 5 min · critical/)).toBeInTheDocument();
    expect(screen.getByText('host=mail-1')).toBeInTheDocument();
  });

  it('validates, previews and creates a rule', async () => {
    alertsApi.listTelemetryRules.mockResolvedValue({ data: [] });
    alertsApi.previewTelemetryRule.mockResolvedValue({ data: { series: [{ labels: { host: 'a' }, value: 0, matches: true }, { labels: { host: 'b' }, value: 1, matches: false }], truncated: false } });
    alertsApi.createTelemetryRule.mockResolvedValue({ data: rule });
    render(<MemoryRouter><TelemetryAlertRules /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add rule' }));

    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    expect(screen.getByRole('alert')).toHaveTextContent('Name is required.');
    expect(alertsApi.createTelemetryRule).not.toHaveBeenCalled();

    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'SMTP egress down' } });
    fireEvent.change(screen.getByLabelText(/Query/), { target: { value: 'min by (host) (smtp_egress_ok)' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('1 of 2 series match now')).toBeInTheDocument();
    expect(alertsApi.previewTelemetryRule).toHaveBeenCalledWith({ query: 'min by (host) (smtp_egress_ok)', comparator: '<', threshold: 1 });

    fireEvent.click(screen.getByRole('button', { name: 'Save rule' }));
    await waitFor(() => expect(alertsApi.createTelemetryRule).toHaveBeenCalledWith({
      name: 'SMTP egress down',
      description: null,
      query: 'min by (host) (smtp_egress_ok)',
      comparator: '<',
      threshold: 1,
      forSeconds: 300,
      severity: 'critical',
      enabled: true,
    }));
  });

  it('formats labels without the metric name', () => {
    expect(formatLabels({ __name__: 'up', role: 'obm', host: 'a' })).toBe('host=a, role=obm');
    expect(formatLabels({})).toBe('all series');
  });
});
