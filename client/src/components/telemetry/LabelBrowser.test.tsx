import { beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { LabelBrowser } from './LabelBrowser';
const api = vi.hoisted(() => ({ labelNames: vi.fn(), labelValues: vi.fn() }));
vi.mock('../../api/client', () => ({ ApiError: class ApiError extends Error {}, telemetryApi: api }));
beforeEach(() => { cleanup(); vi.clearAllMocks(); });

it('ignores a stale metric-label response after another metric is selected', async () => {
  let resolveFirst!: (value: { data: string[] }) => void;
  api.labelNames.mockImplementation(({ match }) => match === 'metric_a'
    ? new Promise(resolve => { resolveFirst = resolve; }) : Promise.resolve({ data: ['device'] }));
  render(<LabelBrowser metricNames={['metric_a', 'metric_b']} start={100} end={200} onInsert={vi.fn()} />);
  fireEvent.click(screen.getByRole('option', { name: 'metric_a' }));
  fireEvent.click(screen.getByRole('option', { name: 'metric_b' }));
  await screen.findByRole('option', { name: 'device' });
  await act(async () => resolveFirst({ data: ['stale'] }));
  expect(screen.queryByRole('option', { name: 'stale' })).not.toBeInTheDocument();
  expect(screen.getByRole('option', { name: 'device' })).toBeInTheDocument();
});

it('escapes arbitrary label values when inserting a selector', async () => {
  const value = 'device"\\\nname';
  api.labelNames.mockResolvedValue({ data: ['device'] });
  api.labelValues.mockResolvedValue({ data: [value] });
  const insert = vi.fn();
  render(<LabelBrowser metricNames={['custom_metric']} start={100} end={200} onInsert={insert} />);
  fireEvent.click(screen.getByRole('option', { name: 'custom_metric' }));
  fireEvent.click(await screen.findByRole('option', { name: 'device' }));
  // Accessible text normalizes whitespace; scope the final option to its list.
  const values = screen.getByRole('listbox', { name: 'Values' });
  await waitFor(() => expect(values.querySelector('button')).not.toBeNull());
  fireEvent.click(values.querySelector('button')!);
  expect(insert).toHaveBeenCalledWith(`custom_metric{device=${JSON.stringify(value)}}`);
});

it('shows metadata failures without leaving a perpetual loading spinner', async () => {
  api.labelNames.mockRejectedValue(new Error('offline'));
  render(<LabelBrowser metricNames={['custom_metric']} start={100} end={200} onInsert={vi.fn()} />);
  fireEvent.click(screen.getByRole('option', { name: 'custom_metric' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load labels');
  expect(screen.queryByRole('status', { name: 'Loading labels' })).not.toBeInTheDocument();
});
