import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { TelemetryRangeData } from '../types/telemetry';
import { seriesLabel, TelemetryExplorePage } from './TelemetryExplore';

const { status, queryRange, sourceQuery, labelValues, labelNames, dashboards, dashboard, saveDashboard, createDashboard } = vi.hoisted(() => ({
  status: vi.fn(),
  queryRange: vi.fn(),
  sourceQuery: vi.fn(),
  labelValues: vi.fn(),
  labelNames: vi.fn(),
  dashboards: vi.fn(),
  dashboard: vi.fn(),
  saveDashboard: vi.fn(),
  createDashboard: vi.fn(),
}));
const auth = vi.hoisted(() => ({ canEdit: true }));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  telemetryApi: { status, queryRange, sourceQuery, labelValues, labelNames, dashboards, dashboard, saveDashboard, createDashboard },
}));
vi.mock('../hooks/useAuth', () => ({ useCanEdit: () => auth.canEdit }));

vi.mock('../components/telemetry/TimeSeriesChart', () => ({
  TimeSeriesChart: ({ data, unit }: { data: TelemetryRangeData; unit: string }) => (
    <div data-testid="chart" data-unit={unit}>{data.series.map((series) => series.name).join(' | ')}</div>
  ),
}));

function renderPage(url = '/telemetry/explore') {
  return render(<MemoryRouter initialEntries={[url]}><TelemetryExplorePage /></MemoryRouter>);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  auth.canEdit = true;
  localStorage.clear();
  status.mockResolvedValue({ success: true, data: { enabled: true, configured: true, reachable: true, totalSeries: 1, sources: ['a'] } });
  labelValues.mockResolvedValue({ success: true, data: ['host_load1'] });
  queryRange.mockResolvedValue({
    success: true,
    data: {
      start: 0, end: 60, step: 15, timestamps: [0, 60], truncated: false,
      series: [{ labels: { __name__: 'host_load1', host: 'b' }, values: [1, 2] }, { labels: { host: 'a' }, values: [3, 4] }],
    },
  });
});

describe('seriesLabel', () => {
  it('opens a fleet link with the configured source selector', async () => {
    sourceQuery.mockResolvedValue({ success: true, data: { query: '{instance="node-a.example.test",job="app"}' } });
    renderPage('/telemetry/explore?source=node-a.example.test&range=1h');
    await waitFor(() => expect(queryRange).toHaveBeenCalledWith('{instance="node-a.example.test",job="app"}', expect.any(Object)));
    expect(sourceQuery).toHaveBeenCalledWith('node-a.example.test');
  });
  it('formats labels with and without a metric name', () => {
    expect(seriesLabel({ __name__: 'up', host: 'a' })).toBe('up{host="a"}');
    expect(seriesLabel({ host: 'a', role: 'worker' })).toBe('{host="a", role="worker"}');
    expect(seriesLabel({ __name__: 'up' })).toBe('up');
    expect(seriesLabel({})).toBe('value');
  });
});

