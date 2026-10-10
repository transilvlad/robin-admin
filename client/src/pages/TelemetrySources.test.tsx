import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ago, TelemetrySourcesPage } from './TelemetrySources';

const api = vi.hoisted(() => ({
  telemetry: { status: vi.fn(), sources: vi.fn(), store: vi.fn() },
  keys: { list: vi.fn(), create: vi.fn(), revoke: vi.fn() },
}));
const auth = vi.hoisted(() => ({ role: 'admin' as 'viewer' | 'editor' | 'admin' }));
vi.mock('../api/client', () => ({ ApiError: class ApiError extends Error {}, telemetryApi: api.telemetry, apiKeysApi: api.keys }));
vi.mock('../hooks/useAuth', () => ({ useCanEdit: () => auth.role !== 'viewer', useIsAdmin: () => auth.role === 'admin' }));

const now = Math.floor(Date.now() / 1000);
const data = {
  sources: [
    { name: 'worker-a', groups: ['worker'], query: '{instance="worker-a"}', series: 1200, lastSeen: now - 30, silent: false },
    { name: 'service-a', groups: ['service'], query: '{instance="service-a"}', series: 800, lastSeen: now - 3600, silent: true },
    { name: 'old', groups: [], query: '{instance="old"}', series: 0, lastSeen: null, silent: true },
  ],
  sourceLabel: 'instance', groupLabel: 'job',
  sourceWindowDays: 14, silentAfterSeconds: 1800, refreshSeconds: 120, limit: 2000, truncated: false,
};
function renderPage() { return render(<MemoryRouter><TelemetrySourcesPage /></MemoryRouter>); }
beforeEach(() => {
  cleanup(); vi.clearAllMocks(); auth.role = 'admin';
  api.telemetry.status.mockResolvedValue({ success: true, data: { enabled: true, configured: true, reachable: true, totalSeries: 10, sources: ['worker-a'], silentAfterSeconds: 1800 } });
  api.telemetry.sources.mockResolvedValue({ success: true, data });
  api.telemetry.store.mockResolvedValue({ success: true, data: {
    address: 'vm:8428', kind: 'victoriametrics', version: 'v1.153.0', retention: '400d', totalSeries: 2005,
    dataSizeBytes: 1048576, freeDiskBytes: null, memoryLimitBytes: null, rowsInserted: 10, rowsRejected: 0, ingestRate: null, rejectRate: null,
    topMetrics: [{ name: 'host_cpu_seconds_total', series: 300 }],
  } });
});

describe('Telemetry sources', () => {
  it.each([
    ['no-data', 'No metrics found in the last 14 days.', 'Ingest API keys'],
    ['selector-mismatch', 'Metrics exist, but none match the discovery series selector.', 'Discovery settings'],
    ['missing-source-label', 'Matching metrics have no non-empty instance source identity.', 'Discovery settings'],
  ])('makes %s discovery actionable', async (emptyReason, message, link) => {
    api.telemetry.sources.mockResolvedValue({ data: { ...data, sources: [], emptyReason } });
    renderPage();
    expect(await screen.findByText(message)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: link })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Explore metrics' })).toHaveAttribute('href', '/telemetry/explore');
  });
  it('shows matching-series label suggestions when the configured source label is missing', async () => {
    api.telemetry.sources.mockResolvedValue({ data: {
      ...data, sources: [], emptyReason: 'missing-source-label', suggestedSourceLabels: ['host', 'role'],
    } });
    renderPage();
    expect(await screen.findByText('Labels found on matching series: host, role. One may be a better source identity.')).toBeInTheDocument();
  });
  it('opens silent sources over the discovery window without dashboard variables', async () => {
    renderPage();
    const link = await screen.findByRole('link', { name: 'service-a' });
    const params = new URL(link.getAttribute('href')!, 'https://admin.example.test').searchParams;
    expect(Number(params.get('to')) - Number(params.get('from'))).toBe(14 * 86400);
    expect(params.get('q')).toBe('{instance="service-a"}');
    expect(params.has('dashboard')).toBe(false);
  });
  it('formats ages', () => { expect(ago(10)).toBe('just now'); expect(ago(125)).toBe('2m ago'); });
  it('uses server policies and statuses, not hardcoded windows', async () => {
    renderPage();
    const hosts = await screen.findByRole('region', { name: 'Sources' });
    expect(await within(hosts).findByText(/1 reporting, 2 silent/)).toHaveTextContent('14 days. Silent after 30m');
    const rows = within(hosts).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Reporting'); expect(rows[2]).toHaveTextContent('Silent');
    expect(rows[3]).toHaveTextContent('Unknown');
    expect(within(hosts).getByRole('columnheader', { name: 'instance' })).toBeInTheDocument();
    expect(within(hosts).getByRole('link', { name: 'worker-a' })).toHaveAttribute('href', '/telemetry/explore?q=%7Binstance%3D%22worker-a%22%7D');
  });
  it('links to the single API key manager without listing or modifying keys', async () => {
    renderPage();
    await screen.findByRole('region', { name: 'Sources' });
    expect(screen.getByRole('link', { name: 'API keys' })).toHaveAttribute('href', '/administration/access?tab=apiKeys&preset=telemetry');
    expect(screen.getByRole('link', { name: 'Telemetry settings' })).toHaveAttribute('href', '/administration/telemetry');
    expect(screen.queryByRole('region', { name: 'Ingest keys' })).not.toBeInTheDocument();
    expect(api.keys.list).not.toHaveBeenCalled(); expect(api.keys.create).not.toHaveBeenCalled();
  });
  it('shows store health to editors', async () => {
    auth.role = 'editor'; renderPage();
    const store = await screen.findByRole('region', { name: 'Store' });
    expect(await within(store).findByText('VictoriaMetrics v1.153.0')).toBeInTheDocument();
    expect(within(store).getByText('400d')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'API keys' })).not.toBeInTheDocument();
  });
  it('marks incomplete results explicitly and refreshes', async () => {
    api.telemetry.sources.mockResolvedValue({ success: true, data: { ...data, truncated: true } });
    renderPage();
    expect(await screen.findByText(/counts may be incomplete/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Refresh sources' }));
    await waitFor(() => expect(api.telemetry.sources).toHaveBeenCalledTimes(2));
  });
  it('shows viewers the host list only', async () => {
    auth.role = 'viewer'; renderPage();
    await screen.findByRole('region', { name: 'Sources' });
    expect(screen.queryByRole('region', { name: 'Store' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Telemetry settings' })).not.toBeInTheDocument();
    expect(api.telemetry.store).not.toHaveBeenCalled(); expect(api.keys.list).not.toHaveBeenCalled();
  });
});
