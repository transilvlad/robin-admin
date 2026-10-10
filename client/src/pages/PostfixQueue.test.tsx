import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PostfixQueuePage } from './PostfixQueue';
import { denyCapabilities } from '../test/capabilities';

const { getQueue, flushQueue, queueAction } = vi.hoisted(() => ({
  getQueue: vi.fn(),
  flushQueue: vi.fn(),
  queueAction: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  postfixApi: { getQueue, flushQueue, queueAction },
}));

vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => async () => true }));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({ selectedPostfixService: { serviceId: 'pf1', name: 'PF', serviceType: 'postfix' } }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const MESSAGE = {
  queueId: '4F1A2B3C4D', queueName: 'deferred', arrivalTime: null, size: 2048, sender: 'a@example.com',
  recipients: [{ address: 'b@example.org', delayReason: 'connect timed out' }], forcedExpire: false,
};

describe('PostfixQueuePage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getQueue.mockResolvedValue({ data: [MESSAGE] });
    flushQueue.mockResolvedValue({ data: { response: '' } });
    queueAction.mockResolvedValue({ data: { response: 'postsuper: Deleted: 1 message' } });
  });

  it('lists the queue, flushes, and deletes through the agent', async () => {
    render(<MemoryRouter><PostfixQueuePage /></MemoryRouter>);

    expect(await screen.findByText('4F1A2B3C4D')).toBeInTheDocument();
    expect(screen.getByText('connect timed out')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Flush queue/ }));
    await vi.waitFor(() => expect(flushQueue).toHaveBeenCalledWith('pf1'));
    // The panel re-lists the queue after a flush.
    await vi.waitFor(() => expect(getQueue).toHaveBeenCalledTimes(2));

    fireEvent.click(await screen.findByTitle('Delete'));
    await vi.waitFor(() => expect(queueAction).toHaveBeenCalledWith('pf1', 'delete', ['4F1A2B3C4D']));
  });

  it('lists nothing when no service here can run the queue browser', async () => {
    denyCapabilities('postfixQueue', 'flush');
    render(<MemoryRouter><PostfixQueuePage /></MemoryRouter>);

    expect(await screen.findByText(/No enabled Postfix service/)).toBeInTheDocument();
    expect(getQueue).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Flush queue/ })).not.toBeInTheDocument();
  });
});
