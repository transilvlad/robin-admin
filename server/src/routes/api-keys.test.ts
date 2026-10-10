import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './api-keys.js';
import * as securityQueries from '../db/queries/security.js';
import * as configQueries from '../db/queries/config.js';
import type { ApiKeyRecord } from '../db/queries/security.js';

vi.mock('../db/queries/security.js', () => ({
  createApiKey: vi.fn(),
  deleteApiKey: vi.fn(),
  listApiKeys: vi.fn(),
  revokeApiKey: vi.fn(),
}));
vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(),
}));
vi.mock('../middleware/auth.js', () => ({
  requireAuth: (
    req: { session?: { admin?: { id: number; role: string } } },
    _res: unknown,
    next: () => void
  ) => {
    req.session = { admin: { id: 1, role: 'admin' } };
    next();
  },
}));
vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));
vi.mock('../middleware/audit.js', () => ({
  AuditActions: { API_KEY_CREATE: 'api_key.create', API_KEY_REVOKE: 'api_key.revoke', API_KEY_DELETE: 'api_key.delete' },
  logAudit: vi.fn(),
}));

const mockGetConfig = vi.mocked(configQueries.getConfig);
const mockCreateApiKey = vi.mocked(securityQueries.createApiKey);

const API_KEY_MAX_LIFETIME_DAYS = 30;

function makeApiKeyRecord(overrides: Partial<ApiKeyRecord> = {}): ApiKeyRecord {
  return {
    id: 1,
    name: 'automation',
    keyPrefix: 'ra_abcdefgh',
    role: 'viewer',
    scopes: ['metrics:read'],
    allowedCidrs: [],
    createdBy: 1,
    createdAt: new Date(),
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    lastUsedIp: null,
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/api-keys', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetConfig.mockResolvedValue({
    apiKeyMaxLifetimeDays: API_KEY_MAX_LIFETIME_DAYS,
  } as Awaited<ReturnType<typeof configQueries.getConfig>>);
  mockCreateApiKey.mockImplementation(async (data) =>
    ({
      key: makeApiKeyRecord({ name: data.name, role: data.role, scopes: data.scopes, expiresAt: data.expiresAt }),
      plainText: 'ra_plaintextsecret',
    })
  );
});

function createKey(body: Record<string, unknown>) {
  return fetch(`${baseUrl}/api-keys`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('POST /api-keys expiry defaulting (SEC-13)', () => {
  it('defaults an omitted expiresAt to the configured max lifetime instead of never expiring', async () => {
    const before = Date.now();
    const response = await createKey({
      name: 'automation',
      role: 'viewer',
      scopes: ['metrics:read'],
    });
    const after = Date.now();

    expect(response.status).toBe(201);
    expect(mockCreateApiKey).toHaveBeenCalledTimes(1);
    const passedExpiry = mockCreateApiKey.mock.calls[0][0].expiresAt;
    expect(passedExpiry).not.toBeNull();
    const expiryMs = (passedExpiry as Date).getTime();
    const expectedMin = before + API_KEY_MAX_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
    const expectedMax = after + API_KEY_MAX_LIFETIME_DAYS * 24 * 60 * 60 * 1000;
    expect(expiryMs).toBeGreaterThanOrEqual(expectedMin);
    expect(expiryMs).toBeLessThanOrEqual(expectedMax);
  });

  it('clamps an explicit expiresAt beyond the configured max lifetime', async () => {
    const farFuture = new Date(Date.now() + (API_KEY_MAX_LIFETIME_DAYS + 10) * 24 * 60 * 60 * 1000);

    const response = await createKey({
      name: 'automation',
      role: 'viewer',
      scopes: ['metrics:read'],
      expiresAt: farFuture.toISOString(),
    });

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: expect.stringContaining(`${API_KEY_MAX_LIFETIME_DAYS} days`),
    });
  });

  it('respects an explicit expiresAt within the configured max lifetime', async () => {
    const withinRange = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);

    const response = await createKey({
      name: 'automation',
      role: 'viewer',
      scopes: ['metrics:read'],
      expiresAt: withinRange.toISOString(),
    });

    expect(response.status).toBe(201);
    expect(mockCreateApiKey).toHaveBeenCalledTimes(1);
    const passedExpiry = mockCreateApiKey.mock.calls[0][0].expiresAt as Date;
    expect(passedExpiry.getTime()).toBe(withinRange.getTime());
  });

  it('rejects an unparseable explicit expiresAt', async () => {
    const response = await createKey({
      name: 'automation',
      role: 'viewer',
      scopes: ['metrics:read'],
      expiresAt: 'not-a-date',
    });

    expect(response.status).toBe(400);
    expect(mockCreateApiKey).not.toHaveBeenCalled();
    await expect(response.json()).resolves.toMatchObject({
      success: false,
      error: 'Invalid expiration date',
    });
  });
});
