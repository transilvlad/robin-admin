import { beforeEach, describe, expect, it, vi } from 'vitest';
import { query } from '../connection.js';
import {
  confirmStatusPageSubscriber,
  createOrUpdatePendingStatusSubscriber,
  createStatusPageUnsubscribeToken,
  listConfirmedStatusSubscribersForComponents,
  unsubscribeStatusPageSubscriber,
} from './email.js';

vi.mock('../connection.js', () => ({
  getClient: vi.fn(),
  query: vi.fn(),
}));

function queryResult<T>(rows: T[], rowCount = rows.length) {
  return { rows, rowCount } as never;
}

describe('status page subscriber unsubscribe tokens', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns signed unsubscribe tokens instead of stored hashes', async () => {
    vi.mocked(query).mockResolvedValueOnce(queryResult([{
      id: 42,
      email: 'subscriber@example.test',
      status: 'confirmed',
      all_components: true,
      confirmed_at: new Date('2026-09-27T10:00:00.000Z'),
      unsubscribed_at: null,
      last_notified_at: null,
      confirmation_sent_at: new Date('2026-09-27T09:00:00.000Z'),
      created_at: new Date('2026-09-27T09:00:00.000Z'),
      updated_at: new Date('2026-09-27T10:00:00.000Z'),
      component_ids: [],
      unsubscribe_hash: 'stored-unsubscribe-hash',
    }]));

    const [subscriber] = await listConfirmedStatusSubscribersForComponents([1]);

    expect(subscriber.unsubscribeToken).toBe(createStatusPageUnsubscribeToken(42, 'stored-unsubscribe-hash'));
    expect(subscriber.unsubscribeToken).not.toBe('stored-unsubscribe-hash');
  });

  it('unsubscribes signed tokens bound to the subscriber secret', async () => {
    const token = createStatusPageUnsubscribeToken(42, 'stored-unsubscribe-hash');
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([{ unsubscribe_hash: 'stored-unsubscribe-hash' }]))
      .mockResolvedValueOnce(queryResult([], 1));

    await expect(unsubscribeStatusPageSubscriber(token)).resolves.toBe(true);

    expect(vi.mocked(query).mock.calls[1][1]).toEqual([42, 'stored-unsubscribe-hash']);
  });

  it.each(['raw-token', 'v2.42.signature', 'v1.042.signature', 'v1.42.signature.extra'])('rejects noncanonical tokens without touching subscribers: %s', async token => {
    await expect(unsubscribeStatusPageSubscriber(token)).resolves.toBe(false);
    expect(query).not.toHaveBeenCalled();
  });

  it('rejects forged signatures without updating the subscriber', async () => {
    vi.mocked(query).mockResolvedValueOnce(queryResult([{ unsubscribe_hash: 'stored-unsubscribe-hash' }]));
    await expect(unsubscribeStatusPageSubscriber('v1.42.forged')).resolves.toBe(false);
    expect(query).toHaveBeenCalledTimes(1);
  });

  it('does not resend confirmation inside the database cooldown window', async () => {
    const subscriberRow = {
      id: 42,
      email: 'subscriber@example.test',
      status: 'pending',
      all_components: true,
      confirmed_at: null,
      unsubscribed_at: null,
      last_notified_at: null,
      confirmation_sent_at: new Date('2026-09-27T09:00:00.000Z'),
      created_at: new Date('2026-09-27T09:00:00.000Z'),
      updated_at: new Date('2026-09-27T09:00:00.000Z'),
      component_ids: [],
    };
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([], 0))
      .mockResolvedValueOnce(queryResult([subscriberRow]));

    const result = await createOrUpdatePendingStatusSubscriber({
      email: 'Subscriber@Example.Test',
      allComponents: true,
      componentIds: [],
    });

    expect(result).toMatchObject({
      token: null,
      sendConfirmation: false,
      subscriber: { email: 'subscriber@example.test' },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('does not alter confirmed subscribers from the public resubscribe flow', async () => {
    const subscriberRow = {
      id: 42,
      email: 'subscriber@example.test',
      status: 'confirmed',
      all_components: true,
      confirmed_at: new Date('2026-09-27T10:00:00.000Z'),
      unsubscribed_at: null,
      last_notified_at: null,
      confirmation_sent_at: new Date('2026-09-27T09:00:00.000Z'),
      created_at: new Date('2026-09-27T09:00:00.000Z'),
      updated_at: new Date('2026-09-27T10:00:00.000Z'),
      component_ids: [],
    };
    vi.mocked(query)
      .mockResolvedValueOnce(queryResult([], 0))
      .mockResolvedValueOnce(queryResult([subscriberRow]));

    const result = await createOrUpdatePendingStatusSubscriber({
      email: 'Subscriber@Example.Test',
      allComponents: false,
      componentIds: [1, 2],
    });

    expect(vi.mocked(query).mock.calls[0][0]).toContain("status_page_subscribers.status <> 'confirmed'");
    expect(result).toMatchObject({
      token: null,
      sendConfirmation: false,
      subscriber: { email: 'subscriber@example.test', status: 'confirmed', allComponents: true },
    });
    expect(query).toHaveBeenCalledTimes(2);
  });

  it('only confirms non-expired confirmation tokens', async () => {
    vi.mocked(query).mockResolvedValueOnce(queryResult([], 1));

    await expect(confirmStatusPageSubscriber('fresh-token')).resolves.toBe(true);

    expect(vi.mocked(query).mock.calls[0][0]).toContain("confirmation_sent_at > CURRENT_TIMESTAMP - INTERVAL '24 hours'");
  });
});
