import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { DovecotSharingPanel } from './DovecotSharingPanel';

const { getAcl, setAcl, deleteAcl, confirm } = vi.hoisted(() => ({
  getAcl: vi.fn(), setAcl: vi.fn(), deleteAcl: vi.fn(), confirm: vi.fn(),
}));
vi.mock('../../api/client', () => ({ dovecotApi: { getAcl, setAcl, deleteAcl } }));
vi.mock('../../context/ConfirmContext', () => ({ useConfirm: () => confirm }));

const state = {
  owner: 'owner@example.test', mailbox: 'INBOX',
  entries: [{ identifier: 'user=member@example.test', global: false, rights: ['lookup', 'read'] }],
};

function fill() {
  fireEvent.change(screen.getByLabelText('Owner address'), { target: { value: state.owner } });
  fireEvent.change(screen.getByLabelText('Member address'), { target: { value: 'member@example.test' } });
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  confirm.mockResolvedValue(true);
  getAcl.mockResolvedValue({ data: state });
  setAcl.mockResolvedValue({ data: { ...state, applied: true } });
  deleteAcl.mockResolvedValue({ data: { ...state, entries: [], applied: true } });
});

describe('Dovecot sharing', () => {
  it('shows backend readback and clears it when the target changes', async () => {
    render(<DovecotSharingPanel serviceId="dc1" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Read ACL' }));
    expect(await screen.findByText('user=member@example.test')).toBeInTheDocument();
    expect(getAcl).toHaveBeenCalledWith('dc1', state.owner, 'INBOX');
    fireEvent.change(screen.getByLabelText('Mailbox'), { target: { value: 'Other' } });
    expect(screen.queryByText('user=member@example.test')).not.toBeInTheDocument();
  });

  it('confirms changes separately from send-as and verifies applied status', async () => {
    render(<DovecotSharingPanel serviceId="dc1" />);
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Set member ACL' }));
    expect(await screen.findByRole('status')).toHaveTextContent('confirmed by backend readback');
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('does not grant send-as'));
    expect(setAcl).toHaveBeenCalledWith('dc1', state.owner, 'INBOX', 'member@example.test', ['lookup', 'read']);
    fireEvent.click(screen.getByRole('button', { name: 'Remove member ACL' }));
    expect(await screen.findByText('No explicit ACL entries returned.')).toBeInTheDocument();
    expect(deleteAcl).toHaveBeenCalledWith('dc1', state.owner, 'INBOX', 'member@example.test');
  });

  it('does not dispatch a declined change or imply success for unconfirmed replies', async () => {
    render(<DovecotSharingPanel serviceId="dc1" />);
    fill();
    confirm.mockResolvedValueOnce(false);
    fireEvent.click(screen.getByRole('button', { name: 'Set member ACL' }));
    await vi.waitFor(() => expect(screen.getByRole('button', { name: 'Set member ACL' })).toBeEnabled());
    expect(setAcl).not.toHaveBeenCalled();
    setAcl.mockResolvedValueOnce({ data: state });
    fireEvent.click(screen.getByRole('button', { name: 'Set member ACL' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('not confirmed');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});
