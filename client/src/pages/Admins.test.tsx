import { beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { AdminsPage } from './Admins';
const api = vi.hoisted(() => ({ list: vi.fn(), create: vi.fn(), revoke: vi.fn(), admins: vi.fn() }));
vi.mock('../api/client', () => ({ ApiError: class ApiError extends Error {}, apiKeysApi: api, adminsApi: { list: api.admins } }));
vi.mock('../hooks/useAuth', () => ({ useAuth: () => ({ user: { id: 1, role: 'admin' } }) }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => vi.fn() }));
vi.mock('./AdminNotifications', () => ({ AdminNotificationsPage: () => null }));
vi.mock('./AuditLog', () => ({ AuditLogPage: () => null }));
beforeEach(() => {
  cleanup(); vi.clearAllMocks(); localStorage.clear();
  api.list.mockResolvedValue({ success: true, data: [] });
  api.admins.mockResolvedValue({ success: true, data: [] });
  api.create.mockResolvedValue({ success: true, data: { plainText: 'synthetic-test-key' } });
});
it('opens the existing key manager with a write-only telemetry preset', async () => {
  localStorage.setItem('robin-admin.access.tab', 'admins');
  render(<MemoryRouter initialEntries={['/administration/access?tab=apiKeys&preset=telemetry']}><AdminsPage /></MemoryRouter>);
  const name = await screen.findByLabelText('Key name');
  await waitFor(() => expect(screen.getByLabelText('telemetry:write')).toBeChecked());
  expect(screen.getByLabelText('reports:read')).not.toBeChecked();
  fireEvent.change(name, { target: { value: 'Telemetry sender' } });
  fireEvent.click(screen.getByRole('button', { name: 'Create key' }));
  await waitFor(() => expect(api.create).toHaveBeenCalledWith(expect.objectContaining({ name: 'Telemetry sender', role: 'viewer', scopes: ['telemetry:write'] })));
  expect(await screen.findByText('synthetic-test-key')).toBeInTheDocument();
  expect(screen.getByLabelText('telemetry:write')).toBeChecked();
});
