/**
 * Admin configuration management.
 */

import { query, getClient } from '../connection.js';
import type { PoolClient } from 'pg';
import { validatePostgresIdentifier } from '../postgres-identifier.js';
import { logger } from '../../logger.js';
import { OBSERVABILITY_SETTINGS, observabilityDefaults, type ObservabilityKey, type ObservabilitySettings } from '../../services/observability-settings.js';
import { REPORTING_SETTINGS, reportingDefaults, applyReportingSettings, type ReportingSettings } from '../../services/reporting-settings.js';
import { OPERATIONS_SETTINGS, OPERATIONS_KEYS, operationsDefaults, applyOperationsSettings, validateOperationsSettings, type OperationsSettings } from '../../services/operations-settings.js';
import { DISCOVERY_DEFAULTS, validateDiscoverySettings, type DiscoverySettings } from '../../services/telemetry/discovery.js';
import { validateObservabilitySettings } from '../../services/observability-settings.js';

export interface AdminConfig extends ObservabilitySettings, ReportingSettings, OperationsSettings, DiscoverySettings {
  // Gravatar settings
  gravatarEnabled: boolean;
  gravatarDefault: string; // identicon, monsterid, wavatar, retro, robohash, blank
  gravatarRating: string;  // g, pg, r, x
  
  // Raw reporting retention
  reportingRetentionDays: number;

  // Audit trail retention; 0 disables pruning and keeps entries indefinitely.
  auditLogRetentionDays: number;

  // Optional reporting posture advisories
  reportingMtaStsChecksEnabled: boolean;
  reportingTlsrptChecksEnabled: boolean;
  reportingDaneChecksEnabled: boolean;
  reportingBimiChecksEnabled: boolean;
  reportingIntegrationEnabled: boolean;
  
  // Session settings
  sessionTimeoutMinutes: number;
  sessionAbsoluteLifetimeMinutes: number;
  
  // Security settings
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  loginProtectionEnabled: boolean;
  loginMaxAttemptsPerEmail: number;
  loginMaxAttemptsPerIp: number;
  globalIpAllowlist: string;
  ingestionAuthRequired: boolean;
  ingestionAllowedCidrs: string;
  ingestionSecretConfigured: boolean;
  csrfProtectionEnabled: boolean;
  allowedOrigins: string;
  trustedProxyCidrs: string;
  allowPrivateServiceUrls: boolean;
  apiKeyMaxLifetimeDays: number;
  fleetEnabled: boolean;
  mailboxesEnabled: boolean;
  monitoringEnabled: boolean;
  telemetryEnabled: boolean;
  modulesEnabled: boolean;
  robinConfigTableName: string;

  alertDeliveryRetentionDays: number;
  reportingDefaultWindowDays: number;
  reportingStaleAfterDays: number;
  reportingAnalysisDebounceMs: number;
  /** Reporting analyses that may run at once; more wait their turn so a burst cannot take every database connection. */
  reportingAnalysisConcurrency: number;
  reportingNonCompliantRateThreshold: number;
  reportingNonCompliantMinVolume: number;
  reportingNonCompliantAbsoluteFloor: number;
  detectionUnknownSenderMinVolume: number;
  detectionSpoofingMinFailCount: number;
  detectionMisconfiguredMinVolume: number;
  detectionDmarcFailingPassRate: number;
  detectionTlsFailureRate: number;
  detectionTlsMinFailures: number;
  detectionForensicSpikeMultiplier: number;
  detectionForensicSpikeMinRecent: number;
  detectionForensicClusterMinOccurrences: number;
  detectionForensicClusterMaxIssues: number;
  detectionRequiredRuns: number;
  detectionGraceRuns: number;

  sourceIdentityTtlDays: number;
  sourceIdentityConcurrency: number;
  sourceIdentityTimeoutMs: number;
  /** Recursive resolvers shared by source identity and sender enrichment DNS lookups. */
  dnsResolvers: string;
  senderEnrichmentDnsTimeoutMs: number;

  metricsPollIntervalMs: number;
  metricsRetentionDays: number;
  logDefaultLines: number;
  logMaxLines: number;
  agentImage: string;
  agentInstallUrl: string;
  agentReleaseUrl: string;
  agentDeployGuideUrl: string;

  // Role descriptions
  roleDescriptions: {
    viewer: string;
    editor: string;
    admin: string;
  };
}

export interface ReportingUsageStats {
  dmarc: {
    reports: number;
    records: number;
    oldestReportDate: string | null;
    newestReportDate: string | null;
    storageBytes: number;
  };
  tlsrpt: {
    reports: number;
    policies: number;
    failures: number;
    oldestReportDate: string | null;
    newestReportDate: string | null;
    storageBytes: number;
  };
  forensic: {
    reports: number;
    oldestReportDate: string | null;
    newestReportDate: string | null;
    storageBytes: number;
  };
}

export interface ReportingCleanupResult {
  dmarc: number;
  tlsrpt: number;
  forensic: number;
  total: number;
}

