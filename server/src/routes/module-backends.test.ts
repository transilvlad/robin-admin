import { describe, expect, it } from 'vitest';
import type { Request } from 'express';
import { buildModuleProxyHeaders, isModuleAssetRequest } from './module-backends.js';
import { getCurrentAdmin } from '../middleware/auth.js';

describe('module backend proxy headers', () => {
  it('does not forward Admin credentials to module backends', async () => {
    const headers = buildModuleProxyHeaders({
      cookie: 'connect.sid=secret',
      authorization: 'Bearer admin-secret',
      'x-csrf-token': 'csrf-secret',
      'accept-language': 'en',
      'x-robin-admin-uid': 'client-forged-identity',
      'x-robin-admin-id': '999',
      'x-robin-admin-role': 'viewer',
    }, {
      adminId: 7,
      uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4',
      role: 'admin',
      email: 'admin@example.test',
      name: 'Admin',
      allowedCidrs: [],
    }, 'module-specific-secret-with-at-least-32-characters');
    expect(headers.get('cookie')).toBeNull();
    expect(headers.get('authorization')).toBeNull();
    expect(headers.get('x-csrf-token')).toBeNull();
    expect(headers.get('accept-language')).toBe('en');
    expect(headers.get('x-robin-admin-id')).toBe('7');
    expect(headers.get('x-robin-admin-uid')).toBe('aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4');
    expect(headers.get('x-robin-admin-role')).toBe('admin');
  });

  it.each([7, null])('omits user UUIDs for API keys with creator %s even alongside a session', createdBy => {
    const principal = getCurrentAdmin({
      apiKey: { createdBy, name: 'Automation', role: 'viewer' },
      session: { admin: { id: 7, uid: 'aee695ef-d8d7-4e15-a27e-e47e9b2b0ce4' } },
    } as unknown as Request);
    const headers = buildModuleProxyHeaders({ 'x-robin-admin-uid': 'client-forged-identity' }, principal, 'module-secret');
    expect(headers.get('x-robin-admin-uid')).toBeNull();
    expect(headers.get('x-robin-admin-id')).toBe(String(createdBy ?? 0));
    expect(headers.get('x-robin-admin-role')).toBe('viewer');
  });

  it('does not manufacture identities for unauthenticated calls', () => {
    const headers = buildModuleProxyHeaders({ 'x-robin-admin-uid': 'client-forged-identity' }, null, 'module-secret');
    expect(headers.get('x-robin-admin-uid')).toBeNull();
    expect(headers.get('x-robin-admin-id')).toBeNull();
  });
});

describe('module asset route detection', () => {
  it('proxies built assets but lets hosted module routes fall through to the Admin SPA', () => {
    expect(isModuleAssetRequest({ params: { path: ['remoteEntry.js'] } } as unknown as Request)).toBe(true);
    expect(isModuleAssetRequest({ params: { path: ['assets', 'index-abc123.js'] } } as unknown as Request)).toBe(true);
    expect(isModuleAssetRequest({ params: { path: ['sync'] } } as unknown as Request)).toBe(false);
    expect(isModuleAssetRequest({ params: { path: ['licenses', 'active'] } } as unknown as Request)).toBe(false);
  });
});
