/**
 * Configuration management routes.
 * 
 * Handles Robin Admin's internal configuration (settings page)
 * and data retention operations.
 * 
 * Endpoints:
 * - GET / - Get configuration (limited for non-admins)
 * - PUT / - Update configuration (admin only)
 * - GET /reporting-usage - Get raw reporting storage usage
 * - POST /cleanup-reporting - Cleanup old raw reporting reports
 * 
 * Configuration values:
 * - reporting_retention_days: How long to keep raw reporting evidence
 * - app_title: UI title (reserved for future use)
 * 
 * This is not for Robin MTA config files.
 * Robin MTA config is handled via robin-config routes.
 * Cleanup operations are permanent and logged to audit.
 */

import { Router, Request, Response } from 'express';
import { getConfig, getConfigValidationError, updateConfig, cleanupOldReportingReports, cleanupOldAuditLog, getReportingUsageStats } from '../db/queries/config.js';
import { setConfigValue } from '../db/queries/config.js';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { logger } from '../logger.js';
import { hashSecret, clearLoginLocks } from '../db/queries/security.js';
import {
  findInvalidCidrOrIp,
  findInvalidCorsOrigin,
  validateSessionLifetimeOrder,
} from './config-validation.js';
import { checkTableHasSchema, validateTableName } from '../db/queries/robin-config-meta.js';
import { config as runtimeConfig } from '../config.js';
import { getSheriffBaseUrl } from '../services/modules.js';
import { OBSERVABILITY_SETTINGS, validateObservabilitySettings } from '../services/observability-settings.js';
import { DISCOVERY_DEFAULTS, validateDiscoverySettings } from '../services/telemetry/discovery.js';
import { REPORTING_SETTINGS, validateReportingSettings } from '../services/reporting-settings.js';
import { connectionUrl, getStoreConnection } from '../services/telemetry/connection.js';
import { OPERATIONS_KEYS, validateOperationsSettings, operationsPolicy } from '../services/operations-settings.js';
import { getModuleHostPolicy, saveModuleHostPolicy, validateModuleHostPolicy } from '../services/module-host-policy.js';
import { getModuleIdentityRotationStatus } from '../services/module-identity.js';
import { routeParam } from './params.js';

const router = Router();

// All routes require authentication
router.use(requireAuth);

function numberUpdate(
  updates: Record<string, unknown>,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
): boolean | string {
  if (updates[key] === undefined) return false;
  const parsed = Number.parseInt(String(updates[key]), 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return `${label} must be between ${minimum} and ${maximum}`;
  }
  updates[key] = parsed;
  return false;
}

function floatUpdate(
  updates: Record<string, unknown>,
  key: string,
  label: string,
  minimum: number,
  maximum: number,
): boolean | string {
  if (updates[key] === undefined) return false;
  const parsed = Number.parseFloat(String(updates[key]));
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    return `${label} must be between ${minimum} and ${maximum}`;
  }
  updates[key] = parsed;
  return false;
}

function validateResolverList(value: unknown, label: string): string | null {
  const raw = String(value ?? '').trim();
  if (!raw) return `${label} is required`;
  const entries = raw.split(/[\s,]+/).filter(Boolean);
  for (const entry of entries) {
    if (entry.includes('/')) return `${label} entries must be IP addresses, not CIDRs: ${entry}`;
    const invalid = findInvalidCidrOrIp(entry);
    if (invalid) return `${label} contains an invalid IP address: ${invalid}`;
  }
  return null;
}

/**
 * GET /api/config
 * Get current configuration (admin only for full config, limited for others).
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const config = await getConfig();
    const isAdmin = req.session.admin?.role === 'admin';
    
    // Non-admins only get limited config
    if (!isAdmin) {
      res.json({
        success: true,
        data: {
          gravatarEnabled: config.gravatarEnabled,
          gravatarDefault: config.gravatarDefault,
          gravatarRating: config.gravatarRating,
          roleDescriptions: config.roleDescriptions,
        },
      });
      return;
    }
    
    res.json({
      success: true,
      data: config,
      configurationError: getConfigValidationError(),
    });
  } catch (error) {
    logger.error('Failed to get config', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get configuration',
    });
  }
});

/**
 * GET /api/config/runtime
 * Show restart-bound and secret-backed deployment settings.
 */
