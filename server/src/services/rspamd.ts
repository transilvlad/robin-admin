import { constants as fsConstants } from 'fs';
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'crypto';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';
import { gunzipSync } from 'zlib';
import { execFile } from 'child_process';
import { promisify } from 'util';
import {
  RSPAMD_CONFIG_STORE_TABLE,
  deleteConfigStoreEntry,
  getConfigStorePayload,
  listConfigStoreOwners,
  upsertConfigStorePayload,
} from '../db/queries/config-store.js';
import { deepMerge, extractDelta, isRecord } from '../db/queries/config-layering.js';
import {
  RSPAMD_BASE_SCOPE,
  RSPAMD_FILE_MANAGEMENT_STORE_FILE,
  RSPAMD_MANAGED_CONFIG_STORE_FILE,
} from '../db/queries/rspamd.js';
import {
  RSPAMD_MANAGED_FILES,
  RSPAMD_MANAGED_FILES_BY_KEY,
  valuesStoreFileName,
  type RspamdManagedFileDef,
} from './rspamd-config-files.js';
import {
  type RspamdScanActionRecord,
  type RspamdClassifierSettings,
  type RspamdFuzzyPreset,
  type RspamdScanRequestMetadata,
  type RspamdScanRunDetail,
  type RspamdScanRunSummary,
  type TrainingSampleListOptions,
  type DkimSigningDomain,
  type DkimSigningSelector,
  type RspamdFileManagement,
  type RspamdManagedConfig,
  type RspamdSettings,
  type TrainingImportJob,
  type TrainingSample,
  activateNewSelector,
  createRspamdScanAction,
  createRspamdScanRun,
  createTrainingImport,
  createTrainingSample,
  deleteTrainingSample,
  finalizeTrainingImport,
  getActiveSelector,
  getRspamdClassifierSettings,
  getDkimDomain,
  getRspamdFileManagement,
  getRspamdManagedConfig,
  getRspamdScanRun,
  getRspamdSettings,
  getTrainingImport,
  getTrainingSample,
  getTrainingSampleByHash,
  listRspamdScanRuns,
  listDomainsDueForRotation,
  listPurgeableSelectors,
  listSelectorNamesByPrefix,
  listTrainingSamples,
  markSelectorKeyDeleted,
  relabelTrainingSample,
  revokeSelector,
  updateRspamdClassifierSettings,
  updateRspamdFileManagement,
  updateRspamdManagedConfig,
  updateRspamdSettings,
  updateTrainingSampleLearning,
  toPublicRspamdSettings,
  type PublicRspamdSettings,
} from '../db/queries/rspamd.js';
import { getFleetServiceById } from '../db/queries/fleet-services.js';
import { encryptStoredSecret } from '../db/queries/secret-crypto.js';
import { logger } from '../logger.js';
import { commandAgentFor, runAgentCommand } from './agent-commands.js';

const execFileAsync = promisify(execFile);
const EXEC_TIMEOUT_MS = 8000;

const MANAGED_DKIM_FILE = 'dkim_signing.conf';
const MANAGED_BAYES_FILE = 'classifier-bayes.conf';
const MANAGED_MARKER = '# Managed by Robin Admin';
const MANAGED_STORE_PREFIX = 'db://rspamd_config_store';
const TRAINING_ARCHIVE_MAX_INPUT_BYTES = Number.parseInt(process.env.RSPAMD_TRAINING_ARCHIVE_MAX_INPUT_BYTES || `${100 * 1024 * 1024}`, 10);
const TRAINING_ARCHIVE_MAX_UNPACKED_BYTES = Number.parseInt(process.env.RSPAMD_TRAINING_ARCHIVE_MAX_UNPACKED_BYTES || `${250 * 1024 * 1024}`, 10);
const TRAINING_ARCHIVE_MAX_FILES = Number.parseInt(process.env.RSPAMD_TRAINING_ARCHIVE_MAX_FILES || '2000', 10);
const TRAINING_SAMPLE_MAX_BYTES = Number.parseInt(process.env.RSPAMD_TRAINING_SAMPLE_MAX_BYTES || `${25 * 1024 * 1024}`, 10);
const RSPAMD_SCAN_HISTORY_MAX_BYTES = Number.parseInt(process.env.RSPAMD_SCAN_HISTORY_MAX_BYTES || `${25 * 1024 * 1024}`, 10);

export interface PathProbe {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  error?: string;
}

export interface ManagedFileState {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  managed: boolean;
  managementEnabled: boolean;
  content: string | null;
}

/**
 * A per-file managed Rspamd config (redis.conf, logging.inc, …) from the
 * additive registry: its stable key + real file name, the current typed values,
 * the rendered UCL, and whether the agent is set to write it.
 */
export interface RspamdManagedFileEntry {
  key: string;
  fileName: string;
  values: Record<string, unknown>;
  rendered: string;
  state: ManagedFileState;
}

export interface RspamdStatus {
  available: boolean;
  enabled: boolean;
  controllerReachable: boolean;
  controllerAuthenticated: boolean;
  controllerStatusCode: number | null;
  controllerPingOk: boolean;
  controllerPingStatusCode: number | null;
  controllerHealthyOk: boolean;
  controllerHealthyStatusCode: number | null;
  controllerStatAuthOk: boolean;
  controllerStatStatusCode: number | null;
  normalWorkerPingOk: boolean;
  normalWorkerPingStatusCode: number | null;
  configDir: PathProbe;
  storeDir: PathProbe;
  trainingDir: PathProbe;
  reasons: string[];
  siblingSuggestion: {
    configDir: string;
    storeDir: string;
    trainingDir: string;
  } | null;
}

export interface RspamdConfigState {
  settings: PublicRspamdSettings;
  managedConfig: RspamdManagedConfig;
  status: RspamdStatus;
  files: {
    dkim: ManagedFileState;
    bayes: ManagedFileState;
  };
  /** Additional per-file managed configs (redis.conf, logging.inc, …). */
  managedFiles: RspamdManagedFileEntry[];
}

export interface TrainingUploadBuffer {
  name: string;
  content: Buffer;
}

export interface TrainingImportResult {
  job: TrainingImportJob | null;
  samples: TrainingSample[];
  skipped: Array<{ fileName: string; reason: string }>;
}

export interface RspamdScanRequest {
  serviceId?: string;
  transport?: 'checkv2' | 'checkv3';
  rawMessage: string;
  fileName?: string | null;
  metadata?: Partial<RspamdScanRequestMetadata>;
}

export interface RspamdScanSummary {
  action: string | null;
  score: number | null;
  requiredScore: number | null;
  isSkipped: boolean;
  symbolNames: string[];
}

export interface RspamdScanHistoryDetail extends RspamdScanRunDetail {
  rawMessage: string;
}

export interface RspamdClassifierStatusEntry {
  symbol: string;
  type: string;
  revision: number | null;
  size: number | null;
  users: number | null;
  languages: string[];
}

export interface RspamdClassifierSummary {
  serviceId: string | null;
  defaultTransport: 'checkv2' | 'checkv3';
  defaultClassifier: string;
  controllerReachable: boolean;
  controllerAuthenticated: boolean;
  normalWorkerReachable: boolean;
  fuzzyPresets: RspamdFuzzyPreset[];
  statfiles: RspamdClassifierStatusEntry[];
  /** Messages the classifiers have learned, from the controller's /stat; null when unknown. */
  learnedMessages: number | null;
  symbolsByType: string[];
}

interface ExtractedSample {
  filename: string;
  content: Buffer;
  sourceType: 'eml' | 'mbox' | 'archive';
}

interface EndpointProbe {
  ok: boolean;
  reachable: boolean;
  statusCode: number | null;
}

