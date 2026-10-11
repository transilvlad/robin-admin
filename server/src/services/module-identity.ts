import { createHash, generateKeyPairSync, randomUUID, createPrivateKey, createPublicKey } from 'node:crypto';
import { SignJWT, exportJWK, type JWK } from 'jose';
import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';
import { getClient, query } from '../db/connection.js';
import { encryptStoredSecret, decryptStoredSecret } from '../db/queries/secret-crypto.js';
import { bodyDigest, identityHeadersDigest, IDENTITY_TYPE, type IdentityTrust } from './module-identity-protocol.js';
import type { SessionData } from '../types/index.js';

const KEY = 'moduleIdentitySigningKey';
const MAX_VERIFIER_LIFETIME_SECONDS = 60;
const SAFETY_MARGIN_MS = 5 * 60_000;
export const MODULE_IDENTITY_RETENTION_MS = MAX_VERIFIER_LIFETIME_SECONDS * 1000 + SAFETY_MARGIN_MS;

interface SigningKey {
  kid: string;
  privateKey: string;
  createdAt: string;
}

interface RetiringKey extends SigningKey {
  retireAfter: string;
  trustRemovalPreparedAt: string | null;
}

interface ReadinessAcknowledgement {
  moduleSlug: string;
  keyId: string;
  trustFingerprint: string;
  evidence: string;
  acknowledgedAt: string;
}

interface StoredIdentity {
  version: 2;
  issuer: string;
  active: SigningKey;
  pending: SigningKey | null;
  retiring: RetiringKey | null;
  affectedModules: string[];
  activationAcks: ReadinessAcknowledgement[];
  retirementAcks: ReadinessAcknowledgement[];
}

export interface ModuleIdentityActor {
  adminId: number;
  ipAddress: string;
}

export type ModuleIdentityReadinessPhase = 'activation' | 'retirement';

export class ModuleIdentityRotationError extends Error {
  constructor(message: string, public readonly status = 409) {
    super(message);
    this.name = 'ModuleIdentityRotationError';
  }
}

export interface ModuleIdentityRotationStatus {
  issuer: string;
  trust: IdentityTrust;
  trustFingerprint: string;
  stage: 'stable' | 'pending' | 'retiring' | 'retirement-ready';
  active: { kid: string; createdAt: string };
  pending: { kid: string; createdAt: string } | null;
  retiring: { kid: string; createdAt: string; retireAfter: string; trustRemovalPreparedAt: string | null } | null;
  retentionMs: number;
  trustExportConfigured: boolean;
  configuredModules: string[];
  affectedModules: string[];
  activationReadiness: Array<{ moduleSlug: string; ready: boolean; acknowledgedAt: string | null; evidence: string | null }>;
  retirementReadiness: Array<{ moduleSlug: string; ready: boolean; acknowledgedAt: string | null; evidence: string | null }>;
}

function newSigningKey(): SigningKey {
  const pair = generateKeyPairSync('ed25519', {
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  return { kid: randomUUID(), privateKey: pair.privateKey, createdAt: new Date().toISOString() };
}

function createInitialState(): StoredIdentity {
  return {
    version: 2,
    issuer: `urn:robin-admin:${randomUUID()}`,
    active: newSigningKey(),
    pending: null,
    retiring: null,
    affectedModules: [],
    activationAcks: [],
    retirementAcks: [],
  };
}

function validateSigningKey(value: unknown, label: string): SigningKey {
  if (!value || typeof value !== 'object') throw new Error(`Invalid stored module identity ${label} key`);
  const candidate = value as Partial<SigningKey>;
  if (typeof candidate.kid !== 'string' || !candidate.kid
      || typeof candidate.privateKey !== 'string' || !candidate.privateKey
      || typeof candidate.createdAt !== 'string' || !Number.isFinite(Date.parse(candidate.createdAt))) {
    throw new Error(`Invalid stored module identity ${label} key`);
  }
  const privateKey = createPrivateKey(candidate.privateKey);
  if (privateKey.asymmetricKeyType !== 'ed25519') throw new Error(`Invalid stored module identity ${label} key type`);
  return { kid: candidate.kid, privateKey: candidate.privateKey, createdAt: new Date(candidate.createdAt).toISOString() };
}

function validateAcknowledgements(value: unknown): ReadinessAcknowledgement[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error('Invalid stored module identity readiness records');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object') throw new Error('Invalid stored module identity readiness record');
    const acknowledgement = entry as Partial<ReadinessAcknowledgement>;
    if (typeof acknowledgement.moduleSlug !== 'string' || !acknowledgement.moduleSlug
        || typeof acknowledgement.keyId !== 'string' || !acknowledgement.keyId
        || typeof acknowledgement.trustFingerprint !== 'string' || !/^[a-f0-9]{64}$/.test(acknowledgement.trustFingerprint)
        || typeof acknowledgement.evidence !== 'string' || !acknowledgement.evidence
        || typeof acknowledgement.acknowledgedAt !== 'string' || !Number.isFinite(Date.parse(acknowledgement.acknowledgedAt))) {
      throw new Error('Invalid stored module identity readiness record');
    }
    return {
      moduleSlug: acknowledgement.moduleSlug,
      keyId: acknowledgement.keyId,
      trustFingerprint: acknowledgement.trustFingerprint,
      evidence: acknowledgement.evidence,
      acknowledgedAt: new Date(acknowledgement.acknowledgedAt).toISOString(),
    };
  });
}

