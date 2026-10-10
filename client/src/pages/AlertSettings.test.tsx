import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertSettingsPage } from './AlertSettings';

const { alertsApi, configUpdate } = vi.hoisted(() => ({
  alertsApi: {
    listWebhooks: vi.fn(),
    listDeliveries: vi.fn(),
    createWebhook: vi.fn(),
    updateWebhook: vi.fn(),
    deleteWebhook: vi.fn(),
    pauseWebhook: vi.fn(),
    resumeWebhook: vi.fn(),
    previewWebhook: vi.fn(),
    testWebhook: vi.fn(),
  },
  configUpdate: vi.fn(),
}));

vi.mock('../api/client', () => ({
  alertsApi,
  configApi: { update: configUpdate },
  ApiError: class ApiError extends Error {},
}));
vi.mock('../constants/appIcons', () => ({ appIcons: { alerts: () => null } }));

const catalog = [
  { key: 'availability', label: 'Service availability', description: 'Alerts when unreachable.', serviceTypes: ['robin'], unit: 'none', direction: 'boolean', defaultThreshold: null, minimum: null, maximum: null },
  { key: 'telemetry_stale', label: 'Telemetry stale', description: 'Alerts when observations stop.', serviceTypes: ['robin'], unit: 'seconds', direction: 'above', defaultThreshold: 180, minimum: 60, maximum: 86400 },
  { key: 'postfix_queue', label: 'Postfix queue', description: 'Alerts on queue size.', serviceTypes: ['postfix'], unit: 'messages', direction: 'above', defaultThreshold: 1000, minimum: 1, maximum: 10000000 },
  { key: 'postfix_deferred_age', label: 'Oldest deferred message', description: 'Alerts on deferred age.', serviceTypes: ['postfix'], unit: 'seconds', direction: 'above', defaultThreshold: 900, minimum: 60, maximum: 2592000 },
  { key: 'postgres_connections', label: 'PostgreSQL connection use', description: 'Alerts on connection use.', serviceTypes: ['postgres'], unit: 'percent', direction: 'above', defaultThreshold: 80, minimum: 1, maximum: 100 },
  { key: 'postgres_cache_hit', label: 'PostgreSQL cache hit ratio', description: 'Alerts on cache hit ratio.', serviceTypes: ['postgres'], unit: 'percent', direction: 'below', defaultThreshold: 95, minimum: 0, maximum: 100 },
  { key: 'redis_hit_ratio', label: 'Redis cache hit ratio', description: 'Alerts on cache hit ratio.', serviceTypes: ['redis'], unit: 'percent', direction: 'below', defaultThreshold: 80, minimum: 0, maximum: 100 },
  { key: 'clamav_database_age', label: 'ClamAV database age', description: 'Alerts on signature age.', serviceTypes: ['clamav'], unit: 'seconds', direction: 'above', defaultThreshold: 86400, minimum: 3600, maximum: 2592000 },
];

const webhook = {
  id: 1,
  name: 'Operations Slack',
  adapter: 'slack',
  enabled: true,
  monitoringEnabled: true,
  hasSecret: true,
  subscriptions: catalog.map((entry) => ({ alertType: entry.key, enabled: entry.key === 'availability', threshold: entry.defaultThreshold })),
  consecutiveFailures: 3,
  repeatIntervalSeconds: 14400,
  notifyRecovery: true,
  pausedAt: null,
  pausedUntil: null,
  pauseReason: null,
  createdAt: '2026-09-10T10:00:00Z',
  updatedAt: '2026-09-10T10:00:00Z',
};