interface ManagedFilePayload {
  content?: string;
  managedBy?: string;
}

let maintenanceTimer: NodeJS.Timeout | null = null;

function safeJoin(...parts: string[]): string {
  return path.normalize(path.join(...parts));
}

/** A feature needs a setting the selected Rspamd service doesn't have. */
export class RspamdNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RspamdNotConfiguredError';
  }
}

function requireConfiguredPath(value: string | null | undefined, label: string): string {
  const trimmed = (value ?? '').trim();
  if (!trimmed) {
    throw new RspamdNotConfiguredError(`${label} is not configured for the selected Rspamd service`);
  }
  return trimmed;
}

function optionalConfiguredPath(value: string | null | undefined): string | null {
  const trimmed = (value ?? '').trim();
  return trimmed.length > 0 ? trimmed : null;
}

async function probePath(target: string): Promise<PathProbe> {
  try {
    await fs.access(target);
  } catch (error) {
    return {
      path: target,
      exists: false,
      readable: false,
      writable: false,
      error: (error as Error).message,
    };
  }

  let readable = true;
  let writable = true;
  try {
    await fs.access(target, fsConstants.R_OK);
  } catch {
    readable = false;
  }
  try {
    await fs.access(target, fsConstants.W_OK);
  } catch {
    writable = false;
  }

  return { path: target, exists: true, readable, writable };
}

function normalizeEndpointBase(url: string | null | undefined): string | null {
  const trimmed = (url ?? '').trim();
  return trimmed ? trimmed.replace(/\/$/, '') : null;
}

function storeRef(serviceId: string | null | undefined, name: string): string {
  if (!serviceId) return `${MANAGED_STORE_PREFIX}/unbound/${name}`;
  return `${MANAGED_STORE_PREFIX}/${serviceId}/${name}`;
}

function syntheticProbe(pathRef: string, available: boolean): PathProbe {
  return {
    path: pathRef,
    exists: available,
    readable: available,
    writable: available,
  };
}

async function probeConfiguredPath(
  configuredPath: string | null | undefined,
  fallbackRef: string,
  available: boolean
): Promise<PathProbe> {
  const trimmed = (configuredPath ?? '').trim();
  if (!trimmed) {
    return syntheticProbe(fallbackRef, available);
  }
  return probePath(trimmed);
}

async function probeEndpoint(url: string, headers?: Record<string, string>): Promise<EndpointProbe> {
  try {
    const response = await fetch(url, { headers });
    return {
      ok: response.ok,
      reachable: true,
      statusCode: response.status,
    };
  } catch {
    return { ok: false, reachable: false, statusCode: null };
  }
}

async function probeController(settings: RspamdSettings): Promise<{
  ping: EndpointProbe;
  healthy: EndpointProbe;
  stat: EndpointProbe;
  authenticated: boolean;
}> {
  const url = normalizeEndpointBase(settings.rspamdControllerUrl);
  if (!url) {
    return {
      ping: { ok: false, reachable: false, statusCode: null },
      healthy: { ok: false, reachable: false, statusCode: null },
      stat: { ok: false, reachable: false, statusCode: null },
      authenticated: false,
    };
  }
  const password = settings.rspamdControllerPassword || settings.rspamdEnablePassword;
  const headers = password ? { Password: password } : undefined;
  // /ping is public; /healthy and /stat are privileged when a password is set.
  const [ping, healthy, stat] = await Promise.all([
    probeEndpoint(`${url}/ping`),
    probeEndpoint(`${url}/healthy`, headers),
    probeEndpoint(`${url}/stat`, headers),
  ]);

  return {
    ping,
    healthy,
    stat,
    authenticated: stat.ok,
  };
}

async function probeNormalWorker(settings: RspamdSettings): Promise<EndpointProbe> {
  const url = normalizeEndpointBase(settings.rspamdNormalUrl);
  if (!url) return { ok: false, reachable: false, statusCode: null };
  return probeEndpoint(`${url}/ping`);
}

function normalizeScanMetadata(
  metadata: Partial<RspamdScanRequestMetadata> | undefined,
): RspamdScanRequestMetadata {
  const recipients = Array.isArray(metadata?.recipients)
    ? metadata.recipients.map((item) => item.trim()).filter(Boolean)
    : [];

  return {
    envelopeFrom: metadata?.envelopeFrom?.trim() ?? '',
    recipients,
    clientIp: metadata?.clientIp?.trim() ?? '',
    helo: metadata?.helo?.trim() ?? '',
    hostname: metadata?.hostname?.trim() ?? '',
    authenticatedUser: metadata?.authenticatedUser?.trim() ?? '',
    settingsId: metadata?.settingsId?.trim() ?? '',
    queueId: metadata?.queueId?.trim() ?? '',
  };
}

function buildScanSummary(result: Record<string, unknown>): RspamdScanSummary {
  const rawSymbols = typeof result.symbols === 'object' && result.symbols !== null
    ? result.symbols as Record<string, unknown>
    : {};
  const symbolNames = Object.values(rawSymbols)
    .map((item) => (typeof item === 'object' && item !== null ? item as Record<string, unknown> : null))
    .filter((item): item is Record<string, unknown> => Boolean(item))
    .sort((a, b) => {
      const scoreA = typeof a.score === 'number' ? Math.abs(a.score) : Number(a.score ?? 0);
      const scoreB = typeof b.score === 'number' ? Math.abs(b.score) : Number(b.score ?? 0);
      return scoreB - scoreA;
    })
    .map((item) => typeof item.name === 'string' ? item.name : null)
    .filter((item): item is string => Boolean(item));

  return {
    action: typeof result.action === 'string' ? result.action : null,
    score: typeof result.score === 'number' ? result.score : Number.isFinite(Number(result.score)) ? Number(result.score) : null,
    requiredScore: typeof result.required_score === 'number'
      ? result.required_score
      : Number.isFinite(Number(result.required_score))
        ? Number(result.required_score)
        : null,
    isSkipped: Boolean(result.is_skipped),
    symbolNames,
  };
}

function scanHistoryPath(storeDir: string, hash: string): string {
  return safeJoin(storeDir, 'scan-lab', `${hash}.eml`);
}

function hashScanMessage(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

async function persistScanMessage(storeDir: string, content: Buffer): Promise<{
  hash: string;
  absolutePath: string;
  relativePath: string;
}> {
  if (content.byteLength > RSPAMD_SCAN_HISTORY_MAX_BYTES) {
    throw new Error('Message exceeds the maximum scan history size');
  }
  const hash = hashScanMessage(content);
  const absolutePath = scanHistoryPath(storeDir, hash);
  await fs.mkdir(path.dirname(absolutePath), { recursive: true });
  try {
    await fs.access(absolutePath, fsConstants.F_OK);
  } catch {
    await fs.writeFile(absolutePath, content, { mode: 0o600 });
  }
  return {
    hash,
    absolutePath,
    relativePath: path.relative(storeDir, absolutePath),
  };
}

async function maybePersistScanMessage(
  storeDir: string | null,
  content: Buffer,
): Promise<{ hash: string; relativePath: string | null }> {
  if (!storeDir) {
    return {
      hash: hashScanMessage(content),
      relativePath: null,
    };
  }

  return persistScanMessage(storeDir, content);
}

async function readJsonResponse(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    const parsed = JSON.parse(text);
    return typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {};
  } catch {
    throw new Error(`Rspamd returned invalid JSON: ${text.slice(0, 400)}`);
  }
}

