import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { decodeJwt, decodeProtectedHeader } from 'jose';

const database = vi.hoisted(() => ({
  value: null as string | null,
  audits: [] as Array<{ action: string; oldValues: string; newValues: string }>,
  lockTail: Promise<void>,
}));
database.lockTail = Promise.resolve();

vi.mock('../config.js', () => ({
  config: { moduleProxySecrets: { 'robin-qa': 'fixture-secret', 'robin-tools': 'fixture-secret' } },
}));
vi.mock('../db/connection.js', () => ({
  query: async (sql: string) => sql.startsWith('SELECT value FROM admin_config')
    ? { rows: database.value === null ? [] : [{ value: database.value }] }
    : { rows: [] },
  getClient: async () => {
    let value = database.value;
    const audits: typeof database.audits = [];
    let releaseLock: (() => void) | undefined;
    const client = {
      async query(sql: string, values: unknown[] = []) {
        if (sql === 'BEGIN') return { rows: [] };
        if (sql.includes('pg_advisory_xact_lock')) {
          const previous = database.lockTail;
          let release!: () => void;
          database.lockTail = new Promise<void>(resolve => { release = resolve; });
          await previous;
          value = database.value;
          releaseLock = release;
          return { rows: [] };
        }
        if (sql.startsWith('SELECT value FROM admin_config')) {
          return { rows: value === null ? [] : [{ value }] };
        }
        if (sql.startsWith('INSERT INTO admin_config')) {
          value = values[1] as string;
          return { rows: [] };
        }
        if (sql.startsWith('UPDATE admin_config')) {
          value = values[1] as string;
          return { rows: [] };
        }
        if (sql.startsWith('INSERT INTO admin_audit_log')) {
          audits.push({ action: String(values[1]), oldValues: String(values[3]), newValues: String(values[4]) });
          return { rows: [] };
        }
        if (sql === 'COMMIT') {
          database.value = value;
          database.audits.push(...audits);
          releaseLock?.();
          releaseLock = undefined;
          return { rows: [] };
        }
        if (sql === 'ROLLBACK') {
          releaseLock?.();
          releaseLock = undefined;
          return { rows: [] };
        }
        throw new Error(`Unexpected fixture SQL: ${sql}`);
      },
      release() {
        releaseLock?.();
        releaseLock = undefined;
      },
    };
    return client;
  },
}));

import { decryptStoredSecret } from '../db/queries/secret-crypto.js';
import {
  acknowledgeModuleIdentityTrust,
  activateModuleIdentityRotation,
  cancelModuleIdentityRotation,
  getModuleIdentityRotationStatus,
  MODULE_IDENTITY_RETENTION_MS,
  prepareModuleIdentityRetirement,
  prepareModuleIdentityRotation,
  publishModuleIdentityTrust,
  retireModuleIdentityKey,
  rollbackModuleIdentityRotation,
  signModuleIdentity,
} from './module-identity.js';
import { createIdentityVerifier } from './module-identity-protocol.js';

const actor = { adminId: 10, ipAddress: '127.0.0.1' };
const admin = { adminId: 10, uid: '9dc7be9a-5fb7-4fd9-990e-b8b51297cae0', role: 'admin' as const, name: 'Fixture', email: 'fixture@example.test' };
let exportDirectory: string;
let exportFile: string;
const originalEncryptionKey = process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
const originalTrustPath = process.env.MODULE_IDENTITY_TRUST_EXPORT_FILE;

async function acknowledge(phase: 'activation' | 'retirement') {
  await acknowledgeModuleIdentityTrust(actor, phase, 'robin-qa', 'Restarted robin-qa and loaded the exported public trust.');
  await acknowledgeModuleIdentityTrust(actor, phase, 'robin-tools', 'Restarted robin-tools and loaded the exported public trust.');
}

beforeEach(async () => {
  vi.useRealTimers();
  database.value = null;
  database.audits = [];
  database.lockTail = Promise.resolve();
  process.env.ROBIN_ADMIN_ENCRYPTION_KEY = 'identity-rotation-fixture-encryption-key';
  exportDirectory = await mkdtemp(path.join(os.tmpdir(), 'robin-admin-identity-'));
  exportFile = path.join(exportDirectory, 'trust.json');
  process.env.MODULE_IDENTITY_TRUST_EXPORT_FILE = exportFile;
});