/**
 * A suggested starter list for operators who want co-located report bots
 * (same host/container network) to post without a credential. NOT the
 * active default (see ingestionAllowedCidrs in DEFAULT_CONFIG below) — these
 * cover entire private address spaces, so treating them as trusted-by-default
 * would let anything on that network submit reports with no authentication.
 * Safe-by-default requires every producer to authenticate; operators opt in
 * to this (or a narrower list) explicitly under Administration -> Reporting.
 */
export const DEFAULT_INGESTION_ALLOWED_CIDRS = [
  '127.0.0.0/8',
  '::1/128',
  '10.0.0.0/8',
  '172.16.0.0/12',
  '192.168.0.0/16',
  'fc00::/7',
].join('\n');

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function envFloat(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function storedFloat(raw: string, fallback: number): number {
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const DEFAULT_CONFIG: AdminConfig = {
  ...DISCOVERY_DEFAULTS,
  ...observabilityDefaults(),
  ...reportingDefaults(),
  ...operationsDefaults(),
  gravatarEnabled: true,
  gravatarDefault: 'monsterid',
  gravatarRating: 'g',
  reportingRetentionDays: 365,
  auditLogRetentionDays: 0,
  reportingMtaStsChecksEnabled: false,
  reportingTlsrptChecksEnabled: false,
  reportingDaneChecksEnabled: false,
  reportingBimiChecksEnabled: false,
  reportingIntegrationEnabled: false,
  sessionTimeoutMinutes: 60,
  sessionAbsoluteLifetimeMinutes: 1440,
  maxLoginAttempts: 5,
  loginLockoutMinutes: 15,
  loginProtectionEnabled: true,
  loginMaxAttemptsPerEmail: 5,
  loginMaxAttemptsPerIp: 20,
  globalIpAllowlist: '',
  ingestionAuthRequired: true,
  // Safe by default: no source is trusted without a credential until an
  // operator explicitly opts a producer network in under Administration ->
  // Reporting. See DEFAULT_INGESTION_ALLOWED_CIDRS above for a starter list.
  ingestionAllowedCidrs: '',
  ingestionSecretConfigured: false,
  csrfProtectionEnabled: true,
  allowedOrigins: process.env.ALLOWED_ORIGINS || '',
  trustedProxyCidrs: '',
  allowPrivateServiceUrls: false,
  apiKeyMaxLifetimeDays: 365,
  fleetEnabled: false,
  mailboxesEnabled: false,
  monitoringEnabled: false,
  telemetryEnabled: false,
  modulesEnabled: false,
  robinConfigTableName: validatePostgresIdentifier(
    process.env.ROBIN_CONFIG_TABLE || 'robin_config_store',
    'ROBIN_CONFIG_TABLE'
  ),
  alertDeliveryRetentionDays: 30,
  reportingDefaultWindowDays: 30,
  reportingStaleAfterDays: 7,
  reportingAnalysisDebounceMs: Math.max(1000, envInt('REPORTING_ANALYSIS_DEBOUNCE_MS', 10000)),
  reportingAnalysisConcurrency: Math.max(1, envInt('REPORTING_ANALYSIS_CONCURRENCY', 4)),
  reportingNonCompliantRateThreshold: 0.02,
  reportingNonCompliantMinVolume: 10,
  reportingNonCompliantAbsoluteFloor: 100,
  detectionUnknownSenderMinVolume: envInt('ROBIN_DETECT_UNKNOWN_MIN_VOLUME', 50),
  detectionSpoofingMinFailCount: envInt('ROBIN_DETECT_SPOOFING_MIN_FAILS', 100),
  detectionMisconfiguredMinVolume: envInt('ROBIN_DETECT_MISCONFIGURED_MIN_VOLUME', 1000),
  detectionDmarcFailingPassRate: envFloat('ROBIN_DETECT_DMARC_FAIL_RATE', 0.95),
  detectionTlsFailureRate: envFloat('ROBIN_DETECT_TLS_FAILURE_RATE', 0.1),
  detectionTlsMinFailures: envInt('ROBIN_DETECT_TLS_MIN_FAILURES', 10),
  detectionForensicSpikeMultiplier: envFloat('ROBIN_DETECT_FORENSIC_SPIKE', 2),
  detectionForensicSpikeMinRecent: envInt('ROBIN_DETECT_FORENSIC_SPIKE_MIN', 3),
  detectionForensicClusterMinOccurrences: envInt('ROBIN_DETECT_FORENSIC_CLUSTER_MIN', 2),
  detectionForensicClusterMaxIssues: envInt('ROBIN_DETECT_FORENSIC_CLUSTER_MAX', 10),
  detectionRequiredRuns: envInt('ROBIN_DETECT_REQUIRED_RUNS', 2),
  detectionGraceRuns: envInt('ROBIN_DETECT_GRACE_RUNS', 2),
  sourceIdentityTtlDays: 30,
  sourceIdentityConcurrency: 12,
  sourceIdentityTimeoutMs: 3000,
  dnsResolvers: process.env.DNS_RESOLVERS ?? '1.1.1.1,8.8.8.8,9.9.9.9',
  senderEnrichmentDnsTimeoutMs: 3000,
  metricsPollIntervalMs: envInt('METRICS_POLL_INTERVAL', 60000),
  metricsRetentionDays: envInt('METRICS_RETENTION_DAYS', 14),
  logDefaultLines: 200,
  logMaxLines: 1000,
  agentImage: process.env.ROBIN_AGENT_IMAGE ?? 'ghcr.io/transilvlad/robin-admin-agent:latest',
  agentInstallUrl: process.env.ROBIN_AGENT_INSTALL_URL ?? 'https://raw.githubusercontent.com/transilvlad/robin-admin/main/agent/install.sh',
  agentReleaseUrl: process.env.ROBIN_AGENT_RELEASE_URL ?? 'https://github.com/transilvlad/robin-admin/releases/latest/download',
  agentDeployGuideUrl: process.env.ROBIN_AGENT_DEPLOY_GUIDE_URL ?? 'https://github.com/transilvlad/robin-admin/blob/main/doc/agent-deployment.md',
  roleDescriptions: {
    viewer: 'Can view all data but cannot make changes',
    editor: 'Can view and edit users, aliases, and queue',
    admin: 'Full access including admin management and configuration',
  },
};

// admin_config is also created by initializeSchema() at startup; this guards
// callers (scripts, tests) that reach getConfig()/updateConfig() before that
// has run. It's memoized after the first successful check to keep hot paths
// from repeating a CREATE TABLE IF NOT EXISTS.
let configTableEnsured = false;

/**
 * Ensure config table exists.
 */
export async function ensureConfigTable(): Promise<void> {
  if (configTableEnsured) {
    return;
  }
  await query(`
    CREATE TABLE IF NOT EXISTS admin_config (
      key VARCHAR(100) PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  configTableEnsured = true;
}

// Set when the first admin is created; cleared when an admin dismisses the
// dashboard's first-time setup guide. Stored server-side so the guide follows
// the install rather than whichever browser ran setup.
export const SETUP_GUIDE_PENDING_KEY = 'setup_guide_pending';

/**
 * Get a config value.
 */
export async function getConfigValue(key: string): Promise<string | null> {
  const result = await query<{ value: string }>(
    'SELECT value FROM admin_config WHERE key = $1',
    [key]
  );
  return result.rows[0]?.value ?? null;
}

/**
 * Set a config value.
 */
export async function setConfigValue(key: string, value: string): Promise<void> {
  await query(`
    INSERT INTO admin_config (key, value, updated_at)
    VALUES ($1, $2, CURRENT_TIMESTAMP)
    ON CONFLICT (key) DO UPDATE SET value = $2, updated_at = CURRENT_TIMESTAMP
  `, [key, value]);
  // Invalidate rather than patch in-place: some callers (module identity,
  // sheriff keys) write admin_config keys that aren't part of AdminConfig
  // at all, so it's simplest to just let the next getConfig() re-read.
  invalidateConfigCache();
  await notifyConfigChanged([key]);
}

let cachedConfig: AdminConfig | null = null;
let lastKnownGoodConfig: AdminConfig | null = null;
let cachedConfigExpiresAt = 0;
let configValidationError: string | null = null;
const CONFIG_CACHE_TTL_MS = 5000;
// One refresh at a time: requests arriving while it runs share it. A write
// bumps the generation, so a refresh started before the write is not reused.
let configGeneration = 0;
let configRefresh: { generation: number; promise: Promise<AdminConfig> } | null = null;

export function invalidateConfigCache(): void {
  cachedConfig = null;
  cachedConfigExpiresAt = 0;
  configGeneration += 1;
}

async function notifyConfigChanged(keys: string[]): Promise<void> {
  const payload = JSON.stringify({ keys: [...new Set(keys)] });
  try {
    await query(`SELECT pg_notify('config_changed', $1)`, [
      Buffer.byteLength(payload) <= 7500 ? payload : JSON.stringify({ keys: ['*'] }),
    ]);
  } catch (error) {
    logger.warn('Failed to broadcast configuration change; replicas will refresh from PostgreSQL', {
      error: (error as Error).message,
    });
  }
}

function reportConfigValidationError(error: string | null): void {
  if (error === configValidationError) return;
  if (error) logger.error('Invalid persisted observability configuration', { error });
  else if (configValidationError) logger.info('Persisted observability configuration is valid again');
  configValidationError = error;
}

export function getConfigValidationError(): string | null {
  return configValidationError;
}

export function resetConfigCacheForTests(): void {
  cachedConfig = null;
  lastKnownGoodConfig = null;
  cachedConfigExpiresAt = 0;
  configValidationError = null;
  configGeneration = 0;
  configRefresh = null;
}

/**
 * Get full config object.
 *
 * getConfig() is on the hot path (enforceIpJail runs it for every incoming
 * request, including every DMARC/TLSRPT/forensic report robin-admin
 * ingests), and admin settings change rarely, so the resolved object is
 * cached in-process and only rebuilt after a write via setConfigValue().
 */
export async function getConfig(): Promise<AdminConfig> {
  if (cachedConfig && Date.now() < cachedConfigExpiresAt) {
    return cachedConfig;
  }
  if (configRefresh && configRefresh.generation === configGeneration) {
    return configRefresh.promise;
  }
  const generation = configGeneration;
  const promise = loadConfig().catch((error: unknown) => {
    // While PostgreSQL is unreachable or out of connections, keep serving the
    // configuration that last loaded instead of failing every request.
    if (!lastKnownGoodConfig) throw error;
    logger.warn('Reading the configuration failed; using the last loaded one', { error: (error as Error).message });
    cachedConfig = lastKnownGoodConfig;
    cachedConfigExpiresAt = Date.now() + CONFIG_CACHE_TTL_MS;
    return lastKnownGoodConfig;
  }).finally(() => {
    if (configRefresh?.promise === promise) configRefresh = null;
  });
  configRefresh = { generation, promise };
  return promise;
}

async function loadConfig(): Promise<AdminConfig> {
  await ensureConfigTable();

  const result = await query<{ key: string; value: string }>(
    'SELECT key, value FROM admin_config'
  );
  
  const config = { ...DEFAULT_CONFIG };
  
  for (const row of result.rows) {
    if (Object.hasOwn(DISCOVERY_DEFAULTS, row.key)) {
      const key = row.key as keyof DiscoverySettings;
      config[key] = row.value;
      continue;
    }
    if (Object.hasOwn(OPERATIONS_SETTINGS, row.key)) {
      const key = row.key as keyof typeof OPERATIONS_SETTINGS;
      const rule = OPERATIONS_SETTINGS[key];
      const value = Number(row.value);
      if (Number.isInteger(value) && value >= rule.min && value <= rule.max) config[key] = value;
      continue;
    }
    if (row.key === 'alertsEnabled') { config.alertsEnabled = row.value === 'true'; continue; }
    if (row.key === 'alertInstanceName') {
      if (!validateOperationsSettings({ alertInstanceName: row.value }, operationsDefaults())) config.alertInstanceName = row.value.trim();
      continue;
    }
    if (Object.hasOwn(REPORTING_SETTINGS, row.key)) {
      const key = row.key as keyof ReportingSettings;
      const rule = REPORTING_SETTINGS[key];
      const value = Number(row.value);
      if (Number.isInteger(value) && value >= rule.min && value <= rule.max) config[key] = value;
      continue;
    }
    if (Object.hasOwn(OBSERVABILITY_SETTINGS, row.key)) {
      const key = row.key as ObservabilityKey;
      const rule = OBSERVABILITY_SETTINGS[key];
      const value = Number(row.value);
      if (Number.isInteger(value) && value >= rule.min && value <= rule.max) config[key] = value;
      continue;
    }
    if (row.key === 'robinConfigTableName') {
      try {
        config.robinConfigTableName = validatePostgresIdentifier(
          row.value,
          'Robin config-store table name'
        );
      } catch (error) {
        logger.warn('Ignoring invalid persisted Robin config-store table name', {
          error: (error as Error).message,
        });
      }
      continue;
    }
    try {
      switch (row.key) {
        case 'gravatarEnabled':
          config.gravatarEnabled = row.value === 'true';
          break;
        case 'gravatarDefault':
          config.gravatarDefault = row.value;
          break;
        case 'gravatarRating':
          config.gravatarRating = row.value;
          break;
        case 'reportingRetentionDays':
          config.reportingRetentionDays = parseInt(row.value) || DEFAULT_CONFIG.reportingRetentionDays;
          break;
        case 'auditLogRetentionDays':
          config.auditLogRetentionDays = row.value === '0' ? 0 : parseInt(row.value) || DEFAULT_CONFIG.auditLogRetentionDays;
          break;
        case 'reportingMtaStsChecksEnabled':
          config.reportingMtaStsChecksEnabled = row.value === 'true';
          break;
        case 'reportingTlsrptChecksEnabled':
          config.reportingTlsrptChecksEnabled = row.value === 'true';
          break;
        case 'reportingDaneChecksEnabled':
          config.reportingDaneChecksEnabled = row.value === 'true';
          break;
        case 'reportingBimiChecksEnabled':
          config.reportingBimiChecksEnabled = row.value === 'true';
          break;
        case 'reportingIntegrationEnabled':
          config.reportingIntegrationEnabled = row.value === 'true';
          break;
        case 'sessionTimeoutMinutes':
          config.sessionTimeoutMinutes = parseInt(row.value) || DEFAULT_CONFIG.sessionTimeoutMinutes;
          break;
        case 'sessionAbsoluteLifetimeMinutes':
          config.sessionAbsoluteLifetimeMinutes = parseInt(row.value) || DEFAULT_CONFIG.sessionAbsoluteLifetimeMinutes;
          break;
        case 'maxLoginAttempts':
          config.maxLoginAttempts = parseInt(row.value) || DEFAULT_CONFIG.maxLoginAttempts;
          break;
        case 'loginLockoutMinutes':
          config.loginLockoutMinutes = parseInt(row.value) || DEFAULT_CONFIG.loginLockoutMinutes;
          break;
        case 'loginProtectionEnabled':
          config.loginProtectionEnabled = row.value === 'true';
          break;
        case 'loginMaxAttemptsPerEmail':
          config.loginMaxAttemptsPerEmail = parseInt(row.value) || DEFAULT_CONFIG.loginMaxAttemptsPerEmail;
          break;
        case 'loginMaxAttemptsPerIp':
          config.loginMaxAttemptsPerIp = parseInt(row.value) || DEFAULT_CONFIG.loginMaxAttemptsPerIp;
          break;
        case 'globalIpAllowlist':
          config.globalIpAllowlist = row.value;
          break;
        case 'ingestionAuthRequired':
          config.ingestionAuthRequired = row.value === 'true';
          break;
        case 'ingestionAllowedCidrs':
          config.ingestionAllowedCidrs = row.value;
          break;
        case 'ingestionSecretHash':
          config.ingestionSecretConfigured = row.value.length > 0;
          break;
        case 'csrfProtectionEnabled':
          config.csrfProtectionEnabled = row.value === 'true';
          break;
        case 'allowedOrigins':
          config.allowedOrigins = row.value;
          break;
        case 'trustedProxyCidrs':
          config.trustedProxyCidrs = row.value;
          break;
        case 'allowPrivateServiceUrls':
          config.allowPrivateServiceUrls = row.value === 'true';
          break;
        case 'apiKeyMaxLifetimeDays':
          config.apiKeyMaxLifetimeDays = parseInt(row.value) || DEFAULT_CONFIG.apiKeyMaxLifetimeDays;
          break;
        case 'fleetEnabled':
          config.fleetEnabled = row.value === 'true';
          break;
        case 'mailboxesEnabled':
          config.mailboxesEnabled = row.value === 'true';
          break;
        case 'monitoringEnabled':
          config.monitoringEnabled = row.value === 'true';
          break;
        case 'telemetryEnabled':
          config.telemetryEnabled = row.value === 'true';
          break;
        case 'modulesEnabled':
          config.modulesEnabled = row.value === 'true';
          break;
        case 'alertDeliveryRetentionDays':
          config.alertDeliveryRetentionDays = parseInt(row.value) || DEFAULT_CONFIG.alertDeliveryRetentionDays;
          break;
        case 'reportingDefaultWindowDays':
          config.reportingDefaultWindowDays = parseInt(row.value) || DEFAULT_CONFIG.reportingDefaultWindowDays;
          break;
        case 'reportingStaleAfterDays':
          config.reportingStaleAfterDays = parseInt(row.value) || DEFAULT_CONFIG.reportingStaleAfterDays;
          break;
        case 'reportingAnalysisDebounceMs':
          config.reportingAnalysisDebounceMs = parseInt(row.value) || DEFAULT_CONFIG.reportingAnalysisDebounceMs;
          break;
        case 'reportingAnalysisConcurrency':
          config.reportingAnalysisConcurrency = parseInt(row.value) || DEFAULT_CONFIG.reportingAnalysisConcurrency;
          break;
        case 'reportingNonCompliantRateThreshold':
          config.reportingNonCompliantRateThreshold = storedFloat(row.value, DEFAULT_CONFIG.reportingNonCompliantRateThreshold);
          break;
        case 'reportingNonCompliantMinVolume':
          config.reportingNonCompliantMinVolume = parseInt(row.value) || DEFAULT_CONFIG.reportingNonCompliantMinVolume;
          break;
        case 'reportingNonCompliantAbsoluteFloor':
          config.reportingNonCompliantAbsoluteFloor = parseInt(row.value) || DEFAULT_CONFIG.reportingNonCompliantAbsoluteFloor;
          break;
        case 'detectionUnknownSenderMinVolume':
          config.detectionUnknownSenderMinVolume = parseInt(row.value) || DEFAULT_CONFIG.detectionUnknownSenderMinVolume;
          break;
        case 'detectionSpoofingMinFailCount':
          config.detectionSpoofingMinFailCount = parseInt(row.value) || DEFAULT_CONFIG.detectionSpoofingMinFailCount;
          break;
        case 'detectionMisconfiguredMinVolume':
          config.detectionMisconfiguredMinVolume = parseInt(row.value) || DEFAULT_CONFIG.detectionMisconfiguredMinVolume;
          break;
        case 'detectionDmarcFailingPassRate':
          config.detectionDmarcFailingPassRate = storedFloat(row.value, DEFAULT_CONFIG.detectionDmarcFailingPassRate);
          break;
        case 'detectionTlsFailureRate':
          config.detectionTlsFailureRate = storedFloat(row.value, DEFAULT_CONFIG.detectionTlsFailureRate);
          break;
        case 'detectionTlsMinFailures':
          config.detectionTlsMinFailures = parseInt(row.value) || DEFAULT_CONFIG.detectionTlsMinFailures;
          break;
        case 'detectionForensicSpikeMultiplier':
          config.detectionForensicSpikeMultiplier = storedFloat(row.value, DEFAULT_CONFIG.detectionForensicSpikeMultiplier);
          break;
        case 'detectionForensicSpikeMinRecent':
          config.detectionForensicSpikeMinRecent = parseInt(row.value) || DEFAULT_CONFIG.detectionForensicSpikeMinRecent;
          break;
        case 'detectionForensicClusterMinOccurrences':
          config.detectionForensicClusterMinOccurrences = parseInt(row.value) || DEFAULT_CONFIG.detectionForensicClusterMinOccurrences;
          break;
        case 'detectionForensicClusterMaxIssues':
          config.detectionForensicClusterMaxIssues = parseInt(row.value) || DEFAULT_CONFIG.detectionForensicClusterMaxIssues;
          break;
        case 'detectionRequiredRuns':
          config.detectionRequiredRuns = parseInt(row.value) || DEFAULT_CONFIG.detectionRequiredRuns;
          break;
        case 'detectionGraceRuns':
          config.detectionGraceRuns = parseInt(row.value) || DEFAULT_CONFIG.detectionGraceRuns;
          break;
        case 'sourceIdentityTtlDays':
          config.sourceIdentityTtlDays = parseInt(row.value) || DEFAULT_CONFIG.sourceIdentityTtlDays;
          break;
        case 'sourceIdentityConcurrency':
          config.sourceIdentityConcurrency = parseInt(row.value) || DEFAULT_CONFIG.sourceIdentityConcurrency;
          break;
        case 'sourceIdentityTimeoutMs':
          config.sourceIdentityTimeoutMs = parseInt(row.value) || DEFAULT_CONFIG.sourceIdentityTimeoutMs;
          break;
        case 'dnsResolvers':
          config.dnsResolvers = row.value;
          break;
        case 'senderEnrichmentDnsTimeoutMs':
          config.senderEnrichmentDnsTimeoutMs = parseInt(row.value) || DEFAULT_CONFIG.senderEnrichmentDnsTimeoutMs;
          break;
        case 'metricsPollIntervalMs':
          config.metricsPollIntervalMs = parseInt(row.value) || DEFAULT_CONFIG.metricsPollIntervalMs;
          break;
        case 'metricsRetentionDays':
          config.metricsRetentionDays = parseInt(row.value) || DEFAULT_CONFIG.metricsRetentionDays;
          break;
        case 'logDefaultLines':
          config.logDefaultLines = parseInt(row.value) || DEFAULT_CONFIG.logDefaultLines;
          break;
        case 'logMaxLines':
          config.logMaxLines = parseInt(row.value) || DEFAULT_CONFIG.logMaxLines;
          break;
        case 'roleDescriptions':
          config.roleDescriptions = JSON.parse(row.value);
          break;
      }
    } catch {
      // Use default if parsing fails
    }
  }

  const validationError = validateObservabilitySettings({}, config)
    ?? validateOperationsSettings(config)
    ?? validateDiscoverySettings({}, config);
  if (validationError) {
    const message = `Invalid persisted observability configuration: ${validationError}`;
    reportConfigValidationError(message);
    if (!lastKnownGoodConfig) throw new Error(message);
    cachedConfig = lastKnownGoodConfig;
    cachedConfigExpiresAt = Date.now() + CONFIG_CACHE_TTL_MS;
    return lastKnownGoodConfig;
  }
  reportConfigValidationError(null);
  applyReportingSettings(config);
  applyOperationsSettings(config);
  cachedConfig = config;
  lastKnownGoodConfig = config;
  cachedConfigExpiresAt = Date.now() + CONFIG_CACHE_TTL_MS;
  return config;
}

/**
 * Update config values.
 */
export async function updateConfig(updates: Partial<AdminConfig>): Promise<AdminConfig> {
  if (updates.mailboxesEnabled !== undefined && typeof updates.mailboxesEnabled !== 'boolean') {
    throw new Error('mailboxesEnabled must be a boolean');
  }
  await ensureConfigTable();
  const values: Record<string, unknown> = { ...updates };
  if (Object.keys(DISCOVERY_DEFAULTS).some(key => Object.hasOwn(updates, key))) {
    const current = await getConfig();
    const error = validateDiscoverySettings(values, current);
    if (error) throw new Error(error);
    for (const key of Object.keys(DISCOVERY_DEFAULTS) as Array<keyof DiscoverySettings>) {
      if (!Object.hasOwn(values, key)) values[key] = current[key];
    }
  }
  if (OPERATIONS_KEYS.some(key => Object.hasOwn(updates, key))) {
    const current = await getConfig();
    const error = validateOperationsSettings(values, current);
    if (error) throw new Error(error);
    // Save one complete valid policy, even when a caller patches a single field.
    for (const key of OPERATIONS_KEYS) if (!Object.hasOwn(values, key)) values[key] = current[key as keyof OperationsSettings];
    values.alertInstanceName = String(values.alertInstanceName).trim();
  }
  const entries = Object.entries(values).filter(([, value]) => value !== undefined);
  if (entries.length) {
    await query(`INSERT INTO admin_config (key, value, updated_at)
      SELECT key, value, CURRENT_TIMESTAMP FROM UNNEST($1::text[], $2::text[]) AS settings(key, value)
      ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = EXCLUDED.updated_at`,
    [entries.map(([key]) => key), entries.map(([, value]) => typeof value === 'object' ? JSON.stringify(value) : String(value))]);
    invalidateConfigCache();
    await notifyConfigChanged(entries.map(([key]) => key));
  }
  return getConfig();
}

/**
 * Get raw reporting store usage so operators can decide when to purge data.
 */
export async function getReportingUsageStats(): Promise<ReportingUsageStats> {
  const [dmarc, tlsrpt, forensic] = await Promise.all([
    query<{
      reports: string;
      records: string;
      oldest_report_date: Date | null;
      newest_report_date: Date | null;
      storage_bytes: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM dmarc_reports)::text AS reports,
        (SELECT COUNT(*) FROM dmarc_records)::text AS records,
        MIN(date_end) AS oldest_report_date,
        MAX(date_end) AS newest_report_date,
        (
          pg_total_relation_size('dmarc_reports'::regclass)
          + pg_total_relation_size('dmarc_records'::regclass)
        )::text AS storage_bytes
      FROM dmarc_reports
    `),
    query<{
      reports: string;
      policies: string;
      failures: string;
      oldest_report_date: Date | null;
      newest_report_date: Date | null;
      storage_bytes: string;
    }>(`
      SELECT
        (SELECT COUNT(*) FROM tlsrpt_reports)::text AS reports,
        (SELECT COUNT(*) FROM tlsrpt_policies)::text AS policies,
        (SELECT COUNT(*) FROM tlsrpt_failures)::text AS failures,
        MIN(date_end) AS oldest_report_date,
        MAX(date_end) AS newest_report_date,
        (
          pg_total_relation_size('tlsrpt_reports'::regclass)
          + pg_total_relation_size('tlsrpt_policies'::regclass)
          + pg_total_relation_size('tlsrpt_failures'::regclass)
        )::text AS storage_bytes
      FROM tlsrpt_reports
    `),
    query<{
      reports: string;
      oldest_report_date: Date | null;
      newest_report_date: Date | null;
      storage_bytes: string;
    }>(`
      SELECT
        COUNT(*)::text AS reports,
        MIN(COALESCE(received_date, arrival_date, created_at)) AS oldest_report_date,
        MAX(COALESCE(received_date, arrival_date, created_at)) AS newest_report_date,
        pg_total_relation_size('forensic_reports'::regclass)::text AS storage_bytes
      FROM forensic_reports
    `),
  ]);

  const dmarcRow = dmarc.rows[0];
  const tlsrptRow = tlsrpt.rows[0];
  const forensicRow = forensic.rows[0];

  return {
    dmarc: {
      reports: parseInt(dmarcRow?.reports ?? '0', 10),
      records: parseInt(dmarcRow?.records ?? '0', 10),
      oldestReportDate: dmarcRow?.oldest_report_date?.toISOString() ?? null,
      newestReportDate: dmarcRow?.newest_report_date?.toISOString() ?? null,
      storageBytes: parseInt(dmarcRow?.storage_bytes ?? '0', 10),
    },
    tlsrpt: {
      reports: parseInt(tlsrptRow?.reports ?? '0', 10),
      policies: parseInt(tlsrptRow?.policies ?? '0', 10),
      failures: parseInt(tlsrptRow?.failures ?? '0', 10),
      oldestReportDate: tlsrptRow?.oldest_report_date?.toISOString() ?? null,
      newestReportDate: tlsrptRow?.newest_report_date?.toISOString() ?? null,
      storageBytes: parseInt(tlsrptRow?.storage_bytes ?? '0', 10),
    },
    forensic: {
      reports: parseInt(forensicRow?.reports ?? '0', 10),
      oldestReportDate: forensicRow?.oldest_report_date?.toISOString() ?? null,
      newestReportDate: forensicRow?.newest_report_date?.toISOString() ?? null,
      storageBytes: parseInt(forensicRow?.storage_bytes ?? '0', 10),
    },
  };
}