describe('AlertSettingsPage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    alertsApi.listWebhooks.mockResolvedValue({
      data: {
        webhooks: [webhook],
        catalog,
        runtime: {
          enabled: true,
          evaluationIntervalMs: 30000,
          deliveryConcurrency: 4,
          deliveryExpiryMs: 3600000,
          instanceName: 'Robin Admin',
          encryptionKeyConfigured: true,
          deliveryRetentionDays: 30,
          workerIntervalMs: 5000,
          maxAttempts: 5,
          baseRetryDelayMs: 30000,
          maxRetryDelayMs: 900000,
          enabledWebhooks: 1,
          pausedWebhooks: 0,
          pendingDeliveries: 0,
          failedDeliveries: 0,
        },
      },
    });
    alertsApi.listDeliveries.mockResolvedValue({ data: [] });
    alertsApi.previewWebhook.mockResolvedValue({ data: { payload: { text: 'Preview' }, networkEffect: false } });
    alertsApi.testWebhook.mockResolvedValue({ data: {} });
  });

  afterEach(cleanup);

  it('shows only current webhook settings and compact history', async () => {
    render(<AlertSettingsPage />);
    expect(await screen.findByRole('heading', { name: 'Alerts' })).toBeInTheDocument();
    expect(screen.getByText('Operations Slack')).toBeInTheDocument();
    expect(screen.queryByText(/routing policies/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/incidents/i)).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Policy' }));
    expect(screen.getByRole('heading', { name: 'Delivery policy' })).toBeInTheDocument();
    expect(screen.getByLabelText('Evaluator interval (ms)')).toHaveValue(30000);
    expect(screen.getByLabelText('Enable alert evaluation and delivery')).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save policy' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Deliveries' }));
    expect(screen.getByRole('heading', { name: 'Webhook delivery history' })).toBeInTheDocument();
  });

  it('keeps alert tabs compact and focused', async () => {
    render(<AlertSettingsPage />);
    await screen.findByText('Operations Slack');
    const cards = screen.getByTestId('alert-cards');
    expect(cards).toHaveClass('xl:grid-cols-[360px_1fr]');
    expect(cards.querySelectorAll('section.card')).toHaveLength(2);
    expect(screen.getByRole('heading', { name: 'Destinations' }).closest('section')).not.toHaveClass('xl:col-span-2');

    fireEvent.click(screen.getByRole('button', { name: 'Deliveries' }));
    expect(screen.getByRole('heading', { name: 'Webhook delivery history' }).closest('section')).toHaveClass('card');
  });

  it('shows when Monitoring is active but alert delivery is disabled', async () => {
    alertsApi.listWebhooks.mockResolvedValueOnce({
      data: {
        webhooks: [],
        catalog,
        runtime: {
          enabled: false,
          evaluationIntervalMs: 30000,
          deliveryConcurrency: 4,
          deliveryExpiryMs: 3600000,
          instanceName: 'Robin Admin',
          encryptionKeyConfigured: true,
          deliveryRetentionDays: 30,
          workerIntervalMs: 5000,
          maxAttempts: 5,
          baseRetryDelayMs: 30000,
          maxRetryDelayMs: 900000,
          enabledWebhooks: 0,
          pausedWebhooks: 0,
          pendingDeliveries: 0,
          failedDeliveries: 0,
          monitoringEnabled: true,
        },
      },
    });
    render(<AlertSettingsPage />);
    expect(await screen.findByText(/Monitoring is active, but alert delivery is disabled/)).toBeInTheDocument();
  });

  it('saves the editable policy without overwriting unrelated configuration', async () => {
    configUpdate.mockResolvedValue({ data: {} });
    render(<AlertSettingsPage />);
    await screen.findByText('Operations Slack');
    fireEvent.click(screen.getByRole('button', { name: 'Policy' }));
    fireEvent.change(screen.getByLabelText('Instance name'), { target: { value: 'Staging' } });
    fireEvent.change(screen.getByLabelText('Delivery concurrency'), { target: { value: '2' } });
    fireEvent.click(screen.getByLabelText('Enable alert evaluation and delivery'));
    fireEvent.click(screen.getByRole('button', { name: 'Save policy' }));
    await waitFor(() => expect(configUpdate).toHaveBeenCalledWith({ alertsEnabled: false, alertInstanceName: 'Staging',
      alertEvaluationIntervalMs: 30000, alertDeliveryIntervalMs: 5000, alertDeliveryConcurrency: 2,
      alertDeliveryExpiryMs: 3600000, alertDeliveryMaxAttempts: 5, alertRetryBaseMs: 30000, alertRetryMaxMs: 900000, alertDeliveryRetentionDays: 30 }));
  });

  it('renders all fixed alert types with thresholds and applicability', async () => {
    render(<AlertSettingsPage />);
    await screen.findByText('Operations Slack');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    for (const entry of catalog) {
      expect(screen.getByText(entry.label)).toBeInTheDocument();
    }
    expect(screen.getByLabelText('Postfix queue threshold')).toHaveValue(1000);
    expect(screen.getAllByText('Applies to postfix.')).toHaveLength(2);
    expect(screen.getByText(/saving an empty one keeps the stored value/)).toBeInTheDocument();
  });

  it('keeps preview network-free and requires a second action for live test', async () => {
    render(<AlertSettingsPage />);
    await screen.findByText('Operations Slack');
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }));
    await waitFor(() => expect(alertsApi.previewWebhook).toHaveBeenCalledWith(1));
    expect(await screen.findByRole('heading', { name: 'Network-free preview' }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.getByText(/was not sent/)).toBeInTheDocument();
    expect(alertsApi.testWebhook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Close dialog' }));

    fireEvent.click(screen.getByRole('button', { name: 'Test' }));
    expect(screen.getByRole('heading', { name: 'Send live test?' })).toBeInTheDocument();
    expect(screen.getByText(/sends a real webhook/)).toBeInTheDocument();
    expect(alertsApi.testWebhook).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Send live test' }));
    await waitFor(() => expect(alertsApi.testWebhook).toHaveBeenCalledWith(1));
  });

  it('exposes accessible pause controls', async () => {
    render(<AlertSettingsPage />);
    await screen.findByText('Operations Slack');
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(screen.getByLabelText('Resume at')).toBeInTheDocument();
    expect(screen.getByLabelText('Reason')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Pause webhook' })).toBeInTheDocument();
  });

  it('subscribes an existing webhook to an alert type added after it was saved', async () => {
    const telemetryRule = { key: 'telemetry_rule', label: 'Telemetry rule', description: 'Rule fires.', serviceTypes: ['monitoring'], unit: 'none', direction: 'boolean', defaultThreshold: null, minimum: null, maximum: null };
    const listed = await alertsApi.listWebhooks();
    alertsApi.listWebhooks.mockResolvedValue({ data: { ...listed.data, catalog: [...catalog, telemetryRule] } });
    alertsApi.updateWebhook.mockResolvedValue({ data: webhook });
    render(<AlertSettingsPage />);
    await screen.findByText('Operations Slack');
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Telemetry rule/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }));
    await waitFor(() => expect(alertsApi.updateWebhook).toHaveBeenCalled());
    const sent = alertsApi.updateWebhook.mock.calls[0][1] as { subscriptions: Array<{ alertType: string; enabled: boolean }> };
    expect(sent.subscriptions).toContainEqual({ alertType: 'telemetry_rule', enabled: true, threshold: null });
  });

  it('creates a Sentry destination with its DSN and optional resolve settings', async () => {
    alertsApi.createWebhook.mockResolvedValue({ data: webhook });
    render(<AlertSettingsPage />);
    await screen.findByText('Operations Slack');
    fireEvent.click(screen.getByRole('button', { name: 'Add destination' }));
    fireEvent.change(screen.getByLabelText('Name'), { target: { value: 'Sentry infrastructure' } });
    fireEvent.change(screen.getByRole('combobox', { name: 'Format' }), { target: { value: 'sentry' } });
    fireEvent.change(screen.getByLabelText('Sentry DSN'), { target: { value: 'https://key@o1.ingest.us.sentry.io/2' } });
    fireEvent.change(screen.getByLabelText('Organization slug'), { target: { value: 'example-org' } });
    fireEvent.change(screen.getByLabelText('API token'), { target: { value: 'sntrys_token' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save webhook' }));
    await waitFor(() => expect(alertsApi.createWebhook).toHaveBeenCalled());
    expect(alertsApi.createWebhook.mock.calls[0][0]).toMatchObject({
      name: 'Sentry infrastructure',
      adapter: 'sentry',
      webhookUrl: 'https://key@o1.ingest.us.sentry.io/2',
      sentryOrg: 'example-org',
      sentryApiUrl: null,
      sentryApiToken: 'sntrys_token',
    });
  });
});

