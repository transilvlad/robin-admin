import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { agentDeploymentTarget, AgentsPage } from './Agents';

const api = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn(), create: vi.fn() }));
vi.mock('../api/client', () => ({ ApiError: class ApiError extends Error {}, agentsApi: api, configApi: api, fleetServicesApi: {} }));
vi.mock('../context/ConfirmContext', () => ({ useConfirm: () => vi.fn() }));
const scrollDescriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
const settings = {
  agentImage: 'registry.example.test/agent:pinned',
  agentInstallUrl: 'https://downloads.example.test/install.sh',
  agentReleaseUrl: 'https://downloads.example.test/releases',
  agentDeployGuideUrl: 'https://docs.example.test/agent',
};
beforeEach(() => {
  cleanup(); vi.clearAllMocks();
  vi.stubEnv('BASE_URL', '/admin/');
  Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', { configurable: true, value: vi.fn() });
  api.list.mockResolvedValue({ data: [] });
  api.get.mockResolvedValue({ data: settings });
  api.create.mockResolvedValue({ data: { agent: { agentId: 'test-agent', name: 'Worker', status: 'pending' }, enrollment: { token: 'local-test-token', expiresAt: new Date(Date.now() + 60000).toISOString() } } });
});
afterEach(() => {
  cleanup(); vi.unstubAllEnvs();
  if (scrollDescriptor) Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollDescriptor);
  else Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
});

it.each(['https://admin.example.test', 'https://localhost.example.test', 'https://admin.example.test:443'])('keeps TLS verification for %s and retains the application prefix', origin => {
  expect(agentDeploymentTarget(origin, '/admin/')).toEqual({ url: new URL('/admin', origin).href, insecure: false });
});
it.each(['https://localhost:3443', 'https://127.0.0.1:3443', 'https://[::1]:3443'])('limits the local certificate exception to %s', origin => {
  expect(agentDeploymentTarget(origin, '/')).toEqual({ url: origin, insecure: true });
});
it('does not issue enrollment tokens or use frontend defaults when settings are missing', async () => {
  api.get.mockResolvedValue({});
  render(<AgentsPage />);
  await screen.findByRole('alert');
  fireEvent.change(screen.getByPlaceholderText('Agent name'), { target: { value: 'Worker' } });
  expect(screen.getByRole('button', { name: 'Create agent' })).toBeDisabled();
  fireEvent.keyDown(screen.getByPlaceholderText('Agent name'), { key: 'Enter' });
  expect(api.create).not.toHaveBeenCalled();
});
it('uses saved artifacts and the deployed prefix for enrollment commands', async () => {
  render(<AgentsPage />);
  fireEvent.change(screen.getByPlaceholderText('Agent name'), { target: { value: 'Worker' } });
  await waitFor(() => expect(screen.getByRole('button', { name: 'Create agent' })).toBeEnabled());
  fireEvent.click(screen.getByRole('button', { name: 'Create agent' }));
  const snippet = await screen.findByText(/docker run -d/, { selector: 'pre' });
  expect(snippet).toHaveTextContent(`ROBIN_ADMIN_URL=${window.location.origin}/admin`);
  expect(snippet).toHaveTextContent(settings.agentImage);
  expect(snippet).not.toHaveTextContent('ghcr.io/transilvlad');
  expect(screen.getByRole('link', { name: /Deployment guide/ })).toHaveAttribute('href', settings.agentDeployGuideUrl);
  fireEvent.click(screen.getByRole('button', { name: 'systemd' }));
  expect(await screen.findByText(/curl -fsSL/, { selector: 'pre' })).toHaveTextContent(settings.agentInstallUrl);
});
