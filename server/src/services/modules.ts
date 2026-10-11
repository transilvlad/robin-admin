import { createHash, createPublicKey, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { config } from '../config.js';
import { logger } from '../logger.js';
import { getConfigValue, setConfigValue } from '../db/queries/config.js';
import {
  extractSheriffPublicKeys,
  unwrapSignedSheriffPayload,
  verifySignedSheriffToken,
  type SheriffDiscoveryDocument,
  type SheriffPublicKey,
} from './sheriff-signatures.js';
import {
  getModuleSummaryBySlug,
  getModuleLicense,
  listModuleSummaries,
  recordModuleInstall,
  refreshInstalledModuleRelease,
  recordModuleLicenseRefreshError,
  removeModuleCatalogEntriesNotIn,
  removeModuleInstall,
  replaceBootstrapInstalledModules,
  snapshotInstalledModulesFromCatalog,
  upsertModuleCatalogEntries,
  upsertModuleLicense,
  type ModuleSummary,
} from '../db/queries/modules.js';
import { extractInstallerRuntime, getAvailableInstallerActions, getInstallerUpgradeStrategy, type ModuleInstallerAction, type ModuleUpgradeStrategy } from './module-installer.js';
import { catalogModuleToUpsert, parseCatalogV1, parseEntitledModuleRelease } from './module-contract.js';
import { probeModuleRuntime, type ModuleRuntimeStatus } from './module-runtime.js';

export type { ModuleRuntimeStatus } from './module-runtime.js';

export type ModuleActivationStatus = 'active' | 'grace' | 'license-required' | 'expired' | 'invalid' | 'not-installed';
const MODULE_INSTANCE_ID_CONFIG_KEY = 'moduleInstanceId';
const MODULE_INSTANCE_PRIVATE_KEY_CONFIG_KEY = 'moduleInstancePrivateKeyPem';
const MODULE_INSTANCE_PUBLIC_KEY_CONFIG_KEY = 'moduleInstancePublicKeyPem';
const SHERIFF_PUBLIC_KEYS_CONFIG_KEY = 'moduleSheriffPublicKeysJson';
const SHERIFF_PUBLIC_KEYS_CACHE_MS = 5 * 60_000;
const MAX_LEASE_MS = 24 * 60 * 60_000;
const MAX_OFFLINE_GRACE_MS = 72 * 60 * 60_000;
const LICENSE_REFRESH_RETRY_MS = 60_000;
let sheriffPublicKeysCache: { checkedAt: number; keys: SheriffPublicKey[] } | null = null;
const moduleLicenseRefreshes = new Map<string, Promise<void>>();

export interface ModuleViewModel extends ModuleSummary {
  installerActions: ModuleInstallerAction[];
  installerUpgradeStrategy: ModuleUpgradeStrategy | null;
  configuredAuthorityUrl: string;
  deploymentLabel: string;
  requiresLicense: boolean;
  updateAvailable: boolean;
  active: boolean;
  activationStatus: ModuleActivationStatus;
  activationMessage: string | null;
  runtimeAvailable: boolean;
  runtimeStatus: ModuleRuntimeStatus;
  runtimeMessage: string | null;
}

export interface ModuleRegistryCredential {
  repository: string;
  registry: 'sheriff.robinmta.com';
  username: string;
  password: string;
  expiresAt: string;
}

interface SherifCatalogResponse {
  success?: boolean;
  data?: unknown;
}

interface SherifValidateResponse {
  success?: boolean;
  data?: {
    reason?: string;
    release?: unknown;
    license?: {
      customerName?: string | null;
      customerEmail?: string | null;
      keyPreview?: string | null;
      expiresAt?: string | null;
    } | null;
    lease?: {
      activationId?: string | null;
      leaseToken?: string | null;
      refreshCredential?: string | null;
      instanceKeyThumbprint?: string | null;
      issuedAt?: string | null;
      expiresAt?: string | null;
      offlineGraceEndsAt?: string | null;
      replacementAllowance?: number | null;
      replacementsUsed?: number | null;
      licenseExpiresAt?: string | null;
      moduleSlug?: string | null;
      customerName?: string | null;
      licenseId?: string | null;
      licenseKeySuffix?: string | null;
      instanceId?: string | null;
      instanceFingerprint?: string | null;
      remoteEntryUrl?: string | null;
    } | null;
  };
  error?: string;
}

interface SheriffChallengeResponse {
  success?: boolean;
  data?: {
    challengeId?: string;
    challenge?: string;
    expiresAt?: string;
  };
  error?: string;
}

interface SheriffV1LeaseResponse extends SherifValidateResponse {}

interface SheriffRegistryTokenResponse {
  success?: boolean;
  data?: {
    token?: string;
    expiresAt?: string;
  };
  error?: string;
}

interface VerifiedLeasePayload {
  activationId?: string;
  leaseToken?: string;
  refreshCredential?: string;
  issuedAt: string;
  expiresAt: string;
  offlineGraceEndsAt?: string;
  replacementAllowance?: number;
  replacementsUsed?: number;
  cacheTtlSeconds?: number;
  licenseExpiresAt?: string;
  moduleSlug: string;
  remoteScope?: string;
  exposedModule?: string;
  remoteEntryPath?: string;
  remoteEntryUrl?: string;
  customerName?: string;
  licenseId?: string;
  licenseKeySuffix?: string;
  instanceId?: string;
  instanceFingerprint: string;
  instanceKeyThumbprint: string;
  hostName?: string;
  robinAdminVersion?: string;
}

class SherifRequestError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly payload: Record<string, unknown> | null,
  ) {
    super(message);
  }
}