router.get('/runtime', requireAdmin, async (_req: Request, res: Response) => {
  const catalogBaseUrl = await getSheriffBaseUrl();
  const telemetryConnection = await getStoreConnection();
  let storeAddress = '';
  try { storeAddress = new URL(connectionUrl(telemetryConnection)).host; }
  catch { /* Missing or invalid deployment URL: never echo credentials. */ }
  res.json({
    success: true,
    data: {
      nodeEnv: runtimeConfig.nodeEnv,
      port: runtimeConfig.port,
      logLevel: runtimeConfig.logLevel,
      cookieDomain: runtimeConfig.cookieDomain,
      cookieSecure: runtimeConfig.cookieSecure,
      allowedOrigins: runtimeConfig.allowedOrigins,
      bodyLimit: runtimeConfig.bodyLimit,
      rateLimit: runtimeConfig.rateLimit,
      postgres: {
        host: runtimeConfig.postgres.host,
        port: runtimeConfig.postgres.port,
        database: runtimeConfig.postgres.database,
        user: runtimeConfig.postgres.user,
        poolMax: runtimeConfig.postgres.poolMax,
        poolMin: runtimeConfig.postgres.poolMin,
        idleTimeoutMillis: runtimeConfig.postgres.idleTimeoutMillis,
        connectionTimeoutMillis: runtimeConfig.postgres.connectionTimeoutMillis,
      },
      robin: {
        apiUrl: runtimeConfig.robin.apiUrl,
        apiAuthConfigured: Boolean(runtimeConfig.robin.apiAuth),
      },
      telemetry: {
        storeConfigured: telemetryConnection.mode !== 'disabled',
        storeAddress,
      },
      alerting: {
        enabled: operationsPolicy().alertsEnabled,
        evaluationIntervalMs: operationsPolicy().alertEvaluationIntervalMs,
        deliveryConcurrency: operationsPolicy().alertDeliveryConcurrency,
        instanceName: operationsPolicy().alertInstanceName,
        encryptionKeyConfigured: runtimeConfig.encryptionKeyConfigured,
      },
      sheriff: {
        catalogBaseUrl,
        rootPublicKeyConfigured: Boolean(runtimeConfig.sheriff.rootPublicKeyPem),
      },
      moduleInstaller: {
        url: runtimeConfig.moduleInstaller.url,
        signingSecretConfigured: Boolean(runtimeConfig.moduleInstaller.signingSecret),
      },
      moduleProxySecretModules: Object.keys(runtimeConfig.moduleProxySecrets),
      bootstrapModules: runtimeConfig.modulesBootstrap.map((moduleEntry) => moduleEntry.moduleSlug),
    },
  });
});

/**
 * PUT /api/config
 * Update configuration (admin only).
 */
