import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PostfixConfigPage } from './PostfixConfig';
import { denyCapabilities } from '../test/capabilities';

const { getConfig, getRenderedConfig, updateConfig, reload } = vi.hoisted(() => ({
  getConfig: vi.fn(),
  getRenderedConfig: vi.fn(),
  updateConfig: vi.fn(),
  reload: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  postfixApi: { getConfig, getRenderedConfig, updateConfig, reload },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => ({
    selectedPostfixService: { serviceId: 'pf1', name: 'PF', serviceType: 'postfix' },
    postfixServices: [{ serviceId: 'pf1', name: 'PF', serviceType: 'postfix' }],
  }),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="selector" />,
}));

vi.mock('../constants/appIcons', () => ({ appIcons: new Proxy({}, { get: () => () => null }) }));

const MANAGED = {
  messageSizeLimit: 20480000, mailboxSizeLimit: 0, maximalQueueLifetime: '1h', bounceQueueLifetime: '1h',
  defaultProcessLimit: 300, defaultDestinationConcurrencyLimit: 50, smtpdClientConnectionCountLimit: 0,
  smtpdClientConnectionRateLimit: 0, smtpdClientMessageRateLimit: 0, smtpdClientRecipientRateLimit: 0,
  smtpdClientAuthRateLimit: 0, notifyClasses: 'resource, software', headerChecks: [], bodyChecks: [],
};

describe('PostfixConfigPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ data: { serviceId: 'pf1', serviceName: 'PF', managed: MANAGED } });
    getRenderedConfig.mockResolvedValue({ data: { mainCf: 'message_size_limit = 20480000', headerChecks: '', bodyChecks: '' } });
  });

  it('renders the managed config form loaded from the API', async () => {
    render(<MemoryRouter><PostfixConfigPage /></MemoryRouter>);
    expect(await screen.findByText('Postfix config')).toBeInTheDocument();
    await waitFor(() => expect(getConfig).toHaveBeenCalledWith('pf1'));
    // A managed value from the API is reflected in an input.
    expect(await screen.findByDisplayValue('20480000')).toBeInTheDocument();
    // Rendered preview is fetched and shown.
    await waitFor(() => expect(getRenderedConfig).toHaveBeenCalledWith('pf1'));
  });

  it('offers Reload only where the service setup can reload it', async () => {
    render(<MemoryRouter><PostfixConfigPage /></MemoryRouter>);
    expect(await screen.findByRole('button', { name: /Reload/ })).toBeInTheDocument();

    cleanup();
    denyCapabilities('reload');
    render(<MemoryRouter><PostfixConfigPage /></MemoryRouter>);
    await waitFor(() => expect(screen.queryByRole('button', { name: /Reload/ })).not.toBeInTheDocument());
  });
});
