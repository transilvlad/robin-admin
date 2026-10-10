import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ObservabilitySettingsPage } from './ObservabilitySettings';
const api = vi.hoisted(() => ({ get: vi.fn(), getRuntime: vi.fn(), update: vi.fn(), labelNames: vi.fn() }));
vi.mock('../components/administration/TelemetryStoreSettings', () => ({ TelemetryConnectionSettings: () => <div>Editable store connection</div>, TelemetryStorageSettingsView: () => <div>Store storage controls</div> }));
vi.mock('../api/client', () => ({ ApiError: class ApiError extends Error {}, configApi: api, telemetryApi: api }));
const config = { telemetrySourceWindowDays: 14, telemetrySilentAfterSeconds: 1800, telemetrySourceRefreshSeconds: 120, telemetrySourceLimit: 500, telemetryIngestBodyLimitBytes: 8388608, telemetryRequestTimeoutMs: 10000, telemetryQueryMaxPoints: 1500, telemetryQueryMaxSeries: 100, telemetryQueryMaxRangeDays: 400, monitoringConcurrency: 24, monitoringManualConcurrency: 8, monitoringManualQueueSize: 20, monitoringQueueWaitMs: 30000, monitoringObservationRetentionDays: 30, monitoringHistoryRetentionDays: 400, globalIpAllowlist: 'unchanged' };
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  api.get.mockResolvedValue({ success: true, data: config });
  api.labelNames.mockResolvedValue({ data: ['instance', 'job', 'device'] });
  api.getRuntime.mockResolvedValue({ success: true, data: { telemetry: { storeConfigured: true, storeAddress: 'vm.internal:8428' } } });
  api.update.mockImplementation(async updates => ({ success: true, data: { ...config, ...updates } }));
});
it('loads persisted telemetry values and saves only telemetry policy', async () => {
  render(<MemoryRouter initialEntries={['/administration/telemetry?tab=policy']}><ObservabilitySettingsPage section="telemetry" /></MemoryRouter>);
  const window = await screen.findByLabelText('Discovery window (days)');
  expect(window).toHaveValue(14);
  fireEvent.change(window, { target: { value: '21' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Settings saved');
  expect(api.update).toHaveBeenCalledWith({ telemetrySourceWindowDays: 21, telemetrySilentAfterSeconds: 1800, telemetrySourceRefreshSeconds: 120, telemetrySourceLimit: 500, telemetryIngestBodyLimitBytes: 8388608, telemetryRequestTimeoutMs: 10000, telemetryQueryMaxPoints: 1500, telemetryQueryMaxSeries: 100, telemetryQueryMaxRangeDays: 400 });
});
it('shows the last-valid configuration warning returned by the server', async () => {
  api.get.mockResolvedValue({ success: true, data: config, configurationError: 'Manual probe concurrency must leave one scheduled slot' });
  render(<MemoryRouter><ObservabilitySettingsPage section="monitoring" /></MemoryRouter>);
  expect(await screen.findByRole('alert')).toHaveTextContent('The last valid settings remain active');
  expect(screen.getByRole('alert')).toHaveTextContent('Manual probe concurrency must leave one scheduled slot');
});
it('deep-links storage without a duplicate API-key manager or deployment panel', async () => {
  render(<MemoryRouter initialEntries={['/administration/telemetry?tab=storage']}><ObservabilitySettingsPage section="telemetry" /></MemoryRouter>);
  expect(await screen.findByText('Store storage controls')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'API keys' })).toHaveAttribute('href', '/administration/access?tab=apiKeys&preset=telemetry');
  expect(api.getRuntime).not.toHaveBeenCalled();
});
it('saves an arbitrary discovery schema independently of resource policy', async () => {
  api.get.mockResolvedValue({ success: true, data: { ...config, telemetrySourceLabel: 'instance', telemetryGroupLabel: 'job', telemetrySourceSelector: 'up' } });
  render(<MemoryRouter initialEntries={['/administration/telemetry?tab=discovery']}><ObservabilitySettingsPage section="telemetry" /></MemoryRouter>);
  const source = await screen.findByLabelText('Source identity label');
  await waitFor(() => expect(document.querySelector('datalist option[value="device"]')).not.toBeNull());
  expect(source).toHaveAttribute('list', 'telemetry-discovery-labels');
  fireEvent.change(source, { target: { value: 'custom_sender' } });
  fireEvent.change(screen.getByLabelText('Grouping label (optional)'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByText('Settings saved');
  expect(api.update).toHaveBeenCalledWith({ telemetrySourceLabel: 'custom_sender', telemetryGroupLabel: '', telemetrySourceSelector: 'up' });
  expect(api.labelNames).toHaveBeenCalledWith(expect.objectContaining({ start: expect.any(Number), end: expect.any(Number) }));
});
it('does not block discovery configuration when suggestions are unavailable', async () => {
  api.labelNames.mockRejectedValue(new Error('offline'));
  render(<MemoryRouter initialEntries={['/administration/telemetry?tab=discovery']}><ObservabilitySettingsPage section="telemetry" /></MemoryRouter>);
  await screen.findByText(/Label suggestions unavailable/);
  expect(screen.getByRole('link', { name: 'Store settings' })).toHaveAttribute('href', '/administration/telemetry?tab=connection');
  expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled();
});
it('leaves failed edits visible and presents server validation', async () => {
  api.update.mockRejectedValue(new Error('bad policy'));
  render(<MemoryRouter><ObservabilitySettingsPage section="monitoring" /></MemoryRouter>);
  const concurrency = await screen.findByLabelText('Concurrent probes');
  fireEvent.change(concurrency, { target: { value: '4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save' }));
  await screen.findByRole('alert');
  expect(concurrency).toHaveValue(4);
  expect(api.getRuntime).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled());
});
it('does not expose an editable default when loading fails', async () => {
  api.get.mockRejectedValue(new Error('offline'));
  render(<MemoryRouter><ObservabilitySettingsPage section="telemetry" /></MemoryRouter>);
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
});
