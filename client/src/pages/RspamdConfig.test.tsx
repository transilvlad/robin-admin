import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { RspamdConfigPage } from './RspamdConfig';

const { getConfig, useServicesMock } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  useServicesMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, public status = 400, public details?: string[]) {
      super(message);
    }
  },
  rspamdApi: {
    getConfig,
    updateConfig: vi.fn(),
  },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => useServicesMock(),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="page-instance-selector" />,
}));

vi.mock('../components/ui/Button', () => ({
  Button: ({ children, onClick, isLoading, disabled, variant }: any) => (
    <button type="button" onClick={onClick} disabled={disabled || isLoading} data-variant={variant}>
      {children}
    </button>
  ),
}));

vi.mock('../components/ui/Input', () => ({
  Input: ({ label, value, onChange, ...rest }: any) => (
    <label>
      <span>{label}</span>
      <input aria-label={label} value={value ?? ''} onChange={onChange} {...rest} />
    </label>
  ),
}));

vi.mock('../components/ui/PageHeader', () => ({
  PageHeader: ({ title, actions }: any) => (
    <div>
      <h1>{title}</h1>
      <div>{actions}</div>
    </div>
  ),
}));

vi.mock('../constants/appIcons', () => ({
  appIcons: new Proxy({}, { get: () => () => null }),
}));

function buildServicesState() {
  return {
    isLoading: false,
    services: [],
    robinServices: [],
    rspamdServices: [{
      id: 1,
      serviceId: 'rspamd',
      serviceType: 'rspamd',
      name: 'Rspamd',
        description: null,
        apiUrl: 'http://spam-backend:11333',
        healthUrl: 'http://spam-backend:11334',
        metricsUrl: null,
        controllerUrl: 'http://spam-backend:11334',
        normalUrl: 'http://spam-backend:11333',
        enabled: true,
        createdAt: '2024-01-01T00:00:00.000Z',
        updatedAt: '2024-01-02T00:00:00.000Z',
    }],
    selectedRobinService: null,
    selectedRspamdService: {
      id: 1,
      serviceId: 'rspamd',
      serviceType: 'rspamd',
      name: 'Rspamd',
      description: null,
      apiUrl: 'http://spam-backend:11333',
      healthUrl: 'http://spam-backend:11334',
      metricsUrl: null,
      controllerUrl: 'http://spam-backend:11334',
      normalUrl: 'http://spam-backend:11333',
      enabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    },
    setSelectedService: vi.fn(),
    setSelectedRobinService: vi.fn(),
    setSelectedRspamdService: vi.fn(),
    refreshServices: vi.fn(),
  };
}

describe('RspamdConfigPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    useServicesMock.mockReturnValue(buildServicesState());
    getConfig.mockResolvedValue({
      data: {
        settings: {
          serviceId: 'rspamd',
          serviceName: 'Rspamd',
          rspamdControllerUrl: 'http://spam-backend:11334',
          rspamdNormalUrl: 'http://spam-backend:11333',
          rspamdControllerPassword: '',
          rspamdEnablePassword: '',
          rspamdConfigDir: '/mnt/rspamd/local.d',
          rspamdStoreDir: '/mnt/rspamd/store',
          rspamdTrainingDir: '/mnt/rspamd/store/training',
        },
        managedConfig: {
          rspamdDkimEnabled: true,
          rspamdDkimPathTemplate: '/var/lib/rspamd/dkim/$domain.$selector.key',
          rspamdDkimSignAuthenticated: true,
          rspamdDkimSignLocal: true,
          rspamdDkimUseDomain: 'header',
          rspamdDkimTryFallback: true,
          rspamdDkimFallbackSelector: 'dkim',
          rspamdDkimCheckPubkey: false,
          rspamdDkimAllowPubkeyMismatch: true,
          rspamdBayesBackend: 'redis',
          rspamdBayesRedisServers: '',
          rspamdBayesTokenizer: 'osb',
          rspamdBayesMinLearns: 200,
          rspamdBayesAutolearnEnabled: false,
          rspamdBayesSpamThreshold: 6,
          rspamdBayesJunkThreshold: 4,
          rspamdBayesHamThreshold: -0.5,
          rspamdBayesCheckBalance: true,
          rspamdBayesMinBalance: 0.9,
        },
        status: {
          available: true,
          enabled: true,
          controllerReachable: true,
          controllerAuthenticated: true,
          controllerStatusCode: 200,
          controllerPingOk: true,
          controllerPingStatusCode: 200,
          controllerHealthyOk: true,
          controllerHealthyStatusCode: 200,
          controllerStatAuthOk: true,
          controllerStatStatusCode: 200,
          normalWorkerPingOk: true,
          normalWorkerPingStatusCode: 200,
          configDir: { path: '/mnt/rspamd/local.d', exists: true, readable: true, writable: false },
          storeDir: { path: '/mnt/rspamd/store', exists: true, readable: true, writable: false },
          trainingDir: { path: '/mnt/rspamd/store/training', exists: true, readable: true, writable: false },
          reasons: [],
          siblingSuggestion: null,
        },
        files: {
          dkim: { path: '/mnt/rspamd/local.d/dkim_signing.conf', exists: true, readable: true, writable: false, managed: false, managementEnabled: false, content: null },
          bayes: { path: '/mnt/rspamd/local.d/classifier-bayes.conf', exists: true, readable: true, writable: false, managed: false, managementEnabled: false, content: null },
        },
      },
    });
  });

  it('renders the per-file config with a DKIM section and its fields', async () => {
    render(<RspamdConfigPage />);

    expect(await screen.findByText('Rspamd config')).toBeInTheDocument();
    // The sidebar lists the config files; DKIM is the default-selected section
    // (its label appears both in the sidebar and the editor header).
    expect((await screen.findAllByText('DKIM signing')).length).toBeGreaterThan(0);
    expect(screen.getByText('Bayes classifier')).toBeInTheDocument();
    expect(screen.getByText('Key path template')).toBeInTheDocument();
  });
});