export class ModuleAccessError extends Error {
  constructor(
    message: string,
    public readonly status = 403,
  ) {
    super(message);
  }
}

export async function getSheriffBaseUrl(): Promise<string> {
  return config.sheriff.baseUrl;
}

async function resolveSheriffUrl(path: string): Promise<string> {
  const baseUrl = await getSheriffBaseUrl();
  return `${baseUrl.replace(/\/$/, '')}${path}`;
}

function parseDate(value?: string | null): Date | null {
  if (!value) {
    return null;
  }

  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function verifySheriffLeaseToken(
  leaseToken: string | null | undefined,
  expected: {
    moduleSlug: string;
    instanceFingerprint: string | null | undefined;
    instanceKeyThumbprint: string | null | undefined;
    requireUnexpired?: boolean;
  },
  publicKeys: SheriffPublicKey[] = [],
): VerifiedLeasePayload | null {
  if (!leaseToken || !expected.instanceFingerprint || !expected.instanceKeyThumbprint) {
    return null;
  }

  try {
    const verified = verifySignedSheriffToken<VerifiedLeasePayload>(leaseToken, publicKeys, {
      purpose: 'lease',
    });
    const payload = verified.payload;

    if (
      payload.moduleSlug !== expected.moduleSlug
      || payload.instanceFingerprint !== expected.instanceFingerprint
      || payload.instanceKeyThumbprint !== expected.instanceKeyThumbprint
    ) {
      return null;
    }

    const issuedAt = parseDate(payload.issuedAt)?.getTime();
    const expiresAt = parseDate(payload.expiresAt)?.getTime();
    const graceEndsAt = parseDate(payload.offlineGraceEndsAt)?.getTime();
    if (
      issuedAt === undefined || expiresAt === undefined
      || issuedAt > Date.now() + 30_000
      || expiresAt <= issuedAt || expiresAt - issuedAt > MAX_LEASE_MS
      || (payload.offlineGraceEndsAt && (graceEndsAt === undefined || graceEndsAt < expiresAt || graceEndsAt - expiresAt > MAX_OFFLINE_GRACE_MS))
      || (expected.requireUnexpired !== false && expiresAt <= Date.now())
    ) {
      return null;
    }

    return payload;
  } catch {
    return null;
  }
}

async function getModuleLicenseIdentity(): Promise<{
  instanceId: string;
  instanceFingerprint: string;
  publicKeyPem: string;
  privateKeyPem: string;
  instanceKeyThumbprint: string;
}> {
  let instanceId = await getConfigValue(MODULE_INSTANCE_ID_CONFIG_KEY);

  if (!instanceId) {
    instanceId = randomUUID();
    await setConfigValue(MODULE_INSTANCE_ID_CONFIG_KEY, instanceId);
  }

  let publicKeyPem = await getConfigValue(MODULE_INSTANCE_PUBLIC_KEY_CONFIG_KEY);
  let privateKeyPem = await getConfigValue(MODULE_INSTANCE_PRIVATE_KEY_CONFIG_KEY);

  if (!publicKeyPem || !privateKeyPem) {
    const keyPair = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    publicKeyPem = keyPair.publicKey;
    privateKeyPem = keyPair.privateKey;
    await setConfigValue(MODULE_INSTANCE_PUBLIC_KEY_CONFIG_KEY, publicKeyPem);
    await setConfigValue(MODULE_INSTANCE_PRIVATE_KEY_CONFIG_KEY, privateKeyPem);
  }

  const instanceFingerprint = createHash('sha256')
    .update(`robin-admin:${instanceId}`)
    .digest('hex');
  const instanceKeyThumbprint = createHash('sha256')
    .update(createPublicKey(publicKeyPem).export({ type: 'spki', format: 'der' }))
    .digest('base64url');

  return { instanceId, instanceFingerprint, publicKeyPem, privateKeyPem, instanceKeyThumbprint };
}

// This robin-admin deployment's stable instance fingerprint, forwarded to
// module backends (e.g. Sheriff) so they can flag which licenses are activated
// here. Cached — the identity is stable for the life of the deployment.
let cachedInstanceFingerprint: string | null = null;
export async function getLocalInstanceFingerprint(): Promise<string> {
  if (cachedInstanceFingerprint) {
    return cachedInstanceFingerprint;
  }
  const identity = await getModuleLicenseIdentity();
  cachedInstanceFingerprint = identity.instanceFingerprint;
  return cachedInstanceFingerprint;
}

function signChallenge(privateKeyPem: string, challenge: string): string {
  return sign(null, Buffer.from(challenge, 'utf8'), privateKeyPem).toString('base64url');
}

async function requestSheriffLease(
  moduleSlug: string,
  licenseKey: string,
  identity: Awaited<ReturnType<typeof getModuleLicenseIdentity>>,
  publicKeys: SheriffPublicKey[],
): Promise<SherifValidateResponse> {
  const challengeResponse = await fetchSheriffJson<SheriffChallengeResponse>('/api/v1/challenges', {
    method: 'POST',
    body: JSON.stringify({
      moduleSlug,
      instanceId: identity.instanceId,
      instanceFingerprint: identity.instanceFingerprint,
      instancePublicKey: identity.publicKeyPem,
      hostName: new URL(config.publicBaseUrl).host,
      robinAdminVersion: process.env.npm_package_version,
    }),
  });

  const challengeId = challengeResponse.data?.challengeId;
  const challenge = challengeResponse.data?.challenge;
  if (!challengeId || !challenge) {
    throw new Error('Sheriff returned an invalid activation challenge');
  }

  const rawLeaseResponse = await fetchSheriffJson<unknown>('/api/v1/licenses/leases', {
    method: 'POST',
    body: JSON.stringify({
      moduleSlug,
      licenseKey,
      instanceId: identity.instanceId,
      instanceFingerprint: identity.instanceFingerprint,
      instancePublicKey: identity.publicKeyPem,
      challengeId,
      challengeSignature: signChallenge(identity.privateKeyPem, challenge),
      hostName: new URL(config.publicBaseUrl).host,
      robinAdminVersion: process.env.npm_package_version,
    }),
  });
  return unwrapSignedSheriffPayload<SheriffV1LeaseResponse>(rawLeaseResponse, publicKeys, {
    purpose: 'license lease',
  }).payload;
}

async function requestSheriffRefresh(
  refreshCredential: string,
  identity: Awaited<ReturnType<typeof getModuleLicenseIdentity>>,
  publicKeys: SheriffPublicKey[],
): Promise<SherifValidateResponse> {
  const refreshSignature = signChallenge(
    identity.privateKeyPem,
    `refresh:${refreshCredential}:${identity.instanceId}`,
  );
  const rawResponse = await fetchSheriffJson<unknown>('/api/v1/licenses/refresh', {
    method: 'POST',
    body: JSON.stringify({
      refreshCredential,
      instanceId: identity.instanceId,
      instancePublicKey: identity.publicKeyPem,
      refreshSignature,
      hostName: new URL(config.publicBaseUrl).host,
    }),
  });
  try {
    return unwrapSignedSheriffPayload<SheriffV1LeaseResponse>(rawResponse, publicKeys, {
      purpose: 'license refresh',
    }).payload;
  } catch (error) {
    throw new SherifRequestError((error as Error).message, 422, null);
  }
}
function storedLicensePreview(licenseKey: string): string {
  const normalized = licenseKey.trim().toUpperCase();
  return normalized.slice(-8) || 'UNKNOWN';
}

function isTerminalRefreshError(error: unknown): boolean {
  return error instanceof SherifRequestError
    && error.status >= 400
    && error.status < 500
    && error.status !== 408
    && error.status !== 429;
}

function refreshIsDue(issuedAt: Date | null, expiresAt: Date | null, now = Date.now()): boolean {
  if (!issuedAt || !expiresAt) {
    return true;
  }
  const ttl = expiresAt.getTime() - issuedAt.getTime();
  const remaining = expiresAt.getTime() - now;
  return ttl > MAX_LEASE_MS || now >= issuedAt.getTime() + (ttl / 2) || remaining <= Math.min(ttl / 4, 60_000);
}

export async function refreshModuleLicenseIfNeeded(moduleSlug: string, force = false): Promise<void> {
  const existingRefresh = moduleLicenseRefreshes.get(moduleSlug);
  if (existingRefresh) {
    return existingRefresh;
  }

  const refresh = (async () => {
    const license = await getModuleLicense(moduleSlug);
    if (
      !license
      || license.status !== 'active'
      || (!force && license.refreshFailureTerminal)
      || !license.refreshCredential
      || (!force && !refreshIsDue(license.leaseStartedAt, license.leaseExpiresAt))
      || (!force && license.lastValidationError && Date.now() - license.updatedAt.getTime() < LICENSE_REFRESH_RETRY_MS)
    ) {
      return;
    }

    if (license.authorityUrl !== config.sheriff.baseUrl) {
      await recordModuleLicenseRefreshError(moduleSlug, 'License authority does not match this deployment. Reactivate against the configured Sheriff.', true);
      return;
    }

    try {
      const identity = await getModuleLicenseIdentity();
      const sheriffPublicKeys = await getSheriffPublicKeys();
      const response = await requestSheriffRefresh(license.refreshCredential, identity, sheriffPublicKeys);
      const lease = response.data?.lease;
      const leaseToken = lease?.leaseToken ?? null;
      const verifiedLease = verifySheriffLeaseToken(leaseToken, {
        moduleSlug,
        instanceFingerprint: identity.instanceFingerprint,
        instanceKeyThumbprint: identity.instanceKeyThumbprint,
        requireUnexpired: true,
      }, sheriffPublicKeys);

      if (
        !verifiedLease
        || !lease?.activationId
        || !lease.refreshCredential
        || lease.instanceId !== identity.instanceId
      ) {
        throw new SherifRequestError(
          'Sheriff returned an invalid refreshed lease for this Robin Admin instance',
          422,
          null,
        );
      }

      await upsertModuleLicense({
        moduleSlug,
        authorityUrl: config.sheriff.baseUrl,
        licenseKey: license.licenseKey,
        status: 'active',
        customerName: verifiedLease.customerName ?? license.customerName,
        issuedTo: license.issuedTo,
        leaseToken,
        activationId: lease.activationId,
        refreshCredential: lease.refreshCredential,
        instanceId: identity.instanceId,
        instanceFingerprint: identity.instanceFingerprint,
        instanceKeyThumbprint: identity.instanceKeyThumbprint,
        leaseStartedAt: parseDate(verifiedLease.issuedAt),
        leaseExpiresAt: parseDate(verifiedLease.expiresAt),
        offlineGraceEndsAt: parseDate(verifiedLease.offlineGraceEndsAt),
        replacementAllowance: lease.replacementAllowance ?? verifiedLease.replacementAllowance ?? null,
        replacementsUsed: lease.replacementsUsed ?? verifiedLease.replacementsUsed ?? null,
        refreshFailureTerminal: false,
        lastValidatedAt: parseDate(verifiedLease.issuedAt),
        lastValidationError: null,
      });
      // A malformed release must not invalidate an independently verified license lease.
      try {
        const release = parseEntitledModuleRelease(response.data?.release, moduleSlug);
        await refreshInstalledModuleRelease(catalogModuleToUpsert(release));
      } catch (error) {
        logger.warn('Failed to refresh entitled module release', { moduleSlug, error: (error as Error).message });
      }
    } catch (error) {
      const rawMessage = (error as Error).message || 'License refresh failed';
      const message = rawMessage.split(license.refreshCredential).join('[redacted]');
      await recordModuleLicenseRefreshError(moduleSlug, message, isTerminalRefreshError(error));
      logger.warn('Failed to refresh module license', { moduleSlug, error: message });
    }
  })().finally(() => {
    moduleLicenseRefreshes.delete(moduleSlug);
  });

  moduleLicenseRefreshes.set(moduleSlug, refresh);
  return refresh;
}

async function fetchSheriffJson<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(await resolveSheriffUrl(path), {
    ...init,
    signal: init?.signal ?? timeoutSignal(10_000),
    headers: {
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  const responseBody = await response.text();
  let payload: T & { error?: string; success?: boolean };
  try {
    payload = JSON.parse(responseBody) as T & { error?: string; success?: boolean };
  } catch {
    throw new SherifRequestError(
      `Sheriff returned a non-JSON response with status ${response.status}`,
      response.status,
      null,
    );
  }
  if (!response.ok || payload?.success === false) {
    throw new SherifRequestError(
      payload?.error || `Sherif request failed with status ${response.status}`,
      response.status,
      typeof payload === 'object' && payload !== null ? payload as Record<string, unknown> : null,
    );
  }

  return payload as T;
}

// Best-effort analytics ping; failures must never affect the purchase link's
// own behavior (it's a plain <a href>, not blocked on this call).
export async function recordModulePurchaseClick(moduleSlug: string): Promise<void> {
  try {
    await fetchSheriffJson(`/v1/catalog/${encodeURIComponent(moduleSlug)}/purchase-click`, {
      method: 'POST',
      signal: timeoutSignal(3000),
    });
  } catch (error) {
    logger.warn('Failed to record purchase click', { moduleSlug, error: (error as Error).message });
  }
}

async function fetchSheriffDiscovery(): Promise<SheriffDiscoveryDocument | null> {
  try {
    return await fetchSheriffJson<SheriffDiscoveryDocument>('/.well-known/robin-sheriff.json', {
      signal: timeoutSignal(2500),
    });
  } catch (error) {
    logger.warn('Failed to fetch Sheriff discovery metadata', { error: (error as Error).message });
    return null;
  }
}

async function getSheriffPublicKeys(): Promise<SheriffPublicKey[]> {
  if (config.nodeEnv === 'production' && !config.sheriff.rootPublicKeyPem) {
    return [];
  }

  if (sheriffPublicKeysCache && Date.now() - sheriffPublicKeysCache.checkedAt < SHERIFF_PUBLIC_KEYS_CACHE_MS) {
    return sheriffPublicKeysCache.keys;
  }

  const discoveredKeys = extractSheriffPublicKeys(
    (await fetchSheriffDiscovery())?.data?.publicKeys,
    config.sheriff.rootPublicKeyPem,
  );
  if (discoveredKeys.length > 0) {
    await setConfigValue(SHERIFF_PUBLIC_KEYS_CONFIG_KEY, JSON.stringify(discoveredKeys));
    sheriffPublicKeysCache = { checkedAt: Date.now(), keys: discoveredKeys };
    return discoveredKeys;
  }

  const cached = await getConfigValue(SHERIFF_PUBLIC_KEYS_CONFIG_KEY);
  if (!cached) {
    return [];
  }

  try {
    const parsed = JSON.parse(cached) as SheriffPublicKey[];
    const keys = extractSheriffPublicKeys(parsed, config.sheriff.rootPublicKeyPem);
    sheriffPublicKeysCache = { checkedAt: Date.now(), keys };
    return keys;
  } catch {
    return [];
  }
}

function timeoutSignal(timeoutMs: number): AbortSignal {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), timeoutMs).unref?.();
  return controller.signal;
}

export function buildModuleViewModel(
  summary: ModuleSummary,
  runtime: {
    runtimeAvailable: boolean;
    runtimeStatus: ModuleRuntimeStatus;
    runtimeMessage: string | null;
  },
  sheriffPublicKeys: SheriffPublicKey[] = [],
  localIdentity?: { instanceFingerprint: string; instanceKeyThumbprint: string } | null,
): ModuleViewModel {
  const requiresLicense = summary.tier === 'paid';
  const installedVersion = summary.installedVersion;
  const updateAvailable = Boolean(
    summary.installed
      && installedVersion
      && summary.latestVersion
      && compareModuleVersions(summary.latestVersion, installedVersion) > 0,
  );
  const now = Date.now();
  const verifiedLease = !requiresLicense ? null : verifySheriffLeaseToken(summary.leaseToken, {
    moduleSlug: summary.slug,
    instanceFingerprint: localIdentity?.instanceFingerprint,
    instanceKeyThumbprint: localIdentity?.instanceKeyThumbprint,
    requireUnexpired: false,
  }, sheriffPublicKeys);
  const expiresAt = parseDate(verifiedLease?.expiresAt)?.getTime() ?? null;
  const hasValidLease = expiresAt !== null && expiresAt > now;
  const graceEndsAt = parseDate(verifiedLease?.offlineGraceEndsAt)?.getTime() ?? null;
  const hasValidSignedLease = !requiresLicense || Boolean(verifiedLease);
  const inOfflineGrace = Boolean(
    hasValidSignedLease
    && !hasValidLease
    && Boolean(summary.lastValidationError)
    && !summary.refreshFailureTerminal
    && graceEndsAt !== null
    && graceEndsAt > now,
  );

  let activationStatus: ModuleActivationStatus;
  let activationMessage: string | null = null;

  if (!summary.installed) {
    activationStatus = 'not-installed';
    activationMessage = 'This module is in the catalog but is not installed on this Robin Admin deployment.';
  } else if (!requiresLicense) {
    activationStatus = 'active';
    activationMessage = null;
  } else if (summary.refreshFailureTerminal) {
    activationStatus = 'invalid';
    activationMessage = summary.lastValidationError ?? 'Sheriff rejected this license. Access is disabled.';
  } else if (summary.leaseToken && summary.licenseAuthorityUrl !== config.sheriff.baseUrl) {
    activationStatus = 'invalid';
    activationMessage = 'License authority does not match this deployment. Reactivate against the configured Sheriff.';
  } else if (summary.leaseToken && !hasValidSignedLease) {
    activationStatus = 'invalid';
    activationMessage = 'The cached lease is invalid for this deployment or exceeds the permitted lifetime. Reactivate the module.';
  } else if (summary.licenseStatus === 'active' && hasValidLease && hasValidSignedLease) {
    activationStatus = 'active';
    activationMessage = null;
  } else if (summary.licenseStatus === 'active' && inOfflineGrace) {
    activationStatus = 'grace';
    activationMessage = `Sheriff is unreachable. Offline grace access is permitted until ${verifiedLease!.offlineGraceEndsAt}.`;
  } else if (summary.licenseStatus === 'expired' || (summary.licenseStatus === 'active' && !hasValidLease)) {
    activationStatus = 'expired';
    activationMessage = summary.lastValidationError ?? 'The cached license lease has expired. Reactivate the module.';
  } else if (summary.licenseStatus === 'invalid') {
    activationStatus = 'invalid';
    activationMessage = summary.lastValidationError ?? 'The last license validation failed.';
  } else {
    activationStatus = 'license-required';
    activationMessage = 'A valid license key is required before this module can activate.';
  }

  return {
    ...summary,
    installerActions: [],
    installerUpgradeStrategy: null,
    configuredAuthorityUrl: config.sheriff.baseUrl,
    deploymentLabel: new URL(config.publicBaseUrl).host,
    requiresLicense,
    updateAvailable,
    active: activationStatus === 'active' || activationStatus === 'grace',
    activationStatus,
    activationMessage,
    runtimeAvailable: runtime.runtimeAvailable,
    runtimeStatus: runtime.runtimeStatus,
    runtimeMessage: runtime.runtimeMessage,
  };
}

function compareModuleVersions(candidate: string, current: string): number {
  if (candidate === current) {
    return 0;
  }

  const candidateParts = tokenizeVersion(candidate);
  const currentParts = tokenizeVersion(current);
  const maxLength = Math.max(candidateParts.length, currentParts.length);

  for (let index = 0; index < maxLength; index += 1) {
    const candidatePart = candidateParts[index] ?? 0;
    const currentPart = currentParts[index] ?? 0;

    if (candidatePart === currentPart) {
      continue;
    }

    if (typeof candidatePart === 'number' && typeof currentPart === 'number') {
      return candidatePart > currentPart ? 1 : -1;
    }

    return String(candidatePart).localeCompare(String(currentPart));
  }

  return 0;
}

function tokenizeVersion(version: string): Array<number | string> {
  return version
    .split(/[^0-9A-Za-z]+/)
    .filter(Boolean)
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part.toLowerCase()));
}