/**
 * Clean up old raw reporting evidence based on retention settings.
 *
 * DMARC reports and their records are partitioned by month, so every month
 * wholly past retention is dropped from both in O(1). TLS-RPT and forensic
 * reports are small and use a filtered DELETE. Rollups are permanent and never
 * touched by retention, so reporting numbers stay stable across a prune.
 */
export async function cleanupOldReportingReports(): Promise<ReportingCleanupResult> {
  const config = await getConfig();

  if (config.reportingRetentionDays <= 0) {
    return { dmarc: 0, tlsrpt: 0, forensic: 0, total: 0 };
  }

  const days = config.reportingRetentionDays;
  const [dmarc, tlsrpt, forensic] = await Promise.all([
    // Reports and records share month bounds (report_day is the report's
    // start), so the same months go from both.
    dropExpiredDmarcPartitions(days),
    deleteExpiredRows('tlsrpt_reports', "date_end < NOW() - ($1::int * INTERVAL '1 day')", days),
    deleteExpiredRows(
      'forensic_reports',
      "COALESCE(received_date, arrival_date, created_at) < NOW() - ($1::int * INTERVAL '1 day')",
      days
    ),
  ]);

  return { dmarc, tlsrpt, forensic, total: dmarc + tlsrpt + forensic };
}

