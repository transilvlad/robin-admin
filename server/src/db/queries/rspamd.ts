import { getClient, query } from '../connection.js';
import {
  RSPAMD_CONFIG_STORE_TABLE,
  getConfigStorePayload,
  upsertConfigStorePayload,
} from './config-store.js';
import { deepMerge, extractDelta } from './config-layering.js';
import {
  RSPAMD_CONTROLLER_PASSWORD_SECRET,
  RSPAMD_ENABLE_PASSWORD_SECRET,
  getFleetServiceSecrets,
  upsertFleetServiceSecret,
} from './fleet-service-secrets.js';
import {
  getFleetServiceById,
  getPrimaryFleetService,
  type FleetService,
  updateFleetService,
} from './fleet-services.js';

const RSPAMD_SETTINGS_STORE_FILE = 'robin-admin.settings.json';
export const RSPAMD_MANAGED_CONFIG_STORE_FILE = 'robin-admin.managed-config.json';
export const RSPAMD_FILE_MANAGEMENT_STORE_FILE = 'robin-admin.file-management.json';
const RSPAMD_RULES_STORE_FILE = 'robin-admin.rules.json';
const RSPAMD_CLASSIFIERS_STORE_FILE = 'robin-admin.classifiers.json';

const RSPAMD_SETTINGS_DEFAULTS = {
  rspamdControllerUrl: '',
  rspamdNormalUrl: '',
  rspamdControllerPassword: '',
  rspamdEnablePassword: '',
  rspamdConfigDir: '',
  rspamdStoreDir: '',
  rspamdTrainingDir: '',
} as const;

const RSPAMD_MANAGED_DEFAULTS = {
  rspamdDkimEnabled: true,
  rspamdDkimPathTemplate: '/var/lib/rspamd/dkim/$domain.$selector.key',
  rspamdDkimSignAuthenticated: true,
  rspamdDkimSignLocal: true,
  rspamdDkimUseDomain: 'header',
  rspamdDkimTryFallback: true,
  rspamdDkimFallbackSelector: 'dkim',
  rspamdDkimCheckPubkey: false,
  rspamdDkimAllowPubkeyMismatch: true,
  rspamdBayesBackend: 'redis',
  rspamdBayesRedisServers: '',
  rspamdBayesTokenizer: 'osb',
  rspamdBayesMinLearns: 200,
  rspamdBayesAutolearnEnabled: false,
  rspamdBayesSpamThreshold: 6,
  rspamdBayesJunkThreshold: 4,
  rspamdBayesHamThreshold: -0.5,
  rspamdBayesCheckBalance: true,
  rspamdBayesMinBalance: 0.9,
} as const;

const RSPAMD_FILE_MANAGEMENT_DEFAULTS = {
  dkim: true,
  bayes: true,
  actions: true,
  groups: true,
  settings: true,
  composites: true,
  multimap: true,
} as const;

export interface RspamdSettings {
  serviceId?: string | null;
  serviceName?: string | null;
  rspamdControllerUrl: string;
  rspamdNormalUrl: string;
  rspamdControllerPassword: string;
  rspamdEnablePassword: string;
  rspamdConfigDir: string;
  rspamdStoreDir: string;
  rspamdTrainingDir: string;
}

/**
 * Settings as the API returns them: the controller passwords are write-only,
 * so a response only says whether each is set. Save with a password field to
 * set it, an empty string to clear it, or leave the field out to keep it.
 */
export type PublicRspamdSettings = Omit<RspamdSettings, 'rspamdControllerPassword' | 'rspamdEnablePassword'> & {
  hasControllerPassword: boolean;
  hasEnablePassword: boolean;
};

export function toPublicRspamdSettings(settings: RspamdSettings): PublicRspamdSettings {
  const { rspamdControllerPassword, rspamdEnablePassword, ...rest } = settings;
  return {
    ...rest,
    hasControllerPassword: Boolean(rspamdControllerPassword),
    hasEnablePassword: Boolean(rspamdEnablePassword),
  };
}

export interface RspamdManagedConfig {
  rspamdDkimEnabled: boolean;
  rspamdDkimPathTemplate: string;
  rspamdDkimSignAuthenticated: boolean;
  rspamdDkimSignLocal: boolean;
  rspamdDkimUseDomain: string;
  rspamdDkimTryFallback: boolean;
  rspamdDkimFallbackSelector: string;
  rspamdDkimCheckPubkey: boolean;
  rspamdDkimAllowPubkeyMismatch: boolean;
  rspamdBayesBackend: string;
  /** Redis servers for the Bayes classifier; blank = inherit the global redis.conf. */
  rspamdBayesRedisServers: string;
  rspamdBayesTokenizer: string;
  rspamdBayesMinLearns: number;
  rspamdBayesAutolearnEnabled: boolean;
  rspamdBayesSpamThreshold: number;
  rspamdBayesJunkThreshold: number | null;
  rspamdBayesHamThreshold: number;
  rspamdBayesCheckBalance: boolean;
  rspamdBayesMinBalance: number;
}

export interface RspamdFileManagement {
  dkim: boolean | null;
  bayes: boolean | null;
  actions: boolean | null;
  groups: boolean | null;
  settings: boolean | null;
  composites: boolean | null;
  multimap: boolean | null;
}

export type RspamdRulesStoreDocument = Record<string, unknown>;

export interface DkimSigningDomain {
  id: number;
  domain: string;
  signDomain: string;
  enabled: boolean;
  autoRotateEnabled: boolean;
  rotateIntervalDays: number | null;
  retainOldDays: number;
  createdAt: Date;
  updatedAt: Date;
  activeSelector: string | null;
  activeSelectorActivatedAt: Date | null;
}

export interface DkimSigningSelector {
  id: number;
  domainId: number;
  selector: string;
  publicKeyTxt: string;
  publicKeyP: string;
  algorithm: string;
  keyBits: number;
  state: 'active' | 'retired' | 'revoked';
  /** False once the retained key has been purged. */
  hasPrivateKey: boolean;
  activatedAt: Date;
  retiredAt: Date | null;
  purgeAfter: Date | null;
  privateKeyDeletedAt: Date | null;
  createdAt: Date;
}

export interface TrainingImportJob {
  id: number;
  sourceFilename: string | null;
  label: 'spam' | 'ham';
  status: 'processing' | 'completed' | 'failed';
  totalFiles: number;
  totalSamples: number;
  learnedSamples: number;
  errorCount: number;
  errors: string[];
  createdBy: number | null;
  createdAt: Date;
  completedAt: Date | null;
}

export interface TrainingSample {
  id: number;
  importId: number | null;
  filename: string;
  contentHash: string;
  label: 'spam' | 'ham';
  sourceType: 'eml' | 'mbox' | 'archive';
  storedRelpath: string;
  sizeBytes: number;
  learnStatus: 'pending' | 'learned' | 'failed';
  learnError: string | null;
  createdAt: Date;
  learnedAt: Date | null;
  relabeledAt: Date | null;
}

export interface TrainingSampleListOptions {
  page?: number;
  limit?: number;
  label?: 'spam' | 'ham';
  status?: 'pending' | 'learned' | 'failed';
  search?: string;
}

