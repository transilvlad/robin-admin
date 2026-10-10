import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ModuleHostPolicies } from './ModuleHostPolicies';
import { modulePolicyApi } from '../../api/client';
vi.mock('../../api/client', () => ({ modulePolicyApi: { get: vi.fn(), save: vi.fn() } }));
const policy = { slug: 'example', directoryRead: false, lifecycleRead: false, maxBodyMiB: 5, timeoutSeconds: 30 };
afterEach(cleanup);
const renderPolicies = (disabled: boolean) => render(<MemoryRouter><ModuleHostPolicies disabled={disabled} /></MemoryRouter>);
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(modulePolicyApi.get).mockResolvedValue({ success: true, data: { policies: [policy], trust: { issuer: 'urn:test:admin', keys: [] } } });
  vi.mocked(modulePolicyApi.save).mockImplementation(async value => ({ success: true, data: value }));
});
it('loads defaults and saves opt-in capabilities with resource bounds', async () => {
  renderPolicies(false);
  const directory = await screen.findByLabelText('Admin directory');
  expect(directory).not.toBeChecked();
  fireEvent.click(directory);
  fireEvent.change(screen.getByLabelText('Maximum body (MiB)'), { target: { value: '12' } });
  fireEvent.click(screen.getByRole('button', { name: 'Save policy for example' }));
  await waitFor(() => expect(modulePolicyApi.save).toHaveBeenCalledWith({ ...policy, directoryRead: true, maxBodyMiB: 12 }));
});
it('shows a save failure without reporting success', async () => {
  vi.mocked(modulePolicyApi.save).mockRejectedValue(new Error('Save refused'));
  renderPolicies(false);
  fireEvent.click(await screen.findByRole('button', { name: 'Save policy for example' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Save refused');
});
it('does not request privileged directory policy for non-admins', () => {
  renderPolicies(true);
  expect(modulePolicyApi.get).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: 'Download identity public keys' })).toBeDisabled();
});

it('links the trust download to the security rotation workflow', async () => {
  renderPolicies(false);
  expect(await screen.findByRole('link', { name: 'Manage signing-key rotation' })).toHaveAttribute('href', '/administration/security?tab=identity');
});