export async function bootstrapInstalledModulesFromConfig(): Promise<void> {
  try {
    await replaceBootstrapInstalledModules(config.modulesBootstrap
      .filter((entry) => entry.install !== false)
      .map((entry) => ({
        ...entry,
        installedVersion: entry.installedVersion ?? entry.latestVersion ?? null,
      })));
  } catch (error) {
    logger.error('Failed to bootstrap installed modules', { error: (error as Error).message });
    throw error;
  }
}

export async function syncModuleCatalogFromSherif(reason: 'startup' | 'scheduled' | 'manual' = 'manual'): Promise<{
  syncedAt: string;
  moduleCount: number;
  modules: string[];
  source: string;
}> {
  const sheriffBaseUrl = await getSheriffBaseUrl();
  if (config.nodeEnv === 'production' && !config.sheriff.rootPublicKeyPem) {
    throw new Error('SHERIFF_ROOT_PUBLIC_KEY_PEM must be configured before syncing modules.');
  }
  const discovery = await fetchSheriffDiscovery();
  const publicKeys = extractSheriffPublicKeys(discovery?.data?.publicKeys, config.sheriff.rootPublicKeyPem);
  if (publicKeys.length === 0) {
    throw new Error('Sheriff discovery did not provide a trusted signing key.');
  }

  const payload = await fetchSheriffJson<SherifCatalogResponse>('/api/v1/catalog');

  const verifiedPayload = unwrapSignedSheriffPayload<SherifCatalogResponse>(payload, publicKeys, {
    purpose: 'catalog',
  });
  const contract = parseCatalogV1(verifiedPayload.payload.data);
  const modules = contract.modules.map(catalogModuleToUpsert);
  await upsertModuleCatalogEntries(modules);
  await snapshotInstalledModulesFromCatalog();
  await removeModuleCatalogEntriesNotIn(modules.map((moduleEntry) => moduleEntry.slug));
  const installedModules = await listModuleSummaries();
  for (const moduleEntry of installedModules.filter((entry) => entry.installed && entry.tier === 'paid')) {
    await refreshModuleLicenseIfNeeded(moduleEntry.slug, reason === 'manual');
  }

  const result = {
    syncedAt: new Date().toISOString(),
    moduleCount: modules.length,
    modules: modules.map((moduleEntry) => moduleEntry.slug),
    source: reason,
  };

  logger.info('Synced module catalog from Sheriff', { ...result, sheriffBaseUrl });
  return result;
}

