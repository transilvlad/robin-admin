import { afterEach, expect, it, vi } from 'vitest';
import { claimDueEmailDeliveries, getEmailSenderProfile } from '../../db/queries/email.js';
import { startEmailDeliveryWorker, stopEmailDeliveryWorker } from './delivery-worker.js';

vi.mock('../../db/queries/email.js', () => ({ claimDueEmailDeliveries: vi.fn(), getEmailSenderProfile: vi.fn(),
  completeEmailDelivery: vi.fn(), getResolvedEmailRelay: vi.fn(), listEmailRelays: vi.fn(), recordEmailDeliveryAttempt: vi.fn() }));
vi.mock('../../db/queries/alerts.js', () => ({ createAlertDelivery: vi.fn(), listAlertWebhooks: vi.fn().mockResolvedValue([]) }));

afterEach(() => { stopEmailDeliveryWorker(); vi.useRealTimers(); });
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
