import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DovecotConfigPage } from './DovecotConfig';
import { denyCapabilities } from '../test/capabilities';

const { getConfig, getRenderedConfig, updateConfig, reload } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getRenderedConfig: vi.fn(),
  updateConfig: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  dovecotApi: { getConfig, getRenderedConfig, updateConfig, reload },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedDovecotService: { serviceId: 'dc1', name: 'DC', serviceType: 'dovecot' },
    dovecotServices: [{ serviceId: 'dc1', name: 'DC', serviceType: 'dovecot' }],
    selectedPostfixService: null,
    selectedClamavService: null,
  }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const MANAGED = {
  authCacheSize: '10M',
  authCacheTtl: '1 hour',
  authCacheNegativeTtl: '1 hour',
  authFailureDelay: '2 secs',
  disablePlaintextAuth: true,
  mailMaxUseripConnections: 10,
  imapIdleNotifyInterval: '2 mins',
  imapMaxLineLength: '',
  mailMaxLockTimeout: '',
  protocols: 'imap lmtp',
  mailRetentionDays: 0,
};

describe('DovecotConfigPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ data: { serviceId: 'dc1', serviceName: 'DC', managed: MANAGED } });
    getRenderedConfig.mockResolvedValue({ data: { managed: 'auth_cache_size = 10M' } });
  });

  it('renders the managed config form loaded from the API', async () => {
    render(<MemoryRouter><DovecotConfigPage /></MemoryRouter>);

    expect(await screen.findByText('Dovecot config')).toBeInTheDocument();
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith('dc1'));
    // The per-file sidebar lists the config sections (also echoed in the header).
    expect((await screen.findAllByText('Authentication')).length).toBeGreaterThan(0);
    expect(screen.getByText('Sessions & protocols')).toBeInTheDocument();
    await waitFor(() => expect(getRenderedConfig).toHaveBeenCalledWith('dc1'));
  });

  it('offers Reload only where the service setup can reload it', async () => {
    render(<MemoryRouter><DovecotConfigPage /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /Reload/ })).toBeInTheDocument();

    cleanup();
    denyCapabilities('reload');
    render(<MemoryRouter><DovecotConfigPage /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Reload/ })).not.toBeInTheDocument());
  });
});
