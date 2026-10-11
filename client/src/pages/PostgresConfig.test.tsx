import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PostgresConfigPage } from './PostgresConfig';

const { getConfig, getStatus, getRenderedConfig, updateConfig, reload } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getStatus: vi.fn(),
  getRenderedConfig: vi.fn(),
  updateConfig: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  postgresApi: { getConfig, getStatus, getRenderedConfig, updateConfig, reload },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedPostgresService: { serviceId: 'pg1', name: 'Postgres 1', serviceType: 'postgres' },
    postgresServices: [{ serviceId: 'pg1', name: 'Postgres 1', serviceType: 'postgres' }],
  }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const MANAGED = {
  workMem: '4MB',
  maintenanceWorkMem: '64MB',
  effectiveCacheSize: '4GB',
  logMinDurationStatement: 1000,
  statementTimeout: 0,
  idleInTransactionSessionTimeout: 0,
  autovacuum: true,
  autovacuumVacuumScaleFactor: 0.2,
  autovacuumAnalyzeScaleFactor: 0.1,
  autovacuumNaptime: 60,
  checkpointTimeout: 300,
  maxWalSize: '1GB',
  minWalSize: '80MB',
  randomPageCost: 4,
  defaultStatisticsTarget: 100,
  logConnections: false,
  logDisconnections: false,
};

describe('PostgresConfigPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getConfig.mockResolvedValue({
      data: { serviceId: 'pg1', serviceName: 'Postgres 1', managed: MANAGED, restartRequired: [] },
    });
    getStatus.mockResolvedValue({ data: { serviceId: 'pg1', serviceName: 'Postgres 1', reachable: true, managed: MANAGED, metrics: null } });
    getRenderedConfig.mockResolvedValue({ data: { managed: 'work_mem = 4MB' } });
  });

  it('renders the managed config form loaded from the API', async () => {
    render(<MemoryRouter><PostgresConfigPage /></MemoryRouter>);

    expect(await screen.findByText('Postgres config')).toBeInTheDocument();
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith('pg1'));
    expect(await screen.findByDisplayValue('4MB')).toBeInTheDocument();
    await waitFor(() => expect(getRenderedConfig).toHaveBeenCalledWith('pg1'));
  });

  it('shows a warning banner for settings pending a restart', async () => {
    getConfig.mockResolvedValue({
      data: {
        serviceId: 'pg1',
        serviceName: 'Postgres 1',
        managed: MANAGED,
        restartRequired: [{ name: 'shared_buffers', setting: '256MB', unit: null, pendingRestart: true }],
      },
    });

    render(<MemoryRouter><PostgresConfigPage /></MemoryRouter>);

    expect(await screen.findByText('Restart required')).toBeInTheDocument();
    expect(screen.getByText('shared_buffers')).toBeInTheDocument();
  });
});