export async function listModulesForUi(): Promise<ModuleViewModel[]> {
  let modules = await listModuleSummaries();
  await Promise.all(modules.filter((moduleEntry) => moduleEntry.tier === 'paid').map(
    (moduleEntry) => refreshModuleLicenseIfNeeded(moduleEntry.slug),
  ));
  modules = await listModuleSummaries();
  const runtimeStates = await Promise.all(modules.map((moduleSummary) => probeModuleRuntime(moduleSummary)));
  const sheriffPublicKeys = modules.some((moduleEntry) => moduleEntry.tier === 'paid')
    ? await getSheriffPublicKeys()
    : [];
  const identity = modules.some((moduleEntry) => moduleEntry.tier === 'paid')
    ? await getModuleLicenseIdentity()
    : null;
  return Promise.all(modules.map(async (moduleSummary, index) => ({ ...buildModuleViewModel(
    moduleSummary,
    runtimeStates[index],
    sheriffPublicKeys,
    identity,
  ), installerActions: await getAvailableInstallerActions(moduleSummary),
  installerUpgradeStrategy: await getInstallerUpgradeStrategy(moduleSummary.slug) })));
}

export async function getModuleForUi(slug: string): Promise<ModuleViewModel | null> {
  await refreshModuleLicenseIfNeeded(slug);
  const moduleSummary = await getModuleSummaryBySlug(slug);
  if (!moduleSummary) {
    return null;
  }

  const identity = moduleSummary.tier === 'paid' ? await getModuleLicenseIdentity() : null;
  return { ...buildModuleViewModel(
    moduleSummary,
    await probeModuleRuntime(moduleSummary),
    moduleSummary.tier === 'paid' ? await getSheriffPublicKeys() : [],
    identity,
  ), installerActions: await getAvailableInstallerActions(moduleSummary),
  installerUpgradeStrategy: await getInstallerUpgradeStrategy(moduleSummary.slug) };
}