function parseStoredIdentity(value: string): StoredIdentity {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decryptStoredSecret(value));
  } catch (error) {
    throw new Error(`Unable to read stored module identity signing keys: ${(error as Error).message}`);
  }
  if (!parsed || typeof parsed !== 'object') throw new Error('Stored module identity signing keys are invalid');
  const record = parsed as Record<string, unknown>;
  if (record.version !== 2) {
    if (record.version !== undefined || typeof record.issuer !== 'string' || !record.issuer
        || typeof record.kid !== 'string' || !record.kid || typeof record.privateKey !== 'string' || !record.privateKey) {
      throw new Error('Stored module identity signing keys use an unsupported format');
    }
    return {
      version: 2,
      issuer: record.issuer,
      active: validateSigningKey({ kid: record.kid, privateKey: record.privateKey, createdAt: new Date(0).toISOString() }, 'active'),
      pending: null,
      retiring: null,
      affectedModules: [],
      activationAcks: [],
      retirementAcks: [],
    };
  }

  if (typeof record.issuer !== 'string' || !record.issuer) throw new Error('Stored module identity issuer is invalid');
  const active = validateSigningKey(record.active, 'active');
  const pending = record.pending === null || record.pending === undefined ? null : validateSigningKey(record.pending, 'pending');
  let retiring: RetiringKey | null = null;
  if (record.retiring !== null && record.retiring !== undefined) {
    const key = validateSigningKey(record.retiring, 'retiring');
    const candidate = record.retiring as Partial<RetiringKey>;
    if (typeof candidate.retireAfter !== 'string' || !Number.isFinite(Date.parse(candidate.retireAfter))
        || (candidate.trustRemovalPreparedAt !== null && candidate.trustRemovalPreparedAt !== undefined
          && (typeof candidate.trustRemovalPreparedAt !== 'string' || !Number.isFinite(Date.parse(candidate.trustRemovalPreparedAt))))) {
      throw new Error('Invalid stored module identity retiring key state');
    }
    retiring = {
      ...key,
      retireAfter: new Date(candidate.retireAfter).toISOString(),
      trustRemovalPreparedAt: candidate.trustRemovalPreparedAt ? new Date(candidate.trustRemovalPreparedAt).toISOString() : null,
    };
  }
  if ((pending && retiring) || new Set([active.kid, pending?.kid, retiring?.kid].filter(Boolean)).size !== 1 + Number(Boolean(pending)) + Number(Boolean(retiring))) {
    throw new Error('Stored module identity key stages conflict');
  }
  return {
    version: 2,
    issuer: record.issuer,
    active,
    pending,
    retiring,
    affectedModules: Array.isArray(record.affectedModules)
      && record.affectedModules.every((slug) => typeof slug === 'string' && slug)
      ? [...new Set(record.affectedModules as string[])].sort()
      : record.affectedModules === undefined ? [] : (() => { throw new Error('Invalid stored module identity affected modules'); })(),
    activationAcks: validateAcknowledgements(record.activationAcks),
    retirementAcks: validateAcknowledgements(record.retirementAcks),
  };
}

async function keyJwk(key: SigningKey): Promise<JWK> {
  return {
    ...await exportJWK(createPublicKey(createPrivateKey(key.privateKey))),
    kid: key.kid,
    alg: 'EdDSA',
    use: 'sig',
  };
}