export interface RspamdFuzzyPreset {
  id: string;
  label: string;
  flag: number;
  weight: number;
}

export interface RspamdClassifierSettings {
  defaultTransport: 'checkv2' | 'checkv3';
  defaultClassifier: string;
  fuzzyPresets: RspamdFuzzyPreset[];
}

export interface RspamdScanRequestMetadata {
  envelopeFrom: string;
  recipients: string[];
  clientIp: string;
  helo: string;
  hostname: string;
  authenticatedUser: string;
  settingsId: string;
  queueId: string;
}

export interface RspamdScanRunSummary {
  id: number;
  serviceId: string;
  actorAdminId: number | null;
  parentRunId: number | null;
  transport: 'checkv2' | 'checkv3';
  sourceMode: 'raw' | 'upload' | 'replay';
  sourceFileName: string | null;
  messageHash: string;
  rawMessageRelpath: string | null;
  messageSizeBytes: number;
  metadata: RspamdScanRequestMetadata;
  summaryAction: string | null;
  summaryScore: number | null;
  summaryRequiredScore: number | null;
  summarySymbols: string[];
  isSkipped: boolean;
  createdAt: Date;
}

export interface RspamdScanActionRecord {
  id: number;
  runId: number;
  serviceId: string;
  actorAdminId: number | null;
  actionType: 'learn_spam' | 'learn_ham' | 'fuzzy_add' | 'fuzzy_remove';
  details: Record<string, unknown>;
  createdAt: Date;
}

export interface RspamdScanRunDetail extends RspamdScanRunSummary {
  result: Record<string, unknown>;
  actions: RspamdScanActionRecord[];
}

const RSPAMD_CLASSIFIER_SETTINGS_DEFAULTS: RspamdClassifierSettings = {
  defaultTransport: 'checkv2',
  defaultClassifier: '',
  fuzzyPresets: [
    { id: 'confirmed-spam', label: 'Confirmed spam', flag: 1, weight: 10 },
    { id: 'probable-spam', label: 'Probable spam', flag: 2, weight: 5 },
    { id: 'allow-whitelist', label: 'Allow / whitelist', flag: 3, weight: 1 },
  ],
};

function parseBoolean(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true' || normalized === '1') return true;
    if (normalized === 'false' || normalized === '0') return false;
  }
  return fallback;
}

function parseNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseNullableNumber(value: unknown, fallback: number | null): number | null {
  if (value === null || value === undefined || value === '') return fallback;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function parseString(value: unknown, fallback: string): string {
  return typeof value === 'string' ? value : fallback;
}

function toRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {};
  }
  return value as Record<string, unknown>;
}

// Config-store scope owner. Decoupled from fleet-service resolution: 'default' is
// the shared base, any other string is a per-instance override scope (its own
// row keyed by service_id). For a registered instance the scope id == its
// serviceId, so overrides land on the row the pull-agent already reads.
export const RSPAMD_BASE_SCOPE = 'default';
function scopeOwner(scopeId?: string | null): string {
  const trimmed = (scopeId ?? '').trim();
  return trimmed === '' ? RSPAMD_BASE_SCOPE : trimmed;
}

/** Raw stored payload for one file at one scope (no defaults applied). */
async function readScopePayload(owner: string, fileName: string): Promise<Record<string, unknown>> {
  return toRecord(await getConfigStorePayload<Record<string, unknown>>(
    RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, fileName,
  ));
}

// Effective stored payload for a scope = base ('default') overlaid with the
// scope's override delta. For the base scope itself it's just the base row.
async function readLayeredPayload(scopeId: string | undefined, fileName: string): Promise<Record<string, unknown>> {
  const owner = scopeOwner(scopeId);
  const base = await readScopePayload(RSPAMD_BASE_SCOPE, fileName);
  if (owner === RSPAMD_BASE_SCOPE) {
    return base;
  }
  const override = await readScopePayload(owner, fileName);
  return deepMerge(base, override);
}

// Persist a scope's config for one file: the base scope stores the full object;
// an instance scope stores ONLY the delta from the (mapped) base — "just the
// changed values". `mapped` is the full effective config the caller wants stored.
async function writeLayeredPayload(
  scopeId: string | undefined,
  fileName: string,
  mapped: Record<string, unknown>,
  base: Record<string, unknown>,
): Promise<void> {
  const owner = scopeOwner(scopeId);
  const payload = owner === RSPAMD_BASE_SCOPE ? mapped : extractDelta(base, mapped);
  await upsertConfigStorePayload(RSPAMD_CONFIG_STORE_TABLE, 'service_id', owner, fileName, payload);
}

function sanitizeSettingsPayload(settings: RspamdSettings): Record<string, unknown> {
  return {
    rspamdConfigDir: settings.rspamdConfigDir,
    rspamdStoreDir: settings.rspamdStoreDir,
    rspamdTrainingDir: settings.rspamdTrainingDir,
  };
}

function mapStoredSettings(payload: Record<string, unknown>): Partial<RspamdSettings> {
  return {
    rspamdConfigDir: parseString(payload.rspamdConfigDir, RSPAMD_SETTINGS_DEFAULTS.rspamdConfigDir),
    rspamdStoreDir: parseString(payload.rspamdStoreDir, RSPAMD_SETTINGS_DEFAULTS.rspamdStoreDir),
    rspamdTrainingDir: parseString(payload.rspamdTrainingDir, RSPAMD_SETTINGS_DEFAULTS.rspamdTrainingDir),
  };
}

