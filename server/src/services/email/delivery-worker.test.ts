import { afterEach, expect, it, vi } from 'vitest';
import { claimDueEmailDeliveries, getEmailSenderProfile } from '../../db/queries/email.js';
import { createAlertDelivery, listAlertWebhooks } from '../../db/queries/alerts.js';
import { applyOperationsSettings, operationsDefaults } from '../operations-settings.js';
import { processEmailDelivery, startEmailDeliveryWorker, stopEmailDeliveryWorker } from './delivery-worker.js';

vi.mock('../../db/queries/email.js', () => ({ claimDueEmailDeliveries: vi.fn(), getEmailSenderProfile: vi.fn(),
  completeEmailDelivery: vi.fn(), getResolvedEmailRelay: vi.fn(), listEmailRelays: vi.fn(), recordEmailDeliveryAttempt: vi.fn() }));
vi.mock('../../db/queries/alerts.js', () => ({ createAlertDelivery: vi.fn(), listAlertWebhooks: vi.fn().mockResolvedValue([]) }));

afterEach(() => { stopEmailDeliveryWorker(); vi.useRealTimers(); applyOperationsSettings(operationsDefaults()); });
it('does not start another email batch after one database failure while another delivery is pending', async () => {
  vi.useFakeTimers();
  const delayed = Promise.withResolvers<null>();
  vi.mocked(claimDueEmailDeliveries).mockResolvedValueOnce([{ id: 1 }, { id: 2 }] as never).mockResolvedValue([]);
  vi.mocked(getEmailSenderProfile).mockRejectedValueOnce(new Error('DB unavailable')).mockReturnValueOnce(delayed.promise);
  startEmailDeliveryWorker();
  await vi.advanceTimersByTimeAsync(5000);
  expect(claimDueEmailDeliveries).toHaveBeenCalledOnce();
  delayed.resolve(null);
  await vi.advanceTimersByTimeAsync(5000);
  expect(claimDueEmailDeliveries).toHaveBeenCalledTimes(2);
});

it('queues an email delivery failure separately for each subscribed destination', async () => {
  vi.clearAllMocks();
  applyOperationsSettings({ ...operationsDefaults(), alertsEnabled: true });
  vi.mocked(getEmailSenderProfile).mockResolvedValue(null);
  vi.mocked(listAlertWebhooks).mockResolvedValue([1, 2].map(id => ({
    id, name: `Destination ${id}`, enabled: true, adapter: 'generic',
    subscriptions: [{ alertType: 'email_delivery_failure', enabled: true }],
  })) as never);
  await processEmailDelivery({
    id: 7, attempts: 1, claimToken: 'claim', senderProfileKey: 'system',
    purpose: 'password_recovery', recipientEmail: 'fixture@example.com', recipientKind: 'admin', subject: 'Reset',
  } as never);
  expect(createAlertDelivery).toHaveBeenCalledTimes(2);
  expect(vi.mocked(createAlertDelivery).mock.calls.map(([delivery]) => delivery.dedupeKey)).toEqual([
    'email-delivery:7:failure:1:1', 'email-delivery:7:failure:1:2',
  ]);
});