// Called once an installer job for 'install'/'upgrade'/'uninstall' reaches a
// terminal state, so the local modules_installed record (which drives the
// "installed" flag, module federation loading, and the proxy/asset routes)
// reflects the outcome instead of staying stuck on whatever it was before
// the job ran.
export async function finalizeModuleInstallerAction(
  action: ModuleInstallerAction,
  moduleSlug: string,
  version: string,
  jobData?: Record<string, unknown>,
): Promise<void> {
  if (action === 'uninstall') {
    await removeModuleInstall(moduleSlug);
    return;
  }
  if (action !== 'install' && action !== 'upgrade') {
    return;
  }

  const moduleSummary = await getModuleSummaryBySlug(moduleSlug);
  if (!moduleSummary || !moduleSummary.remoteEntryPath) {
    return;
  }
  const runtime = extractInstallerRuntime(jobData);
  await recordModuleInstall({
    moduleSlug,
    displayName: moduleSummary.displayName,
    description: moduleSummary.description,
    vendorName: moduleSummary.vendorName,
    tier: moduleSummary.tier,
    latestVersion: moduleSummary.latestVersion,
    routeSlug: moduleSummary.routeSlug,
    remoteScope: moduleSummary.remoteScope,
    exposedModule: moduleSummary.exposedModule,
    remoteEntryPath: moduleSummary.remoteEntryPath,
    iconName: moduleSummary.iconName,
    sortOrder: moduleSummary.sortOrder,
    metadata: moduleSummary.metadata,
    moduleDefinition: moduleSummary.moduleDefinition,
    remoteEntryUrl: moduleSummary.remoteEntryPath,
    installedVersion: version,
    ...runtime,
    installedSource: 'installer',
  });
}