router.put('/', requireAdmin, async (req: Request, res: Response) => {
  try {
    const updates = req.body;
    
    // Validate updates
    const allowedKeys = [
      ...OPERATIONS_KEYS,
      ...Object.keys(OBSERVABILITY_SETTINGS),
      ...Object.keys(DISCOVERY_DEFAULTS),
      ...Object.keys(REPORTING_SETTINGS),
      'gravatarEnabled',
      'gravatarDefault',
      'gravatarRating',
      'reportingRetentionDays',
      'auditLogRetentionDays',
      'reportingMtaStsChecksEnabled',
      'reportingTlsrptChecksEnabled',
      'reportingDaneChecksEnabled',
      'reportingBimiChecksEnabled',
      'reportingIntegrationEnabled',
      'sessionTimeoutMinutes',
      'sessionAbsoluteLifetimeMinutes',
      'maxLoginAttempts',
      'loginLockoutMinutes',
      'loginProtectionEnabled',
      'loginMaxAttemptsPerEmail',
      'loginMaxAttemptsPerIp',
      'globalIpAllowlist',
      'ingestionAuthRequired',
      'ingestionAllowedCidrs',
      'csrfProtectionEnabled',
      'allowedOrigins',
      'trustedProxyCidrs',
      'allowPrivateServiceUrls',
      'apiKeyMaxLifetimeDays',
      'fleetEnabled',
      'mailboxesEnabled',
      'monitoringEnabled',
      'telemetryEnabled',
      'modulesEnabled',
      'robinConfigTableName',
      'alertDeliveryRetentionDays',
      'reportingDefaultWindowDays',
      'reportingStaleAfterDays',
      'reportingAnalysisDebounceMs',
      'reportingAnalysisConcurrency',
      'reportingNonCompliantRateThreshold',
      'reportingNonCompliantMinVolume',
      'reportingNonCompliantAbsoluteFloor',
      'detectionUnknownSenderMinVolume',
      'detectionSpoofingMinFailCount',
      'detectionMisconfiguredMinVolume',
      'detectionDmarcFailingPassRate',
      'detectionTlsFailureRate',
      'detectionTlsMinFailures',
      'detectionForensicSpikeMultiplier',
      'detectionForensicSpikeMinRecent',
      'detectionForensicClusterMinOccurrences',
      'detectionForensicClusterMaxIssues',
      'detectionRequiredRuns',
      'detectionGraceRuns',
      'sourceIdentityTtlDays',
      'sourceIdentityConcurrency',
      'sourceIdentityTimeoutMs',
      'dnsResolvers',
      'senderEnrichmentDnsTimeoutMs',
      'metricsPollIntervalMs',
      'metricsRetentionDays',
      'logDefaultLines',
      'logMaxLines',
      'roleDescriptions',
    ];

    const filteredUpdates: Record<string, unknown> = {};
    for (const key of allowedKeys) {
      if (key in updates) {
        filteredUpdates[key] = updates[key];
      }
    }
    const currentConfig = await getConfig();
    const operationsError = validateOperationsSettings(filteredUpdates, currentConfig);
    if (operationsError) {
      res.status(400).json({ success: false, error: operationsError });
      return;
    }
    const reportingError = validateReportingSettings(filteredUpdates);
    if (reportingError) {
      res.status(400).json({ success: false, error: reportingError });
      return;
    }
    const observabilityError = validateObservabilitySettings(filteredUpdates, currentConfig);
    const discoveryError = validateDiscoverySettings(filteredUpdates, currentConfig);
    if (discoveryError) {
      res.status(400).json({ success: false, error: discoveryError });
      return;
    }
    if (observabilityError) {
      res.status(400).json({ success: false, error: observabilityError });
      return;
    }

    // Validate specific values
    if (filteredUpdates.gravatarDefault) {
      const validDefaults = ['identicon', 'monsterid', 'wavatar', 'retro', 'robohash', 'blank', 'mp'];
      if (!validDefaults.includes(filteredUpdates.gravatarDefault as string)) {
        res.status(400).json({
          success: false,
          error: 'Invalid gravatar default style',
        });
        return;
      }
    }
    
    if (filteredUpdates.gravatarRating) {
      const validRatings = ['g', 'pg', 'r', 'x'];
      if (!validRatings.includes(filteredUpdates.gravatarRating as string)) {
        res.status(400).json({
          success: false,
          error: 'Invalid gravatar rating',
        });
        return;
      }
    }
    
    if (filteredUpdates.reportingRetentionDays !== undefined) {
      const days = parseInt(String(filteredUpdates.reportingRetentionDays));
      if (isNaN(days) || days < 1 || days > 3650) {
        res.status(400).json({
          success: false,
          error: 'Reporting retention days must be between 1 and 3650',
        });
        return;
      }
      filteredUpdates.reportingRetentionDays = days;
    }

    if (filteredUpdates.auditLogRetentionDays !== undefined) {
      const days = parseInt(String(filteredUpdates.auditLogRetentionDays));
      if (isNaN(days) || days < 0 || days > 3650) {
        res.status(400).json({
          success: false,
          error: 'Audit log retention days must be between 0 (keep forever) and 3650',
        });
        return;
      }
      filteredUpdates.auditLogRetentionDays = days;
    }
    
    if (filteredUpdates.sessionTimeoutMinutes !== undefined) {
      const minutes = parseInt(String(filteredUpdates.sessionTimeoutMinutes));
      if (isNaN(minutes) || minutes < 5 || minutes > 1440) {
        res.status(400).json({
          success: false,
          error: 'Session timeout must be between 5 and 1440 minutes',
        });
        return;
      }
      filteredUpdates.sessionTimeoutMinutes = minutes;
    }

    if (filteredUpdates.sessionAbsoluteLifetimeMinutes !== undefined) {
      const minutes = parseInt(String(filteredUpdates.sessionAbsoluteLifetimeMinutes));
      if (isNaN(minutes) || minutes < 5 || minutes > 10080) {
        res.status(400).json({
          success: false,
          error: 'Absolute session lifetime must be between 5 and 10080 minutes',
        });
        return;
      }
      filteredUpdates.sessionAbsoluteLifetimeMinutes = minutes;
    }

    if (
      filteredUpdates.sessionTimeoutMinutes !== undefined ||
      filteredUpdates.sessionAbsoluteLifetimeMinutes !== undefined
    ) {
      const idleMinutes = Number(
        filteredUpdates.sessionTimeoutMinutes ?? currentConfig.sessionTimeoutMinutes
      );
      const absoluteMinutes = Number(
        filteredUpdates.sessionAbsoluteLifetimeMinutes ?? currentConfig.sessionAbsoluteLifetimeMinutes
      );
      const lifetimeError = validateSessionLifetimeOrder(idleMinutes, absoluteMinutes);
      if (lifetimeError) {
        res.status(400).json({ success: false, error: lifetimeError });
        return;
      }
    }
    
    if (filteredUpdates.maxLoginAttempts !== undefined) {
      const attempts = parseInt(String(filteredUpdates.maxLoginAttempts));
      if (isNaN(attempts) || attempts < 3 || attempts > 10) {
        res.status(400).json({
          success: false,
          error: 'Max login attempts must be between 3 and 10',
        });
        return;
      }
      filteredUpdates.maxLoginAttempts = attempts;
    }
    
    if (filteredUpdates.loginLockoutMinutes !== undefined) {
      const lockout = parseInt(String(filteredUpdates.loginLockoutMinutes));
      if (isNaN(lockout) || lockout < 5 || lockout > 60) {
        res.status(400).json({
          success: false,
          error: 'Login lockout duration must be between 5 and 60 minutes',
        });
        return;
      }
      filteredUpdates.loginLockoutMinutes = lockout;
    }

    if (filteredUpdates.loginMaxAttemptsPerEmail !== undefined) {
      const attempts = parseInt(String(filteredUpdates.loginMaxAttemptsPerEmail));
      if (isNaN(attempts) || attempts < 3 || attempts > 50) {
        res.status(400).json({
          success: false,
          error: 'Per-email login attempts must be between 3 and 50',
        });
        return;
      }
      filteredUpdates.loginMaxAttemptsPerEmail = attempts;
    }

    if (filteredUpdates.loginMaxAttemptsPerIp !== undefined) {
      const attempts = parseInt(String(filteredUpdates.loginMaxAttemptsPerIp));
      if (isNaN(attempts) || attempts < 3 || attempts > 500) {
        res.status(400).json({
          success: false,
          error: 'Per-IP login attempts must be between 3 and 500',
        });
        return;
      }
      filteredUpdates.loginMaxAttemptsPerIp = attempts;
    }

    if (filteredUpdates.apiKeyMaxLifetimeDays !== undefined) {
      const days = parseInt(String(filteredUpdates.apiKeyMaxLifetimeDays));
      if (isNaN(days) || days < 1 || days > 3650) {
        res.status(400).json({
          success: false,
          error: 'API key max lifetime must be between 1 and 3650 days',
        });
        return;
      }
      filteredUpdates.apiKeyMaxLifetimeDays = days;
    }

    for (const [key, label, minimum, maximum] of [
      ['alertDeliveryRetentionDays', 'Alert delivery retention days', 1, 365],
      ['reportingDefaultWindowDays', 'Default reporting window days', 1, 3650],
      ['reportingStaleAfterDays', 'Stale reporting threshold days', 1, 3650],
      ['reportingAnalysisDebounceMs', 'Reporting analysis debounce milliseconds', 1000, 300000],
      ['reportingAnalysisConcurrency', 'Concurrent reporting analyses', 1, 32],
      ['reportingNonCompliantMinVolume', 'Source failure minimum volume', 1, 10000000],
      ['reportingNonCompliantAbsoluteFloor', 'Source absolute failure floor', 1, 10000000],
      ['detectionUnknownSenderMinVolume', 'Unknown sender minimum volume', 1, 10000000],
      ['detectionSpoofingMinFailCount', 'Spoofing failure minimum', 1, 10000000],
      ['detectionMisconfiguredMinVolume', 'Misconfiguration minimum volume', 1, 10000000],
      ['detectionTlsMinFailures', 'TLS failure minimum', 1, 10000000],
      ['detectionForensicSpikeMinRecent', 'Forensic spike recent minimum', 1, 10000000],
      ['detectionForensicClusterMinOccurrences', 'Forensic cluster occurrence minimum', 1, 10000000],
      ['detectionForensicClusterMaxIssues', 'Forensic cluster issue limit', 1, 1000],
      ['detectionRequiredRuns', 'Detection required runs', 1, 20],
      ['detectionGraceRuns', 'Detection grace runs', 1, 20],
      ['sourceIdentityTtlDays', 'Source identity TTL days', 1, 3650],
      ['sourceIdentityConcurrency', 'Source identity concurrency', 1, 100],
      ['sourceIdentityTimeoutMs', 'Source identity timeout milliseconds', 500, 30000],
      ['senderEnrichmentDnsTimeoutMs', 'Sender enrichment DNS timeout milliseconds', 500, 30000],
      ['metricsPollIntervalMs', 'Metrics poll interval milliseconds', 5000, 3600000],
      ['metricsRetentionDays', 'Metrics retention days', 1, 3650],
      ['logDefaultLines', 'Default log lines', 1, 10000],
      ['logMaxLines', 'Maximum log lines', 1, 10000],
    ] as const) {
      const error = numberUpdate(filteredUpdates, key, label, minimum, maximum);
      if (error) {
        res.status(400).json({ success: false, error });
        return;
      }
    }

    for (const [key, label, minimum, maximum] of [
      ['reportingNonCompliantRateThreshold', 'Source failure rate threshold', 0.0001, 1],
      ['detectionDmarcFailingPassRate', 'DMARC failing pass rate', 0, 1],
      ['detectionTlsFailureRate', 'TLS failure rate', 0, 1],
      ['detectionForensicSpikeMultiplier', 'Forensic spike multiplier', 1, 100],
    ] as const) {
      const error = floatUpdate(filteredUpdates, key, label, minimum, maximum);
      if (error) {
        res.status(400).json({ success: false, error });
        return;
      }
    }

    if (
      filteredUpdates.logDefaultLines !== undefined ||
      filteredUpdates.logMaxLines !== undefined
    ) {
      const defaultLines = Number(filteredUpdates.logDefaultLines ?? currentConfig.logDefaultLines);
      const maxLines = Number(filteredUpdates.logMaxLines ?? currentConfig.logMaxLines);
      if (defaultLines > maxLines) {
        res.status(400).json({ success: false, error: 'Default log lines cannot exceed maximum log lines' });
        return;
      }
    }

    for (const key of ['globalIpAllowlist', 'ingestionAllowedCidrs', 'allowedOrigins', 'trustedProxyCidrs']) {
      if (filteredUpdates[key] !== undefined) {
        filteredUpdates[key] = String(filteredUpdates[key] ?? '').trim();
      }
    }

    for (const [key, label] of [
      ['globalIpAllowlist', 'Global IP allowlist'],
      ['trustedProxyCidrs', 'Trusted proxy CIDRs'],
      ['ingestionAllowedCidrs', 'Trusted ingestion source CIDRs'],
    ] as const) {
      if (filteredUpdates[key] !== undefined) {
        if (filteredUpdates[key] === currentConfig[key]) {
          continue;
        }
        const invalidEntry = findInvalidCidrOrIp(String(filteredUpdates[key]));
        if (invalidEntry) {
          res.status(400).json({
            success: false,
            error: `${label} contains an invalid IP or CIDR: ${invalidEntry}`,
          });
          return;
        }
      }
    }

    if (
      filteredUpdates.allowedOrigins !== undefined &&
      filteredUpdates.allowedOrigins !== currentConfig.allowedOrigins
    ) {
      const invalidOrigin = findInvalidCorsOrigin(String(filteredUpdates.allowedOrigins));
      if (invalidOrigin) {
        res.status(400).json({
          success: false,
          error: `Allowed CORS origins contains an invalid HTTP(S) origin: ${invalidOrigin}`,
        });
        return;
      }
    }

    if (filteredUpdates.robinConfigTableName !== undefined) {
      try {
        filteredUpdates.robinConfigTableName = validateTableName(
          String(filteredUpdates.robinConfigTableName)
        );
      } catch (error) {
        res.status(400).json({
          success: false,
          error: (error as Error).message,
        });
        return;
      }

      if (
        filteredUpdates.robinConfigTableName !== currentConfig.robinConfigTableName &&
        !await checkTableHasSchema(String(filteredUpdates.robinConfigTableName))
      ) {
        res.status(400).json({
          success: false,
          error: 'Robin config-store table must be a base table with server_id, file_name, payload_json, updated_epoch, and sha256 columns plus a unique (server_id, file_name) key',
        });
        return;
      }
    }

    if (filteredUpdates.reportingIntegrationEnabled !== undefined) {
      filteredUpdates.reportingIntegrationEnabled = Boolean(filteredUpdates.reportingIntegrationEnabled);
    }

    if (filteredUpdates.dnsResolvers !== undefined) {
      filteredUpdates.dnsResolvers = String(filteredUpdates.dnsResolvers ?? '').trim();
      const error = validateResolverList(filteredUpdates.dnsResolvers, 'DNS resolvers');
      if (error) {
        res.status(400).json({ success: false, error });
        return;
      }
    }

    if (filteredUpdates.mailboxesEnabled !== undefined && typeof filteredUpdates.mailboxesEnabled !== 'boolean') {
      res.status(400).json({ success: false, error: 'mailboxesEnabled must be a boolean' });
      return;
    }
    for (const key of ['loginProtectionEnabled', 'ingestionAuthRequired', 'csrfProtectionEnabled', 'allowPrivateServiceUrls', 'fleetEnabled', 'monitoringEnabled', 'telemetryEnabled', 'modulesEnabled']) {
      if (filteredUpdates[key] !== undefined) {
        filteredUpdates[key] = Boolean(filteredUpdates[key]);
      }
    }
    
    const config = await updateConfig(filteredUpdates);

    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'config',
      newValues: filteredUpdates,
    });
    
    logger.info('Configuration updated', { 
      adminId: req.session.admin?.id,
      updates: Object.keys(filteredUpdates),
    });
    
    res.json({
      success: true,
      data: config,
      configurationError: getConfigValidationError(),
    });
  } catch (error) {
    logger.error('Failed to update config', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to update configuration',
    });
  }
});

