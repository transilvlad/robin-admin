import { createHash } from 'crypto';
import {
  getFleetServiceSyncStatus,
  listClamavConfigStoreEntriesForService,
  listDovecotConfigStoreEntriesForService,
  listPostfixConfigStoreEntriesForService,
  listRobinConfigStoreEntriesForService,
  listRspamdConfigStoreEntriesForService,
  type FleetServiceApplyStatus,
  type FleetServiceSyncStatus,
  type ManagedConfigStoreEntry,
} from '../db/queries/fleet-agent-sync.js';
import { getFleetServiceById, getFleetServiceSoftwareVersion, type FleetService } from '../db/queries/fleet-services.js';
import {
  MANAGED_CONF_FILE as DOVECOT_MANAGED_CONF_FILE,
  MANAGED_VALUES_FILE as DOVECOT_MANAGED_VALUES_FILE,
  dovecotConfigVersionOf,
  normalizeDovecotConfig,
  renderDovecotConfig,
} from './dovecot.js';
import { deepMerge, isRecord } from '../db/queries/config-layering.js';
import { listActiveDkimSigningKeys } from '../db/queries/rspamd.js';
import { decryptStoredSecret } from '../db/queries/secret-crypto.js';
import { DKIM_SIGNING_FILE, dkimKeyFileName, renderDkimDomainBlock, type DeliveredDkimKey } from './rspamd-dkim-delivery.js';
import { logger } from '../logger.js';
import type { FleetServiceType } from './service-types.js';

export type ManagedConfigPayloadKind = 'json' | 'text';
export type ManagedConfigSource = 'default' | 'override' | 'merged' | 'service';

export interface ManagedServiceConfigManifestFile {
  fileName: string;
  payloadKind: ManagedConfigPayloadKind;
  source: ManagedConfigSource;
  sha256: string;
  etag: string;
  updatedAt: string;
}

export interface ManagedServiceConfigManifest {
  serviceId: string;
  serviceType: FleetService['serviceType'];
  enabled: boolean;
  sha256: string;
  etag: string;
  generatedAt: string;
  /** Force-sync marker (from "Sync now"); when it changes the agent re-applies. */
  syncRequestedAt: string | null;
  files: ManagedServiceConfigManifestFile[];
  syncStatus: FleetServiceSyncStatus | null;
}

export interface ManagedServiceConfigFile extends ManagedServiceConfigManifestFile {
  serviceId: string;
  serviceType: FleetService['serviceType'];
  payload: Record<string, unknown> | string;
}

export interface FleetAgentStatusReport {
  manifestSha256?: string | null;
  manifestEtag?: string | null;
  manifestFileCount?: number | null;
  applyStartedAt?: Date | null;
  applyFinishedAt?: Date | null;
  applyStatus?: FleetServiceApplyStatus;
  applyError?: string | null;
  appliedSha256?: string | null;
  appliedFileCount?: number | null;
  agentVersion?: string | null;
  metadata?: Record<string, unknown>;
}

interface ResolvedManagedConfigEntry extends ManagedServiceConfigManifestFile {
  serviceId: string;
  serviceType: FleetService['serviceType'];
  payload: Record<string, unknown> | string;
}

interface ManagedServiceSnapshot {
  service: FleetService;
  files: ResolvedManagedConfigEntry[];
  syncStatus: FleetServiceSyncStatus | null;
}

