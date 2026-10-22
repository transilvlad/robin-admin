import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { CyrusQuotaPanel, CyrusSessionsPanel } from './CyrusPanels';
import { denyCapabilities } from '../../test/capabilities';
const { getQuota, lookupUser, getSessions } = vi.hoisted(() => ({ getQuota: vi.fn(), lookupUser: vi.fn(), getSessions: vi.fn() }));
vi.mock('../../api/client', () => ({ ApiError: class extends Error { }, cyrusApi: { getQuota, lookupUser, getSessions } }));
const quota = { available: true, reason: null, rows: [{ root: 'user/happy@example.com', user: 'happy@example.com', storageUsedKiB: 15, storageLimitKiB: null, storagePercent: null, messages: 15, folders: 5 }] };
beforeEach(() => { cleanup(); vi.clearAllMocks(); });
describe('Cyrus operational panels', () => {
  it('loads quota roots, displaying KiB as storage and unlimited limits', async () => {
    getQuota.mockResolvedValue({ data: quota });
    render(<CyrusQuotaPanel serviceId="imap" />);
    fireEvent.click(screen.getByRole('button', { name: /Load quota/ }));
    expect(await screen.findByText('user/happy@example.com')).toBeInTheDocument();
    expect(screen.getByText('Unlimited')).toBeInTheDocument();
    expect(screen.getByText('15 KB')).toBeInTheDocument();
    expect(getQuota).toHaveBeenCalledWith('imap');
  });
  it('shows mailbox paths and missing users', async () => {
    lookupUser.mockResolvedValueOnce({ data: { user: 'happy@example.com', exists: true, fields: { path: '/mail/happy' }, quota } });
    render(<CyrusQuotaPanel serviceId="imap" />);
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'happy@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up$/ }));
    expect(await screen.findByText('/mail/happy')).toBeInTheDocument();
    expect(lookupUser).toHaveBeenCalledWith('imap', 'happy@example.com');
    lookupUser.mockResolvedValueOnce({ data: { user: 'nobody@example.com', exists: false, fields: {}, quota: null } });
    fireEvent.change(screen.getByPlaceholderText('user@example.com'), { target: { value: 'nobody@example.com' } });
    fireEvent.click(screen.getByRole('button', { name: /Look up$/ }));
    expect(await screen.findByText('nobody@example.com does not exist.')).toBeInTheDocument();
  });
  it('can hide user lookup independently of all-user quota', () => {
    denyCapabilities('user');
    render(<CyrusQuotaPanel serviceId="imap" canLookup={false} />);
    expect(screen.queryByPlaceholderText('user@example.com')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Load quota/ })).toBeInTheDocument();
  });
  it('reports agent errors and idle sessions', async () => {
    getSessions.mockRejectedValueOnce(new Error('Agent unavailable'));
    render(<CyrusSessionsPanel serviceId="imap" />);
    expect(await screen.findByText('Agent unavailable')).toBeInTheDocument();
    getSessions.mockResolvedValueOnce({ data: [] });
    fireEvent.click(screen.getByRole('button', { name: /Refresh/ }));
    expect(await screen.findByText('No active Cyrus sessions')).toBeInTheDocument();
  });
});