function mapStoredManagedConfig(payload: Record<string, unknown>): RspamdManagedConfig {
  return {
    rspamdDkimEnabled: parseBoolean(payload.rspamdDkimEnabled, RSPAMD_MANAGED_DEFAULTS.rspamdDkimEnabled),
    rspamdDkimPathTemplate: parseString(payload.rspamdDkimPathTemplate, RSPAMD_MANAGED_DEFAULTS.rspamdDkimPathTemplate),
    rspamdDkimSignAuthenticated: parseBoolean(payload.rspamdDkimSignAuthenticated, RSPAMD_MANAGED_DEFAULTS.rspamdDkimSignAuthenticated),
    rspamdDkimSignLocal: parseBoolean(payload.rspamdDkimSignLocal, RSPAMD_MANAGED_DEFAULTS.rspamdDkimSignLocal),
    rspamdDkimUseDomain: parseString(payload.rspamdDkimUseDomain, RSPAMD_MANAGED_DEFAULTS.rspamdDkimUseDomain),
    rspamdDkimTryFallback: parseBoolean(payload.rspamdDkimTryFallback, RSPAMD_MANAGED_DEFAULTS.rspamdDkimTryFallback),
    rspamdDkimFallbackSelector: parseString(payload.rspamdDkimFallbackSelector, RSPAMD_MANAGED_DEFAULTS.rspamdDkimFallbackSelector),
    rspamdDkimCheckPubkey: parseBoolean(payload.rspamdDkimCheckPubkey, RSPAMD_MANAGED_DEFAULTS.rspamdDkimCheckPubkey),
    rspamdDkimAllowPubkeyMismatch: parseBoolean(payload.rspamdDkimAllowPubkeyMismatch, RSPAMD_MANAGED_DEFAULTS.rspamdDkimAllowPubkeyMismatch),
    rspamdBayesBackend: parseString(payload.rspamdBayesBackend, RSPAMD_MANAGED_DEFAULTS.rspamdBayesBackend),
    rspamdBayesRedisServers: parseString(payload.rspamdBayesRedisServers, RSPAMD_MANAGED_DEFAULTS.rspamdBayesRedisServers),
    rspamdBayesTokenizer: parseString(payload.rspamdBayesTokenizer, RSPAMD_MANAGED_DEFAULTS.rspamdBayesTokenizer),
    rspamdBayesMinLearns: parseNumber(payload.rspamdBayesMinLearns, RSPAMD_MANAGED_DEFAULTS.rspamdBayesMinLearns),
    rspamdBayesAutolearnEnabled: parseBoolean(payload.rspamdBayesAutolearnEnabled, RSPAMD_MANAGED_DEFAULTS.rspamdBayesAutolearnEnabled),
    rspamdBayesSpamThreshold: parseNumber(payload.rspamdBayesSpamThreshold, RSPAMD_MANAGED_DEFAULTS.rspamdBayesSpamThreshold),
    rspamdBayesJunkThreshold: parseNullableNumber(payload.rspamdBayesJunkThreshold, RSPAMD_MANAGED_DEFAULTS.rspamdBayesJunkThreshold),
    rspamdBayesHamThreshold: parseNumber(payload.rspamdBayesHamThreshold, RSPAMD_MANAGED_DEFAULTS.rspamdBayesHamThreshold),
    rspamdBayesCheckBalance: parseBoolean(payload.rspamdBayesCheckBalance, RSPAMD_MANAGED_DEFAULTS.rspamdBayesCheckBalance),
    rspamdBayesMinBalance: parseNumber(payload.rspamdBayesMinBalance, RSPAMD_MANAGED_DEFAULTS.rspamdBayesMinBalance),
  };
}

function mapStoredFileManagement(payload: Record<string, unknown>): RspamdFileManagement {
  return {
    dkim: payload.dkim === null ? null : parseBoolean(payload.dkim, RSPAMD_FILE_MANAGEMENT_DEFAULTS.dkim),
    bayes: payload.bayes === null ? null : parseBoolean(payload.bayes, RSPAMD_FILE_MANAGEMENT_DEFAULTS.bayes),
    actions: payload.actions === null ? null : parseBoolean(payload.actions, RSPAMD_FILE_MANAGEMENT_DEFAULTS.actions),
    groups: payload.groups === null ? null : parseBoolean(payload.groups, RSPAMD_FILE_MANAGEMENT_DEFAULTS.groups),
    settings: payload.settings === null ? null : parseBoolean(payload.settings, RSPAMD_FILE_MANAGEMENT_DEFAULTS.settings),
    composites: payload.composites === null ? null : parseBoolean(payload.composites, RSPAMD_FILE_MANAGEMENT_DEFAULTS.composites),
    multimap: payload.multimap === null ? null : parseBoolean(payload.multimap, RSPAMD_FILE_MANAGEMENT_DEFAULTS.multimap),
  };
}

function mapStoredClassifierSettings(payload: Record<string, unknown>): RspamdClassifierSettings {
  const defaultTransport = payload.defaultTransport === 'checkv3' ? 'checkv3' : 'checkv2';
  const defaultClassifier = parseString(payload.defaultClassifier, '');
  const fuzzyPresets = Array.isArray(payload.fuzzyPresets)
    ? payload.fuzzyPresets
      .map((item, index) => {
        const record = toRecord(item);
        const id = parseString(record.id, `preset-${index + 1}`).trim() || `preset-${index + 1}`;
        const label = parseString(record.label, `Preset ${index + 1}`).trim() || `Preset ${index + 1}`;
        const flag = Math.max(0, parseNumber(record.flag, index + 1));
        const weight = parseNumber(record.weight, 1);
        return { id, label, flag, weight };
      })
      .filter((item) => item.label.length > 0)
    : RSPAMD_CLASSIFIER_SETTINGS_DEFAULTS.fuzzyPresets;

  return {
    defaultTransport,
    defaultClassifier,
    fuzzyPresets: fuzzyPresets.length > 0 ? fuzzyPresets : RSPAMD_CLASSIFIER_SETTINGS_DEFAULTS.fuzzyPresets,
  };
}

async function resolveRspamdService(serviceId?: string): Promise<FleetService | null> {
  if (serviceId) {
    const requested = await getFleetServiceById(serviceId);
    if (requested?.serviceType === 'rspamd') return requested;
    return null;
  }

  const service = await getPrimaryFleetService('rspamd');
  return service?.serviceType === 'rspamd' ? service : null;
}

export async function getRspamdSettings(serviceId?: string): Promise<RspamdSettings> {
  const service = await resolveRspamdService(serviceId);
  if (!service) {
    return {
      ...RSPAMD_SETTINGS_DEFAULTS,
      serviceId: null,
      serviceName: null,
    };
  }

  const [storedPayload, secrets] = await Promise.all([
    getConfigStorePayload<Record<string, unknown>>(
      RSPAMD_CONFIG_STORE_TABLE,
      'service_id',
      service.serviceId,
      RSPAMD_SETTINGS_STORE_FILE
    ),
    getFleetServiceSecrets(service.serviceId, [
      RSPAMD_CONTROLLER_PASSWORD_SECRET,
      RSPAMD_ENABLE_PASSWORD_SECRET,
    ]),
  ]);

  const storedSettings = mapStoredSettings(toRecord(storedPayload));

  return {
    ...RSPAMD_SETTINGS_DEFAULTS,
    ...storedSettings,
    serviceId: service.serviceId,
    serviceName: service.name,
    rspamdControllerUrl: service.controllerUrl ?? '',
    rspamdNormalUrl: service.normalUrl ?? service.apiUrl ?? '',
    rspamdControllerPassword: secrets[RSPAMD_CONTROLLER_PASSWORD_SECRET] ?? '',
    rspamdEnablePassword: secrets[RSPAMD_ENABLE_PASSWORD_SECRET] ?? '',
  };
}

export async function updateRspamdSettings(updates: Partial<RspamdSettings>): Promise<RspamdSettings> {
  const current = await getRspamdSettings(updates.serviceId ?? undefined);
  if (!current.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }

  const next: RspamdSettings = {
    ...current,
    ...updates,
    serviceId: current.serviceId,
    serviceName: current.serviceName,
  };

  await updateFleetService(current.serviceId, {
    controllerUrl: next.rspamdControllerUrl,
    normalUrl: next.rspamdNormalUrl,
  });

  await Promise.all([
    upsertConfigStorePayload(
      RSPAMD_CONFIG_STORE_TABLE,
      'service_id',
      current.serviceId,
      RSPAMD_SETTINGS_STORE_FILE,
      sanitizeSettingsPayload(next)
    ),
    upsertFleetServiceSecret({
      serviceId: current.serviceId,
      secretType: RSPAMD_CONTROLLER_PASSWORD_SECRET,
      secret: next.rspamdControllerPassword,
    }),
    upsertFleetServiceSecret({
      serviceId: current.serviceId,
      secretType: RSPAMD_ENABLE_PASSWORD_SECRET,
      secret: next.rspamdEnablePassword,
    }),
  ]);

  return getRspamdSettings(current.serviceId);
}