afterEach(async () => {
  vi.useRealTimers();
  if (originalEncryptionKey === undefined) delete process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
  else process.env.ROBIN_ADMIN_ENCRYPTION_KEY = originalEncryptionKey;
  if (originalTrustPath === undefined) delete process.env.MODULE_IDENTITY_TRUST_EXPORT_FILE;
  else process.env.MODULE_IDENTITY_TRUST_EXPORT_FILE = originalTrustPath;
  await rm(exportDirectory, { recursive: true, force: true });
});

describe('module identity signing-key rotation', () => {
  it('pre-publishes overlapping trust, requires per-backend readiness, activates atomically, and retires only after restart acknowledgements', async () => {
    const initial = await getModuleIdentityRotationStatus();
    const oldKid = initial.active.kid;
    const oldAssertion = await signModuleIdentity('robin-tools', admin, undefined, 'GET', '/health', Buffer.alloc(0), new Headers());
    await prepareModuleIdentityRotation(actor);
    const pending = await getModuleIdentityRotationStatus();
    expect(pending.stage).toBe('pending');
    expect(pending.trust.keys.map(key => key.kid)).toEqual(expect.arrayContaining([oldKid, pending.pending!.kid]));
    expect(pending.activationReadiness.map(item => item.moduleSlug)).toEqual(['robin-qa', 'robin-tools']);
    expect(pending.trust.keys.every(key => !Object.hasOwn(key, 'd'))).toBe(true);
    const plaintext = decryptStoredSecret(database.value!);
    expect(plaintext).toContain('PRIVATE KEY');
    expect(database.value).not.toContain('PRIVATE KEY');
    await expect(activateModuleIdentityRotation(actor)).rejects.toThrow('Trust readiness is missing');

    await acknowledge('activation');
    const acknowledgedState = JSON.parse(decryptStoredSecret(database.value!)) as {
      activationAcks: Array<{ moduleSlug: string; keyId: string; trustFingerprint: string; evidence: string }>;
      affectedModules: string[];
    };
    expect(acknowledgedState.affectedModules).toEqual(['robin-qa', 'robin-tools']);
    expect(acknowledgedState.activationAcks).toEqual(expect.arrayContaining([
      expect.objectContaining({ moduleSlug: 'robin-tools', keyId: pending.pending!.kid, trustFingerprint: pending.trustFingerprint }),
    ]));
    const [racingAssertion] = await Promise.all([
      signModuleIdentity('robin-tools', admin, undefined, 'GET', '/health', Buffer.alloc(0), new Headers()),
      activateModuleIdentityRotation(actor),
    ]);
    const racingClaims = decodeJwt(racingAssertion);
    const activated = await getModuleIdentityRotationStatus();
    expect(activated.stage).toBe('retiring');
    expect(activated.active.kid).toBe(pending.pending!.kid);
    expect(activated.retiring?.kid).toBe(oldKid);
    if (decodeProtectedHeader(racingAssertion).kid === oldKid) {
      expect(Date.parse(activated.retiring!.retireAfter)).toBeGreaterThanOrEqual(
        (racingClaims.issuedAtMs as number) + MODULE_IDENTITY_RETENTION_MS,
      );
    } else {
      expect(decodeProtectedHeader(racingAssertion).kid).toBe(activated.active.kid);
    }
    expect(activated.trust.keys.map(key => key.kid)).toEqual(expect.arrayContaining([oldKid, activated.active.kid]));
    const overlapVerifier = createIdentityVerifier(JSON.stringify(activated.trust), 'robin-tools', 0);
    await expect(overlapVerifier(oldAssertion, 'GET', '/health', Buffer.alloc(0))).resolves.toMatchObject({ uid: admin.uid });
    const newAssertion = await signModuleIdentity('robin-tools', admin, undefined, 'GET', '/health', Buffer.alloc(0), new Headers());
    expect(decodeProtectedHeader(newAssertion).kid).toBe(activated.active.kid);
    await expect(prepareModuleIdentityRetirement(actor)).rejects.toThrow('must remain published');

    vi.setSystemTime(new Date(Date.parse(activated.retiring!.retireAfter) + 1));
    await prepareModuleIdentityRetirement(actor);
    const preparedRetirement = await getModuleIdentityRotationStatus();
    expect(preparedRetirement.trust.keys.map(key => key.kid)).toEqual([activated.active.kid]);
    await expect(retireModuleIdentityKey(actor)).rejects.toThrow('Retirement readiness is missing');
    await acknowledge('retirement');
    await retireModuleIdentityKey(actor);
    const retired = await getModuleIdentityRotationStatus();
    expect(retired.stage).toBe('stable');
    expect(retired.retiring).toBeNull();
    expect(retired.trust.keys.map(key => key.kid)).toEqual([activated.active.kid]);
    const retiredState = JSON.parse(decryptStoredSecret(database.value!)) as {
      activationAcks: Array<{ evidence: string }>;
      retirementAcks: Array<{ evidence: string }>;
    };
    expect(retiredState.activationAcks[0].evidence).toContain('Restarted robin-qa');
    expect(retiredState.retirementAcks[0].evidence).toContain('Restarted robin-qa');
    expect(database.audits.map(entry => entry.action)).toEqual([
      'module_identity.prepare',
      'module_identity.acknowledge',
      'module_identity.acknowledge',
      'module_identity.activate',
      'module_identity.retirement_prepare',
      'module_identity.acknowledge',
      'module_identity.acknowledge',
      'module_identity.retire',
    ]);
    await publishModuleIdentityTrust();
    const published = JSON.parse(await readFile(exportFile, 'utf8'));
    expect(published).toEqual(retired.trust);
    expect(JSON.stringify(published)).not.toContain('PRIVATE KEY');
  });

  it('cancels a pending key and rolls back to the retained signer without dropping either trust pin', async () => {
    const initial = await getModuleIdentityRotationStatus();
    const originalKid = initial.active.kid;
    await prepareModuleIdentityRotation(actor);
    const cancelledKid = (await getModuleIdentityRotationStatus()).pending!.kid;
    await cancelModuleIdentityRotation(actor);
    expect((await getModuleIdentityRotationStatus()).trust.keys.map(key => key.kid)).toEqual([originalKid]);
    expect(database.value).not.toContain(cancelledKid);

    await prepareModuleIdentityRotation(actor);
    const pending = await getModuleIdentityRotationStatus();
    await acknowledge('activation');
    await activateModuleIdentityRotation(actor);
    await rollbackModuleIdentityRotation(actor);
    const rolledBack = await getModuleIdentityRotationStatus();
    expect(rolledBack.active.kid).toBe(originalKid);
    expect(rolledBack.retiring?.kid).toBe(pending.pending!.kid);
    expect(rolledBack.trust.keys.map(key => key.kid)).toEqual(expect.arrayContaining([originalKid, pending.pending!.kid]));
    vi.setSystemTime(new Date(Date.parse(rolledBack.retiring!.retireAfter) + 1));
    await prepareModuleIdentityRetirement(actor);
    await expect(rollbackModuleIdentityRotation(actor)).rejects.toThrow('Rollback is blocked');
  }, 15_000);

  it('migrates the legacy encrypted key in place and never replaces unreadable stored material', async () => {
    const legacyPair = generateKeyPairSync('ed25519', {
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    database.value = (await import('../db/queries/secret-crypto.js')).encryptStoredSecret(JSON.stringify({
      issuer: 'urn:robin-admin:fixture-issuer',
      kid: 'fixture-legacy-kid',
      privateKey: legacyPair.privateKey,
    }));
    const migrated = await getModuleIdentityRotationStatus();
    expect(migrated.issuer).toBe('urn:robin-admin:fixture-issuer');
    expect(migrated.active.kid).toBe('fixture-legacy-kid');
    expect(JSON.parse(decryptStoredSecret(database.value!))).toMatchObject({ version: 2, issuer: migrated.issuer });
    const unreadable = '{"version":1}';
    database.value = unreadable;
    await expect(getModuleIdentityRotationStatus()).rejects.toThrow();
    expect(database.value).toBe(unreadable);
  });

  it('rolls back persisted changes and audit entries when public trust export fails', async () => {
    const initial = await getModuleIdentityRotationStatus();
    await rm(exportFile, { force: true });
    await mkdir(exportFile);
    await expect(prepareModuleIdentityRotation(actor)).rejects.toThrow();
    expect((await getModuleIdentityRotationStatus()).active.kid).toBe(initial.active.kid);
    expect((await getModuleIdentityRotationStatus()).pending).toBeNull();
    expect(database.audits).toEqual([]);
  });

  it('serializes competing prepare requests and leaves exactly one pending key', async () => {
    await getModuleIdentityRotationStatus();
    const results = await Promise.allSettled([
      prepareModuleIdentityRotation(actor),
      prepareModuleIdentityRotation(actor),
    ]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toHaveLength(1);
    expect((await getModuleIdentityRotationStatus()).pending).not.toBeNull();
  });
});
