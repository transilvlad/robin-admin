import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfirmProvider } from '../context/ConfirmContext';
import { LogsSearchPage } from './LogsSearch';

const { search, status, listServices, listSavedSearches, createSavedSearch, deleteSavedSearch } = vi.hoisted(() => ({
  search: vi.fn(),
  status: vi.fn(),
  listServices: vi.fn(),
  listSavedSearches: vi.fn(),
  createSavedSearch: vi.fn(),
  deleteSavedSearch: vi.fn(),
}));

vi.mock('../api/client', () => ({
  logsApi: { search, status, listSavedSearches, createSavedSearch, deleteSavedSearch },
  fleetServicesApi: { list: listServices },
}));

const healthy = {
  enabled: true,
  reachable: true,
  storageBytes: 2048,
  write: { queuedLines: 0, queuedBytes: 0, capacityBytes: 268435456, oldestQueuedAt: null, retryingBatches: 0, uncertainBatches: 0, uncertainDeliveries24h: 0, droppedLines24h: 0, rejectedLines24h: 0, discardedLines24h: 0, lastDeliveredAt: null, lastErrorAt: null, lastError: null },
};

function renderPage(path = '/logs') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <ConfirmProvider>
        <LogsSearchPage />
      </ConfirmProvider>
    </MemoryRouter>,
  );
}