function deliveryServicesFromMetadata(
  moduleSummary: ModuleSummary,
  requestedVersion: string,
): Array<{ repository: string; digest: string }> {
  const delivery = moduleSummary.metadata.delivery;
  if (!delivery || typeof delivery !== 'object' || Array.isArray(delivery)) {
    if (moduleSummary.tier === 'free') return [];
    throw new ModuleAccessError('Paid module delivery metadata is unavailable.', 409);
  }
  const input = delivery as Record<string, unknown>;
  const allowedDeliveryKeys = new Set(['mode', 'available', 'services']);
  if (Object.keys(input).some((key) => !allowedDeliveryKeys.has(key)) || input.available !== true) {
    throw new ModuleAccessError('Requested paid module delivery is not available.', 409);
  }
  if (input.mode === 'public-ghcr' && moduleSummary.tier === 'free') return [];
  if (
    input.mode !== 'sheriff-proxy'
    || moduleSummary.tier !== 'paid'
    || requestedVersion !== moduleSummary.latestVersion
  ) {
    throw new ModuleAccessError('Requested module delivery metadata is inconsistent.', 409);
  }
  if (!Array.isArray(input.services) || input.services.length < 1 || input.services.length > 2) {
    throw new ModuleAccessError('Paid module delivery services are invalid.', 409);
  }
  const services = input.services.map((value) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new ModuleAccessError('Paid module delivery service is invalid.', 409);
    }
    const service = value as Record<string, unknown>;
    const allowedKeys = new Set(['name', 'repository', 'digest', 'platforms']);
    if (Object.keys(service).some((key) => !allowedKeys.has(key))) {
      throw new ModuleAccessError('Paid module delivery service contains unsupported fields.', 409);
    }
    if (
      typeof service.repository !== 'string'
      || !/^[a-z0-9][a-z0-9._/-]{1,200}$/.test(service.repository)
      || typeof service.digest !== 'string'
      || !/^sha256:[a-f0-9]{64}$/.test(service.digest)
    ) {
      throw new ModuleAccessError('Paid module delivery service is invalid.', 409);
    }
    return { repository: service.repository, digest: service.digest };
  });
  if (new Set(services.map((service) => service.repository)).size !== services.length) {
    throw new ModuleAccessError('Paid module delivery repositories must be distinct.', 409);
  }
  return services;
}