function buildScanHeaders(metadata: RspamdScanRequestMetadata): Headers {
  const headers = new Headers({
    Flags: 'groups',
  });
  if (metadata.envelopeFrom) headers.set('From', metadata.envelopeFrom);
  if (metadata.clientIp) headers.set('IP', metadata.clientIp);
  if (metadata.helo) headers.set('Helo', metadata.helo);
  if (metadata.hostname) headers.set('Hostname', metadata.hostname);
  if (metadata.authenticatedUser) headers.set('User', metadata.authenticatedUser);
  if (metadata.settingsId) headers.set('Settings-ID', metadata.settingsId);
  if (metadata.queueId) headers.set('Queue-Id', metadata.queueId);
  for (const recipient of metadata.recipients) {
    headers.append('Rcpt', recipient);
  }
  return headers;
}

function getRspamdScanBase(settings: RspamdSettings): string {
  return normalizeEndpointBase(settings.rspamdNormalUrl)
    ?? normalizeEndpointBase(settings.rspamdControllerUrl)
    ?? '';
}

async function scanMessageWithRspamd(
  settings: RspamdSettings,
  transport: 'checkv2' | 'checkv3',
  content: Buffer,
  metadata: RspamdScanRequestMetadata,
): Promise<Record<string, unknown>> {
  const baseUrl = getRspamdScanBase(settings);
  if (!baseUrl) {
    throw new Error('Rspamd normal worker URL is not configured');
  }

  const url = `${baseUrl}/${transport}`;
  let response: Response;
  if (transport === 'checkv3') {
    const form = new FormData();
    form.append('metadata', new Blob([JSON.stringify({
      ip: metadata.clientIp || undefined,
      helo: metadata.helo || undefined,
      from: metadata.envelopeFrom || undefined,
      rcpt: metadata.recipients,
      hostname: metadata.hostname || undefined,
      user: metadata.authenticatedUser || undefined,
      settings_id: metadata.settingsId || undefined,
      queue_id: metadata.queueId || undefined,
    })], { type: 'application/json' }));
    form.append('message', new Blob([new Uint8Array(content)], { type: 'application/octet-stream' }), 'message.eml');
    response = await fetch(url, {
      method: 'POST',
      body: form,
    });
  } else {
    const headers = buildScanHeaders(metadata);
    headers.set('Content-Type', 'message/rfc822');
    response = await fetch(url, {
      method: 'POST',
      headers,
      body: content,
    });
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Rspamd ${transport} failed (${response.status}): ${text || response.statusText}`);
  }
  return readJsonResponse(response);
}

async function fetchControllerJson(
  settings: RspamdSettings,
  endpoint: string,
): Promise<Record<string, unknown>> {
  const controllerUrl = normalizeEndpointBase(settings.rspamdControllerUrl);
  if (!controllerUrl) {
    throw new Error('Rspamd controller URL is not configured');
  }
  const password = settings.rspamdControllerPassword || settings.rspamdEnablePassword;
  const response = await fetch(`${controllerUrl}/${endpoint}`, {
    headers: password ? { Password: password } : undefined,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Rspamd ${endpoint} failed (${response.status}): ${text || response.statusText}`);
  }
  return readJsonResponse(response);
}

