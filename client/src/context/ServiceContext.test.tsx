import { act, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ServiceProvider, useServices } from './ServiceContext';

const { authState, listEnabledMock } = vi.hoisted(() => ({
  authState: { isAuthenticated: false, isLoading: false },
  listEnabledMock: vi.fn(),
}));

vi.mock('./AuthContext', () => ({
  useAuth: () => authState,
}));

vi.mock('../api/client', () => ({
  fleetServicesApi: {
    listEnabled: listEnabledMock,
  },
}));

const services = [
  {
    id: 1,
    serviceId: 'robin-main',
    serviceType: 'robin',
    name: 'Robin Main',
    description: null,
    apiUrl: 'http://robin:8090',
    healthUrl: null,
    metricsUrl: null,
    controllerUrl: null,
    normalUrl: null,
    enabled: true,
    createdAt: '2024-01-01T00:00:00.000Z',
    updatedAt: '2024-01-01T00:00:00.000Z',
  },
  {
    id: 2,
    serviceId: 'rspamd-main',
    serviceType: 'rspamd',
    name: 'Rspamd Main',
    description: null,
    apiUrl: 'http://rspamd:11333',
    healthUrl: null,
    metricsUrl: null,
    controllerUrl: null,
    normalUrl: null,
    enabled: true,
    createdAt: '2024-01-02T00:00:00.000Z',
    updatedAt: '2024-01-02T00:00:00.000Z',
  },
  {
    id: 3,
    serviceId: 'clamav-main',
    serviceType: 'clamav',
    name: 'ClamAV Main',
    description: null,
    apiUrl: 'http://clamav:3310',
    healthUrl: null,
    metricsUrl: null,
    controllerUrl: null,
    normalUrl: null,
    enabled: true,
    createdAt: '2024-01-03T00:00:00.000Z',
    updatedAt: '2024-01-03T00:00:00.000Z',
  },
];

function SelectionProbe() {
  const context = useServices();
  return (
    <div>
      <span data-testid="loading">{String(context.isLoading)}</span>
      <span data-testid="robin">{context.selectedRobinService?.serviceId ?? 'none'}</span>
      <span data-testid="rspamd">{context.selectedRspamdService?.serviceId ?? 'none'}</span>
      <span data-testid="clamav">{context.selectedClamavService?.serviceId ?? 'none'}</span>
    </div>
  );
}

describe('ServiceProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    authState.isAuthenticated = false;
    authState.isLoading = false;
    listEnabledMock.mockResolvedValue({ data: services });
  });

  it('loads services after login and selects the first enabled service of each type', async () => {
    const view = render(
      <ServiceProvider>
        <SelectionProbe />
      </ServiceProvider>,
    );

    expect(listEnabledMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('robin')).toHaveTextContent('none');

    authState.isAuthenticated = true;
    await act(async () => view.rerender(
      <ServiceProvider>
        <SelectionProbe />
      </ServiceProvider>,
    ));

    await waitFor(() => {
      expect(screen.getByTestId('loading')).toHaveTextContent('false');
      expect(screen.getByTestId('robin')).toHaveTextContent('robin-main');
      expect(screen.getByTestId('rspamd')).toHaveTextContent('rspamd-main');
      expect(screen.getByTestId('clamav')).toHaveTextContent('clamav-main');
    });
    expect(listEnabledMock).toHaveBeenCalledTimes(1);
  });
});
