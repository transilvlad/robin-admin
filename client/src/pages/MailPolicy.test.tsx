import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MailPolicyPage } from './MailPolicy';

const { status, domains, grants, saveDomain, saveGrant, isAdmin } = vi.hoisted(() => ({
  status: vi.fn(), domains: vi.fn(), grants: vi.fn(), saveDomain: vi.fn(), saveGrant: vi.fn(), isAdmin: vi.fn(),
}));
vi.mock('../api/client', () => ({ mailPolicyApi: { status, domains, grants, saveDomain, saveGrant } }));
vi.mock('../hooks/useAuth', () => ({ useIsAdmin: isAdmin }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  isAdmin.mockReturnValue(true);
  status.mockResolvedValue({ data: { available: true } });
  domains.mockResolvedValue({ data: [], pagination: { total: 0 } });
  grants.mockResolvedValue({ data: [], pagination: { total: 0 } });
  saveDomain.mockResolvedValue({ success: true });
  saveGrant.mockResolvedValue({ success: true });
});
afterEach(cleanup);
const show = () => render(<MemoryRouter><MailPolicyPage /></MemoryRouter>);

describe('mail policy controls', () => {
  it('does not offer writes when the external schema is absent', async () => {
    status.mockResolvedValue({ data: { available: false } });
    show();
    expect(await screen.findByText(/schema is not installed/)).toBeInTheDocument();
    expect(domains).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Save sender grant' })).not.toBeInTheDocument();
  });

  it('defaults catch-all and plus addressing off and saves explicit policy', async () => {
    show();
    const input = await screen.findByLabelText('Domain');
    expect(screen.getByLabelText('Allow plus addressing')).not.toBeChecked();
    expect(screen.getByLabelText('Catch-all local mailbox (blank disables)')).toHaveValue('');
    fireEvent.change(input, { target: { value: 'example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save domain policy' }));
    await waitFor(() => expect(saveDomain).toHaveBeenCalledWith({ domain: 'example.test', enabled: true, plus_addressing: false, catch_all: null }));
  });

  it('keeps sending grants separate from IMAP ACL and hides writes from viewers', async () => {
    isAdmin.mockReturnValue(false);
    show();
    expect(await screen.findByText(/do not grant IMAP mailbox access/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save domain policy' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save sender grant' })).not.toBeInTheDocument();
  });

  it('surfaces backend errors without closing or clearing the input', async () => {
    saveGrant.mockRejectedValue(new Error('Grant requires an existing account'));
    show();
    fireEvent.change(await screen.findByLabelText('Authenticated account'), { target: { value: 'a@example.test' } });
    fireEvent.change(screen.getByLabelText('Allowed sender address'), { target: { value: 'a@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save sender grant' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Grant requires an existing account');
    expect(screen.getByLabelText('Authenticated account')).toHaveValue('a@example.test');
  });
});
