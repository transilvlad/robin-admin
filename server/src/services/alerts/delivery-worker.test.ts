import { beforeEach, describe, expect, it, vi } from 'vitest';
import { claimDueAlertDeliveries, completeAlertDelivery, expireStaleAlertDeliveries } from '../../db/queries/alerts.js';
import { applyOperationsSettings, operationsDefaults, operationsPolicy } from '../operations-settings.js';
import { sendAlertWebhook } from './webhook-transport.js';
import { nextAlertRetryAt, processAlertDelivery, startAlertDeliveryWorker, stopAlertDeliveryWorker } from './delivery-worker.js';

vi.mock('../../db/queries/alerts.js', () => ({
  claimDueAlertDeliveries: vi.fn(),
  completeAlertDelivery: vi.fn(),
  expireStaleAlertDeliveries: vi.fn(),
}));
vi.mock('./webhook-transport.js', () => ({ sendAlertWebhook: vi.fn() }));
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
  payload: { text: 'test' },
  webhookUrl: 'https://hooks.slack.com/services/test',
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
});