/**
 * POST /api/config/ingestion-secret
 * Rotate the shared report-ingestion secret.
 */
router.post('/ingestion-secret', requireAdmin, async (req: Request, res: Response) => {
  try {
    const { secret } = req.body;
    if (!secret || typeof secret !== 'string' || secret.length < 20) {
      res.status(400).json({
        success: false,
        error: 'Ingestion secret must be at least 20 characters long',
      });
      return;
    }

    await setConfigValue('ingestionSecretHash', hashSecret(secret));
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'security',
      entityId: 'ingestion-secret',
      newValues: { rotated: true },
    });
    res.json({ success: true, data: { ingestionSecretConfigured: true } });
  } catch (error) {
    logger.error('Failed to rotate ingestion secret', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to rotate ingestion secret' });
  }
});

/**
 * POST /api/config/clear-login-locks
 * Clear active login lockouts.
 */
router.post('/clear-login-locks', requireAdmin, async (req: Request, res: Response) => {
  try {
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : undefined;
    const cleared = await clearLoginLocks(email || undefined);
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'security',
      entityId: 'login-locks',
      newValues: { email: email || null, cleared },
    });
    res.json({ success: true, data: { cleared } });
  } catch (error) {
    logger.error('Failed to clear login locks', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to clear login locks' });
  }
});