async function trustForState(state: StoredIdentity): Promise<IdentityTrust> {
  const keys = await Promise.all([state.active, state.pending, state.retiring && !state.retiring.trustRemovalPreparedAt ? state.retiring : null]
    .filter((key): key is SigningKey => key !== null)
    .map(keyJwk));
  keys.sort((left, right) => String(left.kid).localeCompare(String(right.kid)));
  return { issuer: state.issuer, keys };
}

function fingerprint(trust: IdentityTrust): string {
  return createHash('sha256').update(JSON.stringify(trust)).digest('hex');
}

async function publishTrust(trust: IdentityTrust): Promise<void> {
  const file = process.env.MODULE_IDENTITY_TRUST_EXPORT_FILE;
  if (!file) return;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o755 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(trust), { mode: 0o644 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

async function migrateLegacyIdentity(): Promise<StoredIdentity> {
  return initializeOrMigrate(false);
}

async function initializeIdentity(): Promise<StoredIdentity> {
  return initializeOrMigrate(true);
}

async function initializeOrMigrate(createIfMissing: boolean): Promise<StoredIdentity> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('robin-module-identity'))");
    const result = await client.query<{ value: string }>('SELECT value FROM admin_config WHERE key = $1', [KEY]);
    if (result.rows[0]) {
      const state = parseStoredIdentity(result.rows[0].value);
      const decoded = JSON.parse(decryptStoredSecret(result.rows[0].value)) as Record<string, unknown>;
      if (decoded.version !== 2) {
        await client.query('UPDATE admin_config SET value = $2, updated_at = CURRENT_TIMESTAMP WHERE key = $1', [KEY, encryptStoredSecret(JSON.stringify(state))]);
      }
      await client.query('COMMIT');
      return state;
    }
    if (!createIfMissing) throw new Error('Module identity signing key disappeared during migration');
    const state = createInitialState();
    await client.query('INSERT INTO admin_config (key, value) VALUES ($1, $2)', [KEY, encryptStoredSecret(JSON.stringify(state))]);
    await client.query('COMMIT');
    return state;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function getState(): Promise<StoredIdentity> {
  const result = await query<{ value: string }>('SELECT value FROM admin_config WHERE key = $1', [KEY]);
  if (!result.rows[0]) return initializeIdentity();
  const decoded = JSON.parse(decryptStoredSecret(result.rows[0].value)) as Record<string, unknown>;
  const state = parseStoredIdentity(result.rows[0].value);
  return decoded.version === 2 ? state : migrateLegacyIdentity();
}

export async function getModuleIdentity() {
  const state = await getState();
  return {
    trust: await trustForState(state),
    privateKey: createPrivateKey(state.active.privateKey),
  };
}

export async function getModuleIdentityRotationStatus(): Promise<ModuleIdentityRotationStatus> {
  const state = await getState();
  const trust = await trustForState(state);
  const trustFingerprint = fingerprint(trust);
  const configuredModules = Object.keys(config.moduleProxySecrets).sort();
  const affectedModules = state.affectedModules;
  const readiness = (phase: ModuleIdentityReadinessPhase) => {
    const acknowledgements = phase === 'activation' ? state.activationAcks : state.retirementAcks;
    const keyId = phase === 'activation' ? state.pending?.kid ?? state.active.kid : state.retiring?.kid;
    return affectedModules.map((moduleSlug) => {
      const acknowledgement = acknowledgements.find((entry) =>
        entry.moduleSlug === moduleSlug && entry.keyId === keyId && entry.trustFingerprint === trustFingerprint);
      return {
        moduleSlug,
        ready: Boolean(acknowledgement),
        acknowledgedAt: acknowledgement?.acknowledgedAt ?? null,
        evidence: acknowledgement?.evidence ?? null,
      };
    });
  };
  return {
    issuer: state.issuer,
    trust,
    trustFingerprint,
    stage: state.pending ? 'pending' : state.retiring
      ? state.retiring.trustRemovalPreparedAt ? 'retirement-ready' : 'retiring'
      : 'stable',
    active: { kid: state.active.kid, createdAt: state.active.createdAt },
    pending: state.pending ? { kid: state.pending.kid, createdAt: state.pending.createdAt } : null,
    retiring: state.retiring ? {
      kid: state.retiring.kid,
      createdAt: state.retiring.createdAt,
      retireAfter: state.retiring.retireAfter,
      trustRemovalPreparedAt: state.retiring.trustRemovalPreparedAt,
    } : null,
    retentionMs: MODULE_IDENTITY_RETENTION_MS,
    trustExportConfigured: Boolean(process.env.MODULE_IDENTITY_TRUST_EXPORT_FILE?.trim()),
    configuredModules,
    affectedModules,
    activationReadiness: readiness('activation'),
    retirementReadiness: readiness('retirement'),
  };
}

function configuredModuleSet(): string[] {
  return Object.keys(config.moduleProxySecrets).sort();
}

function moduleSetMatches(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((slug, index) => slug === right[index]);
}

function acknowledgementsCover(
  modules: string[],
  acknowledgements: ReadinessAcknowledgement[],
  keyId: string,
  trustFingerprint: string,
): boolean {
  return modules.every((moduleSlug) =>
    acknowledgements.some((entry) => entry.moduleSlug === moduleSlug && entry.keyId === keyId && entry.trustFingerprint === trustFingerprint));
}

function auditSummary(state: StoredIdentity) {
  return {
    issuer: state.issuer,
    activeKid: state.active.kid,
    pendingKid: state.pending?.kid ?? null,
    retiringKid: state.retiring?.kid ?? null,
    retireAfter: state.retiring?.retireAfter ?? null,
    trustRemovalPreparedAt: state.retiring?.trustRemovalPreparedAt ?? null,
    activationAcknowledgements: state.activationAcks.length,
    retirementAcknowledgements: state.retirementAcks.length,
    affectedModules: [...state.affectedModules],
  };
}

async function saveTransition(
  actor: ModuleIdentityActor,
  action: string,
  change: (state: StoredIdentity) => { next: StoredIdentity; details?: Record<string, unknown> } | Promise<{ next: StoredIdentity; details?: Record<string, unknown> }>,
): Promise<StoredIdentity> {
  const client = await getClient();
  let trustExportAttempted = false;
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('robin-module-identity'))");
    const result = await client.query<{ value: string }>('SELECT value FROM admin_config WHERE key = $1 FOR UPDATE', [KEY]);
    if (!result.rows[0]) throw new Error('Module identity signing key is missing');
    const current = parseStoredIdentity(result.rows[0].value);
    const { next, details } = await change(current);
    const trust = await trustForState(next);
    await client.query(
      'UPDATE admin_config SET value = $2, updated_at = CURRENT_TIMESTAMP WHERE key = $1',
      [KEY, encryptStoredSecret(JSON.stringify(next))],
    );
    await client.query(
      `INSERT INTO admin_audit_log (admin_id, action, entity_type, entity_id, old_values, new_values, ip_address)
       VALUES ($1, $2, 'module_identity_signing', $3, $4, $5, $6)`,
      [
        actor.adminId,
        `module_identity.${action}`,
        next.issuer,
        JSON.stringify(auditSummary(current)),
        JSON.stringify({ ...auditSummary(next), ...details }),
        actor.ipAddress,
      ],
    );
    trustExportAttempted = Boolean(process.env.MODULE_IDENTITY_TRUST_EXPORT_FILE?.trim());
    await publishTrust(trust);
    await client.query('COMMIT');
    return next;
  } catch (error) {
    let rollbackError: unknown;
    try {
      await client.query('ROLLBACK');
    } catch (failure) {
      rollbackError = failure;
    }
    if (trustExportAttempted) {
      try {
        const persisted = await query<{ value: string }>('SELECT value FROM admin_config WHERE key = $1', [KEY]);
        if (!persisted.rows[0]) throw new Error('Stored module identity signing key is missing during trust-export recovery.');
        await publishTrust(await trustForState(parseStoredIdentity(persisted.rows[0].value)));
      } catch (recoveryError) {
        throw new Error(`Module identity transition failed and the public trust export could not be reconciled: ${(recoveryError as Error).message}`);
      }
    }
    if (rollbackError) {
      throw new Error(`Module identity transition failed and its database rollback also failed: ${(rollbackError as Error).message}`);
    }
    throw error;
  } finally {
    client.release();
  }
}