async function deleteExpiredRows(
  table: 'tlsrpt_reports' | 'forensic_reports',
  deleteWhere: string,
  retentionDays: number
): Promise<number> {
  const result = await query<{ count: string }>(
    `WITH deleted AS (DELETE FROM ${table} WHERE ${deleteWhere} RETURNING 1)
     SELECT COUNT(*) AS count FROM deleted`,
    [retentionDays]
  );
  return parseInt(result.rows[0]?.count ?? '0', 10);
}

/**
 * Drop the month partitions whose upper bound (exclusive) is at or before the
 * retention cutoff — those months are entirely past retention. The default
 * partition has no bound and is never dropped. reltuples is used for the
 * returned count as a cheap estimate; an exact count would require an extra
 * scan and this figure is diagnostic only.
 */
async function dropExpiredDmarcPartitions(retentionDays: number): Promise<number> {
  const client = await getClient();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    await client.query('LOCK TABLE dmarc_reports, dmarc_records IN SHARE ROW EXCLUSIVE MODE');
    const reports = await dropExpiredPartitions(client, 'dmarc_reports', retentionDays);
    await dropExpiredPartitions(client, 'dmarc_records', retentionDays);
    await client.query('COMMIT');
    return reports;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function dropExpiredPartitions(client: PoolClient, parent: 'dmarc_reports' | 'dmarc_records', retentionDays: number): Promise<number> {
  // The bound reads `TO ('2026-10-01')` on a date key and
  // `TO ('2026-10-01 00:00:00')` on a timestamp key; take the date either way.
  const partitions = await client.query<{ child: string; upper: string | null; rows_est: string }>(
    `SELECT c.oid::regclass::text AS child,
            c.reltuples::text AS rows_est,
            (regexp_match(pg_get_expr(c.relpartbound, c.oid), 'TO \\(''([0-9]{4}-[0-9]{2}-[0-9]{2})'))[1] AS upper
     FROM pg_inherits i JOIN pg_class c ON c.oid = i.inhrelid
     WHERE i.inhparent = $1::regclass`,
    [parent]
  );
  const cutoffStr = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
  let rowsDropped = 0;
  for (const partition of partitions.rows) {
    if (partition.upper && partition.upper <= cutoffStr) {
      await client.query(`DROP TABLE IF EXISTS ${partition.child}`);
      rowsDropped += Math.max(0, Math.round(Number(partition.rows_est) || 0));
    }
  }
  return rowsDropped;
}

/**
 * Prune admin_audit_log entries older than the configured retention window.
 * A retention of 0 or less means "keep forever" and is a no-op.
 */
export async function cleanupOldAuditLog(): Promise<number> {
  const config = await getConfig();

  if (config.auditLogRetentionDays <= 0) {
    return 0;
  }

  const result = await query<{ count: string }>(`
    WITH deleted AS (
      DELETE FROM admin_audit_log
      WHERE created_at < NOW() - ($1::int * INTERVAL '1 day')
      RETURNING id
    )
    SELECT COUNT(*) as count FROM deleted
  `, [config.auditLogRetentionDays]);

  return parseInt(result.rows[0]?.count ?? '0', 10);
}

// ── Scheduled retention maintenance ─────────────────────────────────────────
// Runs once a day; a leader-locked caller (see index.ts) keeps this to one
// execution across a multi-instance deployment.

let reportingMaintenanceTimer: NodeJS.Timeout | null = null;
const REPORTING_MAINTENANCE_INTERVAL_MS = 24 * 60 * 60 * 1000;

async function runReportingMaintenance(): Promise<void> {
  try {
    const reporting = await cleanupOldReportingReports();
    const auditLog = await cleanupOldAuditLog();
    if (reporting.total > 0 || auditLog > 0) {
      logger.info('Scheduled retention cleanup completed', {
        dmarc: reporting.dmarc,
        tlsrpt: reporting.tlsrpt,
        forensic: reporting.forensic,
        auditLog,
      });
    }
  } catch (error) {
    logger.error('Scheduled retention cleanup failed', { error: (error as Error).message });
  }
}

export function startReportingMaintenanceScheduler(): void {
  if (reportingMaintenanceTimer) return;
  void runReportingMaintenance();
  reportingMaintenanceTimer = setInterval(() => {
    void runReportingMaintenance();
  }, REPORTING_MAINTENANCE_INTERVAL_MS);
}

export function stopReportingMaintenanceScheduler(): void {
  if (!reportingMaintenanceTimer) return;
  clearInterval(reportingMaintenanceTimer);
  reportingMaintenanceTimer = null;
}