describe('TelemetryExplorePage', () => {
  it('queries historical metrics and suggestions without any discovered sources', async () => {
    status.mockResolvedValue({ data: { configured: true, reachable: true, sources: [], silentAfterSeconds: 900 } });
    renderPage('/telemetry/explore?q=custom_metric&from=100000&to=103600');
    await screen.findByTestId('chart');
    expect(queryRange).toHaveBeenCalledWith('custom_metric', { start: 100000, end: 103600 });
    expect(labelValues).toHaveBeenCalledWith('__name__', { start: 100000, end: 103600 });
  });
  it('keeps queries usable when metric suggestions fail', async () => {
    labelValues.mockRejectedValue(new Error('offline'));
    renderPage('/telemetry/explore?q=custom_metric');
    await screen.findByTestId('chart');
    expect(await screen.findByRole('alert')).toHaveTextContent('Metric suggestions unavailable');
  });
  it('creates a first generic dashboard atomically from Explore', async () => {
    dashboards.mockResolvedValue({ data: [] });
    createDashboard.mockResolvedValue({ data: { uid: 'custom' } });
    renderPage('/telemetry/explore?q=custom_metric%7Bdevice%3D%22a%22%7D&unit=milliseconds');
    await screen.findByTestId('chart');
    fireEvent.click(screen.getByRole('button', { name: 'Add to dashboard' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.change(await within(dialog).findByLabelText('Dashboard title'), { target: { value: 'Devices' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add panel' }));
    await waitFor(() => expect(createDashboard).toHaveBeenCalled());
    expect(createDashboard.mock.calls[0][0]).toMatchObject({ title: 'Devices', variables: [], rows: [{ panels: [{ unit: 'milliseconds', queries: [{ expr: 'custom_metric{device="a"}' }] }] }] });
    expect(saveDashboard).not.toHaveBeenCalled();
  });
  it('runs the query from the URL and charts sorted series', async () => {
    renderPage('/telemetry/explore?q=host_load1&unit=percent');
    expect(await screen.findByTestId('chart')).toHaveTextContent('{host="a"} | host_load1{host="b"}');
    expect(screen.getByTestId('chart')).toHaveAttribute('data-unit', 'percent');
    expect(queryRange).toHaveBeenCalledWith('host_load1', expect.objectContaining({ start: expect.any(Number) }));
  });

  it('runs a typed query with Ctrl+Enter', async () => {
    renderPage();
    const editor = await screen.findByLabelText('PromQL query');
    fireEvent.change(editor, { target: { value: 'up' } });
    fireEvent.keyDown(editor, { key: 'Enter', ctrlKey: true });
    await waitFor(() => expect(queryRange).toHaveBeenCalledWith('up', expect.any(Object)));
  });

  it('shows query errors', async () => {
    const { ApiError } = await import('../api/client');
    queryRange.mockRejectedValue(new ApiError('parse error', 400));
    renderPage('/telemetry/explore?q=rate(');
    expect(await screen.findByRole('alert')).toHaveTextContent('parse error');
  });

  it('adds the query to a new row on a dashboard', async () => {
    dashboards.mockResolvedValue({ success: true, data: [{ uid: 'mail', title: 'Mail', description: '', templateKey: null, version: 4, updatedAt: '' }] });
    dashboard.mockResolvedValue({
      success: true,
      data: { uid: 'mail', title: 'Mail', description: '', templateKey: null, version: 4, updatedAt: '', updatedBy: null, variables: [], rows: [] },
    });
    saveDashboard.mockResolvedValue({ success: true, data: {} });
    renderPage('/telemetry/explore?q=host_load1&unit=count');
    await screen.findByTestId('chart');
    fireEvent.click(screen.getByRole('button', { name: 'Add to dashboard' }));
    const dialog = await screen.findByRole('dialog');
    await within(dialog).findByRole('option', { name: 'Mail' });
    expect(dashboard).not.toHaveBeenCalled();
    expect(within(dialog).getByRole('button', { name: 'Add panel' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText('Dashboard'), { target: { value: 'mail' } });
    await waitFor(() => expect(dashboard).toHaveBeenCalledWith('mail'));
    fireEvent.change(within(dialog).getByLabelText('Panel title'), { target: { value: 'Load' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add panel' }));
    await waitFor(() => expect(saveDashboard).toHaveBeenCalled());
    const [uid, content, version] = saveDashboard.mock.calls[0];
    expect([uid, version]).toEqual(['mail', 4]);
    expect(content.rows).toHaveLength(1);
    expect(content.rows[0]).toMatchObject({ title: 'From Explore', panels: [{ title: 'Load', unit: 'count', queries: [{ expr: 'host_load1' }] }] });
  });

  it('does not offer adding to dashboards to viewers', async () => {
    auth.canEdit = false;
    renderPage('/telemetry/explore?q=host_load1');
    await screen.findByTestId('chart');
    expect(screen.queryByRole('button', { name: 'Add to dashboard' })).not.toBeInTheDocument();
  });

  it('runs several queries together and prefixes series with the query letter', async () => {
    queryRange.mockImplementation((query: string) => Promise.resolve({
      success: true,
      data: { start: 0, end: 120, step: 60, timestamps: query === 'a' ? [0, 60] : [60, 120], truncated: false, series: [{ labels: { q: query }, values: [1, 2] }] },
    }));
    renderPage('/telemetry/explore?q=a&q=b');
    expect(await screen.findByTestId('chart')).toHaveTextContent('A: {q="a"} | B: {q="b"}');
    expect(screen.getByLabelText('Query A')).toHaveValue('a');
    expect(screen.getByLabelText('Query B')).toHaveValue('b');
  });

  it('adds and removes query editors', async () => {
    renderPage();
    await screen.findByLabelText('PromQL query');
    fireEvent.click(screen.getByRole('button', { name: 'Add query' }));
    fireEvent.change(await screen.findByLabelText('Query A'), { target: { value: 'up' } });
    fireEvent.change(screen.getByLabelText('Query B'), { target: { value: 'host_load1' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    await waitFor(() => expect(queryRange).toHaveBeenCalledWith('host_load1', expect.any(Object)));
    expect(queryRange).toHaveBeenCalledWith('up', expect.any(Object));
    fireEvent.click(screen.getByRole('button', { name: 'Remove query A' }));
    expect(screen.getByLabelText('PromQL query')).toHaveValue('host_load1');
  });

  it('shows a table of series summaries', async () => {
    renderPage('/telemetry/explore?q=host_load1&unit=percent');
    await screen.findByTestId('chart');
    fireEvent.click(screen.getByRole('button', { name: 'Table' }));
    const rows = screen.getAllByRole('row');
    expect(rows).toHaveLength(3);
    expect(within(rows[1]).getByText('{host="a"}')).toBeInTheDocument();
    expect(rows[1]).toHaveTextContent('4%');
  });

  it('remembers run queries and reopens them', async () => {
    renderPage();
    const editor = await screen.findByLabelText('PromQL query');
    fireEvent.change(editor, { target: { value: 'up' } });
    fireEvent.click(screen.getByRole('button', { name: 'Run' }));
    const recent = await screen.findByLabelText('Recent queries');
    expect(JSON.parse(localStorage.getItem('telemetry-explore-history')!)).toEqual([['up']]);
    fireEvent.change(editor, { target: { value: 'other' } });
    fireEvent.change(recent, { target: { value: '0' } });
    await waitFor(() => expect(screen.getByLabelText('PromQL query')).toHaveValue('up'));
  });

  it('inserts a selector from the label browser', async () => {
    labelNames.mockResolvedValue({ success: true, data: ['host'] });
    labelValues.mockImplementation((label: string) => Promise.resolve({ success: true, data: label === '__name__' ? ['host_load1'] : ['worker-a'] }));
    renderPage('/telemetry/explore?q=sum(');
    await screen.findByLabelText('PromQL query');
    fireEvent.click(screen.getByRole('button', { name: 'Metrics and labels' }));
    fireEvent.click(await screen.findByRole('option', { name: 'host_load1' }));
    fireEvent.click(await screen.findByRole('option', { name: 'host' }));
    fireEvent.click(await screen.findByRole('option', { name: 'worker-a' }));
    // Without a cursor placed, the selector goes at the end.
    expect(screen.getByLabelText('PromQL query')).toHaveValue('sum(host_load1{host="worker-a"}');
    const editor = screen.getByLabelText('PromQL query') as HTMLTextAreaElement;
    fireEvent.focus(editor);
    editor.setSelectionRange(0, 0);
    fireEvent.click(screen.getByRole('option', { name: 'worker-a' }));
    expect(editor).toHaveValue('host_load1{host="worker-a"}sum(host_load1{host="worker-a"}');
  });
});
