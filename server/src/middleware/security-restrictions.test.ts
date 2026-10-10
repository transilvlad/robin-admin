import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getConfigMock, getConfigValueMock, getAdminByIdMock, findActiveIpJailMatchMock, getApiKeyByTokenMock, touchApiKeyMock } = vi.hoisted(() => ({
  getConfigMock: vi.fn(),
  getConfigValueMock: vi.fn(),
  getAdminByIdMock: vi.fn(),
  findActiveIpJailMatchMock: vi.fn(),
  getApiKeyByTokenMock: vi.fn(),
  touchApiKeyMock: vi.fn(),
}));

vi.mock('../db/queries/config.js', () => ({
  getConfig: getConfigMock,
  getConfigValue: getConfigValueMock,
}));

vi.mock('../db/queries/admins.js', () => ({
  getAdminById: getAdminByIdMock,
}));

vi.mock('../db/queries/security.js', () => ({
  findActiveIpJailMatch: findActiveIpJailMatchMock,
  getApiKeyByToken: getApiKeyByTokenMock,
  hashSecret: (value: string) => value,
  touchApiKey: touchApiKeyMock,
}));

import { enforceIpRestrictions, getTrustedClientIp, isLoopbackConnection } from './security.js';

describe('enforceIpRestrictions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfigValueMock.mockResolvedValue(null);
    findActiveIpJailMatchMock.mockResolvedValue(null);
    getApiKeyByTokenMock.mockResolvedValue(null);
    touchApiKeyMock.mockResolvedValue(undefined);
  });

  it('requires the request IP to satisfy both global and admin-specific CIDR policies', async () => {
    getConfigMock.mockResolvedValue({
      trustedProxyCidrs: '',
      globalIpAllowlist: '203.0.113.0/24',
    });
    getAdminByIdMock.mockResolvedValue({
      id: 1,
      uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
      name: 'Robin Admin',
      email: 'admin@example.com',
      role: 'admin',
      allowedCidrs: ['203.0.113.10/32'],
      disabled: false,
    });

    const req = {
      socket: { remoteAddress: '203.0.113.11' },
      session: {
        admin: {
          id: 1,
          uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
          name: 'Robin Admin',
          email: 'admin@example.com',
          role: 'admin',
          allowedCidrs: [],
        },
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    await enforceIpRestrictions(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({
      success: false,
      error: 'Your administrator account is not allowed from this IP address',
    });
    expect(next).not.toHaveBeenCalled();
  });

  it('does not weaken the global allowlist when admin CIDRs are empty', async () => {
    getConfigMock.mockResolvedValue({
      trustedProxyCidrs: '',
      globalIpAllowlist: '203.0.113.0/24',
    });
    getAdminByIdMock.mockResolvedValue({
      id: 1,
      name: 'Robin Admin',
      email: 'admin@example.com',
      role: 'admin',
      allowedCidrs: [],
      disabled: false,
    });

    const req = {
      socket: { remoteAddress: '198.51.100.10' },
      session: {
        admin: {
          id: 1,
          name: 'Robin Admin',
          email: 'admin@example.com',
          role: 'admin',
          allowedCidrs: [],
        },
      },
    } as any;
    const res = {
      status: vi.fn().mockReturnThis(),
      json: vi.fn(),
    } as any;
    const next = vi.fn();

    await enforceIpRestrictions(req, res, next);

    expect(res.status).toHaveBeenCalledWith(403);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'IP address is not allowed' });
    expect(next).not.toHaveBeenCalled();
  });

  it('destroys the session and rejects when the account has since been disabled', async () => {
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '', globalIpAllowlist: '' });
    getAdminByIdMock.mockResolvedValue({
      id: 1,
      name: 'Robin Admin',
      email: 'admin@example.com',
      role: 'admin',
      allowedCidrs: [],
      disabled: true,
    });

    const destroy = vi.fn((cb: () => void) => cb());
    const req = {
      socket: { remoteAddress: '203.0.113.11' },
      session: {
        admin: { id: 1, name: 'Robin Admin', email: 'admin@example.com', role: 'admin', allowedCidrs: [] },
        destroy,
      },
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await enforceIpRestrictions(req, res, next);

    expect(destroy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(res.json).toHaveBeenCalledWith({ success: false, error: 'Session no longer valid' });
    expect(next).not.toHaveBeenCalled();
  });

  it('destroys the session and rejects when the account no longer exists', async () => {
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '', globalIpAllowlist: '' });
    getAdminByIdMock.mockResolvedValue(null);

    const destroy = vi.fn((cb: () => void) => cb());
    const req = {
      socket: { remoteAddress: '203.0.113.11' },
      session: {
        admin: { id: 1, name: 'Robin Admin', email: 'admin@example.com', role: 'admin', allowedCidrs: [] },
        destroy,
      },
    } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();

    await enforceIpRestrictions(req, res, next);

    expect(destroy).toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
  });
});

