import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { QueuePage } from './Queue';

const { list, getStats } = vi.hoisted(() => ({
  list: vi.fn(),
  getStats: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  queueApi: { list, getStats },
}));

vi.mock('../hooks/useAuth', () => ({ useCanEdit: () => true }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => async () => true }));
vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({ selectedRobinService: { serviceId: 'robin1', name: 'Robin', serviceType: 'robin' } }),
}));
vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));
vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const ITEM = {
  queueUid: 'q-1', state: 'DEAD', protocol: 'esmtp', retryCount: 3, createdEpoch: 0, lastError: 'boom',
};

describe('QueuePage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    list.mockResolvedValue({ data: [ITEM], pagination: { page: 1, totalPages: 1, total: 1 } });
    getStats.mockResolvedValue({ data: { total: 7, byState: { READY: 2, DEAD: 5 }, byProtocol: {} } });
  });

  it('filters by state with tabs that show per-state counts', async () => {
    render(<MemoryRouter><QueuePage /></MemoryRouter>);

    const dead = await screen.findByRole('button', { name: 'Dead (5)' });
    expect(screen.getByRole('button', { name: 'Ready (2)' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Claimed' })).toBeInTheDocument();

    fireEvent.click(dead);
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(1, 50, { state: 'DEAD', search: undefined }));
    expect(dead).toHaveAttribute('aria-pressed', 'true');
  });

  it('searches as you type, without a submit button', async () => {
    render(<MemoryRouter><QueuePage /></MemoryRouter>);
    await screen.findByText('q-1');
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument();

    fireEvent.change(screen.getByPlaceholderText('Queue or session ID'), { target: { value: 'sess-9' } });
    await waitFor(() => expect(list).toHaveBeenLastCalledWith(1, 50, { state: undefined, search: 'sess-9' }));
  });
});
