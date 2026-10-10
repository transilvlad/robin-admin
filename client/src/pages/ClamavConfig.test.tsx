import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ClamavConfigPage } from './ClamavConfig';

const { getConfig, getStatus, getRenderedConfig, updateConfig, reload } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getStatus: vi.fn(),
  getRenderedConfig: vi.fn(),
  updateConfig: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  clamavApi: { getConfig, getStatus, getRenderedConfig, updateConfig, reload },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedClamavService: { serviceId: 'cl1', name: 'CL', serviceType: 'clamav' },
    clamavServices: [{ serviceId: 'cl1', name: 'CL', serviceType: 'clamav' }],
    selectedPostfixService: null,
    selectedDovecotService: null,
  }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const CLAMD = {
  tcpAddr: 'antivirus-backend',
  tcpPort: 3310,
  localSocket: '',
  localSocketMode: '666',
  maxScanSize: '100M',
  maxFileSize: '25M',
  maxRecursion: 17,
  maxFiles: 10000,
  scanArchive: true,
  maxThreads: 12,
  readTimeoutSeconds: 120,
  user: 'clamav',
  logFile: '/var/log/clamav/clamd.log',
  logVerbose: false,
  virusEvent: '',
  notifyClamdOnUpdate: true,
};

const FRESHCLAM = {
  enabled: true,
  daemon: true,
  checks: 12,
  databaseMirror: ['database.clamav.net'],
  privateMirror: [],
  updateLogFile: '/var/log/clamav/freshclam.log',
  databaseOwner: 'clamav',
  notifyClamd: '/etc/clamav/clamd.conf',
  connectTimeoutSeconds: 30,
  receiveTimeoutSeconds: 60,
  httpProxyServer: '',
  httpProxyPort: null,
  httpProxyUsername: '',
  httpProxyPassword: '',
};

describe('ClamavConfigPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ data: { serviceId: 'cl1', serviceName: 'CL', clamd: CLAMD, freshclam: FRESHCLAM } });
    getStatus.mockResolvedValue({ data: {
      serviceId: 'cl1',
      serviceName: 'CL',
      endpoint: { host: 'antivirus-backend', port: 3310 },
      pingOk: false,
      engineVersion: null,
      databaseVersion: null,
      statusText: null,
      rawStats: '',
    } });
    getRenderedConfig.mockResolvedValue({ data: { clamd: 'TCPAddr antivirus-backend', freshclam: 'DatabaseMirror database.clamav.net' } });
  });

  it('renders the ClamD and FreshClam config form loaded from the API', async () => {
    render(<MemoryRouter><ClamavConfigPage /></MemoryRouter>);

    expect(await screen.findByText('ClamAV Config')).toBeInTheDocument();
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith('cl1'));
    // A managed clamd value from the API is reflected in an input.
    expect(await screen.findByDisplayValue('antivirus-backend')).toBeInTheDocument();
    await waitFor(() => expect(getRenderedConfig).toHaveBeenCalledWith('cl1'));
  });
});