describe('LogsSearchPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    status.mockResolvedValue({ data: healthy });
    listServices.mockResolvedValue({ data: [{ serviceId: 'suite-dovecot', name: 'Suite Mailbox', serviceType: 'dovecot' }] });
    listSavedSearches.mockResolvedValue({ data: [] });
    search.mockResolvedValue({ data: { rows: [], limit: 200, truncated: false, query: '*' } });
  });

  it('searches the deep-linked service and shows rows with service names', async () => {
    search.mockResolvedValue({ data: {
      rows: [{ time: '2026-11-03T10:00:00Z', serviceType: 'dovecot', serviceId: 'suite-dovecot', source: 'file', sourceType: 'fleet', sourceName: 'suite-dovecot', severity: '', host: '', environment: '', eventId: '', receivedAt: '', message: 'auth failed for bob' }],
      limit: 200,
      truncated: true,
      query: '',
    } });

    renderPage('/logs?service=suite-dovecot&source=collector&q=auth');

    expect(await screen.findByText('auth failed for bob')).toBeInTheDocument();
    expect(await screen.findByText('Suite Mailbox', { selector: 'td' })).toBeInTheDocument();
    expect(screen.getByText(/showing the newest 200/)).toBeInTheDocument();
    expect(search).toHaveBeenCalledWith(expect.objectContaining({ serviceIds: ['suite-dovecot'], sourceNames: ['collector'], q: 'auth', limit: 200 }));
    const { start, end } = search.mock.calls[0][0];
    expect(end - start).toBe(3600);
  });

  it('runs the typed filter on submit', async () => {
    renderPage();
    await waitFor(() => expect(search).toHaveBeenCalledTimes(1));

    fireEvent.change(screen.getByLabelText('Log filter'), { target: { value: 'error OR warn' } });
    fireEvent.change(screen.getByLabelText('Source name'), { target: { value: 'collector' } });
    expect(search).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: /Search/ }));

    await waitFor(() => expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      q: 'error OR warn',
      sourceNames: ['collector'],
    })));
  });

  it('displays an external service filter even when it is not registered in Fleet', async () => {
    renderPage('/logs?service=checkout&source=collector');

    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({
      serviceIds: ['checkout'], sourceNames: ['collector'],
    })));
    expect(screen.getByLabelText('Service')).toHaveValue('checkout');
    expect(screen.getByRole('option', { name: 'checkout' })).toBeInTheDocument();
  });

  it('preserves an exact source link with comma-containing names and type filters', async () => {
    const params = new URLSearchParams({
      source: 'collector, prod',
      service: 'checkout, api',
      q: 'service_type:in("external") source_type:in("http")',
      range: '7d',
    });
    renderPage(`/logs?${params}`);

    await waitFor(() => expect(search).toHaveBeenCalledWith(expect.objectContaining({
      serviceIds: ['checkout, api'],
      sourceNames: ['collector, prod'],
      q: 'service_type:in("external") source_type:in("http")',
    })));
    expect(screen.getByLabelText('Source name')).toHaveValue('collector, prod');
    expect(screen.getByLabelText('Log filter')).toHaveValue('service_type:in("external") source_type:in("http")');
  });

  it('shows search errors and an unreachable store', async () => {
    status.mockResolvedValue({ data: { ...healthy, reachable: false, storageBytes: null, error: 'Logs store is unreachable' } });
    search.mockRejectedValue(new Error('Logs store is unavailable'));

    renderPage();

    expect(await screen.findByText('Logs store is unavailable')).toBeInTheDocument();
    expect(await screen.findByText(/new lines are queued while capacity remains/)).toBeInTheDocument();
  });

  it('warns when recent uncertain writes could affect search and alert counts', async () => {
    status.mockResolvedValue({ data: { ...healthy, write: { ...healthy.write, uncertainDeliveries24h: 1 } } });
    renderPage();
    expect(await screen.findByText(/Retried lines may appear more than once/)).toBeInTheDocument();
  });

  it('warns that results may be incomplete while lines are queued without an error', async () => {
    status.mockResolvedValue({ data: { ...healthy, write: { ...healthy.write, queuedLines: 2 } } });
    renderPage();
    expect(await screen.findByText('2 lines are waiting to be stored. Search results may be incomplete.')).toBeInTheDocument();
  });

  it('applies a shared saved search and saves the active relative query', async () => {
    listSavedSearches.mockResolvedValue({ data: [{
      id: 8,
      name: 'Auth failures',
      description: null,
      filters: { query: 'auth failed', serviceId: 'suite-dovecot', sourceName: 'collector', rangePreset: '6h' },
      createdBy: 'Admin',
      createdAt: '2026-11-03T10:00:00Z',
      updatedAt: '2026-11-03T10:00:00Z',
    }] });
    createSavedSearch.mockResolvedValue({ data: { id: 9, name: 'Current auth search' } });

    renderPage();
    const savedSearch = await screen.findByRole('option', { name: 'Auth failures' });
    fireEvent.change(screen.getByLabelText('Apply a saved search'), { target: { value: savedSearch.getAttribute('value') } });
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(expect.objectContaining({
      q: 'auth failed',
      serviceIds: ['suite-dovecot'],
      sourceNames: ['collector'],
    })));

    fireEvent.click(screen.getByRole('button', { name: /Save as shared search/ }));
    fireEvent.change(screen.getByLabelText('Saved search name'), { target: { value: 'Current auth search' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(createSavedSearch).toHaveBeenCalledWith({
      name: 'Current auth search',
      description: null,
      filters: { query: 'auth failed', serviceId: 'suite-dovecot', sourceName: 'collector', rangePreset: '6h' },
    }));
  });

  it('runs and deletes saved searches from the inline manager', async () => {
    listSavedSearches.mockResolvedValue({ data: [{
      id: 8,
      name: 'Auth failures',
      description: null,
      filters: { query: 'auth failed', serviceId: '', sourceName: '', rangePreset: '6h' },
      createdBy: 'Admin',
      createdAt: '2026-11-03T10:00:00Z',
      updatedAt: '2026-11-03T10:00:00Z',
    }] });
    deleteSavedSearch.mockResolvedValue({ success: true });

    renderPage();
    fireEvent.click(await screen.findByRole('button', { name: /Manage \(1\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Run Auth failures' }));
    await waitFor(() => expect(search).toHaveBeenLastCalledWith(expect.objectContaining({ q: 'auth failed' })));
    const { start, end } = search.mock.calls[search.mock.calls.length - 1][0];
    expect(end - start).toBe(6 * 3600);

    fireEvent.click(screen.getByRole('button', { name: 'Delete Auth failures' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));
    await waitFor(() => expect(deleteSavedSearch).toHaveBeenCalledWith(8));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Run Auth failures' })).not.toBeInTheDocument());
    expect(screen.getByText('No saved searches yet')).toBeInTheDocument();
  });
});