export async function getModuleRegistryCredentials(
  moduleSummary: ModuleSummary,
  requestedVersion: string,
): Promise<ModuleRegistryCredential[]> {
  await refreshModuleLicenseIfNeeded(moduleSummary.slug);
  const refreshedSummary = await getModuleSummaryBySlug(moduleSummary.slug) ?? moduleSummary;
  const services = deliveryServicesFromMetadata(refreshedSummary, requestedVersion);
  if (services.length === 0) return [];
  if (!refreshedSummary.leaseToken || refreshedSummary.licenseStatus !== 'active'
    || refreshedSummary.refreshFailureTerminal || refreshedSummary.licenseAuthorityUrl !== config.sheriff.baseUrl) {
    throw new ModuleAccessError('A valid paid module lease is required for delivery.', 403);
  }

  const identity = await getModuleLicenseIdentity();
  const lease = verifySheriffLeaseToken(refreshedSummary.leaseToken, {
    moduleSlug: refreshedSummary.slug,
    instanceFingerprint: identity.instanceFingerprint,
    instanceKeyThumbprint: identity.instanceKeyThumbprint,
    requireUnexpired: true,
  }, await getSheriffPublicKeys());
  if (!lease) {
    throw new ModuleAccessError('A valid paid module lease is required for delivery.', 403);
  }

  return Promise.all(services.map(async (service) => {
    const response = await fetchSheriffJson<SheriffRegistryTokenResponse>('/api/v1/registry/token', {
      method: 'POST',
      body: JSON.stringify({
        leaseToken: refreshedSummary.leaseToken,
        moduleSlug: refreshedSummary.slug,
        repository: service.repository,
        digest: service.digest,
      }),
    });
    const token = response.data?.token;
    const expiresAt = response.data?.expiresAt;
    const expiration = typeof expiresAt === 'string' ? Date.parse(expiresAt) : Number.NaN;
    if (
      typeof token !== 'string'
      || token.length < 1
      || token.length > 8192
      || !Number.isFinite(expiration)
      || expiration <= Date.now()
      || expiration - Date.now() > 15 * 60_000
    ) {
      throw new ModuleAccessError('Sheriff returned an invalid registry grant.', 502);
    }
    return {
      repository: service.repository,
      registry: 'sheriff.robinmta.com' as const,
      username: refreshedSummary.activationId || 'robin',
      password: token,
      expiresAt: expiresAt!,
    };
  }));
}