describe('session identity binding', () => {
  const uid = 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4';

  beforeEach(() => {
    vi.clearAllMocks();
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '', globalIpAllowlist: '' });
    getAdminByIdMock.mockResolvedValue({ id: 7, uid, name: 'Updated', email: 'new@example.test', role: 'viewer', allowedCidrs: [], disabled: false });
  });

  it.each([undefined, 'a980195e-f1a0-43cd-80c3-df8d12c17136'])('rejects legacy or reused-ID sessions with UUID %s', async sessionUid => {
    const destroy = vi.fn();
    const req = { socket: { remoteAddress: '127.0.0.1' }, session: { admin: { id: 7, uid: sessionUid }, destroy } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();
    await enforceIpRestrictions(req, res, next);
    expect(destroy).toHaveBeenCalledOnce();
    expect(res.status).toHaveBeenCalledWith(401);
    expect(next).not.toHaveBeenCalled();
    expect(req.session.admin.uid).toBe(sessionUid);
  });

  it('refreshes mutable attributes without replacing the authenticated UUID', async () => {
    const req = { socket: { remoteAddress: '127.0.0.1' }, session: { admin: { id: 7, uid, name: 'Old', email: 'old@example.test', role: 'admin' } } } as any;
    const res = { status: vi.fn().mockReturnThis(), json: vi.fn() } as any;
    const next = vi.fn();
    await enforceIpRestrictions(req, res, next);
    expect(next).toHaveBeenCalledWith();
    expect(req.session.admin).toMatchObject({ id: 7, uid, name: 'Updated', email: 'new@example.test', role: 'viewer' });
    expect(res.status).not.toHaveBeenCalled();
  });
});

describe('getTrustedClientIp', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('ignores X-Forwarded-For when no trusted proxy CIDRs are configured', async () => {
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '', globalIpAllowlist: '' });

    const req = {
      headers: { 'x-forwarded-for': '203.0.113.50' },
      socket: { remoteAddress: '198.51.100.10' },
      ip: '203.0.113.50',
    } as any;

    await expect(getTrustedClientIp(req)).resolves.toBe('198.51.100.10');
  });

  it('honors X-Forwarded-For only when the socket peer is a trusted proxy', async () => {
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '198.51.100.0/24', globalIpAllowlist: '' });

    const req = {
      headers: { 'x-forwarded-for': '203.0.113.50, 198.51.100.10' },
      socket: { remoteAddress: '198.51.100.10' },
    } as any;

    await expect(getTrustedClientIp(req)).resolves.toBe('203.0.113.50');
  });

  it('ignores X-Forwarded-For when the socket peer is not a trusted proxy', async () => {
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '198.51.100.0/24', globalIpAllowlist: '' });

    const req = {
      headers: { 'x-forwarded-for': '203.0.113.50' },
      socket: { remoteAddress: '192.0.2.10' },
    } as any;

    await expect(getTrustedClientIp(req)).resolves.toBe('192.0.2.10');
  });

  it('trusts a same-host reverse proxy without configuration', async () => {
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '', globalIpAllowlist: '' });

    const req = {
      headers: { 'x-forwarded-for': '203.0.113.50' },
      socket: { remoteAddress: '::ffff:127.0.0.1' },
    } as any;

    await expect(getTrustedClientIp(req)).resolves.toBe('203.0.113.50');
  });

  it('takes the nearest untrusted hop, not a forged leftmost entry', async () => {
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '', globalIpAllowlist: '' });

    const req = {
      headers: { 'x-forwarded-for': '127.0.0.1, 10.0.0.5, 203.0.113.50' },
      socket: { remoteAddress: '127.0.0.1' },
    } as any;

    await expect(getTrustedClientIp(req)).resolves.toBe('203.0.113.50');
  });

  it('keeps a direct same-host producer as loopback', async () => {
    getConfigMock.mockResolvedValue({ trustedProxyCidrs: '', globalIpAllowlist: '' });

    const req = { headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any;

    await expect(getTrustedClientIp(req)).resolves.toBe('127.0.0.1');
  });
});

describe('isLoopbackConnection', () => {
  it('is true for a direct same-host connection', () => {
    expect(isLoopbackConnection({ headers: {}, socket: { remoteAddress: '127.0.0.1' } } as any)).toBe(true);
  });

  it('is false for a visitor forwarded by a same-host proxy', () => {
    expect(isLoopbackConnection({ headers: { 'x-forwarded-for': '203.0.113.50' }, socket: { remoteAddress: '127.0.0.1' } } as any)).toBe(false);
  });

  it('is false for a remote connection', () => {
    expect(isLoopbackConnection({ headers: {}, socket: { remoteAddress: '203.0.113.50' } } as any)).toBe(false);
  });
});
