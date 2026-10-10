import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { MariadbConfigPage } from './MariadbConfig';

const api = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getRenderedConfig: vi.fn(),
  getConfigScopes: vi.fn(),
  updateConfig: vi.fn(),
  resetConfig: vi.fn(),
  reapply: vi.fn(),
}));

vi.mock('../api/client', () => ({ ApiError: class ApiError extends Error {}, mariadbApi: api }));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedMariadbService: { serviceId: 'db1', name: 'Application DB', serviceType: 'mariadb' },
    mariadbServices: [{ serviceId: 'db1', name: 'Application DB', serviceType: 'mariadb' }],
  }),
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

describe('MariadbConfigPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    api.getConfigScopes.mockResolvedValue({ data: ['default'] });
    api.getConfig.mockResolvedValue({
      data: {
        serviceId: 'db1',
        serviceName: 'Application DB',
        managed: { maxConnections: 350, waitTimeout: null },
        live: { maxConnections: '350', waitTimeout: '3600' },
        flavor: 'mariadb',
        serverSettings: [{ name: 'innodb_buffer_pool_size', setting: '134217728' }],
      },
    });
    api.getRenderedConfig.mockResolvedValue({ data: { managed: 'SET GLOBAL max_connections = 350;' } });
  });

  it('shows the running value of an unmanaged variable and server-managed settings', async () => {
    render(<MemoryRouter><MariadbConfigPage /></MemoryRouter>);
    expect(await screen.findByPlaceholderText('Server: 3600')).toBeInTheDocument();
    expect(screen.getByText('innodb_buffer_pool_size')).toBeInTheDocument();
    expect(screen.getByText('134217728')).toBeInTheDocument();
  });

  it.each(['mariadb', 'mysql'])('shows only %s statement timeout settings on an instance', async (flavor) => {
    api.getConfig.mockResolvedValue({ data: { serviceId: 'db1', managed: {}, live: {}, flavor, serverSettings: [] } });
    render(<MemoryRouter><MariadbConfigPage /></MemoryRouter>);
    expect(await screen.findByText(flavor === 'mariadb' ? 'max_statement_time (s)' : 'max_execution_time (ms)')).toBeInTheDocument();
    expect(screen.queryByText(flavor === 'mariadb' ? 'max_execution_time (ms)' : 'max_statement_time (s)')).not.toBeInTheDocument();
  });
});