export async function prepareModuleIdentityRotation(actor: ModuleIdentityActor): Promise<void> {
  await saveTransition(actor, 'prepare', (state) => {
    if (state.pending || state.retiring) throw new ModuleIdentityRotationError('Finish or cancel the existing key rotation before preparing another one.');
    return {
      next: {
        ...state,
        pending: newSigningKey(),
        affectedModules: configuredModuleSet(),
        activationAcks: [],
        retirementAcks: [],
      },
    };
  });
}

export async function acknowledgeModuleIdentityTrust(
  actor: ModuleIdentityActor,
  phase: ModuleIdentityReadinessPhase,
  moduleSlug: string,
  evidence: string,
): Promise<void> {
  if (!Object.hasOwn(config.moduleProxySecrets, moduleSlug)) {
    throw new ModuleIdentityRotationError('Module is not configured with an Admin backend credential.', 404);
  }
  const note = evidence.trim();
  if (note.length < 8 || note.length > 500) {
    throw new ModuleIdentityRotationError('Readiness evidence must be between 8 and 500 characters.', 400);
  }
  await saveTransition(actor, 'acknowledge', async (state) => {
    if (phase === 'activation' && !state.pending) throw new ModuleIdentityRotationError('There is no pending key to acknowledge.');
    if (phase === 'retirement' && (!state.retiring || !state.retiring.trustRemovalPreparedAt)) {
      throw new ModuleIdentityRotationError('Prepare retirement trust before recording backend readiness.');
    }
    if (!state.affectedModules.includes(moduleSlug)) {
      throw new ModuleIdentityRotationError('This module is not part of the frozen readiness set for this rotation.');
    }
    const trustFingerprint = fingerprint(await trustForState(state));
    const field = phase === 'activation' ? 'activationAcks' : 'retirementAcks';
    const keyId = phase === 'activation' ? state.pending!.kid : state.retiring!.kid;
    const acknowledgement = {
      moduleSlug,
      keyId,
      trustFingerprint,
      evidence: note,
      acknowledgedAt: new Date().toISOString(),
    };
    return {
      next: {
        ...state,
        [field]: [...state[field].filter((entry) => entry.moduleSlug !== moduleSlug), acknowledgement],
      },
      details: {
        phase,
        moduleSlug,
        keyId,
        trustFingerprint,
        evidenceDigest: createHash('sha256').update(note).digest('hex'),
      },
    };
  });
}

