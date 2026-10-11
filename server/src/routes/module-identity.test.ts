import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import router from './module-identity.js';
import { csrfProtection } from '../middleware/security.js';

const mocks = vi.hoisted(() => ({
  status: vi.fn(),
  prepare: vi.fn(),
  acknowledge: vi.fn(),
  activate: vi.fn(),
  cancel: vi.fn(),
  prepareRetirement: vi.fn(),
  retire: vi.fn(),
  rollback: vi.fn(),
  ip: vi.fn(),
}));

vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(async () => ({ csrfProtectionEnabled: true })),
  getConfigValue: vi.fn(),
}));
vi.mock('../middleware/security.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../middleware/security.js')>();
  return { ...actual, getTrustedClientIp: mocks.ip };
});
vi.mock('../services/module-identity.js', () => ({
  ModuleIdentityRotationError: class extends Error {
    constructor(message: string, public status = 409) { super(message); }
  },
  getModuleIdentityRotationStatus: mocks.status,
  prepareModuleIdentityRotation: mocks.prepare,
  acknowledgeModuleIdentityTrust: mocks.acknowledge,
  activateModuleIdentityRotation: mocks.activate,
  cancelModuleIdentityRotation: mocks.cancel,
  prepareModuleIdentityRetirement: mocks.prepareRetirement,
  retireModuleIdentityKey: mocks.retire,
  rollbackModuleIdentityRotation: mocks.rollback,
}));

let server: Server;
let baseUrl: string;
let role: 'admin' | 'viewer' = 'admin';
const status = {
  issuer: 'urn:robin-admin:fixture',
  trust: { issuer: 'urn:robin-admin:fixture', keys: [{ kid: 'public-fixture', kty: 'OKP', crv: 'Ed25519', x: 'public', alg: 'EdDSA', use: 'sig' }] },
  trustFingerprint: 'a'.repeat(64),
  stage: 'stable',
  active: { kid: 'public-fixture', createdAt: new Date(0).toISOString() },
  pending: null,
  retiring: null,
  retentionMs: 360_000,
  configuredModules: ['robin-tools'],
  affectedModules: [],
  activationReadiness: [],
  retirementReadiness: [],
};

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    Object.assign(req, {
      session: {
        admin: { id: 42, uid: '9dc7be9a-5fb7-4fd9-990e-b8b51297cae0', role },
        csrfToken: 'fixture-csrf-token',
      },
    });
    next();
  });
  app.use(csrfProtection);
  app.use('/module-identity', router);
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
});

beforeEach(() => {
  vi.clearAllMocks();
  role = 'admin';
  mocks.status.mockResolvedValue(status);
  mocks.ip.mockResolvedValue('127.0.0.1');
});

it('requires an admin browser role and serves no-store public-only rotation state', async () => {
  role = 'viewer';
  expect((await fetch(`${baseUrl}/module-identity`)).status).toBe(403);
  role = 'admin';
  const response = await fetch(`${baseUrl}/module-identity`);
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
  const body = await response.json() as { data: typeof status };
  expect(body.data.trust.keys[0]).not.toHaveProperty('d');
});

it('enforces CSRF for browser mutations and records the authenticated actor and client IP', async () => {
  const blocked = await fetch(`${baseUrl}/module-identity/prepare`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  expect(blocked.status).toBe(403);
  expect(mocks.prepare).not.toHaveBeenCalled();

  const response = await fetch(`${baseUrl}/module-identity/prepare`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'fixture-csrf-token' },
    body: '{}',
  });
  expect(response.status).toBe(200);
  expect(mocks.prepare).toHaveBeenCalledWith({ adminId: 42, ipAddress: '127.0.0.1' });
});

it('rejects unsupported fields and requires literal rollback acknowledgement', async () => {
  const invalid = await fetch(`${baseUrl}/module-identity/activate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'fixture-csrf-token' },
    body: JSON.stringify({ issuer: 'attacker-controlled' }),
  });
  expect(invalid.status).toBe(400);
  expect(mocks.activate).not.toHaveBeenCalled();
  const rollback = await fetch(`${baseUrl}/module-identity/rollback`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'fixture-csrf-token' },
    body: JSON.stringify({ acknowledge: false }),
  });
  expect(rollback.status).toBe(400);
  expect(mocks.rollback).not.toHaveBeenCalled();
});

it('requires exact per-module readiness fields', async () => {
  const response = await fetch(`${baseUrl}/module-identity/acknowledgements`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': 'fixture-csrf-token' },
    body: JSON.stringify({ phase: 'activation', moduleSlug: 'robin-tools', evidence: 'restarted backend and loaded trust' }),
  });
  expect(response.status).toBe(200);
  expect(mocks.acknowledge).toHaveBeenCalledWith(
    { adminId: 42, ipAddress: '127.0.0.1' },
    'activation',
    'robin-tools',
    'restarted backend and loaded trust',
  );
});
