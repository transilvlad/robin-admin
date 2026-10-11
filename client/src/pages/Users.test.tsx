import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { UsersPage } from './Users';

const { schema, list, create } = vi.hoisted(() => ({ schema: vi.fn(), list: vi.fn(), create: vi.fn() }));
vi.mock('../api/client', async importOriginal => ({
  ...await importOriginal<typeof import('../api/client')>(),
  usersApi: { schema, list, create },
}));
vi.mock('../hooks/useAuth', () => ({ useCanEdit: () => true }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  schema.mockResolvedValue({ data: { columns: ['id', 'email'], knownOptional: [], extraColumns: [] } });
  list.mockResolvedValue({ data: [], pagination: { total: 0, totalPages: 1 } });
  create.mockResolvedValue({ success: true });
});
afterEach(cleanup);

describe('schema-aware mailbox forms', () => {
  it('does not offer or send UID/GID when the backend has no such columns', async () => {
    render(<MemoryRouter><UsersPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add user' }));
    expect(screen.queryByRole('spinbutton', { name: 'UID' })).not.toBeInTheDocument();
    expect(screen.queryByRole('spinbutton', { name: 'GID' })).not.toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testPassword123' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('person@example.test', 'testPassword123', undefined, undefined));
  });

  it('preserves zero values for supported UID/GID columns', async () => {
    schema.mockResolvedValue({ data: { columns: ['id', 'email', 'uid', 'gid'], knownOptional: ['uid', 'gid'], extraColumns: [] } });
    render(<MemoryRouter><UsersPage /></MemoryRouter>);
    fireEvent.click(await screen.findByRole('button', { name: 'Add user' }));
    fireEvent.change(screen.getByLabelText('Email'), { target: { value: 'person@example.test' } });
    fireEvent.change(screen.getByLabelText('Password'), { target: { value: 'testPassword123' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'UID' }), { target: { value: '0' } });
    fireEvent.change(screen.getByRole('spinbutton', { name: 'GID' }), { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create user' }));
    await waitFor(() => expect(create).toHaveBeenCalledWith('person@example.test', 'testPassword123', 0, 0));
  });
});
