import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { FleetPage } from './Fleet';
import { ConfirmProvider } from '../context/ConfirmContext';

function renderPage() {
  return render(<MemoryRouter><ConfirmProvider><FleetPage /></ConfirmProvider></MemoryRouter>);
}

const {
  listServices,
  serviceHealth,
  createService,
  updateService,
  deleteService,
  refreshServices,
} = vi.hoisted(() => ({
  listServices: vi.fn(),
  serviceHealth: vi.fn(),
  createService: vi.fn(),
  updateService: vi.fn(),
  deleteService: vi.fn(),
  refreshServices: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string) {
      super(message);
    }
  },
  fleetServicesApi: {
    list: listServices,
    health: serviceHealth,
    create: createService,
    update: updateService,
    delete: deleteService,
  },
}));

vi.mock('../components/ui/Button', () => ({
  Button: ({ children, onClick, type = 'button', disabled, isLoading, variant, size }: any) => (
    <button type={type} onClick={onClick} disabled={disabled || isLoading} data-variant={variant} data-size={size}>
      {children}
    </button>
  ),
}));

vi.mock('../components/ui/PageHeader', () => ({
  PageHeader: ({ title, description, actions }: any) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
      <div>{actions}</div>
    </div>
  ),
}));

vi.mock('../constants/appIcons', () => ({
  appIcons: new Proxy({}, { get: () => () => null }),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: { role: 'admin' },
  }),
}));

vi.mock('../context/FeaturesContext', () => ({
  useFeatures: () => ({ features: { telemetry: true }, isLoading: false, capabilitiesSettled: true, refresh: async () => undefined }),
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    refreshServices,
  }),
}));

describe('FleetPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();

    listServices.mockResolvedValue({
      data: [
        {
          id: 1,
          serviceId: 'robin-primary',
          serviceType: 'robin',
          name: 'Primary Robin',
          description: null,
          apiUrl: 'http://robin.example:8080',
          healthUrl: null,
          metricsUrl: 'http://robin.example:8080',
          controllerUrl: null,
          normalUrl: null,
          telemetrySource: 'node-a',
          enabled: true,
        },
        {
          id: 2,
          serviceId: 'rspamd-primary',
          serviceType: 'rspamd',
          name: 'Primary Rspamd',
          description: null,
          apiUrl: 'http://rspamd.example:11333',
          healthUrl: null,
          metricsUrl: 'http://rspamd.example:11334',
          controllerUrl: 'http://rspamd.example:11334',
          normalUrl: 'http://rspamd.example:11333',
          enabled: true,
        },
      ],
    });
    serviceHealth.mockResolvedValue({ data: { healthy: true } });
    createService.mockResolvedValue({ data: null });
    updateService.mockResolvedValue({ data: null });
    deleteService.mockResolvedValue({ data: null });
  });

  it('shows only service-specific endpoints and trims the add-service form per service type', async () => {
    renderPage();

    expect(await screen.findByText('Primary Robin')).toBeInTheDocument();
    expect(screen.getByText('Controller')).toBeInTheDocument();
    expect(screen.getByText('Worker')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /add service/i }));

    expect(screen.getByLabelText('API URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Metrics URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('Health URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Controller URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Normal worker URL')).not.toBeInTheDocument();

    fireEvent.change(screen.getByLabelText('Service type'), { target: { value: 'rspamd' } });

    expect(screen.getByLabelText('Controller URL')).toBeInTheDocument();
    expect(screen.getByLabelText('Normal worker URL')).toBeInTheDocument();
    expect(screen.queryByLabelText('API URL')).not.toBeInTheDocument();
    expect(screen.queryByLabelText('Metrics URL')).not.toBeInTheDocument();
  });

  it('lets operators change the external service id while editing a fleet service', async () => {
    renderPage();

    expect(await screen.findByText('Primary Rspamd')).toBeInTheDocument();

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[1]);
    fireEvent.change(screen.getByLabelText('Service ID'), { target: { value: 'rspamd-edge' } });
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Rspamd Edge' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(updateService).toHaveBeenCalledWith('rspamd-primary', expect.objectContaining({
      serviceId: 'rspamd-edge',
      name: 'Rspamd Edge',
    }));
  });

  it('links a service to scoped Explore and edits its telemetry source', async () => {
    renderPage();

    expect(await screen.findByRole('link', { name: 'Metrics' })).toHaveAttribute('href', '/telemetry/explore?source=node-a');
    expect(screen.getAllByRole('link', { name: 'Metrics' })).toHaveLength(1);

    fireEvent.click(screen.getAllByRole('button', { name: 'Edit' })[0]);
    expect(screen.getByLabelText(/Telemetry source/)).toHaveValue('node-a');
    fireEvent.change(screen.getByLabelText(/Telemetry source/), { target: { value: '  ' } });
    fireEvent.click(screen.getByRole('button', { name: /save changes/i }));

    expect(updateService).toHaveBeenCalledWith('robin-primary', expect.objectContaining({ telemetrySource: null }));
  });
});