export async function activateModuleIdentityRotation(actor: ModuleIdentityActor): Promise<void> {
  await saveTransition(actor, 'activate', async (state) => {
    if (!state.pending) throw new ModuleIdentityRotationError('Prepare a pending key before activation.');
    if (!moduleSetMatches(state.affectedModules, configuredModuleSet())) {
      throw new ModuleIdentityRotationError('Configured module backends changed after preparation. Cancel and prepare again so readiness covers the current set.');
    }
    const currentTrustFingerprint = fingerprint(await trustForState(state));
    const missing = state.affectedModules
      .filter((moduleSlug) => !state.activationAcks.some((entry) => entry.moduleSlug === moduleSlug
        && entry.keyId === state.pending!.kid && entry.trustFingerprint === currentTrustFingerprint));
    if (missing.length) throw new ModuleIdentityRotationError(`Trust readiness is missing for: ${missing.join(', ')}`);
    const now = new Date();
    const retiring: RetiringKey = { ...state.active, retireAfter: new Date(now.getTime() + MODULE_IDENTITY_RETENTION_MS).toISOString(), trustRemovalPreparedAt: null };
    return {
      next: { ...state, active: state.pending, pending: null, retiring, retirementAcks: [] },
      details: { activatedAt: now.toISOString(), retireAfter: retiring.retireAfter },
    };
  });
}

export async function prepareModuleIdentityRetirement(actor: ModuleIdentityActor): Promise<void> {
  await saveTransition(actor, 'retirement_prepare', (state) => {
    if (!state.retiring) throw new ModuleIdentityRotationError('There is no retiring key to remove.');
    if (Date.now() < Date.parse(state.retiring.retireAfter)) {
      throw new ModuleIdentityRotationError(`The old verification key must remain published until ${state.retiring.retireAfter}.`);
    }
    const affectedModules = configuredModuleSet();
    if (state.retiring.trustRemovalPreparedAt && moduleSetMatches(state.affectedModules, affectedModules)) {
      throw new ModuleIdentityRotationError('Retirement trust has already been prepared.');
    }
    const trustRemovalPreparedAt = new Date().toISOString();
    return {
      next: {
        ...state,
        retiring: { ...state.retiring, trustRemovalPreparedAt },
        affectedModules,
        retirementAcks: [],
      },
      details: { trustRemovalPreparedAt, affectedModules },
    };
  });
}

