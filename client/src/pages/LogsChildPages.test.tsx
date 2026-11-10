import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { LogsAlertsPage } from './LogsAlerts';
import { LogsHealthPage } from './LogsHealth';
import { LogsSourcesPage } from './LogsSources';
import { ConfirmProvider } from '../context/ConfirmContext';

const {
  status, listSources,
  listAlertRules, previewAlertRule, createAlertRule,
  listQuarantined, getQuarantined, retryQuarantined, discardQuarantined,
} = vi.hoisted(() => ({
  status: vi.fn(),
  listSources: vi.fn(),
  listAlertRules: vi.fn(),
  previewAlertRule: vi.fn(),
  createAlertRule: vi.fn(),
  listQuarantined: vi.fn(),
  getQuarantined: vi.fn(),
  retryQuarantined: vi.fn(),
  discardQuarantined: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  logsApi: {
    status,
    listQuarantined,
    getQuarantined,
    retryQuarantined,
    discardQuarantined,
    listSources,
    listAlertRules,
    previewAlertRule,
    createAlertRule,
  },
}));

function Location() {
  const location = useLocation();
  return <output data-testid="location">{location.pathname}{location.search}</output>;
}

function renderPage(page: ReactNode, initialEntry = '/') {
  return render(<MemoryRouter initialEntries={[initialEntry]}><ConfirmProvider>{page}<Location /></ConfirmProvider></MemoryRouter>);
}

const storeStatus = {
  enabled: true,
  reachable: true,
  storageBytes: 512,
  maxDiskBytes: 1024,
  retentionDays: 14,
  rowsIngested24h: 50,
  oldestLogAt: '2026-11-03T10:00:00Z',
  metrics: { rowsIngestedTotal: 100, bytesIngestedTotal: 2000, rowsDroppedTotal: 0, streamsCreatedTotal: 3 },
  write: { queuedLines: 0, queuedBytes: 0, quarantinedBatches: 0, quarantinedLines: 0, quarantinedBytes: 0, usedBytes: 0, capacityBytes: 268435456, oldestQueuedAt: null, retryingBatches: 0, uncertainBatches: 0, uncertainDeliveries24h: 0, droppedLines24h: 0, rejectedLines24h: 0, discardedLines24h: 0, lastDeliveredAt: null, lastErrorAt: null, lastError: null },
};

beforeEach(() => {
  cleanup();
  vi.resetAllMocks();
  status.mockResolvedValue({ data: storeStatus });
  listQuarantined.mockResolvedValue({ data: [] });
  getQuarantined.mockResolvedValue({ data: [] });
  retryQuarantined.mockResolvedValue({ data: undefined });
  discardQuarantined.mockResolvedValue({ data: undefined });
  listSources.mockResolvedValue({ data: { windowDays: 7, sources: [], truncated: false, limit: 200, quietAfterSeconds: 900 } });
  listAlertRules.mockResolvedValue({ data: [] });
  previewAlertRule.mockResolvedValue({ data: { value: 7, matches: true } });
  createAlertRule.mockResolvedValue({ data: { id: 2 } });
});

