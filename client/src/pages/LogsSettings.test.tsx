import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { LogsSettingsPage } from './LogsSettings';

const { configGet, configUpdate, configuration, status, refreshFeatures } = vi.hoisted(() => ({
  configGet: vi.fn(),
  configUpdate: vi.fn(),
  configuration: vi.fn(),
  status: vi.fn(),
  refreshFeatures: vi.fn(),
}));

vi.mock('../context/FeaturesContext', () => ({ useFeatures: () => ({ refresh: refreshFeatures }) }));
vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  configApi: { get: configGet, update: configUpdate },
  logsApi: { configuration, status },
}));

const config = {
  logsEnabled: true,
  logsSourceQuietAfterSeconds: 900,
  logsSourceLimit: 200,
  logsRequestTimeoutMs: 15000,
  logsIngestBodyLimitBytes: 8388608,
};

const storeStatus = {
  enabled: true,
  reachable: true,
  storageBytes: 2048,
  maxDiskBytes: 10737418240,
  retentionDays: 14,
  rowsIngested24h: 5,
  oldestLogAt: null,
  metrics: { rowsIngestedTotal: 5, bytesIngestedTotal: 100, rowsDroppedTotal: 0, streamsCreatedTotal: 1 },
  write: { queuedLines: 0, queuedBytes: 0, capacityBytes: 268435456, oldestQueuedAt: null, retryingBatches: 0, uncertainBatches: 0, uncertainDeliveries24h: 0, droppedLines24h: 0, rejectedLines24h: 0, discardedLines24h: 0, lastDeliveredAt: null, lastErrorAt: null, lastError: null },
};

function renderPage(tab = 'connection') {
  return render(<MemoryRouter initialEntries={[`/administration/logs?tab=${tab}`]}><LogsSettingsPage /></MemoryRouter>);
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  configGet.mockResolvedValue({ data: config });
  configUpdate.mockImplementation(async (updates: object) => ({ data: { ...config, ...updates } }));
  configuration.mockResolvedValue({ data: {
    enabled: true,
    storeUrl: 'http://logs:9428',
    retentionDays: 14,
    maxDiskBytes: 10737418240,
    sentryWebhookConfigured: false,
    endpoints: { ingest: '/api/logs/ingest', sentry: '/api/logs/sentry' },
  } });
  status.mockResolvedValue({ data: storeStatus });
});

describe('LogsSettingsPage', () => {
  it('shows the store connection and toggles collection', async () => {
    renderPage();
    expect(await screen.findByText('http://logs:9428')).toBeInTheDocument();
    expect(await screen.findByText('Reachable')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Enable logs' }));
    await waitFor(() => expect(configUpdate).toHaveBeenCalledWith({ logsEnabled: false }));
    expect(await screen.findByText('Logs disabled')).toBeInTheDocument();
    expect(refreshFeatures).toHaveBeenCalledOnce();
  });

  it('saves the source inventory policy', async () => {
    renderPage('policy');
    const quiet = await screen.findByLabelText('Quiet after (seconds)');
    fireEvent.change(quiet, { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(configUpdate).toHaveBeenCalledWith({
      logsSourceQuietAfterSeconds: 600,
      logsSourceLimit: 200,
      logsRequestTimeoutMs: 15000,
    }));
  });

  it('reports ingestion endpoints without exposing the Sentry secret', async () => {
    renderPage('ingestion');
    expect(await screen.findByText('POST /api/logs/ingest')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    expect(screen.getByLabelText('Maximum ingest request (bytes)')).toHaveValue(8388608);
  });

  it('shows deployment-managed retention and capacity', async () => {
    renderPage('storage');
    expect(await screen.findByText('14 days')).toBeInTheDocument();
    expect(screen.getByText('10 GB')).toBeInTheDocument();
  });

  it('preserves unsaved changes in another tab when saving', async () => {
    renderPage('policy');
    fireEvent.change(await screen.findByLabelText('Quiet after (seconds)'), { target: { value: '600' } });
    fireEvent.click(screen.getByRole('button', { name: 'Ingestion' }));
    fireEvent.change(screen.getByLabelText('Maximum ingest request (bytes)'), { target: { value: '1048576' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('Settings saved');
    fireEvent.click(screen.getByRole('button', { name: 'Policy' }));
    expect(screen.getByLabelText('Quiet after (seconds)')).toHaveValue(600);
    expect(screen.getByText(/You have unsaved settings/)).toBeInTheDocument();
  });
});
