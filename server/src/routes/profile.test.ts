import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './profile.js';
import * as adminsQueries from '../db/queries/admins.js';
import * as passwordService from '../services/password.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/audit.js', () => ({
  AuditActions: {
    ADMIN_UPDATE: 'admin-update',
  },
  logAudit: vi.fn(),
}));

vi.mock('../db/queries/admins.js', () => ({
  getAdminById: vi.fn(),
  getAdminByIdWithPassword: vi.fn(),
  updateAdmin: vi.fn(),
  invalidateAdminSessions: vi.fn(),
}));

vi.mock('../services/password.js', () => ({
  hashAdminPassword: vi.fn(),
  verifyAdminPassword: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: {
    error: vi.fn(),
    info: vi.fn(),
  },
}));

const mockGetAdminById = vi.mocked(adminsQueries.getAdminById);
const mockUpdateAdmin = vi.mocked(adminsQueries.updateAdmin);
const mockGetAdminByIdWithPassword = vi.mocked(adminsQueries.getAdminByIdWithPassword);
const mockInvalidateAdminSessions = vi.mocked(adminsQueries.invalidateAdminSessions);
const mockVerifyAdminPassword = vi.mocked(passwordService.verifyAdminPassword);
const mockHashAdminPassword = vi.mocked(passwordService.hashAdminPassword);

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.sessionID = 'current-sid';
    req.session = {
      admin: {
        id: 1,
        name: 'Robin Admin',
        email: 'admin@example.com',
        role: 'admin',
        allowedCidrs: [],
      },
    };
    next();
  });
  app.use('/profile', router);
  server = app.listen(0);

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/profile`;
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
});

describe('profile routes', () => {
  it('updates the current admin name and email', async () => {
    mockGetAdminById.mockResolvedValue({
      id: 1,
      uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
      name: 'Robin Admin',
      email: 'admin@example.com',
      role: 'admin',
      allowedCidrs: ['203.0.113.0/24'],
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      lastLogin: new Date('2024-01-02T00:00:00.000Z'),
      disabled: false,
    } as never);
    mockUpdateAdmin.mockResolvedValue({
      id: 1,
      uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
      name: 'Robin Ops',
      email: 'ops@example.com',
      role: 'admin',
      allowedCidrs: ['203.0.113.0/24'],
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-03T00:00:00.000Z'),
      lastLogin: new Date('2024-01-02T00:00:00.000Z'),
      disabled: false,
    } as never);

    const response = await fetch(baseUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        name: 'Robin Ops',
        email: 'ops@example.com',
        uid: 'client-forged-identity',
      }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockUpdateAdmin).toHaveBeenCalledWith(1, { name: 'Robin Ops', email: 'ops@example.com' });
    expect(body.data).toMatchObject({
      uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
      name: 'Robin Ops',
      email: 'ops@example.com',
      allowedCidrs: ['203.0.113.0/24'],
    });
  });

  it('changing password invalidates other sessions but keeps the current one', async () => {
    mockGetAdminByIdWithPassword.mockResolvedValue({
      id: 1,
      name: 'Robin Admin',
      email: 'admin@example.com',
      role: 'admin',
      allowedCidrs: [],
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
      lastLogin: null,
      disabled: false,
      passwordHash: 'old-hash',
    } as never);
    mockVerifyAdminPassword.mockResolvedValue(true);
    mockHashAdminPassword.mockResolvedValue('new-hash');
    mockUpdateAdmin.mockResolvedValue({} as never);

    const response = await fetch(`${baseUrl}/password`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'old-password', newPassword: 'new-password-123' }),
    });

    expect(response.status).toBe(200);
    expect(mockUpdateAdmin).toHaveBeenCalledWith(1, { passwordHash: 'new-hash' });
    expect(mockInvalidateAdminSessions).toHaveBeenCalledWith(1, 'current-sid');
  });
});
