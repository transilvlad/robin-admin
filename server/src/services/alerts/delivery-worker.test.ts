import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimDueAlertDeliveries, completeAlertDelivery, expireStaleAlertDeliveries } from '../../db/queries/alerts.js';
import { applyOperationsSettings, operationsDefaults, operationsPolicy } from '../operations-settings.js';
import { sendAlertWebhook } from './webhook-transport.js';
import { getEmailSenderProfile } from '../../db/queries/email.js';
import { resolveEmailRelays, sendEmailViaRelay } from '../email/transport.js';
import { nextAlertRetryAt, processAlertDelivery, startAlertDeliveryWorker, stopAlertDeliveryWorker } from './delivery-worker.js';

vi.mock('../../db/queries/alerts.js', () => ({
  claimDueAlertDeliveries: vi.fn(),
  completeAlertDelivery: vi.fn(),
  expireStaleAlertDeliveries: vi.fn(),
}));
vi.mock('./webhook-transport.js', () => ({ sendAlertWebhook: vi.fn() }));
vi.mock('../../db/queries/email.js', () => ({ getEmailSenderProfile: vi.fn() }));
vi.mock('../email/transport.js', () => ({ resolveEmailRelays: vi.fn(), sendEmailViaRelay: vi.fn() }));
vi.mock('../../middleware/security.js', () => ({ validateOutboundUrl: vi.fn(() => null) }));
vi.mock('../../logger.js', () => ({
  logger: { debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const delivery = {
  id: 4,
  notificationId: '8a5149d1-867a-4c2e-9fac-7bbc21873dac',
  webhookId: 2,
  webhookName: 'Operations',
  fleetServiceId: 3,
  serviceId: 'postfix-primary',
  serviceName: 'Postfix',
  serviceType: 'postfix' as const,
  alertType: 'postfix_queue' as const,
  eventKind: 'failure' as const,
  status: 'processing' as const,
  attempts: 1,
  nextAttemptAt: null,
  lastAttemptAt: new Date(),
  responseStatus: null,
  error: null,
  createdAt: new Date(),
  completedAt: null,
  adapter: 'slack' as const,
  destinationUid: 'destination-1',
  payload: { text: 'test' },
  webhookUrl: 'https://hooks.slack.com/services/test',
  sentry: { org: null, apiUrl: null, apiToken: null },
  claimToken: 'claim-token',
  claimError: null,
};

describe('alert delivery worker', () => {
  it('keeps its batch guard after a failed completion while another completion is pending', async () => {
    vi.useFakeTimers();
    const previous = { ...operationsPolicy() };
    applyOperationsSettings({ ...previous, alertsEnabled: true });
    const delayed = Promise.withResolvers<void>();
    vi.mocked(claimDueAlertDeliveries).mockResolvedValueOnce([
      { ...delivery, claimError: 'Unavailable destination' },
      { ...delivery, id: 5, claimError: 'Unavailable destination' },
    ]).mockResolvedValue([]);
    vi.mocked(completeAlertDelivery).mockRejectedValueOnce(new Error('DB unavailable')).mockReturnValueOnce(delayed.promise);
    try {
      startAlertDeliveryWorker();
      await vi.advanceTimersByTimeAsync(5000);
      expect(claimDueAlertDeliveries).toHaveBeenCalledOnce();
      delayed.resolve();
      await vi.advanceTimersByTimeAsync(5000);
      expect(claimDueAlertDeliveries).toHaveBeenCalledTimes(2);
    } finally {
      delayed.resolve();
      stopAlertDeliveryWorker();
      applyOperationsSettings(previous);
      vi.useRealTimers();
    }
  });

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(expireStaleAlertDeliveries).mockResolvedValue(0);
    applyOperationsSettings(operationsDefaults());
  });

  it('records accepted deliveries and passes the notification ID', async () => {
    vi.mocked(sendAlertWebhook).mockResolvedValue({ accepted: true, retryable: false, status: 200, error: null });
    await processAlertDelivery(delivery);
    expect(sendAlertWebhook).toHaveBeenCalledWith(expect.objectContaining({
      notificationId: delivery.notificationId,
    }));
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      id: delivery.id,
      claimToken: delivery.claimToken,
      status: 'accepted',
    }));
  });

  it('retries transient failures and stops after five attempts', async () => {
    vi.mocked(sendAlertWebhook).mockResolvedValue({ accepted: false, retryable: true, status: 503, error: 'Unavailable' });
    await processAlertDelivery(delivery);
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending',
      nextAttemptAt: expect.any(Date),
    }));

    vi.clearAllMocks();
    await processAlertDelivery({ ...delivery, attempts: 5 });
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed',
      nextAttemptAt: null,
    }));
  });

  it('uses capped exponential retry delays', () => {
    const original = Date.now;
    Date.now = () => 1_000_000;
    try {
      expect(nextAlertRetryAt(1).getTime()).toBe(1_030_000);
      expect(nextAlertRetryAt(20).getTime()).toBe(1_900_000);
    } finally {
      Date.now = original;
    }
  });

  it('sends a Teams Adaptive Card through the existing safe webhook transport', async () => {
    vi.mocked(sendAlertWebhook).mockResolvedValue({ accepted: true, retryable: false, status: 202, error: null });
    await processAlertDelivery({ ...delivery, adapter: 'teams', webhookUrl: 'https://example.com/teams', payload: { summary: 'Down' } });
    expect(sendAlertWebhook).toHaveBeenCalledWith(expect.objectContaining({
      adapter: 'teams',
      payload: expect.objectContaining({ type: 'message', attachments: expect.any(Array) }),
    }));
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
  });

  it('sends PagerDuty resolves to the fixed Events API endpoint without putting the key in the URL', async () => {
    vi.mocked(sendAlertWebhook).mockResolvedValue({ accepted: true, retryable: false, status: 202, error: null });
    await processAlertDelivery({ ...delivery, adapter: 'pagerduty', webhookUrl: 'a'.repeat(32), eventKind: 'recovery' });
    expect(sendAlertWebhook).toHaveBeenCalledWith(expect.objectContaining({
      webhookUrl: 'https://events.pagerduty.com/v2/enqueue',
      payload: expect.objectContaining({ routing_key: 'a'.repeat(32), event_action: 'resolve' }),
    }));
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));
  });

  it('uses the alerts email sender and relay failover, reporting the real delivery result', async () => {
    const sender = { enabled: true };
    const relays = [{ id: 1 }, { id: 2 }];
    vi.mocked(getEmailSenderProfile).mockResolvedValue(sender as never);
    vi.mocked(resolveEmailRelays).mockResolvedValue(relays as never);
    vi.mocked(sendEmailViaRelay)
      .mockResolvedValueOnce({ accepted: false, retryable: true, error: 'temporary' })
      .mockResolvedValueOnce({ accepted: true, retryable: false });
    await processAlertDelivery({ ...delivery, adapter: 'email', webhookUrl: 'ops@example.com', payload: { summary: 'Test down' } });
    expect(getEmailSenderProfile).toHaveBeenCalledWith('alerts');
    expect(sendEmailViaRelay).toHaveBeenCalledTimes(2);
    expect(sendEmailViaRelay).toHaveBeenCalledWith(expect.objectContaining({
      recipientEmail: 'ops@example.com', subject: expect.stringContaining('Test down'),
    }), sender, relays[1]);
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({ status: 'accepted' }));

    vi.clearAllMocks();
    vi.mocked(getEmailSenderProfile).mockResolvedValue(sender as never);
    vi.mocked(resolveEmailRelays).mockResolvedValue(relays.slice(0, 1) as never);
    vi.mocked(sendEmailViaRelay).mockResolvedValue({ accepted: false, retryable: true, error: 'recipient ops@example.com secret' });
    await processAlertDelivery({ ...delivery, adapter: 'email', webhookUrl: 'ops@example.com' });
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'pending', error: 'All configured alert email relays rejected delivery',
    }));
  });

  it('fails visibly when the alerts email profile is disabled', async () => {
    vi.mocked(getEmailSenderProfile).mockResolvedValue(null);
    await processAlertDelivery({ ...delivery, adapter: 'email', webhookUrl: 'ops@example.com' });
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', error: 'Alerts email sender profile is disabled or missing',
    }));
    expect(sendEmailViaRelay).not.toHaveBeenCalled();
  });

  it('rejects unsafe sender profile headers before connecting to a relay', async () => {
    vi.mocked(getEmailSenderProfile).mockResolvedValue({ enabled: true, fromName: 'Alerts\r\nBcc: other@example.com' } as never);
    await processAlertDelivery({ ...delivery, adapter: 'email', webhookUrl: 'ops@example.com' });
    expect(completeAlertDelivery).toHaveBeenCalledWith(expect.objectContaining({
      status: 'failed', error: 'Alerts email sender profile contains invalid header characters',
    }));
    expect(sendEmailViaRelay).not.toHaveBeenCalled();
  });
});