export async function assertModuleRuntimeAccess(moduleSlug: string): Promise<ModuleSummary> {
  await refreshModuleLicenseIfNeeded(moduleSlug);
  const moduleSummary = await getModuleSummaryBySlug(moduleSlug);
  if (!moduleSummary || !moduleSummary.installed) {
    throw new ModuleAccessError('Module is not installed on this Robin Admin deployment.', 404);
  }

  if (moduleSummary.tier === 'paid') {
    const identity = await getModuleLicenseIdentity();
    const view = buildModuleViewModel(moduleSummary, {
      runtimeAvailable: false, runtimeStatus: 'unknown', runtimeMessage: null,
    }, await getSheriffPublicKeys(), identity);
    if (!view.active) {
      throw new ModuleAccessError(view.activationMessage ?? 'A valid paid module license is required.', 403);
    }
  }

  return moduleSummary;
}

export async function activateModuleLicense(moduleSlug: string, licenseKey: string): Promise<ModuleViewModel> {
  const existing = await getModuleSummaryBySlug(moduleSlug);
  if (!existing) {
    throw new Error('Unknown module');
  }

  // Paid modules may be activated before install: the lease/registry token
  // obtained here is what lets the installer pull the module's private
  // image in the first place. Free modules have nothing to license.
  if (!existing.installed && existing.tier !== 'paid') {
    throw new Error('Module is not installed on this Robin Admin deployment');
  }

  const identity = await getModuleLicenseIdentity();
  const licenseKeyPreview = storedLicensePreview(licenseKey);

  try {
    const sheriffPublicKeys = await getSheriffPublicKeys();
    const response = await requestSheriffLease(moduleSlug, licenseKey, identity, sheriffPublicKeys);

    const payload = response.data;
    const leaseToken = payload?.lease?.leaseToken ?? null;
    const verifiedLease = verifySheriffLeaseToken(leaseToken, {
      moduleSlug,
      instanceFingerprint: identity.instanceFingerprint,
      instanceKeyThumbprint: identity.instanceKeyThumbprint,
    }, sheriffPublicKeys);

    if (
      !verifiedLease
      || !payload?.lease?.activationId
      || !payload.lease.refreshCredential
      || payload.lease.instanceId !== identity.instanceId
      || payload.lease.instanceKeyThumbprint !== identity.instanceKeyThumbprint
    ) {
      throw new Error('Sheriff returned an invalid or unsigned lease for this Robin Admin instance');
    }

    const lastValidatedAt = parseDate(verifiedLease.issuedAt) ?? new Date();
    const leaseStartedAt = parseDate(verifiedLease.issuedAt) ?? lastValidatedAt;
    const leaseExpiresAt = parseDate(verifiedLease.expiresAt) ?? parseDate(payload?.license?.expiresAt);

    await upsertModuleLicense({
      moduleSlug,
      authorityUrl: config.sheriff.baseUrl,
      licenseKey: verifiedLease.licenseKeySuffix ?? licenseKeyPreview,
      status: 'active',
      customerName: verifiedLease.customerName ?? payload?.license?.customerName ?? null,
      issuedTo: payload?.license?.customerEmail ?? null,
      leaseToken,
      activationId: payload.lease.activationId,
      refreshCredential: payload.lease.refreshCredential,
      instanceId: identity.instanceId,
      instanceFingerprint: identity.instanceFingerprint,
      instanceKeyThumbprint: identity.instanceKeyThumbprint,
      leaseStartedAt,
      leaseExpiresAt,
      offlineGraceEndsAt: parseDate(payload.lease.offlineGraceEndsAt) ?? parseDate(verifiedLease.offlineGraceEndsAt),
      replacementAllowance: payload.lease.replacementAllowance ?? verifiedLease.replacementAllowance ?? null,
      replacementsUsed: payload.lease.replacementsUsed ?? verifiedLease.replacementsUsed ?? null,
      refreshFailureTerminal: false,
      lastValidatedAt,
      lastValidationError: null,
    });
  } catch (error) {
    const message = error instanceof SherifRequestError
      ? error.message
      : (error as Error).message || 'License validation failed';

    if (existing.leaseToken) {
      await recordModuleLicenseRefreshError(moduleSlug, message, isTerminalRefreshError(error));
    } else {
      await upsertModuleLicense({
        moduleSlug,
        authorityUrl: config.sheriff.baseUrl,
        licenseKey: licenseKeyPreview,
        status: error instanceof SherifRequestError && error.status === 403 ? 'invalid' : 'inactive',
        customerName: null,
        issuedTo: null,
        leaseToken: null,
        activationId: null,
        refreshCredential: null,
        instanceId: identity.instanceId,
        instanceFingerprint: identity.instanceFingerprint,
        instanceKeyThumbprint: identity.instanceKeyThumbprint,
        leaseStartedAt: null,
        leaseExpiresAt: null,
        offlineGraceEndsAt: null,
        replacementAllowance: null,
        replacementsUsed: null,
        refreshFailureTerminal: false,
        lastValidatedAt: null,
        lastValidationError: message,
      });
    }

    throw new Error(message);
  }

  const updated = await getModuleForUi(moduleSlug);
  if (!updated) {
    throw new Error('Module disappeared after activation');
  }

  return updated;
}