describe('Logs child pages', () => {
  it('shows health metrics and storage headroom', async () => {
    renderPage(<LogsHealthPage />);
    expect(await screen.findByText('Stored logs · 24h')).toBeInTheDocument();
    expect(screen.getByText('512 B')).toBeInTheDocument();
    expect(screen.getByText(/50% used/)).toBeInTheDocument();
    expect(screen.getByText(/Monitor free space on the host volume separately/)).toBeInTheDocument();
  });

  it('inspects and retries rejected batches from Logs health', async () => {
    listQuarantined.mockResolvedValue({ data: [{
      id: '18', origin: 'http', lineCount: 1, bytes: 42, error: 'invalid row', createdAt: '2026-11-03T10:00:00Z',
    }] });
    getQuarantined.mockResolvedValue({ data: [{ _msg: 'retained log line' }] });
    renderPage(<LogsHealthPage />);

    expect(await screen.findByText('1 lines · http · batch 18')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText(/retained log line/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryQuarantined).toHaveBeenCalledWith('18'));
  });

  it('ignores stale quarantine inspection responses when selection changes', async () => {
    let resolveFirst!: (value: { data: Record<string, unknown>[] }) => void;
    let resolveSecond!: (value: { data: Record<string, unknown>[] }) => void;
    listQuarantined.mockResolvedValue({ data: [
      { id: '18', origin: 'http', lineCount: 1, bytes: 42, error: 'invalid row', createdAt: '2026-11-03T10:00:00Z' },
      { id: '19', origin: 'fleet', lineCount: 1, bytes: 45, error: 'invalid row', createdAt: '2026-11-03T10:01:00Z' },
    ] });
    getQuarantined.mockImplementation((id: string) => new Promise((resolve) => {
      if (id === '18') resolveFirst = resolve;
      else resolveSecond = resolve;
    }));
    renderPage(<LogsHealthPage />);
    expect(await screen.findByText('1 lines · fleet · batch 19')).toBeInTheDocument();
    const inspectButtons = screen.getAllByRole('button', { name: 'Inspect' });
    fireEvent.click(inspectButtons[0]);
    fireEvent.click(inspectButtons[1]);
    await act(async () => resolveSecond({ data: [{ _msg: 'new selection' }] }));
    expect(await screen.findByText(/new selection/)).toBeInTheDocument();
    await act(async () => resolveFirst({ data: [{ _msg: 'stale selection' }] }));
    expect(screen.queryByText(/stale selection/)).not.toBeInTheDocument();
    expect(screen.getByText(/new selection/)).toBeInTheDocument();
  });

  it('allows another inspection after the first request fails', async () => {
    listQuarantined.mockResolvedValue({ data: [{
      id: '18', origin: 'http', lineCount: 1, bytes: 42, error: 'invalid row', createdAt: '2026-11-03T10:00:00Z',
    }] });
    getQuarantined.mockRejectedValueOnce(new Error('unavailable')).mockResolvedValueOnce({ data: [{ _msg: 'retained line' }] });
    renderPage(<LogsHealthPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText('Failed to inspect quarantined batch')).toBeInTheDocument();
    expect(screen.queryByText('Loading batch…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Inspect' }));
    expect(await screen.findByText(/retained line/)).toBeInTheDocument();
    expect(screen.queryByText('Failed to inspect quarantined batch')).not.toBeInTheDocument();
  });

  it('ignores an inspection still in flight when its batch is retried', async () => {
    let resolveInspection!: (value: { data: Record<string, unknown>[] }) => void;
    listQuarantined.mockResolvedValue({ data: [{
      id: '18', origin: 'http', lineCount: 1, bytes: 42, error: 'invalid row', createdAt: '2026-11-03T10:00:00Z',
    }] });
    getQuarantined.mockImplementation(() => new Promise((resolve) => { resolveInspection = resolve; }));
    renderPage(<LogsHealthPage />);
    fireEvent.click(await screen.findByRole('button', { name: 'Inspect' }));
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(retryQuarantined).toHaveBeenCalledWith('18'));
    await act(async () => resolveInspection({ data: [{ _msg: 'stale inspection' }] }));
    expect(screen.queryByText(/stale inspection/)).not.toBeInTheDocument();
    expect(screen.queryByText('Loading batch…')).not.toBeInTheDocument();
  });

  it('warns when uncertain store writes may have created duplicates', async () => {
    status.mockResolvedValue({ data: { ...storeStatus, write: { ...storeStatus.write, uncertainDeliveries24h: 2 } } });
    renderPage(<LogsHealthPage />);
    expect(await screen.findByText(/2 batches had uncertain store outcomes/)).toHaveTextContent('Duplicates may appear in search results and alert counts.');
  });

  it('warns when VictoriaLogs reports dropped rows', async () => {
    status.mockResolvedValue({ data: { ...storeStatus, metrics: { ...storeStatus.metrics, rowsDroppedTotal: 3 } } });
    renderPage(<LogsHealthPage />);
    expect(await screen.findByText('3 rows have been dropped by VictoriaLogs since its last restart.')).toBeInTheDocument();
  });

  it('reports explicitly discarded quarantine lines', async () => {
    status.mockResolvedValue({ data: { ...storeStatus, write: { ...storeStatus.write, discardedLines24h: 2 } } });
    renderPage(<LogsHealthPage />);
    expect(await screen.findByText('2 rejected log lines were explicitly discarded in the last 24 hours.')).toBeInTheDocument();
  });

  it('shows quiet observed sources and refreshes the selected inventory window', async () => {
    listSources.mockResolvedValue({ data: {
      windowDays: 7,
      sources: [{ sourceName: 'collector-a', sourceType: 'http', serviceType: 'robin', serviceId: 'r1', count: 8, lastSeen: new Date(Date.now() - 30 * 60_000).toISOString() }],
      truncated: false, limit: 200, quietAfterSeconds: 900,
    } });
    renderPage(<LogsSourcesPage />);
    expect(await screen.findByText('collector-a')).toBeInTheDocument();
    expect(screen.getByText('HTTP ingest')).toBeInTheDocument();
    const url = new URL(screen.getByRole('link', { name: 'collector-a' }).getAttribute('href')!, 'https://admin.example.test');
    expect(url.searchParams.get('source')).toBe('collector-a');
    expect(url.searchParams.get('service')).toBe('r1');
    expect(url.searchParams.get('range')).toBe('7d');
    expect(url.searchParams.get('q')).toBe('service_type:in("robin") source_type:in("http")');
    expect(screen.getAllByText('Quiet').length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Inventory window'), { target: { value: '30' } });
    await waitFor(() => expect(listSources).toHaveBeenLastCalledWith(30));
  });

  it('shows Fleet pipeline counters and warnings even when no lines reach the store', async () => {
    listSources.mockResolvedValue({ data: {
      windowDays: 7, sources: [], truncated: false, limit: 200, quietAfterSeconds: 900,
      pipelineStreams: [{
        serviceId: 'mx-quiet', serviceType: 'postfix', source: 'docker containers',
        capturedAt: new Date().toISOString(), lagCycles: 3,
        counters: { read: 100, excluded: 90, masked: 4, truncated: 2, rateLimited: 3, rateLimitedCurrent: 1, shipped: 7, bytesShipped: 2048, readLagMs: 120000 },
      }, {
        serviceId: 'mx-recovered', serviceType: 'postfix', source: 'docker containers',
        capturedAt: new Date().toISOString(), lagCycles: 0,
        counters: { read: 100, excluded: 0, masked: 0, truncated: 0, rateLimited: 3, rateLimitedCurrent: 0, shipped: 97, bytesShipped: 4096, readLagMs: 0 },
      }],
      pipelineStreamsTruncated: false,
    } });
    renderPage(<LogsSourcesPage />);
    expect(await screen.findByText('postfix · mx-quiet')).toBeInTheDocument();
    expect(screen.getByText('Rate-limited · Lagging for 3 cycles')).toBeInTheDocument();
    expect(screen.getByText('Healthy')).toBeInTheDocument();
    expect(screen.getByText('120.0s')).toBeInTheDocument();
    expect(screen.getByText('2,048')).toBeInTheDocument();
  });

  it('scopes source links by type, including legacy Fleet and unattributed rows', async () => {
    listSources.mockResolvedValue({ data: {
      windowDays: 7,
      sources: [
        { sourceName: 'collector, prod', sourceType: 'http', serviceType: 'external', serviceId: 'collector, prod', count: 2, lastSeen: null },
        { sourceName: 'collector, prod', sourceType: 'fleet', serviceType: 'external', serviceId: 'collector, prod', count: 3, lastSeen: null },
        { sourceName: 'Unknown source', sourceType: '', serviceType: '', serviceId: '', count: 1, lastSeen: null },
      ],
      truncated: false, limit: 200, quietAfterSeconds: 900,
    } });
    renderPage(<LogsSourcesPage />);
    const links = await screen.findAllByRole('link', { name: 'collector, prod' });
    const http = new URL(links[0].getAttribute('href')!, 'https://admin.example.test');
    const fleet = new URL(links[1].getAttribute('href')!, 'https://admin.example.test');
    const unknown = new URL(screen.getByRole('link', { name: 'Unknown source' }).getAttribute('href')!, 'https://admin.example.test');
    expect(http.searchParams.get('source')).toBe('collector, prod');
    expect(http.searchParams.get('service')).toBe('collector, prod');
    expect(http.searchParams.get('q')).toBe('service_type:in("external") source_type:in("http")');
    expect(fleet.searchParams.get('q')).toBe('service_type:in("external") (source_type:in("fleet") OR (source_name:"" agent_id:* service_id:*))');
    expect(unknown.searchParams.get('source')).toBeNull();
    expect(unknown.searchParams.get('q')).toBe('service_type:"" service_id:"" (source_type:"" NOT (source_name:"" agent_id:* service_id:*)) (source_name:"" OR source_name:in("Unknown source"))');
  });

  it('quotes source metadata when constructing a search link', async () => {
    const serviceType = 'external "quoted" | test\\host';
    listSources.mockResolvedValue({ data: {
      windowDays: 1,
      sources: [{ sourceName: 'collector', sourceType: 'http', serviceType, serviceId: 'service', count: 1, lastSeen: null }],
      truncated: false, limit: 200, quietAfterSeconds: 900,
    } });
    renderPage(<LogsSourcesPage />);
    const link = await screen.findByRole('link', { name: 'collector' });
    const url = new URL(link.getAttribute('href')!, 'https://admin.example.test');
    expect(url.searchParams.get('q')).toBe(`service_type:in(${JSON.stringify(serviceType)}) source_type:in("http")`);
  });

  it('keeps bounded control-character metadata within the search query limit', async () => {
    listSources.mockResolvedValue({ data: {
      windowDays: 1,
      sources: [{ sourceName: 'collector', sourceType: 'http', serviceType: '\u0001'.repeat(120), serviceId: 'service', count: 1, lastSeen: null }],
      truncated: false, limit: 200, quietAfterSeconds: 900,
    } });
    renderPage(<LogsSourcesPage />);
    const link = await screen.findByRole('link', { name: 'collector' });
    const url = new URL(link.getAttribute('href')!, 'https://admin.example.test');
    expect(url.searchParams.get('q')!.length).toBeLessThanOrEqual(1_000);
  });

  it('previews and creates a count-based Logs alert', async () => {
    renderPage(<LogsAlertsPage />);
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Repeated auth failures' } });
    fireEvent.change(screen.getByPlaceholderText('error, "connection refused", source:file…'), { target: { value: 'auth failed' } });
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    expect(await screen.findByText('7', { selector: 'strong' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create rule' }));
    await waitFor(() => expect(createAlertRule).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Repeated auth failures',
      query: 'auth failed',
      windowSeconds: 300,
      comparator: '>=',
      threshold: 1,
      forSeconds: 300,
      enabled: true,
    })));
  });

  it('warns when queued or uncertain delivery can affect alert counts', async () => {
    status.mockResolvedValue({ data: {
      ...storeStatus,
      write: { ...storeStatus.write, queuedLines: 2, uncertainBatches: 1 },
    } });
    renderPage(<LogsAlertsPage />);
    expect(await screen.findByText(/Queued, rejected, dropped, or discarded lines can make alert counts incomplete/)).toBeInTheDocument();
    expect(screen.getByText(/Retried lines may be counted more than once/)).toBeInTheDocument();
  });

  it('reports when delivery health cannot be loaded on the alerts page', async () => {
    status.mockRejectedValue(new Error('unavailable'));
    renderPage(<LogsAlertsPage />);
    expect(await screen.findByText(/Logs delivery health is unavailable/)).toBeInTheDocument();
  });
});