function hashString(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function hashJson(value: unknown): string {
  return hashString(JSON.stringify(value ?? {}));
}

export function toStrongEtag(sha256: string): string {
  return `"${sha256}"`;
}

export function etagMatches(
  headerValue: string | string[] | undefined,
  etag: string
): boolean {
  if (!headerValue) {
    return false;
  }

  const source = Array.isArray(headerValue) ? headerValue.join(',') : headerValue;
  const normalizedTarget = normalizeEtag(etag);

  return source
    .split(',')
    .map((value) => normalizeEtag(value))
    .some((value) => value === '*' || value === normalizedTarget);
}

function normalizeEtag(value: string): string {
  return value.trim().replace(/^W\//, '').replace(/^"(.*)"$/, '$1');
}

function normalizeObjectPayload(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function toIso(updatedEpoch: number): string {
  return new Date(updatedEpoch * 1000).toISOString();
}

function maybeResolveTextPayload(fileName: string, payload: unknown): string | null {
  if (typeof payload === 'string') {
    return payload;
  }

  // A `{ content: "..." }` wrapper is an explicitly rendered config file (e.g.
  // dovecot's conf.d include, postfix's main.cf + check maps). Serve it as text.
  // `.json` payloads are managed-values metadata and stay JSON.
  if (!isRecord(payload) || typeof payload.content !== 'string' || /\.json$/i.test(fileName)) {
    return null;
  }

  return payload.content;
}

function toResolvedFile(
  service: FleetService,
  fileName: string,
  payload: Record<string, unknown> | string,
  payloadKind: ManagedConfigPayloadKind,
  source: ManagedConfigSource,
  updatedEpoch: number
): ResolvedManagedConfigEntry {
  const sha256 = payloadKind === 'text'
    ? hashString(payload as string)
    : hashJson(payload);

  return {
    serviceId: service.serviceId,
    serviceType: service.serviceType,
    fileName,
    payload,
    payloadKind,
    source,
    sha256,
    etag: toStrongEtag(sha256),
    updatedAt: toIso(updatedEpoch),
  };
}

// Generic override layering for every service type. Rows come from the store
// scoped to ('default' OR this serviceId); the 'default' row is the base and the
// serviceId row is the per-service override. JSON payloads deep-merge; text
// config files (.conf/.inc/...) can't be line-merged, so an override file
// replaces the default file wholesale. `source` records how each file resolved
// (default | override | merged) so it can be surfaced for auditing.
function resolveLayeredEntries(
  service: FleetService,
  rows: ManagedConfigStoreEntry[]
): ResolvedManagedConfigEntry[] {
  const grouped = new Map<string, {
    base?: ManagedConfigStoreEntry;
    override?: ManagedConfigStoreEntry;
  }>();

  for (const row of rows) {
    const entry = grouped.get(row.fileName) ?? {};
    if (row.ownerId === 'default') {
      entry.base = row;
    } else if (row.ownerId === service.serviceId) {
      entry.override = row;
    }
    grouped.set(row.fileName, entry);
  }

  return Array.from(grouped.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([fileName, pair]) => {
      const updatedEpoch = Math.max(pair.base?.updatedEpoch ?? 0, pair.override?.updatedEpoch ?? 0);
      const sample = pair.override ?? pair.base;
      const sampleText = sample ? maybeResolveTextPayload(fileName, sample.payloadJson) : null;

      if (sampleText !== null) {
        if (pair.base && pair.override) {
          const overrideText = maybeResolveTextPayload(fileName, pair.override.payloadJson) ?? sampleText;
          return toResolvedFile(service, fileName, overrideText, 'text', 'merged', updatedEpoch);
        }
        const source: ManagedConfigSource = pair.override ? 'override' : 'default';
        return toResolvedFile(service, fileName, sampleText, 'text', source, updatedEpoch);
      }

      const basePayload = normalizeObjectPayload(pair.base?.payloadJson);
      const overridePayload = normalizeObjectPayload(pair.override?.payloadJson);
      if (pair.base && pair.override) {
        return toResolvedFile(service, fileName, deepMerge(basePayload, overridePayload), 'json', 'merged', updatedEpoch);
      }
      if (pair.override) {
        return toResolvedFile(service, fileName, overridePayload, 'json', 'override', updatedEpoch);
      }
      return toResolvedFile(service, fileName, basePayload, 'json', 'default', updatedEpoch);
    });
}

// The Dovecot include is rendered when the config is saved, for the version
// known then (or inherited from the shared base). Once the agent has reported
// the host's actual version, serve it rendered for that one: 2.4 rejects the
// whole include over a single 2.3-only setting, and vice versa.
async function renderForReportedDovecotVersion(
  service: FleetService,
  files: ResolvedManagedConfigEntry[]
): Promise<ResolvedManagedConfigEntry[]> {
  const index = files.findIndex((file) => file.fileName === DOVECOT_MANAGED_CONF_FILE && file.payloadKind === 'text');
  const values = files.find((file) => file.fileName === DOVECOT_MANAGED_VALUES_FILE && file.payloadKind === 'json');
  if (index < 0 || !values) return files;
  const detected = dovecotConfigVersionOf(await getFleetServiceSoftwareVersion(service.serviceId));
  if (!detected) return files;
  const content = renderDovecotConfig({ ...normalizeDovecotConfig(values.payload), dovecotVersion: detected });
  if (content === files[index].payload) return files;
  const sha256 = hashString(content);
  const next = [...files];
  next[index] = { ...files[index], payload: content, sha256, etag: toStrongEtag(sha256) };
  return next;
}

// dkim_signing.conf is stored without the per-domain selectors, which change
// with every key rotation. They are added here along with the key files, so a
// rotation reaches rspamd on the next sync. A service whose DKIM file isn't
// managed gets no keys.
async function withDkimSigningKeys(
  service: FleetService,
  files: ResolvedManagedConfigEntry[]
): Promise<ResolvedManagedConfigEntry[]> {
  const index = files.findIndex((file) => file.fileName === DKIM_SIGNING_FILE && file.payloadKind === 'text');
  if (index < 0) return files;

  const delivered: DeliveredDkimKey[] = [];
  const keyFiles: ResolvedManagedConfigEntry[] = [];
  const updatedEpoch = Math.floor(Date.parse(files[index].updatedAt) / 1000);
  for (const key of await listActiveDkimSigningKeys()) {
    let pem: string;
    try {
      pem = decryptStoredSecret(key.privateKeyEnc);
    } catch (error) {
      logger.error('DKIM key could not be decrypted; the domain is not signed', {
        domain: key.domain,
        selector: key.selector,
        error: (error as Error).message,
      });
      continue;
    }
    delivered.push(key);
    keyFiles.push(toResolvedFile(service, dkimKeyFileName(key), pem, 'text', 'service', updatedEpoch));
  }
  if (delivered.length === 0) return files;

  const content = `${files[index].payload as string}${renderDkimDomainBlock(delivered)}`;
  const next = [...files];
  next[index] = toResolvedFile(service, DKIM_SIGNING_FILE, content, 'text', files[index].source, updatedEpoch);
  return [...next, ...keyFiles];
}

// The config files an agent places for a service. The database types apply
// their settings over their own protocol from robin-admin, so they have none.
function listConfigFileEntries(serviceType: FleetServiceType, serviceId: string): Promise<ManagedConfigStoreEntry[]> {
  switch (serviceType) {
    case 'robin': return listRobinConfigStoreEntriesForService(serviceId);
    case 'rspamd': return listRspamdConfigStoreEntriesForService(serviceId);
    case 'dovecot': return listDovecotConfigStoreEntriesForService(serviceId);
    case 'postfix': return listPostfixConfigStoreEntriesForService(serviceId);
    case 'clamav': return listClamavConfigStoreEntriesForService(serviceId);
    case 'redis':
    case 'postgres':
    case 'mariadb': return Promise.resolve([]);
  }
}

async function loadManagedServiceSnapshot(serviceId: string): Promise<ManagedServiceSnapshot | null> {
  const service = await getFleetServiceById(serviceId);
  if (!service) {
    return null;
  }

  const [rows, syncStatus] = await Promise.all([
    listConfigFileEntries(service.serviceType, serviceId),
    getFleetServiceSyncStatus(serviceId),
  ]);

  const resolved = resolveLayeredEntries(service, rows);
  const files = service.serviceType === 'dovecot'
    ? await renderForReportedDovecotVersion(service, resolved)
    : service.serviceType === 'rspamd'
      ? await withDkimSigningKeys(service, resolved)
      : resolved;

  return {
    service,
    files,
    syncStatus,
  };
}

export async function buildManagedServiceManifest(
  serviceId: string
): Promise<ManagedServiceConfigManifest | null> {
  const snapshot = await loadManagedServiceSnapshot(serviceId);
  if (!snapshot) {
    return null;
  }

  const files = snapshot.files.map((file) => ({
    fileName: file.fileName,
    payloadKind: file.payloadKind,
    source: file.source,
    sha256: file.sha256,
    etag: file.etag,
    updatedAt: file.updatedAt,
  }));

  const syncRequestedAt = snapshot.syncStatus?.syncRequestedAt
    ? snapshot.syncStatus.syncRequestedAt.toISOString()
    : null;

  const sha256 = hashJson({
    serviceId: snapshot.service.serviceId,
    serviceType: snapshot.service.serviceType,
    enabled: snapshot.service.enabled,
    // Folding the force-sync marker into the hash makes "Sync now" change the
    // manifest sha, so the agent re-pulls and re-applies unchanged config.
    forceToken: syncRequestedAt,
    files: files.map(({ fileName, payloadKind, source, sha256: fileSha256, updatedAt }) => ({
      fileName,
      payloadKind,
      source,
      sha256: fileSha256,
      updatedAt,
    })),
  });

  return {
    serviceId: snapshot.service.serviceId,
    serviceType: snapshot.service.serviceType,
    enabled: snapshot.service.enabled,
    sha256,
    etag: toStrongEtag(sha256),
    generatedAt: new Date().toISOString(),
    syncRequestedAt,
    files,
    syncStatus: snapshot.syncStatus,
  };
}

export async function getManagedServiceConfigFile(
  serviceId: string,
  fileName: string
): Promise<ManagedServiceConfigFile | null> {
  const snapshot = await loadManagedServiceSnapshot(serviceId);
  if (!snapshot) {
    return null;
  }

  const file = snapshot.files.find((entry) => entry.fileName === fileName);
  return file ?? null;
}
