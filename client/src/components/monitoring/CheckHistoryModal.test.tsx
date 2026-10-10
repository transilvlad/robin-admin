import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { MonitoringCheck, MonitoringCheckDay } from '../../types/monitoring';
import type { TelemetryRangeData } from '../../types/telemetry';
import { CheckHistoryModal, overallAvailability, responseChartData } from './CheckHistoryModal';

const checkHistory = vi.hoisted(() => vi.fn());
const checkLocationHistory = vi.hoisted(() => vi.fn(async () => ({ data: [] })));
const checkObservations = vi.hoisted(() => vi.fn(async () => ({ data: [] })));

vi.mock('../../api/client', () => ({
  ApiError: class ApiError extends Error {},
  monitoringApi: { checkHistory, checkLocationHistory, checkObservations },
}));
vi.mock('../telemetry/TimeSeriesChart', () => ({
  TimeSeriesChart: ({ data, unit }: { data: TelemetryRangeData; unit: string }) => (
    <div data-testid="chart" data-unit={unit}>{data.series.map((series) => series.name).join(',')}</div>
  ),
}));

const day = (date: string, up: number, warning: number, down: number, average: number | null = 120): MonitoringCheckDay => ({
  day: date,
  up,
  warning,
  down,
  availability: up + warning + down > 0 ? (up + warning) / (up + warning + down) : null,
  averageResponseTimeMs: average,
  maxResponseTimeMs: average === null ? null : average * 2,
});

const CHECK = { id: 7, name: 'SMTP', targetName: 'worker-a', endpoint: 'worker-a.example.com', port: 25 } as MonitoringCheck;

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  checkHistory.mockResolvedValue({ success: true, data: [day('2026-09-29', 1440, 0, 0), day('2026-09-30', 1420, 10, 10), day('2026-10-01', 0, 0, 0, null)] });
});

describe('helpers', () => {
  it('weights availability by observations', () => {
    expect(overallAvailability([day('a', 99, 0, 1), day('b', 1, 0, 0)])).toBeCloseTo(100 / 101);
    expect(overallAvailability([])).toBeNull();
  });

  it('charts average and slowest response per UTC day', () => {
    const data = responseChartData([day('2026-10-01', 1, 0, 0, 100)]);
    const timestamp = Date.UTC(2026, 9, 1) / 1000;
    expect(data.timestamps).toEqual([timestamp - 43200, timestamp, timestamp + 43200]);
    expect(data.series.map((series) => [series.name, series.values])).toEqual([['Average', [null, 100, null]], ['Slowest', [null, 200, null]]]);
  });
});

describe('CheckHistoryModal', () => {
  it('shows availability, daily bars and the response chart', async () => {
    render(<CheckHistoryModal check={CHECK} onClose={() => undefined} />);
    const dialog = await screen.findByRole('dialog');
    expect(checkHistory).toHaveBeenCalledWith(7, 90);
    expect(await within(dialog).findByText('99.652%')).toBeInTheDocument();
    const bars = within(dialog).getByRole('list', { name: 'Availability per day' });
    expect(within(bars).getAllByRole('listitem').map((item) => item.getAttribute('aria-label'))).toEqual([
      '2026-09-29: 100%', '2026-09-30: 99.305%', '2026-10-01: no data',
    ]);
    expect(within(dialog).getByTestId('chart')).toHaveAttribute('data-unit', 'milliseconds');
  });

  it('reloads for another period', async () => {
    render(<CheckHistoryModal check={CHECK} onClose={() => undefined} />);
    await screen.findByText('99.652%');
    fireEvent.click(screen.getByRole('button', { name: '30 days' }));
    await waitFor(() => expect(checkHistory).toHaveBeenLastCalledWith(7, 30));
  });

  it('explains an empty history', async () => {
    checkHistory.mockResolvedValue({ success: true, data: [] });
    render(<CheckHistoryModal check={CHECK} onClose={() => undefined} />);
    expect(await screen.findByText('No observations in this period yet.')).toBeInTheDocument();
  });
});
