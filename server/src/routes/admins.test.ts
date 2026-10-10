import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './admins.js';
import * as adminsQueries from '../db/queries/admins.js';
import * as passwordService from '../services/password.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/audit.js', () => ({
  AuditActions: { ADMIN_CREATE: 'admin.create', ADMIN_UPDATE: 'admin.update', ADMIN_DELETE: 'admin.delete' },
  logAudit: vi.fn(),
}));

vi.mock('../services/password.js', () => ({
  hashAdminPassword: vi.fn(),
  validatePasswordStrength: vi.fn(() => ({ valid: true, errors: [] })),
}));

vi.mock('../db/queries/admins.js', () => ({
  getAllAdmins: vi.fn(),
  getAdminById: vi.fn(),
  createAdmin: vi.fn(),
  updateAdmin: vi.fn(),
  deleteAdmin: vi.fn(),
  countAdminsByRole: vi.fn(async () => 5),
  invalidateAdminSessions: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const mockGetAdminById = vi.mocked(adminsQueries.getAdminById);
const mockUpdateAdmin = vi.mocked(adminsQueries.updateAdmin);
const mockDeleteAdmin = vi.mocked(adminsQueries.deleteAdmin);
const mockInvalidateAdminSessions = vi.mocked(adminsQueries.invalidateAdminSessions);
const mockHashAdminPassword = vi.mocked(passwordService.hashAdminPassword);

let server: Server;
let baseUrl: string;

function buildAdmin(overrides: Record<string, unknown> = {}) {
  return {
    id: 2,
    uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
    name: 'Other Admin',
    email: 'other@example.com',
    role: 'admin',
    allowedCidrs: [],
    createdAt: new Date('2024-01-01T00:00:00.000Z'),
    updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    lastLogin: null,
    disabled: false,
    ...overrides,
  };
}

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res, next) => {
    req.sessionID = 'current-sid';
    req.session = {
      admin: { id: 1, name: 'Me', email: 'me@example.com', role: 'admin', allowedCidrs: [] },
    };
    next();
  });
  app.use('/admins', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/admins`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe('admin session invalidation on lifecycle changes', () => {
  it('includes stable UUIDs in admin listing and detail responses', async () => {
    vi.mocked(adminsQueries.getAllAdmins).mockResolvedValue([buildAdmin()] as never);
    mockGetAdminById.mockResolvedValue(buildAdmin() as never);
    const list = await fetch(baseUrl);
    expect(list.status).toBe(200);
    expect((await list.json()).data[0]).toMatchObject({ id: 2, uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4' });
    const detail = await fetch(`${baseUrl}/2`);
    expect(detail.status).toBe(200);
    expect((await detail.json()).data).toMatchObject({ id: 2, uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4' });
  });

  it('invalidates sessions when disabling another admin', async () => {
    mockGetAdminById.mockResolvedValue(buildAdmin() as never);
    mockUpdateAdmin.mockResolvedValue(buildAdmin({ disabled: true }) as never);

    const response = await fetch(`${baseUrl}/2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ disabled: true }),
    });

    expect(response.status).toBe(200);
    expect(mockInvalidateAdminSessions).toHaveBeenCalledWith(2, undefined);
  });

  it('invalidates sessions when an admin resets another admin\'s password', async () => {
    mockGetAdminById.mockResolvedValue(buildAdmin() as never);
    mockHashAdminPassword.mockResolvedValue('new-hash');
    mockUpdateAdmin.mockResolvedValue(buildAdmin() as never);

    const response = await fetch(`${baseUrl}/2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'a-new-password-123' }),
    });

    expect(response.status).toBe(200);
    expect(mockInvalidateAdminSessions).toHaveBeenCalledWith(2, undefined);
  });

  it('does not invalidate sessions for an unrelated field update', async () => {
    mockGetAdminById.mockResolvedValue(buildAdmin() as never);
    mockUpdateAdmin.mockResolvedValue(buildAdmin({ name: 'Renamed' }) as never);

    const response = await fetch(`${baseUrl}/2`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Renamed' }),
    });

    expect(response.status).toBe(200);
    expect(mockInvalidateAdminSessions).not.toHaveBeenCalled();
  });

  it('keeps the current session when an admin edits their own record', async () => {
    mockGetAdminById.mockResolvedValue(buildAdmin({ id: 1 }) as never);
    mockHashAdminPassword.mockResolvedValue('new-hash');
    mockUpdateAdmin.mockResolvedValue(buildAdmin({ id: 1 }) as never);

    const response = await fetch(`${baseUrl}/1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password: 'a-new-password-123' }),
    });

    expect(response.status).toBe(200);
    expect(mockInvalidateAdminSessions).toHaveBeenCalledWith(1, 'current-sid');
  });

  it('invalidates sessions when deleting an admin', async () => {
    mockGetAdminById.mockResolvedValue(buildAdmin() as never);
    mockDeleteAdmin.mockResolvedValue(true as never);

    const response = await fetch(`${baseUrl}/2`, { method: 'DELETE' });

    expect(response.status).toBe(200);
    expect(mockInvalidateAdminSessions).toHaveBeenCalledWith(2);
  });
});
