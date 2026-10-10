import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { NextFunction, Request, Response } from 'express';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createOrUpdatePendingStatusSubscriber } from '../db/queries/email.js';
import { getStatusPageSettings } from '../db/queries/status-page.js';
import { enqueueStatusSubscriptionConfirmation } from '../services/email/messages.js';
import router from './email.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));
vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));
vi.mock('../db/queries/email.js', () => ({
  enqueueEmailDelivery: vi.fn(),
  confirmStatusPageSubscriber: vi.fn(),
  createOrUpdatePendingStatusSubscriber: vi.fn(),
  deleteEmailRelay: vi.fn(),
  deleteStatusPageSubscriber: vi.fn(),
  getEmailTransportAdminView: vi.fn(),
  listAdminEmailSubscriptions: vi.fn(),
  listEmailDeliveries: vi.fn(),
  listStatusPageSubscribers: vi.fn(),
  unsubscribeStatusPageSubscriber: vi.fn(),
  updateAdminEmailSubscription: vi.fn(),
  updateEmailSenderProfile: vi.fn(),
  upsertEmailRelay: vi.fn(),
}));
vi.mock('../services/email/messages.js', () => ({
  enqueueStatusSubscriptionConfirmation: vi.fn(),
}));
vi.mock('../db/queries/status-page.js', () => ({
  getStatusPageSettings: vi.fn(),
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/email', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/email`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe('public status subscription links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getStatusPageSettings).mockResolvedValue({
      published: true,
      subscribable: true,
    } as never);
  });

  it('uses the configured public URL for confirmation emails instead of the request host', async () => {
    const subscriber = {
      id: 9,
      email: 'subscriber@example.test',
      status: 'pending',
      allComponents: true,
      componentIds: [],
      confirmedAt: null,
      unsubscribedAt: null,
      lastNotifiedAt: null,
      confirmationSentAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(createOrUpdatePendingStatusSubscriber).mockResolvedValue({
      subscriber,
      token: 'confirm-token',
      sendConfirmation: true,
    } as never);

    const response = await fetch(`${baseUrl}/public/status-subscriptions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'evil.example.test',
      },
      body: JSON.stringify({ email: 'subscriber@example.test', allComponents: true }),
    });

    expect(response.status).toBe(202);
    expect(enqueueStatusSubscriptionConfirmation).toHaveBeenCalledWith({
      subscriber,
      token: 'confirm-token',
      baseUrl: 'https://localhost:3443',
    });
  });

  it('does not enqueue repeated confirmation emails during the resend cooldown', async () => {
    const subscriber = {
      id: 9,
      email: 'subscriber@example.test',
      status: 'pending',
      allComponents: true,
      componentIds: [],
      confirmedAt: null,
      unsubscribedAt: null,
      lastNotifiedAt: null,
      confirmationSentAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    vi.mocked(createOrUpdatePendingStatusSubscriber).mockResolvedValue({
      subscriber,
      token: null,
      sendConfirmation: false,
    } as never);

    const response = await fetch(`${baseUrl}/public/status-subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'subscriber@example.test', allComponents: true }),
    });

    expect(response.status).toBe(202);
    expect(enqueueStatusSubscriptionConfirmation).not.toHaveBeenCalled();
  });

  it('rejects public subscriptions when the status page is not accepting them', async () => {
    vi.mocked(getStatusPageSettings).mockResolvedValue({
      published: true,
      subscribable: false,
    } as never);

    const response = await fetch(`${baseUrl}/public/status-subscriptions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'subscriber@example.test', allComponents: true }),
    });

    expect(response.status).toBe(403);
    expect(createOrUpdatePendingStatusSubscriber).not.toHaveBeenCalled();
    expect(enqueueStatusSubscriptionConfirmation).not.toHaveBeenCalled();
  });
});