export async function retireModuleIdentityKey(actor: ModuleIdentityActor): Promise<void> {
  await saveTransition(actor, 'retire', async (state) => {
    if (!state.retiring?.trustRemovalPreparedAt) throw new ModuleIdentityRotationError('Prepare and publish retirement trust before retiring the key.');
    if (Date.now() < Date.parse(state.retiring.retireAfter)) throw new ModuleIdentityRotationError('The old verification-key retention interval has not elapsed.');
    if (!moduleSetMatches(state.affectedModules, configuredModuleSet())) {
      throw new ModuleIdentityRotationError('Configured module backends changed after retirement preparation. Prepare retirement again so readiness covers the current set.');
    }
    const currentTrustFingerprint = fingerprint(await trustForState(state));
    const missing = state.affectedModules
      .filter((moduleSlug) => !state.retirementAcks.some((entry) => entry.moduleSlug === moduleSlug
        && entry.keyId === state.retiring!.kid && entry.trustFingerprint === currentTrustFingerprint));
    if (missing.length) throw new ModuleIdentityRotationError(`Retirement readiness is missing for: ${missing.join(', ')}`);
    return {
      next: { ...state, retiring: null, affectedModules: [] },
      details: { retiredKid: state.retiring.kid },
    };
  });
}

export async function cancelModuleIdentityRotation(actor: ModuleIdentityActor): Promise<void> {
  await saveTransition(actor, 'cancel', (state) => {
    if (!state.pending) throw new ModuleIdentityRotationError('There is no pending key to cancel.');
    return {
      next: { ...state, pending: null, affectedModules: [] },
      details: { cancelledKid: state.pending.kid },
    };
  });
}

export async function rollbackModuleIdentityRotation(actor: ModuleIdentityActor): Promise<void> {
  await saveTransition(actor, 'rollback', (state) => {
    if (!state.retiring) throw new ModuleIdentityRotationError('There is no retained key available for rollback.');
    if (state.retiring.trustRemovalPreparedAt) {
      throw new ModuleIdentityRotationError('Rollback is blocked after retirement trust was prepared; the backends may no longer trust the retained key.');
    }
    const previousActive = state.retiring;
    const rejectedActive: RetiringKey = {
      ...state.active,
      retireAfter: new Date(Date.now() + MODULE_IDENTITY_RETENTION_MS).toISOString(),
      trustRemovalPreparedAt: null,
    };
    return {
      next: {
        ...state,
        active: { kid: previousActive.kid, privateKey: previousActive.privateKey, createdAt: previousActive.createdAt },
        retiring: rejectedActive,
      },
      details: { rolledBackToKid: previousActive.kid, retainedRejectedKidUntil: rejectedActive.retireAfter },
    };
  });
}

export async function publishModuleIdentityTrust(): Promise<void> {
  await publishTrust(await trustForState(await getState()));
}

export async function signModuleIdentity(
  slug: string,
  admin: SessionData,
  apiKeyId: number | undefined,
  method: string,
  target: string,
  body: Uint8Array,
  headers: Headers,
): Promise<string> {
  if (apiKeyId === undefined && !admin.uid) throw new Error('Missing administrator UUID');
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock_shared(hashtext('robin-module-identity'))");
    const result = await client.query<{ value: string }>('SELECT value FROM admin_config WHERE key = $1', [KEY]);
    if (!result.rows[0]) throw new Error('Stored module identity signing key is missing');
    const state = parseStoredIdentity(result.rows[0].value);
    const issuedAtMs = Date.now();
    const iat = Math.floor(issuedAtMs / 1000);
    const token = await new SignJWT({
      principal: apiKeyId === undefined ? 'admin' : 'api-key', adminId: admin.adminId,
      role: admin.role, name: admin.name, email: admin.email,
      method: method.toUpperCase(), target, digest: bodyDigest(body), headersDigest: identityHeadersDigest(name => headers.get(name)), issuedAtMs,
    }).setProtectedHeader({ alg: 'EdDSA', typ: IDENTITY_TYPE, kid: state.active.kid })
      .setSubject(apiKeyId === undefined ? admin.uid! : `api-key:${apiKeyId}`)
      .setIssuer(state.issuer).setAudience(slug).setIssuedAt(iat).setExpirationTime(iat + 30)
      .setJti(randomUUID()).sign(createPrivateKey(state.active.privateKey));
    await client.query('COMMIT');
    return token;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
