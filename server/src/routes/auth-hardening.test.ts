import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getAdminByEmail } from '../db/queries/admins.js';
import { query } from '../db/connection.js';
import { enqueuePasswordRecoveryEmail } from '../services/email/messages.js';
import router from './auth.js';

vi.mock('../db/queries/admins.js', () => ({
  getAdminByEmail: vi.fn(),
  updateAdmin: vi.fn(),
  resetAdminPasswordWithRecoveryToken: vi.fn(),
  updateLastLogin: vi.fn(),
}));
vi.mock('../db/queries/config.js', () => ({ getConfig: vi.fn() }));
vi.mock('../db/connection.js', () => ({ query: vi.fn().mockResolvedValue({ rows: [], rowCount: 0 }) }));
vi.mock('../db/queries/security.js', () => ({
  countRecentFailedLogins: vi.fn(),
  getActiveLoginLock: vi.fn(),
  recordLoginAttempt: vi.fn(),
}));
vi.mock('../middleware/security.js', () => ({
  getCsrfToken: vi.fn(() => 'csrf'),
  getTrustedClientIp: vi.fn(() => '127.0.0.1'),
}));
vi.mock('../middleware/audit.js', () => ({
  AuditActions: {
    ADMIN_LOGIN: 'admin.login',
    ADMIN_LOGIN_FAILED: 'admin.login_failed',
    ADMIN_LOGIN_LOCKED: 'admin.login_locked',
    ADMIN_PASSWORD_RECOVERY_REQUESTED: 'admin.password_recovery_requested',
    ADMIN_PASSWORD_RECOVERY_COMPLETED: 'admin.password_recovery_completed',
    ADMIN_LOGOUT: 'admin.logout',
  },
  logAudit: vi.fn(),
}));
vi.mock('../services/email/messages.js', () => ({
  enqueuePasswordRecoveryEmail: vi.fn(),
}));
vi.mock('../services/password.js', () => ({
  hashAdminPassword: vi.fn().mockResolvedValue('hashed'),
  validatePasswordStrength: vi.fn(() => ({ valid: false, errors: ['weak password'] })),
  verifyAdminPassword: vi.fn(),
}));
vi.mock('../db/schema.js', () => ({ needsSetup: vi.fn() }));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/auth', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe('authentication hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue({ rows: [], rowCount: 0 } as never);
  });

  it('accepts password recovery requests with a generic response', async () => {
    const response = await fetch(`${baseUrl}/recovery/request`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'missing@example.test' }),
    });
    expect(response.status).toBe(202);
  });

  it('uses the configured public URL for recovery emails instead of the request host', async () => {
    vi.mocked(getAdminByEmail).mockResolvedValue({
      id: 12,
      name: 'Admin',
      email: 'admin@example.test',
      role: 'admin',
      allowedCidrs: [],
      createdAt: new Date(),
      updatedAt: new Date(),
      lastLogin: null,
      disabled: false,
      passwordHash: 'hash',
    });

    const response = await fetch(`${baseUrl}/recovery/request`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Host: 'evil.example.test',
      },
      body: JSON.stringify({ email: 'admin@example.test' }),
    });

    expect(response.status).toBe(202);
    expect(enqueuePasswordRecoveryEmail).toHaveBeenCalledWith(expect.objectContaining({
      email: 'admin@example.test',
      baseUrl: 'https://localhost:3443',
    }));
  });

  it('validates password recovery reset payloads without revealing accounts', async () => {
    const response = await fetch(`${baseUrl}/recovery/reset`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    expect(response.status).toBe(400);
  });
});
