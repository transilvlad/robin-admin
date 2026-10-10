import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SendEmailPage } from './SendEmailPage';

const { robinConfigGet, useServicesMock, fetchMock } = vi.hoisted(() => ({
  robinConfigGet: vi.fn(),
  useServicesMock: vi.fn(),
  fetchMock: vi.fn(),
}));

vi.mock('../api/client', () => ({
  robinConfigApi: {
    get: robinConfigGet,
  },
}));

vi.mock('../context/ServiceContext', () => ({
  useServices: () => useServicesMock(),
}));

vi.mock('../components/fleet/PageServiceSelector', () => ({
  PageServiceSelector: () => <div data-testid="page-instance-selector" />,
}));

vi.mock('../components/ui/PageHeader', () => ({
  PageHeader: ({ title, description, actions }: any) => (
    <div>
      <h1>{title}</h1>
      <div>{description}</div>
      <div>{actions}</div>
    </div>
  ),
}));

vi.mock('../constants/appIcons', () => ({
  appIcons: new Proxy({}, { get: () => () => null }),
}));

function buildServicesState(selected = true) {
  return {
    selectedRobinService: selected ? {
      id: 1,
      serviceId: 'robin-east',
      serviceType: 'robin',
      name: 'Robin East',
      description: null,
      apiUrl: 'http://robin-east:8080',
      healthUrl: 'http://robin-east:8080/health',
      metricsUrl: 'http://robin-east:8080/metrics',
      controllerUrl: null,
      normalUrl: null,
      enabled: true,
      createdAt: '2024-01-01T00:00:00.000Z',
      updatedAt: '2024-01-02T00:00:00.000Z',
    } : null,
  };
}

describe('SendEmailPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', fetchMock);
    robinConfigGet.mockResolvedValue({ data: null });
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ success: true, data: { queued: true } }),
    });
    useServicesMock.mockReturnValue(buildServicesState(true));
  });

  it('shows an empty state when no enabled Robin service is selected', async () => {
    useServicesMock.mockReturnValue(buildServicesState(false));

    render(<SendEmailPage />);

    expect(await screen.findByText('No enabled Robin service is currently selected.')).toBeInTheDocument();
  });

  it('includes the selected Robin service id when queueing a delivery test', async () => {
    render(<SendEmailPage />);

    fireEvent.change(await screen.findByLabelText('Mail from'), { target: { value: 'sender@example.test' } });
    fireEvent.change(screen.getByLabelText('Recipients'), { target: { value: 'recipient@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: /send email/i }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalled();
    });

    const [, init] = fetchMock.mock.calls[fetchMock.mock.calls.length - 1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      serviceId: 'robin-east',
      envelopes: [{
        mail: 'sender@example.test',
        rcpt: ['recipient@example.test'],
      }],
    });
  });
});