export async function getRspamdManagedConfig(serviceId?: string): Promise<RspamdManagedConfig> {
  const payload = await readLayeredPayload(serviceId, RSPAMD_MANAGED_CONFIG_STORE_FILE);
  return mapStoredManagedConfig(payload);
}

// The base config a scope inherits from — for delta extraction on save.
async function getRspamdManagedBase(): Promise<RspamdManagedConfig> {
  return mapStoredManagedConfig(await readScopePayload(RSPAMD_BASE_SCOPE, RSPAMD_MANAGED_CONFIG_STORE_FILE));
}

export async function updateRspamdManagedConfig(
  updates: Partial<RspamdManagedConfig>,
  serviceId?: string,
): Promise<RspamdManagedConfig> {
  // The client sends the full effective config; merge over the current effective
  // as a safety net for partial callers, then store base-full / instance-delta.
  const current = await getRspamdManagedConfig(serviceId);
  const effective = mapStoredManagedConfig({ ...current, ...updates });
  const base = await getRspamdManagedBase();
  await writeLayeredPayload(
    serviceId,
    RSPAMD_MANAGED_CONFIG_STORE_FILE,
    effective as unknown as Record<string, unknown>,
    base as unknown as Record<string, unknown>,
  );
  return getRspamdManagedConfig(serviceId);
}

export async function getRspamdFileManagement(serviceId?: string): Promise<RspamdFileManagement> {
  const payload = await readLayeredPayload(serviceId, RSPAMD_FILE_MANAGEMENT_STORE_FILE);
  return mapStoredFileManagement(payload);
}

export async function updateRspamdFileManagement(
  updates: Partial<Record<'dkim' | 'bayes' | 'actions' | 'groups' | 'settings' | 'composites' | 'multimap', boolean>>,
  serviceId?: string,
): Promise<RspamdFileManagement> {
  const current = await getRspamdFileManagement(serviceId);
  const effective = mapStoredFileManagement({ ...current, ...updates });
  const base = mapStoredFileManagement(await readScopePayload(RSPAMD_BASE_SCOPE, RSPAMD_FILE_MANAGEMENT_STORE_FILE));
  await writeLayeredPayload(
    serviceId,
    RSPAMD_FILE_MANAGEMENT_STORE_FILE,
    effective as unknown as Record<string, unknown>,
    base as unknown as Record<string, unknown>,
  );
  return getRspamdFileManagement(serviceId);
}

export async function getRspamdRulesDocument(serviceId?: string): Promise<RspamdRulesStoreDocument | null> {
  const settings = await getRspamdSettings(serviceId);
  if (!settings.serviceId) {
    return null;
  }

  return getConfigStorePayload<RspamdRulesStoreDocument>(
    RSPAMD_CONFIG_STORE_TABLE,
    'service_id',
    settings.serviceId,
    RSPAMD_RULES_STORE_FILE
  );
}

export async function updateRspamdRulesDocument(
  document: RspamdRulesStoreDocument,
  serviceId?: string,
): Promise<RspamdRulesStoreDocument> {
  const settings = await getRspamdSettings(serviceId);
  if (!settings.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }

  await upsertConfigStorePayload(
    RSPAMD_CONFIG_STORE_TABLE,
    'service_id',
    settings.serviceId,
    RSPAMD_RULES_STORE_FILE,
    document
  );

  return (await getRspamdRulesDocument(settings.serviceId)) ?? {};
}

export async function getRspamdClassifierSettings(serviceId?: string): Promise<RspamdClassifierSettings> {
  const settings = await getRspamdSettings(serviceId);
  if (!settings.serviceId) {
    return { ...RSPAMD_CLASSIFIER_SETTINGS_DEFAULTS };
  }

  const payload = toRecord(await getConfigStorePayload<Record<string, unknown>>(
    RSPAMD_CONFIG_STORE_TABLE,
    'service_id',
    settings.serviceId,
    RSPAMD_CLASSIFIERS_STORE_FILE
  ));

  return mapStoredClassifierSettings(payload);
}

export async function updateRspamdClassifierSettings(
  updates: Partial<RspamdClassifierSettings>,
  serviceId?: string,
): Promise<RspamdClassifierSettings> {
  const settings = await getRspamdSettings(serviceId);
  if (!settings.serviceId) {
    throw new Error('No managed Rspamd service is configured in fleet_services');
  }

  const current = await getRspamdClassifierSettings(settings.serviceId);
  const next = mapStoredClassifierSettings({
    ...current,
    ...updates,
  });

  await upsertConfigStorePayload(
    RSPAMD_CONFIG_STORE_TABLE,
    'service_id',
    settings.serviceId,
    RSPAMD_CLASSIFIERS_STORE_FILE,
    next
  );

  return getRspamdClassifierSettings(settings.serviceId);
}

interface DkimDomainRow {
  id: number;
  domain: string;
  sign_domain: string;
  enabled: boolean;
  auto_rotate_enabled: boolean;
  rotate_interval_days: number | null;
  retain_old_days: number;
  created_at: Date;
  updated_at: Date;
  active_selector: string | null;
  active_selector_activated_at: Date | null;
}

interface DkimSelectorRow {
  id: number;
  domain_id: number;
  selector: string;
  public_key_txt: string;
  public_key_p: string;
  algorithm: string;
  key_bits: number;
  state: 'active' | 'retired' | 'revoked';
  has_private_key: boolean;
  activated_at: Date;
  retired_at: Date | null;
  purge_after: Date | null;
  private_key_deleted_at: Date | null;
  created_at: Date;
}

function mapDomain(row: DkimDomainRow): DkimSigningDomain {
  return {
    id: row.id,
    domain: row.domain,
    signDomain: row.sign_domain,
    enabled: row.enabled,
    autoRotateEnabled: row.auto_rotate_enabled,
    rotateIntervalDays: row.rotate_interval_days,
    retainOldDays: row.retain_old_days,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    activeSelector: row.active_selector,
    activeSelectorActivatedAt: row.active_selector_activated_at,
  };
}

function mapSelector(row: DkimSelectorRow): DkimSigningSelector {
  return {
    id: row.id,
    domainId: row.domain_id,
    selector: row.selector,
    publicKeyTxt: row.public_key_txt,
    publicKeyP: row.public_key_p,
    algorithm: row.algorithm,
    keyBits: row.key_bits,
    state: row.state,
    hasPrivateKey: row.has_private_key,
    activatedAt: row.activated_at,
    retiredAt: row.retired_at,
    purgeAfter: row.purge_after,
    privateKeyDeletedAt: row.private_key_deleted_at,
    createdAt: row.created_at,
  };
}