async function postControllerMessage(
  settings: RspamdSettings,
  endpoint: 'learnspam' | 'learnham' | 'fuzzyadd' | 'fuzzydel',
  content: Buffer,
  headers: Record<string, string> = {},
): Promise<void> {
  const controllerUrl = normalizeEndpointBase(settings.rspamdControllerUrl);
  if (!controllerUrl) {
    throw new Error('Rspamd controller URL is not configured');
  }
  const password = settings.rspamdControllerPassword || settings.rspamdEnablePassword;
  const response = await fetch(`${controllerUrl}/${endpoint}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'message/rfc822',
      ...(password ? { Password: password } : {}),
      ...headers,
    },
    body: content,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`Rspamd ${endpoint} failed (${response.status}): ${text || response.statusText}`);
  }
}

async function readManagedFile(
  serviceId: string | null | undefined,
  fileName: string,
  renderedContent: string,
  managementEnabled = false
): Promise<ManagedFileState> {
  const payload = await getConfigStorePayload<ManagedFilePayload>(
    RSPAMD_CONFIG_STORE_TABLE,
    'service_id',
    serviceId ?? '',
    fileName
  );
  const content = typeof payload?.content === 'string' ? payload.content : renderedContent;
  const exists = Boolean(serviceId) && content.length > 0;
  return {
    path: storeRef(serviceId, fileName),
    exists,
    readable: exists,
    writable: Boolean(serviceId),
    managed: content.includes(MANAGED_MARKER),
    managementEnabled,
    content: exists ? content : null,
  };
}

function renderDkimSigningConf(config: RspamdManagedConfig): string {
  return [
    MANAGED_MARKER,
    `enabled = ${config.rspamdDkimEnabled ? 'true' : 'false'};`,
    `path = "${config.rspamdDkimPathTemplate}";`,
    `sign_authenticated = ${config.rspamdDkimSignAuthenticated ? 'true' : 'false'};`,
    `sign_local = ${config.rspamdDkimSignLocal ? 'true' : 'false'};`,
    `use_domain = "${config.rspamdDkimUseDomain}";`,
    `try_fallback = ${config.rspamdDkimTryFallback ? 'true' : 'false'};`,
    `selector = "${config.rspamdDkimFallbackSelector}";`,
    `check_pubkey = ${config.rspamdDkimCheckPubkey ? 'true' : 'false'};`,
    `allow_pubkey_mismatch = ${config.rspamdDkimAllowPubkeyMismatch ? 'true' : 'false'};`,
    '',
  ].join('\n');
}

function renderBayesConf(config: RspamdManagedConfig): string {
  return [
    MANAGED_MARKER,
    `backend = "${config.rspamdBayesBackend}";`,
    // Blank servers => inherit the global redis.conf (the recommended setup, so
    // one Redis config drives Bayes, ratelimit, fuzzy, history, etc.). Only pin a
    // Bayes-specific server when explicitly set.
    config.rspamdBayesRedisServers.trim() ? `servers = "${config.rspamdBayesRedisServers.trim()}";` : '',
    `tokenizer { name = "${config.rspamdBayesTokenizer}"; }`,
    `min_learns = ${config.rspamdBayesMinLearns};`,
    `autolearn = ${config.rspamdBayesAutolearnEnabled ? 'true' : 'false'};`,
    `spam_threshold = ${config.rspamdBayesSpamThreshold};`,
    config.rspamdBayesJunkThreshold === null ? '' : `junk_threshold = ${config.rspamdBayesJunkThreshold};`,
    `ham_threshold = ${config.rspamdBayesHamThreshold};`,
    `check_balance = ${config.rspamdBayesCheckBalance ? 'true' : 'false'};`,
    `min_balance = ${config.rspamdBayesMinBalance};`,
    '',
  ].filter(Boolean).join('\n');
}

async function writeManagedFile(
  serviceId: string,
  fileName: string,
  content: string
): Promise<void> {
  await upsertConfigStorePayload(
    RSPAMD_CONFIG_STORE_TABLE,
    'service_id',
    serviceId,
    fileName,
    {
      content,
      managedBy: 'Robin Admin',
    }
  );
}

export async function getRspamdStatus(settingsOverride?: RspamdSettings): Promise<RspamdStatus> {
  const settings = settingsOverride ?? await getRspamdSettings();
  const serviceId = settings.serviceId ?? null;
  const [service, configDir, storeDir, trainingDir, controller, normalWorker] = await Promise.all([
    serviceId ? getFleetServiceById(serviceId) : Promise.resolve(null),
    probeConfiguredPath(settings.rspamdConfigDir, storeRef(serviceId, 'local.d'), Boolean(serviceId)),
    probeConfiguredPath(settings.rspamdStoreDir, storeRef(serviceId, 'store'), Boolean(serviceId)),
    probeConfiguredPath(settings.rspamdTrainingDir, storeRef(serviceId, 'training'), Boolean(serviceId)),
    probeController(settings),
    probeNormalWorker(settings),
  ]);
  const serviceEnabled = service?.enabled ?? false;

  const reasons: string[] = [];
  if (!serviceId) reasons.push('No managed Rspamd service is registered in fleet_services');
  if (serviceId && !serviceEnabled) reasons.push('Selected Rspamd service is disabled');
  if (settings.rspamdConfigDir && !configDir.readable) reasons.push(`Config cache path is not readable: ${settings.rspamdConfigDir}`);
  if (settings.rspamdStoreDir && !storeDir.readable) reasons.push(`Store cache path is not readable: ${settings.rspamdStoreDir}`);
  if (settings.rspamdControllerUrl && !controller.ping.reachable && !controller.healthy.reachable && !controller.stat.reachable) {
    reasons.push(`Rspamd controller is not reachable at ${settings.rspamdControllerUrl}`);
  }
  if ((controller.ping.reachable || controller.healthy.reachable || controller.stat.reachable) && !controller.authenticated) {
    reasons.push('Rspamd controller is reachable but controller authentication failed');
  }
  if (settings.rspamdNormalUrl && !normalWorker.reachable) reasons.push(`Rspamd normal worker is not reachable at ${settings.rspamdNormalUrl}`);
  if (!settings.rspamdControllerUrl) reasons.push('Rspamd controller URL is not configured');
  if (!settings.rspamdNormalUrl) reasons.push('Rspamd normal worker URL is not configured');
  if (settings.rspamdConfigDir && configDir.readable && !configDir.writable) reasons.push(`Config cache path is read-only: ${settings.rspamdConfigDir}`);
  if (settings.rspamdStoreDir && storeDir.readable && !storeDir.writable) reasons.push(`Store cache path is read-only: ${settings.rspamdStoreDir}`);

  const controllerReachable = controller.ping.reachable || controller.healthy.reachable || controller.stat.reachable;

  return {
    available: Boolean(serviceId) && serviceEnabled && controllerReachable,
    enabled: serviceEnabled,
    controllerReachable,
    controllerAuthenticated: controller.authenticated,
    controllerStatusCode: controller.stat.statusCode,
    controllerPingOk: controller.ping.ok,
    controllerPingStatusCode: controller.ping.statusCode,
    controllerHealthyOk: controller.healthy.ok,
    controllerHealthyStatusCode: controller.healthy.statusCode,
    controllerStatAuthOk: controller.stat.ok,
    controllerStatStatusCode: controller.stat.statusCode,
    normalWorkerPingOk: normalWorker.ok,
    normalWorkerPingStatusCode: normalWorker.statusCode,
    configDir,
    storeDir,
    trainingDir,
    reasons,
    siblingSuggestion: null,
  };
}

// Config-store scope owner: 'default' base, or a per-instance override scope.
function scopeOwner(scopeId?: string | null): string {
  const trimmed = (scopeId ?? '').trim();
  return trimmed === '' ? RSPAMD_BASE_SCOPE : trimmed;
}

async function readScopeValues(owner: string, fileName: string): Promise<Record<string, unknown>> {
  const stored = await getConfigStorePayload<Record<string, unknown>>(
    RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, fileName,
  );
  return isRecord(stored) ? stored : {};
}

// ── Per-file managed configs (redis.conf, logging.inc, …) ───────────────────
// Values layer base ('default') ⊕ instance override delta; the rendered .conf is
// written per scope as the full effective file (the pull-agent replaces text
// files wholesale, so the instance content must be the merged result).
async function getRspamdManagedFileEntry(
  scopeId: string | null | undefined,
  def: RspamdManagedFileDef,
): Promise<RspamdManagedFileEntry> {
  const owner = scopeOwner(scopeId);
  const base = await readScopeValues(RSPAMD_BASE_SCOPE, valuesStoreFileName(def.key));
  const effectiveRaw = owner === RSPAMD_BASE_SCOPE
    ? base
    : deepMerge(base, await readScopeValues(owner, valuesStoreFileName(def.key)));
  const values = def.normalize(Object.keys(effectiveRaw).length ? effectiveRaw : def.defaults) as Record<string, unknown>;
  const rendered = def.render(values);
  const state = await readManagedFile(owner, def.fileName, rendered, true);
  return { key: def.key, fileName: def.fileName, values, rendered, state };
}

export async function getRspamdManagedFiles(serviceId?: string | null): Promise<RspamdManagedFileEntry[]> {
  return Promise.all(RSPAMD_MANAGED_FILES.map((def) => getRspamdManagedFileEntry(serviceId ?? null, def)));
}

/** Save one per-file managed config: store base-full / instance-delta values + write the effective file. */
export async function saveRspamdManagedFile(
  key: string,
  values: unknown,
  serviceId?: string,
): Promise<RspamdManagedFileEntry> {
  const def = RSPAMD_MANAGED_FILES_BY_KEY[key];
  if (!def) {
    throw new Error(`Unknown Rspamd managed file: ${key}`);
  }
  const owner = scopeOwner(serviceId);
  const effective = def.normalize(values) as Record<string, unknown>;
  const baseValues = def.normalize(await readScopeValues(RSPAMD_BASE_SCOPE, valuesStoreFileName(def.key))) as Record<string, unknown>;
  const toStore = owner === RSPAMD_BASE_SCOPE ? effective : extractDelta(baseValues, effective);
  await upsertConfigStorePayload(
    RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, valuesStoreFileName(def.key), toStore,
  );
  await writeManagedFile(owner, def.fileName, def.render(effective));
  return getRspamdManagedFileEntry(owner, def);
}

/** All config scopes for rspamd: the 'default' base plus every override owner. */
export async function listRspamdConfigScopes(): Promise<string[]> {
  return listConfigStoreOwners(RSPAMD_CONFIG_STORE_TABLE, 'service_id');
}

/**
 * Drop an instance's override for one file so it inherits the base again. The
 * dkim/bayes sections share one managed-config object, so resetting either
 * resets both (plus their rendered files). Refuses the base scope.
 */
export async function resetRspamdManagedFile(key: string, serviceId?: string): Promise<RspamdConfigState> {
  const owner = scopeOwner(serviceId);
  if (owner === RSPAMD_BASE_SCOPE) {
    throw new Error('The default base scope has no override to reset');
  }
  if (key === 'dkim' || key === 'bayes') {
    await Promise.all([
      deleteConfigStoreEntry(RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, RSPAMD_MANAGED_CONFIG_STORE_FILE),
      deleteConfigStoreEntry(RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, RSPAMD_FILE_MANAGEMENT_STORE_FILE),
      deleteConfigStoreEntry(RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, MANAGED_DKIM_FILE),
      deleteConfigStoreEntry(RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, MANAGED_BAYES_FILE),
    ]);
  } else {
    const def = RSPAMD_MANAGED_FILES_BY_KEY[key];
    if (!def) {
      throw new Error(`Unknown Rspamd managed file: ${key}`);
    }
    await Promise.all([
      deleteConfigStoreEntry(RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, valuesStoreFileName(def.key)),
      deleteConfigStoreEntry(RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, def.fileName),
    ]);
  }
  return getRspamdConfigState(owner);
}

// `rspamadm configtest` then `control reload` on the service's host, through
// the agent that applies its config.
export async function reloadRspamd(serviceId?: string): Promise<string> {
  const settings = await getRspamdSettings(serviceId);
  const service = settings.serviceId ? await getFleetServiceById(settings.serviceId) : null;
  if (!service) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }
  const agentId = commandAgentFor(service, 'config');
  if (!agentId) {
    throw new Error('This Rspamd service has no robin-agent to reload it');
  }
  return summarizeRspamdReload(await runAgentCommand(agentId, service, 'rspamd.reload'));
}

/** `rspamadm control reload` lists every worker with a status; 0 means it reloaded. */
export function summarizeRspamdReload(output: string): string {
  const workers = [...output.matchAll(/type = "([^"]+)";\s*status = (-?\d+);/g)];
  if (workers.length === 0) return output.trim() || 'Reload signal sent';
  const failed = workers.filter((worker) => worker[2] !== '0').map((worker) => worker[1]);
  if (failed.length === 0) return `Reloaded ${workers.length} Rspamd workers`;
  return `Reloaded ${workers.length - failed.length} of ${workers.length} Rspamd workers; failed: ${failed.join(', ')}`;
}

export async function getRspamdConfigState(serviceId?: string): Promise<RspamdConfigState> {
  const settings = await getRspamdSettings(serviceId);
  const managedConfig = await getRspamdManagedConfig(serviceId);
  const fileManagement = await getRspamdFileManagement(serviceId);
  const owner = scopeOwner(serviceId);
  const dkimManagementEnabled = fileManagement.dkim ?? true;
  const bayesManagementEnabled = fileManagement.bayes ?? true;
  const [dkimRaw, bayesRaw, managedFiles] = await Promise.all([
    readManagedFile(owner, MANAGED_DKIM_FILE, renderDkimSigningConf(managedConfig), dkimManagementEnabled),
    readManagedFile(owner, MANAGED_BAYES_FILE, renderBayesConf(managedConfig), bayesManagementEnabled),
    getRspamdManagedFiles(owner),
  ]);
  const status = await getRspamdStatus(settings);
  const files = {
    dkim: { ...dkimRaw, managementEnabled: dkimManagementEnabled },
    bayes: { ...bayesRaw, managementEnabled: bayesManagementEnabled },
  };
  return { settings: toPublicRspamdSettings(settings), managedConfig, status, files, managedFiles };
}

export async function saveRspamdSettings(updates: Partial<RspamdSettings>): Promise<RspamdSettings> {
  return updateRspamdSettings(updates);
}

export async function saveRspamdManagedConfig(
  updates: Partial<RspamdManagedConfig>,
  options: { manageDkimFile?: boolean; manageBayesFile?: boolean } = {},
  serviceId?: string,
): Promise<RspamdConfigState> {
  const owner = scopeOwner(serviceId);
  const managedConfig = await updateRspamdManagedConfig(updates, owner);
  const fileManagement = Object.keys(options).length > 0
    ? await updateRspamdFileManagement({
      dkim: options.manageDkimFile,
      bayes: options.manageBayesFile,
    }, owner)
    : await getRspamdFileManagement(owner);
  const dkimManagementEnabled = fileManagement.dkim ?? true;
  const bayesManagementEnabled = fileManagement.bayes ?? true;

  // Write the effective rendered .conf per scope (base or instance). The values
  // delta is already persisted by updateRspamdManagedConfig; this is the
  // materialized file the pull-agent applies.
  if (dkimManagementEnabled) {
    await writeManagedFile(owner, MANAGED_DKIM_FILE, renderDkimSigningConf(managedConfig));
  }
  if (bayesManagementEnabled) {
    await writeManagedFile(owner, MANAGED_BAYES_FILE, renderBayesConf(managedConfig));
  }

  return getRspamdConfigState(owner);
}

function computeSelectorSuffix(existing: string[], prefix: string): string {
  if (!existing.includes(prefix)) return prefix;
  const alphabet = 'abcdefghijklmnopqrstuvwxyz';
  for (const char of alphabet) {
    const candidate = `${prefix}${char}`;
    if (!existing.includes(candidate)) return candidate;
  }
  throw new Error(`No selector suffix slots left for ${prefix}`);
}

async function nextSelector(domainId: number, date = new Date()): Promise<string> {
  const prefix = date.toISOString().slice(0, 10).replace(/-/g, '');
  const existing = await listSelectorNamesByPrefix(domainId, prefix);
  return computeSelectorSuffix(existing, prefix);
}

function buildDkimDnsTxt(publicKeyP: string): string {
  return `v=DKIM1; k=rsa; p=${publicKeyP}`;
}

function normalizeSelectorInput(selector: string | null | undefined): string | null {
  const normalized = (selector ?? '').trim().toLowerCase();
  if (!normalized) {
    return null;
  }
  if (!/^[a-z0-9][a-z0-9_-]{0,62}$/i.test(normalized)) {
    throw new Error('Selector must start with a letter or number and contain only letters, numbers, hyphens, or underscores');
  }
  return normalized;
}

function generateDkimMaterial(selector: string, domain: string): {
  selector: string;
  domain: string;
  privateKeyPem: string;
  publicKeyP: string;
  publicKeyTxt: string;
  algorithm: string;
  keyBits: number;
} {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicExponent: 0x10001,
  });

  const privateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
  const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
  return {
    selector,
    domain,
    privateKeyPem,
    publicKeyP: publicKeyDer,
    publicKeyTxt: buildDkimDnsTxt(publicKeyDer),
    algorithm: 'rsa',
    keyBits: 2048,
  };
}

function deriveDkimMaterialFromPrivateKey(selector: string, domain: string, privateKeyPem: string): {
  selector: string;
  domain: string;
  privateKeyPem: string;
  publicKeyP: string;
  publicKeyTxt: string;
  algorithm: string;
  keyBits: number;
} {
  try {
    const privateKey = createPrivateKey(privateKeyPem);
    if (privateKey.asymmetricKeyType !== 'rsa') {
      throw new Error('Only RSA private keys are supported');
    }
    const publicKey = createPublicKey(privateKey);
    const normalizedPrivateKeyPem = privateKey.export({ format: 'pem', type: 'pkcs8' }).toString();
    const publicKeyDer = publicKey.export({ format: 'der', type: 'spki' }).toString('base64');
    return {
      selector,
      domain,
      privateKeyPem: normalizedPrivateKeyPem,
      publicKeyP: publicKeyDer,
      publicKeyTxt: buildDkimDnsTxt(publicKeyDer),
      algorithm: 'rsa',
      keyBits: privateKey.asymmetricKeyDetails?.modulusLength ?? 2048,
    };
  } catch (error) {
    throw error instanceof Error && error.message === 'Only RSA private keys are supported'
      ? error
      : new Error('Invalid private key. Provide an RSA private key in PEM format.');
  }
}

async function resolveSelectorForActivation(domainId: number, requestedSelector?: string | null): Promise<string> {
  const normalized = normalizeSelectorInput(requestedSelector ?? null);
  if (!normalized) {
    return nextSelector(domainId);
  }
  const existing = await listSelectorNamesByPrefix(domainId, normalized);
  if (existing.includes(normalized)) {
    throw new Error(`Selector '${normalized}' already exists for this signing identity`);
  }
  return normalized;
}

export async function createOrRotateDkimKey(domainId: number, mode: 'initial' | 'rotate'): Promise<DkimSigningSelector> {
  const domain = await getDkimDomain(domainId);
  if (!domain) throw new Error('DKIM domain not found');

  const current = await getActiveSelector(domainId);
  if (mode === 'initial' && current) {
    throw new Error('This domain already has an active selector. Use rotate instead.');
  }

  const selector = await nextSelector(domainId);
  return activateDkimMaterial(domainId, generateDkimMaterial(selector, domain.signDomain));
}

export async function importDkimKey(
  domainId: number,
  privateKeyPem: string,
  requestedSelector?: string | null
): Promise<DkimSigningSelector> {
  const domain = await getDkimDomain(domainId);
  if (!domain) throw new Error('DKIM domain not found');

  const selector = await resolveSelectorForActivation(domainId, requestedSelector);
  return activateDkimMaterial(domainId, deriveDkimMaterialFromPrivateKey(selector, domain.signDomain, privateKeyPem));
}

// The key is kept sealed in the database; the fleet agent delivers it to
// rspamd with dkim_signing.conf (see services/rspamd-dkim-delivery.ts).
function activateDkimMaterial(
  domainId: number,
  material: ReturnType<typeof generateDkimMaterial>,
): Promise<DkimSigningSelector> {
  return activateNewSelector({
    domainId,
    selector: material.selector,
    publicKeyTxt: material.publicKeyTxt,
    publicKeyP: material.publicKeyP,
    algorithm: material.algorithm,
    keyBits: material.keyBits,
    privateKeyEnc: encryptStoredSecret(material.privateKeyPem),
  });
}

export async function revokeDkimSelector(selectorId: number): Promise<boolean> {
  return revokeSelector(selectorId);
}

export async function runRspamdDkimMaintenance(): Promise<void> {
  for (const domain of await listDomainsDueForRotation()) {
    try {
      await createOrRotateDkimKey(domain.id, 'rotate');
    } catch (error) {
      logger.warn('DKIM auto-rotation failed', { domain: domain.domain, error: (error as Error).message });
    }
  }

  // Retired keys are kept for the domain's retention window, then dropped.
  for (const selector of await listPurgeableSelectors()) {
    await markSelectorKeyDeleted(selector.id);
  }
}

export function startRspamdMaintenance(): void {
  if (maintenanceTimer) return;
  maintenanceTimer = setInterval(() => {
    runRspamdDkimMaintenance().catch(() => undefined);
  }, 6 * 60 * 60 * 1000);
}

export function stopRspamdMaintenance(): void {
  if (!maintenanceTimer) return;
  clearInterval(maintenanceTimer);
  maintenanceTimer = null;
}

function isArchive(name: string): boolean {
  return ['.zip', '.tar', '.tgz', '.tar.gz'].some((suffix) => name.toLowerCase().endsWith(suffix));
}

function assertSampleSize(fileName: string, size: number): void {
  if (size > TRAINING_SAMPLE_MAX_BYTES) {
    throw new Error(`Training sample ${fileName} exceeds the maximum size`);
  }
}

async function extractArchive(fileName: string, buffer: Buffer): Promise<Array<{ filePath: string; content: Buffer }>> {
  if (buffer.byteLength > TRAINING_ARCHIVE_MAX_INPUT_BYTES) {
    throw new Error(`Archive ${fileName} exceeds the maximum upload size`);
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'robin-admin-rspamd-'));
  const archivePath = path.join(tempRoot, fileName);
  const extractDir = path.join(tempRoot, 'out');
  await fs.mkdir(extractDir, { recursive: true });
  await fs.writeFile(archivePath, buffer);

  try {
    if (fileName.toLowerCase().endsWith('.zip')) {
      await execFileAsync('unzip', ['-q', archivePath, '-d', extractDir]);
    } else {
      await execFileAsync('tar', ['-xf', archivePath, '-C', extractDir]);
    }

    const files: Array<{ filePath: string; content: Buffer }> = [];
    const stack = [extractDir];
    const realExtractDir = await fs.realpath(extractDir);
    let unpackedBytes = 0;
    while (stack.length) {
      const current = stack.pop()!;
      const entries = await fs.readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isSymbolicLink()) {
          throw new Error(`Archive ${fileName} contains a symbolic link`);
        }
        if (entry.isDirectory()) {
          stack.push(fullPath);
        } else {
          const realPath = await fs.realpath(fullPath);
          if (!realPath.startsWith(`${realExtractDir}${path.sep}`)) {
            throw new Error(`Archive ${fileName} contains a path outside the extraction directory`);
          }
          const stat = await fs.stat(fullPath);
          if (!stat.isFile()) {
            continue;
          }
          if (files.length >= TRAINING_ARCHIVE_MAX_FILES) {
            throw new Error(`Archive ${fileName} contains too many files`);
          }
          assertSampleSize(entry.name, stat.size);
          unpackedBytes += stat.size;
          if (unpackedBytes > TRAINING_ARCHIVE_MAX_UNPACKED_BYTES) {
            throw new Error(`Archive ${fileName} exceeds the maximum unpacked size`);
          }
          files.push({
            filePath: path.relative(extractDir, fullPath),
            content: await fs.readFile(fullPath),
          });
        }
      }
    }
    return files;
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

function splitMbox(buffer: Buffer, fileName: string): ExtractedSample[] {
  assertSampleSize(fileName, buffer.byteLength);
  const text = buffer.toString('utf8');
  const parts = text.split(/\n(?=From )/g).filter((part) => part.trim().length > 0);
  if (parts.length > TRAINING_ARCHIVE_MAX_FILES) {
    throw new Error(`Mbox ${fileName} contains too many messages`);
  }
  return parts.map((part, index) => {
    const normalized = part.startsWith('From ') ? part.slice(part.indexOf('\n') + 1) : part;
    const content = Buffer.from(normalized);
    assertSampleSize(`${fileName} message ${index + 1}`, content.byteLength);
    return {
      filename: `${fileName.replace(/\.mbox$/i, '')}-${index + 1}.eml`,
      content,
      sourceType: 'mbox',
    };
  });
}

async function extractSamples(fileName: string, buffer: Buffer): Promise<ExtractedSample[]> {
  const lower = fileName.toLowerCase();
  if (lower.endsWith('.gz') && !lower.endsWith('.tar.gz') && !lower.endsWith('.tgz')) {
    const uncompressed = gunzipSync(buffer, { maxOutputLength: TRAINING_ARCHIVE_MAX_UNPACKED_BYTES });
    return extractSamples(fileName.slice(0, -3), uncompressed);
  }
  if (lower.endsWith('.eml')) {
    assertSampleSize(fileName, buffer.byteLength);
    return [{ filename: fileName, content: buffer, sourceType: 'eml' }];
  }
  if (lower.endsWith('.mbox')) {
    return splitMbox(buffer, fileName);
  }
  if (isArchive(lower)) {
    const extracted = await extractArchive(fileName, buffer);
    const nested: ExtractedSample[] = [];
    for (const entry of extracted) {
      nested.push(...await extractSamples(entry.filePath, entry.content));
      if (nested.length > TRAINING_ARCHIVE_MAX_FILES) {
        throw new Error(`Archive ${fileName} produced too many training samples`);
      }
    }
    return nested.map((item) => ({ ...item, sourceType: 'archive' }));
  }
  throw new Error(`Unsupported training file format: ${fileName}`);
}

async function learnBuffer(
  label: 'spam' | 'ham',
  content: Buffer,
  settings: RspamdSettings,
  classifier?: string | null,
): Promise<void> {
  const endpoint = label === 'spam' ? 'learnspam' : 'learnham';
  try {
    await postControllerMessage(settings, endpoint, content, classifier ? { Classifier: classifier } : {});
  } catch (error) {
    if (!isAlreadyLearnedAs(label, (error as Error).message)) throw error;
  }
}

/**
 * Rspamd refuses (404) to learn a message it already learned with the same
 * label; the message is learned, which is what was asked for.
 */
export function isAlreadyLearnedAs(label: 'spam' | 'ham', message: string): boolean {
  return message.includes(`has been already learned as ${label},`);
}

function samplePath(trainingDir: string, hash: string): string {
  return safeJoin(trainingDir, 'samples', `${hash}.eml`);
}

async function importTrainingBuffers(
  files: TrainingUploadBuffer[],
  label: 'spam' | 'ham',
  createdBy: number | null,
  serviceId?: string,
): Promise<TrainingImportResult> {
  const settings = await getRspamdSettings(serviceId);
  const trainingDir = requireConfiguredPath(settings.rspamdTrainingDir, 'Rspamd training directory');
  const importJob = await createTrainingImport({
    sourceFilename: files.length === 1 ? files[0].name : null,
    label,
    createdBy,
    totalFiles: files.length,
  });

  const createdSamples: TrainingSample[] = [];
  const skipped: Array<{ fileName: string; reason: string }> = [];
  const errors: string[] = [];
  let learnedSamples = 0;

  try {
    await fs.mkdir(path.join(trainingDir, 'samples'), { recursive: true });

    for (const file of files) {
      try {
        const extracted = await extractSamples(file.name, file.content);
        for (const sample of extracted) {
          const hash = createHash('sha256').update(sample.content).digest('hex');
          const existing = await getTrainingSampleByHash(hash);
          if (existing) {
            skipped.push({ fileName: sample.filename, reason: 'Duplicate sample' });
            continue;
          }

          const absPath = samplePath(trainingDir, hash);
          await fs.writeFile(absPath, sample.content, { mode: 0o600 });
          const relpath = path.relative(trainingDir, absPath);
          const created = await createTrainingSample({
            importId: importJob.id,
            filename: sample.filename,
            contentHash: hash,
            label,
            sourceType: sample.sourceType,
            storedRelpath: relpath,
            sizeBytes: sample.content.byteLength,
          });

          if (!created) {
            skipped.push({ fileName: sample.filename, reason: 'Duplicate sample' });
            continue;
          }

          try {
            await learnBuffer(label, sample.content, settings);
            await updateTrainingSampleLearning(created.id, { status: 'learned' });
            learnedSamples += 1;
            const updated = await getTrainingSample(created.id);
            createdSamples.push(updated ?? created);
          } catch (error) {
            const message = (error as Error).message;
            await updateTrainingSampleLearning(created.id, { status: 'failed', error: message });
            const updated = await getTrainingSample(created.id);
            createdSamples.push(updated ?? created);
            errors.push(`${sample.filename}: ${message}`);
          }
        }
      } catch (error) {
        errors.push(`${file.name}: ${(error as Error).message}`);
      }
    }

    const status = errors.length === files.length && createdSamples.length === 0 ? 'failed' : 'completed';
    await finalizeTrainingImport({
      id: importJob.id,
      status,
      totalSamples: createdSamples.length,
      learnedSamples,
      errors,
    });
  } catch (error) {
    errors.push((error as Error).message);
    await finalizeTrainingImport({
      id: importJob.id,
      status: 'failed',
      totalSamples: createdSamples.length,
      learnedSamples,
      errors,
    });
  }

  return {
    job: await getTrainingImport(importJob.id),
    samples: createdSamples,
    skipped,
  };
}

export async function importTrainingBinary(
  file: TrainingUploadBuffer,
  label: 'spam' | 'ham',
  createdBy: number | null,
  serviceId?: string,
): Promise<TrainingImportResult> {
  return importTrainingBuffers([file], label, createdBy, serviceId);
}

export async function relearnTrainingSample(
  id: number,
  serviceId?: string,
  classifier?: string | null,
): Promise<TrainingSample | null> {
  const sample = await getTrainingSample(id);
  if (!sample) return null;
  const settings = await getRspamdSettings(serviceId);
  const absolutePath = safeJoin(
    requireConfiguredPath(settings.rspamdTrainingDir, 'Rspamd training directory'),
    sample.storedRelpath
  );
  const content = await fs.readFile(absolutePath);
  try {
    await learnBuffer(sample.label, content, settings, classifier);
    await updateTrainingSampleLearning(sample.id, { status: 'learned', error: null });
  } catch (error) {
    await updateTrainingSampleLearning(sample.id, { status: 'failed', error: (error as Error).message });
  }
  return getTrainingSample(id);
}

export async function relabelAndRelearnTrainingSample(
  id: number,
  label: 'spam' | 'ham',
  serviceId?: string,
  classifier?: string | null,
): Promise<TrainingSample | null> {
  const relabeled = await relabelTrainingSample(id, label);
  if (!relabeled) return null;
  return relearnTrainingSample(id, serviceId, classifier);
}

export async function deleteTrainingSampleAndFile(id: number, serviceId?: string): Promise<TrainingSample | null> {
  const sample = await getTrainingSample(id);
  if (!sample) return null;
  const settings = await getRspamdSettings(serviceId);
  const absolutePath = safeJoin(
    requireConfiguredPath(settings.rspamdTrainingDir, 'Rspamd training directory'),
    sample.storedRelpath
  );
  await fs.rm(absolutePath, { force: true });
  return deleteTrainingSample(id);
}

export async function getTrainingCorpus(options: TrainingSampleListOptions = {}): Promise<{
  samples: TrainingSample[];
  total: number;
  page: number;
  limit: number;
}> {
  return listTrainingSamples(options);
}

function mapStatfileEntry(item: unknown): RspamdClassifierStatusEntry | null {
  if (typeof item !== 'object' || item === null) {
    return null;
  }
  const record = item as Record<string, unknown>;
  const symbol = typeof record.symbol === 'string'
    ? record.symbol
    : typeof record.name === 'string'
      ? record.name
      : '';
  if (!symbol) {
    return null;
  }
  return {
    symbol,
    type: typeof record.type === 'string' ? record.type : 'unknown',
    revision: Number.isFinite(Number(record.revision)) ? Number(record.revision) : null,
    size: Number.isFinite(Number(record.size)) ? Number(record.size) : null,
    users: Number.isFinite(Number(record.users)) ? Number(record.users) : null,
    languages: Array.isArray(record.languages)
      ? record.languages.filter((value): value is string => typeof value === 'string')
      : [],
  };
}

export async function getRspamdClassifierSummary(serviceId?: string): Promise<RspamdClassifierSummary> {
  const settings = await getRspamdSettings(serviceId);
  const classifierSettings = await getRspamdClassifierSettings(serviceId);
  const [controller, normalWorker] = await Promise.all([
    probeController(settings),
    probeNormalWorker(settings),
  ]);

  let statfiles: RspamdClassifierStatusEntry[] = [];
  let learnedMessages: number | null = null;
  try {
    const stat = await fetchControllerJson(settings, 'stat');
    statfiles = Array.isArray(stat.statfiles)
      ? stat.statfiles.map(mapStatfileEntry).filter((item): item is RspamdClassifierStatusEntry => Boolean(item))
      : [];
    // Rspamd 4 can report no statfiles while its classifiers learn; the learned count is reliable.
    learnedMessages = Number.isFinite(Number(stat.learned)) ? Number(stat.learned) : null;
  } catch {
    statfiles = [];
  }

  return {
    serviceId: settings.serviceId ?? null,
    defaultTransport: classifierSettings.defaultTransport,
    defaultClassifier: classifierSettings.defaultClassifier,
    controllerReachable: controller.ping.reachable || controller.healthy.reachable || controller.stat.reachable,
    controllerAuthenticated: controller.authenticated,
    normalWorkerReachable: normalWorker.reachable,
    fuzzyPresets: classifierSettings.fuzzyPresets,
    statfiles,
    learnedMessages,
    symbolsByType: Array.from(new Set(statfiles.map((entry) => entry.symbol))).sort(),
  };
}

export async function saveRspamdClassifierSettings(
  updates: Partial<RspamdClassifierSettings>,
  serviceId?: string,
): Promise<RspamdClassifierSummary> {
  const settings = await getRspamdSettings(serviceId);
  if (!settings.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }
  await updateRspamdClassifierSettings(updates, settings.serviceId);
  return getRspamdClassifierSummary(settings.serviceId);
}

export async function runRspamdScan(
  input: RspamdScanRequest,
  actorAdminId: number | null,
): Promise<RspamdScanHistoryDetail> {
  const rawMessage = input.rawMessage ?? '';
  if (!rawMessage.trim()) {
    throw new Error('A raw RFC822 message is required');
  }

  const settings = await getRspamdSettings(input.serviceId);
  if (!settings.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }
  const classifierSettings = await getRspamdClassifierSettings(settings.serviceId);
  const transport = input.transport ?? classifierSettings.defaultTransport;
  const metadata = normalizeScanMetadata(input.metadata);
  const content = Buffer.from(rawMessage, 'utf8');
  const storeDir = optionalConfiguredPath(settings.rspamdStoreDir);
  const stored = await maybePersistScanMessage(storeDir, content);
  const result = await scanMessageWithRspamd(settings, transport, content, metadata);
  const summary = buildScanSummary(result);

  const created = await createRspamdScanRun({
    serviceId: settings.serviceId,
    actorAdminId,
    transport,
    sourceMode: input.fileName ? 'upload' : 'raw',
    sourceFileName: input.fileName ?? null,
    messageHash: stored.hash,
    rawMessageRelpath: stored.relativePath,
    messageSizeBytes: content.byteLength,
    metadata,
    result,
    summaryAction: summary.action,
    summaryScore: summary.score,
    summaryRequiredScore: summary.requiredScore,
    summarySymbols: summary.symbolNames,
    isSkipped: summary.isSkipped,
  });
  return { ...created, rawMessage };
}

export async function runRspamdScanFile(
  input: {
    serviceId?: string;
    transport?: 'checkv2' | 'checkv3';
    fileName?: string | null;
    metadata?: Partial<RspamdScanRequestMetadata>;
    content: Buffer;
  },
  actorAdminId: number | null,
): Promise<RspamdScanHistoryDetail> {
  if (!Buffer.isBuffer(input.content) || input.content.length === 0) {
    throw new Error('A message upload is required');
  }
  const rawMessage = input.content.toString('utf8');
  return runRspamdScan({
    serviceId: input.serviceId,
    transport: input.transport,
    rawMessage,
    fileName: input.fileName ?? null,
    metadata: input.metadata,
  }, actorAdminId);
}

export async function listRspamdScanHistory(options: {
  serviceId?: string;
  page?: number;
  limit?: number;
}): Promise<{
  runs: RspamdScanRunSummary[];
  total: number;
  page: number;
  limit: number;
}> {
  const settings = await getRspamdSettings(options.serviceId);
  if (!settings.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }
  return listRspamdScanRuns({
    serviceId: settings.serviceId,
    page: options.page,
    limit: options.limit,
  });
}

export async function getRspamdScanHistoryDetail(id: number, serviceId?: string): Promise<RspamdScanHistoryDetail | null> {
  const settings = await getRspamdSettings(serviceId);
  if (!settings.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }
  const detail = await getRspamdScanRun(id, settings.serviceId);
  if (!detail) {
    return null;
  }
  if (!detail.rawMessageRelpath) {
    return {
      ...detail,
      rawMessage: '',
    };
  }
  const storeDir = requireConfiguredPath(settings.rspamdStoreDir, 'Rspamd store directory');
  const rawMessage = await fs.readFile(safeJoin(storeDir, detail.rawMessageRelpath), 'utf8');
  return {
    ...detail,
    rawMessage,
  };
}

export async function replayRspamdScan(id: number, serviceId: string | undefined, actorAdminId: number | null): Promise<RspamdScanHistoryDetail | null> {
  const detail = await getRspamdScanHistoryDetail(id, serviceId);
  if (!detail) {
    return null;
  }
  if (!detail.rawMessageRelpath) {
    throw new Error('Raw message was not retained for this scan because Rspamd store directory was not configured');
  }
  const settings = await getRspamdSettings(detail.serviceId);
  if (!settings.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }
  const storeDir = requireConfiguredPath(settings.rspamdStoreDir, 'Rspamd store directory');
  const content = Buffer.from(detail.rawMessage, 'utf8');
  const stored = await persistScanMessage(storeDir, content);
  const result = await scanMessageWithRspamd(settings, detail.transport, content, detail.metadata);
  const summary = buildScanSummary(result);

  const created = await createRspamdScanRun({
    serviceId: settings.serviceId,
    actorAdminId,
    parentRunId: detail.id,
    transport: detail.transport,
    sourceMode: 'replay',
    sourceFileName: detail.sourceFileName,
    messageHash: stored.hash,
    rawMessageRelpath: stored.relativePath,
    messageSizeBytes: content.byteLength,
    metadata: detail.metadata,
    result,
    summaryAction: summary.action,
    summaryScore: summary.score,
    summaryRequiredScore: summary.requiredScore,
    summarySymbols: summary.symbolNames,
    isSkipped: summary.isSkipped,
  });
  return { ...created, rawMessage: detail.rawMessage };
}

export async function learnRspamdScan(
  id: number,
  label: 'spam' | 'ham',
  actorAdminId: number | null,
  serviceId?: string,
  classifier?: string | null,
): Promise<RspamdScanActionRecord | null> {
  const detail = await getRspamdScanHistoryDetail(id, serviceId);
  if (!detail) {
    return null;
  }
  if (!detail.rawMessageRelpath) {
    throw new Error('Raw message was not retained for this scan because Rspamd store directory was not configured');
  }
  const settings = await getRspamdSettings(detail.serviceId);
  const content = Buffer.from(detail.rawMessage, 'utf8');
  await learnBuffer(label, content, settings, classifier);
  return createRspamdScanAction({
    runId: detail.id,
    serviceId: detail.serviceId,
    actorAdminId,
    actionType: label === 'spam' ? 'learn_spam' : 'learn_ham',
    details: {
      classifier: classifier ?? null,
      summaryAction: detail.summaryAction,
      summaryScore: detail.summaryScore,
    },
  });
}

export async function fuzzyRspamdScan(
  id: number,
  operation: 'add' | 'remove',
  actorAdminId: number | null,
  serviceId?: string,
  presetId?: string,
  flag?: number,
  weight?: number,
): Promise<RspamdScanActionRecord | null> {
  const detail = await getRspamdScanHistoryDetail(id, serviceId);
  if (!detail) {
    return null;
  }
  if (!detail.rawMessageRelpath) {
    throw new Error('Raw message was not retained for this scan because Rspamd store directory was not configured');
  }
  const settings = await getRspamdSettings(detail.serviceId);
  const classifierSettings = await getRspamdClassifierSettings(detail.serviceId);
  const preset = presetId
    ? classifierSettings.fuzzyPresets.find((candidate) => candidate.id === presetId) ?? null
    : null;
  const fuzzyFlag = preset?.flag ?? flag ?? 1;
  const fuzzyWeight = preset?.weight ?? weight ?? 1;
  const content = Buffer.from(detail.rawMessage, 'utf8');

  await postControllerMessage(settings, operation === 'add' ? 'fuzzyadd' : 'fuzzydel', content, {
    Flag: String(fuzzyFlag),
    Weight: String(fuzzyWeight),
  });

  return createRspamdScanAction({
    runId: detail.id,
    serviceId: detail.serviceId,
    actorAdminId,
    actionType: operation === 'add' ? 'fuzzy_add' : 'fuzzy_remove',
    details: {
      presetId: preset?.id ?? null,
      flag: fuzzyFlag,
      weight: fuzzyWeight,
    },
  });
}
