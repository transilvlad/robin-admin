import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './robin.js';
import * as robinApi from '../services/robin-api.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireEditor: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/audit.js', () => ({
  AuditActions: {
    EMAIL_SEND: 'email-send',
  },
  logAudit: vi.fn(),
}));

vi.mock('../services/robin-api.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../services/robin-api.js')>(),
  queueEmail: vi.fn(),
  sendEmail: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const mockQueueEmail = vi.mocked(robinApi.queueEmail);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/robin', router);
  server = app.listen(0);

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/robin`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockQueueEmail.mockResolvedValue({ queued: true });
});

describe('robin routes', () => {
  it('passes the selected service id through delivery-test requests', async () => {
    const response = await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        serviceId: 'robin-east',
        mx: ['mail.example.test'],
        port: 25,
        tls: true,
        envelopes: [{
          mail: 'sender@example.test',
          rcpt: ['recipient@example.test'],
          subject: 'hello',
          message: 'test',
        }],
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockQueueEmail).toHaveBeenCalledWith({
      mx: ['mail.example.test'],
      port: 25,
      tls: true,
      envelopes: [{
        mail: 'sender@example.test',
        rcpt: ['recipient@example.test'],
        subject: 'hello',
        message: 'test',
      }],
    }, 'robin-east');
    expect(body.success).toBe(true);
  });

  it('returns an explicit 503 when Robin MTA is unavailable', async () => {
    mockQueueEmail.mockRejectedValueOnce(new robinApi.RobinApiUnavailableError('Robin MTA API is unavailable'));

    const response = await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelopes: [] }),
    });

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Robin MTA API is unavailable. Email delivery is not available on this deployment.',
    });
    expect(response.status).toBe(503);
  });

  it("passes Robin's reason through as a 502 when Robin refuses the request", async () => {
    mockQueueEmail.mockRejectedValueOnce(new robinApi.RobinApiRejectedError(400, 'Invalid envelope'));

    const response = await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ envelopes: [] }),
    });

    await expect(response.json()).resolves.toEqual({
      success: false,
      error: 'Robin rejected the request (HTTP 400): Invalid envelope',
    });
    expect(response.status).toBe(502);
  });

  it('answers 400 for a Robin service that cannot be used', async () => {
    mockQueueEmail.mockRejectedValueOnce(new robinApi.RobinInstanceUnusableError('robin-old', 'disabled'));

    const response = await fetch(`${baseUrl}/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ serviceId: 'robin-old', envelopes: [] }),
    });

    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({ success: false, error: 'Robin service robin-old is disabled' });
  });
});