export async function listDkimDomains(): Promise<DkimSigningDomain[]> {
  const result = await query<DkimDomainRow>(`
    SELECT d.id, d.domain, d.sign_domain, d.enabled, d.auto_rotate_enabled, d.rotate_interval_days,
           d.retain_old_days, d.created_at, d.updated_at,
           s.selector AS active_selector, s.activated_at AS active_selector_activated_at
    FROM rspamd_dkim_domains d
    LEFT JOIN LATERAL (
      SELECT selector, activated_at
      FROM rspamd_dkim_selectors
      WHERE domain_id = d.id AND state = 'active'
      ORDER BY activated_at DESC, created_at DESC, id DESC
      LIMIT 1
    ) s ON TRUE
    ORDER BY d.domain ASC
  `);
  return result.rows.map(mapDomain);
}

export async function getDkimDomain(id: number): Promise<DkimSigningDomain | null> {
  const result = await query<DkimDomainRow>(`
    SELECT d.id, d.domain, d.sign_domain, d.enabled, d.auto_rotate_enabled, d.rotate_interval_days,
           d.retain_old_days, d.created_at, d.updated_at,
           s.selector AS active_selector, s.activated_at AS active_selector_activated_at
    FROM rspamd_dkim_domains d
    LEFT JOIN LATERAL (
      SELECT selector, activated_at
      FROM rspamd_dkim_selectors
      WHERE domain_id = d.id AND state = 'active'
      ORDER BY activated_at DESC, created_at DESC, id DESC
      LIMIT 1
    ) s ON TRUE
    WHERE d.id = $1
  `, [id]);
  return result.rows[0] ? mapDomain(result.rows[0]) : null;
}

export async function createDkimDomain(input: {
  domain: string;
  signDomain: string;
  enabled?: boolean;
  autoRotateEnabled?: boolean;
  rotateIntervalDays?: number | null;
  retainOldDays?: number;
}): Promise<DkimSigningDomain> {
  const result = await query<DkimDomainRow>(`
    INSERT INTO rspamd_dkim_domains
      (domain, sign_domain, enabled, auto_rotate_enabled, rotate_interval_days, retain_old_days)
    VALUES ($1, $2, $3, $4, $5, $6)
    RETURNING id, domain, sign_domain, enabled, auto_rotate_enabled, rotate_interval_days,
              retain_old_days, created_at, updated_at, NULL::text AS active_selector,
              NULL::timestamp AS active_selector_activated_at
  `, [
    input.domain,
    input.signDomain,
    input.enabled ?? true,
    input.autoRotateEnabled ?? false,
    input.rotateIntervalDays ?? null,
    input.retainOldDays ?? 30,
  ]);
  return mapDomain(result.rows[0]);
}

export async function updateDkimDomain(id: number, updates: Partial<{
  domain: string;
  signDomain: string;
  enabled: boolean;
  autoRotateEnabled: boolean;
  rotateIntervalDays: number | null;
  retainOldDays: number;
}>): Promise<DkimSigningDomain | null> {
  const current = await query<DkimDomainRow>(`
    SELECT d.id, d.domain, d.sign_domain, d.enabled, d.auto_rotate_enabled, d.rotate_interval_days,
           d.retain_old_days, d.created_at, d.updated_at,
           NULL::text AS active_selector, NULL::timestamp AS active_selector_activated_at
    FROM rspamd_dkim_domains d
    WHERE d.id = $1
  `, [id]);
  if (!current.rows[0]) return null;
  const row = current.rows[0];
  await query(`
    UPDATE rspamd_dkim_domains
    SET domain = $2,
        sign_domain = $3,
        enabled = $4,
        auto_rotate_enabled = $5,
        rotate_interval_days = $6,
        retain_old_days = $7,
        updated_at = CURRENT_TIMESTAMP
    WHERE id = $1
  `, [
    id,
    updates.domain ?? row.domain,
    updates.signDomain ?? row.sign_domain,
    updates.enabled ?? row.enabled,
    updates.autoRotateEnabled ?? row.auto_rotate_enabled,
    updates.rotateIntervalDays === undefined ? row.rotate_interval_days : updates.rotateIntervalDays,
    updates.retainOldDays ?? row.retain_old_days,
  ]);
  return getDkimDomain(id);
}

export async function listDkimSelectors(domainId: number): Promise<DkimSigningSelector[]> {
  const result = await query<DkimSelectorRow>(`
    SELECT id, domain_id, selector, public_key_txt, public_key_p, algorithm, key_bits, state,
           private_key_enc IS NOT NULL AS has_private_key, activated_at, retired_at, purge_after, private_key_deleted_at, created_at
    FROM rspamd_dkim_selectors
    WHERE domain_id = $1
    ORDER BY activated_at DESC, created_at DESC, id DESC
  `, [domainId]);
  return result.rows.map(mapSelector);
}

export async function getDkimSelector(id: number): Promise<DkimSigningSelector | null> {
  const result = await query<DkimSelectorRow>(`
    SELECT id, domain_id, selector, public_key_txt, public_key_p, algorithm, key_bits, state,
           private_key_enc IS NOT NULL AS has_private_key, activated_at, retired_at, purge_after, private_key_deleted_at, created_at
    FROM rspamd_dkim_selectors
    WHERE id = $1
  `, [id]);
  return result.rows[0] ? mapSelector(result.rows[0]) : null;
}

export async function getActiveSelector(domainId: number): Promise<DkimSigningSelector | null> {
  const result = await query<DkimSelectorRow>(`
    SELECT id, domain_id, selector, public_key_txt, public_key_p, algorithm, key_bits, state,
           private_key_enc IS NOT NULL AS has_private_key, activated_at, retired_at, purge_after, private_key_deleted_at, created_at
    FROM rspamd_dkim_selectors
    WHERE domain_id = $1 AND state = 'active'
    ORDER BY activated_at DESC, created_at DESC, id DESC
    LIMIT 1
  `, [domainId]);
  return result.rows[0] ? mapSelector(result.rows[0]) : null;
}

export async function listSelectorNamesByPrefix(domainId: number, prefix: string): Promise<string[]> {
  const result = await query<{ selector: string }>(
    `SELECT selector
     FROM rspamd_dkim_selectors
     WHERE domain_id = $1 AND selector LIKE $2`,
    [domainId, `${prefix}%`]
  );
  return result.rows.map((row) => row.selector);
}