/**
 * GET /api/config/reporting-usage
 * Get raw reporting store usage (admin only).
 */
router.get('/reporting-usage', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const usage = await getReportingUsageStats();
    res.json({ success: true, data: usage });
  } catch (error) {
    logger.error('Failed to get reporting usage stats', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to get reporting usage stats',
    });
  }
});

/**
 * POST /api/config/cleanup-reporting
 * Manually trigger raw reporting cleanup (admin only).
 */
router.post('/cleanup-reporting', requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await cleanupOldReportingReports();
    
    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'reporting',
      newValues: { action: 'cleanup', deletedReports: result },
    });
    
    logger.info('Reporting cleanup triggered', {
      adminId: req.session.admin?.id,
      deletedReports: result,
    });
    
    res.json({
      success: true,
      data: result,
    });
  } catch (error) {
    logger.error('Failed to cleanup reporting reports', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup reporting reports',
    });
  }
});

/**
 * POST /api/config/cleanup-audit-log
 * Manually trigger admin_audit_log pruning (admin only).
 */
router.post('/cleanup-audit-log', requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await cleanupOldAuditLog();

    await logAudit(req, AuditActions.CONFIG_UPDATE, {
      entityType: 'audit-log',
      newValues: { action: 'cleanup', deleted },
    });

    logger.info('Audit log cleanup triggered', {
      adminId: req.session.admin?.id,
      deleted,
    });

    res.json({
      success: true,
      data: { deleted },
    });
  } catch (error) {
    logger.error('Failed to cleanup audit log', { error: (error as Error).message });
    res.status(500).json({
      success: false,
      error: 'Failed to cleanup audit log',
    });
  }
});

router.get('/modules/policies', requireAdmin, async (_req, res) => {
  const policies = [];
  for (const slug of Object.keys(runtimeConfig.moduleProxySecrets)) policies.push(await getModuleHostPolicy(slug));
  res.json({ success: true, data: { policies, trust: (await getModuleIdentityRotationStatus()).trust } });
});
router.put('/modules/policies/:slug', requireAdmin, async (req, res) => {
  const slug = routeParam(req, 'slug');
  if (!Object.hasOwn(runtimeConfig.moduleProxySecrets, slug)) {
    res.status(404).json({ success: false, error: 'Module credential is not configured' }); return;
  }
  if (!validateModuleHostPolicy(req.body)) {
    res.status(400).json({ success: false, error: 'Invalid module policy; maximum body 1-64 MiB and timeout 5-120 seconds' }); return;
  }
  const oldValues = await getModuleHostPolicy(slug);
  const saved = await saveModuleHostPolicy(slug, req.body);
  await logAudit(req, AuditActions.CONFIG_UPDATE, { entityType: 'module_host_policy', entityId: slug, oldValues: { ...oldValues }, newValues: { ...saved } });
  res.json({ success: true, data: saved });
});

export default router;