export async function activateNewSelector(input: {
  domainId: number;
  selector: string;
  publicKeyTxt: string;
  publicKeyP: string;
  algorithm: string;
  keyBits: number;
  /** The PEM private key, sealed with encryptStoredSecret. */
  privateKeyEnc: string;
}): Promise<DkimSigningSelector> {
  const client = await getClient();
  try {
    await client.query('BEGIN');

    await client.query(`
      UPDATE rspamd_dkim_selectors s
      SET state = 'retired',
          retired_at = CURRENT_TIMESTAMP,
          purge_after = CURRENT_TIMESTAMP + make_interval(days => d.retain_old_days)
      FROM rspamd_dkim_domains d
      WHERE s.domain_id = d.id
        AND s.domain_id = $1
        AND s.state = 'active'
    `, [input.domainId]);

    const result = await client.query<DkimSelectorRow>(`
      INSERT INTO rspamd_dkim_selectors
        (domain_id, selector, public_key_txt, public_key_p, algorithm, key_bits, state, private_key_enc, activated_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'active', $7, CURRENT_TIMESTAMP)
      RETURNING id, domain_id, selector, public_key_txt, public_key_p, algorithm, key_bits, state,
                private_key_enc IS NOT NULL AS has_private_key, activated_at, retired_at, purge_after, private_key_deleted_at, created_at
    `, [
      input.domainId,
      input.selector,
      input.publicKeyTxt,
      input.publicKeyP,
      input.algorithm,
      input.keyBits,
      input.privateKeyEnc,
    ]);

    await client.query('COMMIT');
    return mapSelector(result.rows[0]);
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export async function revokeSelector(id: number): Promise<boolean> {
  const result = await query(
    `UPDATE rspamd_dkim_selectors
     SET state = 'revoked'
     WHERE id = $1 AND state <> 'active'`,
    [id]
  );
  return (result.rowCount ?? 0) > 0;
}

export async function markSelectorKeyDeleted(id: number): Promise<void> {
  await query(
    `UPDATE rspamd_dkim_selectors
     SET private_key_deleted_at = CURRENT_TIMESTAMP, private_key_enc = NULL
     WHERE id = $1 AND private_key_deleted_at IS NULL`,
    [id]
  );
}

/** The key rspamd signs with for each enabled domain: its active selector. */
export interface DkimSigningKey {
  domain: string;
  selector: string;
  privateKeyEnc: string;
}

export async function listActiveDkimSigningKeys(): Promise<DkimSigningKey[]> {
  const result = await query<{ domain: string; selector: string; private_key_enc: string }>(`
    SELECT d.domain, s.selector, s.private_key_enc
    FROM rspamd_dkim_domains d
    JOIN rspamd_dkim_selectors s ON s.domain_id = d.id AND s.state = 'active'
    WHERE d.enabled = TRUE AND s.private_key_enc IS NOT NULL
    ORDER BY d.domain ASC
  `);
  return result.rows.map((row) => ({ domain: row.domain, selector: row.selector, privateKeyEnc: row.private_key_enc }));
}

export async function listDomainsDueForRotation(): Promise<Array<DkimSigningDomain & { activeSelectorId: number | null }>> {
  const result = await query<DkimDomainRow & { active_selector_id: number | null }>(`
    SELECT d.id, d.domain, d.sign_domain, d.enabled, d.auto_rotate_enabled, d.rotate_interval_days,
           d.retain_old_days, d.created_at, d.updated_at,
           s.id AS active_selector_id, s.selector AS active_selector, s.activated_at AS active_selector_activated_at
    FROM rspamd_dkim_domains d
    LEFT JOIN LATERAL (
      SELECT id, selector, activated_at
      FROM rspamd_dkim_selectors
      WHERE domain_id = d.id AND state = 'active'
      ORDER BY activated_at DESC, created_at DESC, id DESC
      LIMIT 1
    ) s ON TRUE
    WHERE d.enabled = TRUE
      AND d.auto_rotate_enabled = TRUE
      AND d.rotate_interval_days IS NOT NULL
      AND s.activated_at IS NOT NULL
      AND s.activated_at <= CURRENT_TIMESTAMP - make_interval(days => d.rotate_interval_days)
    ORDER BY d.domain ASC
  `);
  return result.rows.map((row) => ({
    ...mapDomain(row),
    activeSelectorId: row.active_selector_id,
  }));
}

export async function listPurgeableSelectors(): Promise<DkimSigningSelector[]> {
  const result = await query<DkimSelectorRow>(`
    SELECT id, domain_id, selector, public_key_txt, public_key_p, algorithm, key_bits, state,
           private_key_enc IS NOT NULL AS has_private_key, activated_at, retired_at, purge_after, private_key_deleted_at, created_at
    FROM rspamd_dkim_selectors
    WHERE state IN ('retired', 'revoked')
      AND purge_after IS NOT NULL
      AND purge_after <= CURRENT_TIMESTAMP
      AND private_key_deleted_at IS NULL
    ORDER BY purge_after ASC
  `);
  return result.rows.map(mapSelector);
}

interface TrainingImportRow {
  id: number;
  source_filename: string | null;
  label: 'spam' | 'ham';
  status: 'processing' | 'completed' | 'failed';
  total_files: number;
  total_samples: number;
  learned_samples: number;
  error_count: number;
  errors: string[];
  created_by: number | null;
  created_at: Date;
  completed_at: Date | null;
}

interface RspamdScanRunRow {
  id: number;
  service_id: string;
  actor_admin_id: number | null;
  parent_run_id: number | null;
  transport: 'checkv2' | 'checkv3';
  source_mode: 'raw' | 'upload' | 'replay';
  source_file_name: string | null;
  message_hash: string;
  raw_message_relpath: string | null;
  message_size_bytes: number;
  metadata_json: Record<string, unknown> | null;
  result_json?: Record<string, unknown> | null;
  summary_action: string | null;
  summary_score: number | null;
  summary_required_score: number | null;
  summary_symbols: string[] | null;
  is_skipped: boolean;
  created_at: Date;
}

interface RspamdScanActionRow {
  id: number;
  run_id: number;
  service_id: string;
  actor_admin_id: number | null;
  action_type: 'learn_spam' | 'learn_ham' | 'fuzzy_add' | 'fuzzy_remove';
  details_json: Record<string, unknown> | null;
  created_at: Date;
}

interface TrainingSampleRow {
  id: number;
  import_id: number | null;
  filename: string;
  content_hash: string;
  label: 'spam' | 'ham';
  source_type: 'eml' | 'mbox' | 'archive';
  stored_relpath: string;
  size_bytes: number;
  learn_status: 'pending' | 'learned' | 'failed';
  learn_error: string | null;
  created_at: Date;
  learned_at: Date | null;
  relabeled_at: Date | null;
}

function mapImport(row: TrainingImportRow): TrainingImportJob {
  return {
    id: row.id,
    sourceFilename: row.source_filename,
    label: row.label,
    status: row.status,
    totalFiles: row.total_files,
    totalSamples: row.total_samples,
    learnedSamples: row.learned_samples,
    errorCount: row.error_count,
    errors: row.errors ?? [],
    createdBy: row.created_by,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

function mapSample(row: TrainingSampleRow): TrainingSample {
  return {
    id: row.id,
    importId: row.import_id,
    filename: row.filename,
    contentHash: row.content_hash,
    label: row.label,
    sourceType: row.source_type,
    storedRelpath: row.stored_relpath,
    sizeBytes: row.size_bytes,
    learnStatus: row.learn_status,
    learnError: row.learn_error,
    createdAt: row.created_at,
    learnedAt: row.learned_at,
    relabeledAt: row.relabeled_at,
  };
}

function mapScanMetadata(value: Record<string, unknown> | null | undefined): RspamdScanRequestMetadata {
  const metadata = toRecord(value ?? {});
  return {
    envelopeFrom: parseString(metadata.envelopeFrom, ''),
    recipients: Array.isArray(metadata.recipients)
      ? metadata.recipients.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
      : [],
    clientIp: parseString(metadata.clientIp, ''),
    helo: parseString(metadata.helo, ''),
    hostname: parseString(metadata.hostname, ''),
    authenticatedUser: parseString(metadata.authenticatedUser, ''),
    settingsId: parseString(metadata.settingsId, ''),
    queueId: parseString(metadata.queueId, ''),
  };
}

function mapScanRunSummary(row: RspamdScanRunRow): RspamdScanRunSummary {
  return {
    id: row.id,
    serviceId: row.service_id,
    actorAdminId: row.actor_admin_id,
    parentRunId: row.parent_run_id,
    transport: row.transport,
    sourceMode: row.source_mode,
    sourceFileName: row.source_file_name,
    messageHash: row.message_hash,
    rawMessageRelpath: row.raw_message_relpath,
    messageSizeBytes: Number(row.message_size_bytes),
    metadata: mapScanMetadata(row.metadata_json),
    summaryAction: row.summary_action,
    summaryScore: row.summary_score === null ? null : Number(row.summary_score),
    summaryRequiredScore: row.summary_required_score === null ? null : Number(row.summary_required_score),
    summarySymbols: row.summary_symbols ?? [],
    isSkipped: row.is_skipped,
    createdAt: row.created_at,
  };
}

function mapScanAction(row: RspamdScanActionRow): RspamdScanActionRecord {
  return {
    id: row.id,
    runId: row.run_id,
    serviceId: row.service_id,
    actorAdminId: row.actor_admin_id,
    actionType: row.action_type,
    details: toRecord(row.details_json),
    createdAt: row.created_at,
  };
}

export async function createTrainingImport(input: {
  sourceFilename: string | null;
  label: 'spam' | 'ham';
  createdBy: number | null;
  totalFiles: number;
}): Promise<TrainingImportJob> {
  const result = await query<TrainingImportRow>(`
    INSERT INTO rspamd_training_jobs (source_filename, label, status, total_files, created_by)
    VALUES ($1, $2, 'processing', $3, $4)
    RETURNING id, source_filename, label, status, total_files, total_samples, learned_samples,
              error_count, errors, created_by, created_at, completed_at
  `, [input.sourceFilename, input.label, input.totalFiles, input.createdBy]);
  return mapImport(result.rows[0]);
}

export async function finalizeTrainingImport(input: {
  id: number;
  status: 'completed' | 'failed';
  totalSamples: number;
  learnedSamples: number;
  errors: string[];
}): Promise<TrainingImportJob | null> {
  const result = await query<TrainingImportRow>(`
    UPDATE rspamd_training_jobs
    SET status = $2,
        total_samples = $3,
        learned_samples = $4,
        error_count = $5,
        errors = $6,
        completed_at = CURRENT_TIMESTAMP
    WHERE id = $1
    RETURNING id, source_filename, label, status, total_files, total_samples, learned_samples,
              error_count, errors, created_by, created_at, completed_at
  `, [input.id, input.status, input.totalSamples, input.learnedSamples, input.errors.length, input.errors]);
  return result.rows[0] ? mapImport(result.rows[0]) : null;
}

export async function getTrainingImport(id: number): Promise<TrainingImportJob | null> {
  const result = await query<TrainingImportRow>(`
    SELECT id, source_filename, label, status, total_files, total_samples, learned_samples,
           error_count, errors, created_by, created_at, completed_at
    FROM rspamd_training_jobs
    WHERE id = $1
  `, [id]);
  return result.rows[0] ? mapImport(result.rows[0]) : null;
}

export async function listTrainingSamples(options: TrainingSampleListOptions = {}): Promise<{
  samples: TrainingSample[];
  total: number;
  page: number;
  limit: number;
}> {
  const page = Math.max(1, Number(options.page ?? 1) || 1);
  const limit = Math.min(200, Math.max(1, Number(options.limit ?? 25) || 25));
  const values: Array<string | number> = [];
  const where: string[] = [];

  if (options.label) {
    values.push(options.label);
    where.push(`label = $${values.length}`);
  }
  if (options.status) {
    values.push(options.status);
    where.push(`learn_status = $${values.length}`);
  }
  if (options.search) {
    values.push(`%${options.search.toLowerCase()}%`);
    where.push(`(LOWER(filename) LIKE $${values.length} OR LOWER(content_hash) LIKE $${values.length})`);
  }

  const whereClause = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const offset = (page - 1) * limit;

  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM rspamd_training_samples ${whereClause}`, values),
    query<TrainingSampleRow>(
      `SELECT id, job_id AS import_id, filename, content_hash, label, source_type, stored_relpath, size_bytes,
              learn_status, learn_error, created_at, learned_at, relabeled_at
       FROM rspamd_training_samples
       ${whereClause}
       ORDER BY created_at DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}`,
      [...values, limit, offset]
    ),
  ]);

  return {
    samples: dataResult.rows.map(mapSample),
    total: parseInt(countResult.rows[0]?.count ?? '0', 10),
    page,
    limit,
  };
}

export async function getTrainingSample(id: number): Promise<TrainingSample | null> {
  const result = await query<TrainingSampleRow>(`
    SELECT id, job_id AS import_id, filename, content_hash, label, source_type, stored_relpath, size_bytes,
           learn_status, learn_error, created_at, learned_at, relabeled_at
    FROM rspamd_training_samples
    WHERE id = $1
  `, [id]);
  return result.rows[0] ? mapSample(result.rows[0]) : null;
}

export async function getTrainingSampleByHash(hash: string): Promise<TrainingSample | null> {
  const result = await query<TrainingSampleRow>(`
    SELECT id, job_id AS import_id, filename, content_hash, label, source_type, stored_relpath, size_bytes,
           learn_status, learn_error, created_at, learned_at, relabeled_at
    FROM rspamd_training_samples
    WHERE content_hash = $1
  `, [hash]);
  return result.rows[0] ? mapSample(result.rows[0]) : null;
}

export async function createTrainingSample(input: {
  importId: number | null;
  filename: string;
  contentHash: string;
  label: 'spam' | 'ham';
  sourceType: 'eml' | 'mbox' | 'archive';
  storedRelpath: string;
  sizeBytes: number;
}): Promise<TrainingSample | null> {
  const result = await query<TrainingSampleRow>(`
    INSERT INTO rspamd_training_samples
      (job_id, filename, content_hash, label, source_type, stored_relpath, size_bytes, learn_status)
    VALUES ($1, $2, $3, $4, $5, $6, $7, 'pending')
    ON CONFLICT (content_hash) DO NOTHING
    RETURNING id, job_id AS import_id, filename, content_hash, label, source_type, stored_relpath, size_bytes,
              learn_status, learn_error, created_at, learned_at, relabeled_at
  `, [
    input.importId,
    input.filename,
    input.contentHash,
    input.label,
    input.sourceType,
    input.storedRelpath,
    input.sizeBytes,
  ]);
  return result.rows[0] ? mapSample(result.rows[0]) : null;
}

export async function updateTrainingSampleLearning(id: number, input: {
  status: 'pending' | 'learned' | 'failed';
  error?: string | null;
}): Promise<void> {
  await query(`
    UPDATE rspamd_training_samples
    SET learn_status = $2,
        learn_error = $3,
        learned_at = CASE WHEN $4 THEN CURRENT_TIMESTAMP ELSE learned_at END
    WHERE id = $1
  `, [id, input.status, input.error ?? null, input.status === 'learned']);
}

export async function relabelTrainingSample(id: number, label: 'spam' | 'ham'): Promise<TrainingSample | null> {
  const result = await query<TrainingSampleRow>(`
    UPDATE rspamd_training_samples
    SET label = $2,
        relabeled_at = CURRENT_TIMESTAMP,
        learn_status = 'pending',
        learn_error = NULL
    WHERE id = $1
    RETURNING id, job_id AS import_id, filename, content_hash, label, source_type, stored_relpath, size_bytes,
              learn_status, learn_error, created_at, learned_at, relabeled_at
  `, [id, label]);
  return result.rows[0] ? mapSample(result.rows[0]) : null;
}

export async function deleteTrainingSample(id: number): Promise<TrainingSample | null> {
  const result = await query<TrainingSampleRow>(`
    DELETE FROM rspamd_training_samples
    WHERE id = $1
    RETURNING id, job_id AS import_id, filename, content_hash, label, source_type, stored_relpath, size_bytes,
              learn_status, learn_error, created_at, learned_at, relabeled_at
  `, [id]);
  return result.rows[0] ? mapSample(result.rows[0]) : null;
}

export async function createRspamdScanRun(input: {
  serviceId: string;
  actorAdminId: number | null;
  parentRunId?: number | null;
  transport: 'checkv2' | 'checkv3';
  sourceMode: 'raw' | 'upload' | 'replay';
  sourceFileName?: string | null;
  messageHash: string;
  rawMessageRelpath: string | null;
  messageSizeBytes: number;
  metadata: RspamdScanRequestMetadata;
  result: Record<string, unknown>;
  summaryAction?: string | null;
  summaryScore?: number | null;
  summaryRequiredScore?: number | null;
  summarySymbols?: string[];
  isSkipped?: boolean;
}): Promise<RspamdScanRunDetail> {
  const result = await query<RspamdScanRunRow>(`
    INSERT INTO rspamd_scan_runs (
      service_id,
      actor_admin_id,
      parent_run_id,
      transport,
      source_mode,
      source_file_name,
      message_hash,
      raw_message_relpath,
      message_size_bytes,
      metadata_json,
      result_json,
      summary_action,
      summary_score,
      summary_required_score,
      summary_symbols,
      is_skipped
    )
    VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::jsonb, $11::jsonb, $12, $13, $14, $15, $16)
    RETURNING id, service_id, actor_admin_id, parent_run_id, transport, source_mode, source_file_name,
              message_hash, raw_message_relpath, message_size_bytes, metadata_json, result_json,
              summary_action, summary_score, summary_required_score, summary_symbols, is_skipped, created_at
  `, [
    input.serviceId,
    input.actorAdminId,
    input.parentRunId ?? null,
    input.transport,
    input.sourceMode,
    input.sourceFileName ?? null,
    input.messageHash,
    input.rawMessageRelpath,
    input.messageSizeBytes,
    JSON.stringify(input.metadata),
    JSON.stringify(input.result),
    input.summaryAction ?? null,
    input.summaryScore ?? null,
    input.summaryRequiredScore ?? null,
    input.summarySymbols ?? [],
    input.isSkipped ?? false,
  ]);

  const row = result.rows[0];
  return {
    ...mapScanRunSummary(row),
    result: toRecord(row.result_json),
    actions: [],
  };
}

export async function listRspamdScanRuns(options: {
  serviceId: string;
  page?: number;
  limit?: number;
}): Promise<{
  runs: RspamdScanRunSummary[];
  total: number;
  page: number;
  limit: number;
}> {
  const page = Math.max(1, Number(options.page ?? 1) || 1);
  const limit = Math.min(100, Math.max(1, Number(options.limit ?? 20) || 20));
  const offset = (page - 1) * limit;

  const [countResult, dataResult] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*)::text AS count
       FROM rspamd_scan_runs
       WHERE service_id = $1`,
      [options.serviceId]
    ),
    query<RspamdScanRunRow>(
      `SELECT id, service_id, actor_admin_id, parent_run_id, transport, source_mode, source_file_name,
              message_hash, raw_message_relpath, message_size_bytes, metadata_json,
              summary_action, summary_score, summary_required_score, summary_symbols, is_skipped, created_at
       FROM rspamd_scan_runs
       WHERE service_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [options.serviceId, limit, offset]
    ),
  ]);

  return {
    runs: dataResult.rows.map(mapScanRunSummary),
    total: parseInt(countResult.rows[0]?.count ?? '0', 10),
    page,
    limit,
  };
}

export async function getRspamdScanRun(id: number, serviceId: string): Promise<RspamdScanRunDetail | null> {
  const [runResult, actionsResult] = await Promise.all([
    query<RspamdScanRunRow>(
      `SELECT id, service_id, actor_admin_id, parent_run_id, transport, source_mode, source_file_name,
              message_hash, raw_message_relpath, message_size_bytes, metadata_json, result_json,
              summary_action, summary_score, summary_required_score, summary_symbols, is_skipped, created_at
       FROM rspamd_scan_runs
       WHERE id = $1 AND service_id = $2`,
      [id, serviceId]
    ),
    query<RspamdScanActionRow>(
      `SELECT id, run_id, service_id, actor_admin_id, action_type, details_json, created_at
       FROM rspamd_scan_actions
       WHERE run_id = $1 AND service_id = $2
       ORDER BY created_at DESC`,
      [id, serviceId]
    ),
  ]);

  const row = runResult.rows[0];
  if (!row) {
    return null;
  }

  return {
    ...mapScanRunSummary(row),
    result: toRecord(row.result_json),
    actions: actionsResult.rows.map(mapScanAction),
  };
}

export async function createRspamdScanAction(input: {
  runId: number;
  serviceId: string;
  actorAdminId: number | null;
  actionType: 'learn_spam' | 'learn_ham' | 'fuzzy_add' | 'fuzzy_remove';
  details: Record<string, unknown>;
}): Promise<RspamdScanActionRecord> {
  const result = await query<RspamdScanActionRow>(`
    INSERT INTO rspamd_scan_actions (run_id, service_id, actor_admin_id, action_type, details_json)
    VALUES ($1, $2, $3, $4, $5::jsonb)
    RETURNING id, run_id, service_id, actor_admin_id, action_type, details_json, created_at
  `, [
    input.runId,
    input.serviceId,
    input.actorAdminId,
    input.actionType,
    JSON.stringify(input.details),
  ]);

  return mapScanAction(result.rows[0]);
}
