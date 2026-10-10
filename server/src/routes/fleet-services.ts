/**
 * API routes for fleet service management.
 *
 * Surface: /api/fleet/services/*
 */

import { Router, Request, Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { validateOutboundUrl } from '../middleware/security.js';
import { isDsnFor, restoreDsnPassword, toPublicFleetService } from '../services/service-dsn.js';
import { getConfig } from '../db/queries/config.js';
import {
  getFleetServiceSyncStatus,
  listFleetServiceSyncLog,
  appendFleetServiceSyncLog,
  requestFleetServiceSync,
} from '../db/queries/fleet-agent-sync.js';
import {
  createFleetService,
  deleteFleetService,
  fleetServiceExists,
  getAllFleetServices,
  getEnabledFleetServices,
  getFleetServiceById,
  getFleetServiceCount,
  type FleetService,
  type FleetServiceType,
  updateFleetService,
} from '../db/queries/fleet-services.js';
import { clearInstanceCache } from '../services/robin-api.js';
// Agent-aware live-metrics wrappers (they serve the pushed snapshot for
// agent-mode services, and probe directly otherwise) so the health check matches
// how the service is actually collected — a direct probe would wrongly report an
// agent-mode service (e.g. postfix once its exporter is retired) as unhealthy.
import {
  getLiveClamavMetrics,
  getLiveDovecotMetrics,
  getLivePostfixMetrics,
  getLiveRedisMetrics,
  getLivePostgresMetrics,
  getLiveMariadbMetrics,
} from '../services/metrics-poller.js';
import { DSN_PROTOCOLS, parseServiceType } from '../services/service-types.js';
import { logger } from '../logger.js';
import { routeParam } from './params.js';
import { invalidateFleetCapabilities } from '../services/service-capabilities.js';

const router = Router();

// Any change to services or agents can change what the UI may show.
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', invalidateFleetCapabilities);
  next();
});
const SERVICE_ID_PATTERN = /^[a-zA-Z0-9_-]+$/;

function parseOptionalBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  throw new Error(`${fieldName} must be true or false`);
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }

  return value.trim();
}

function parseOptionalNonEmptyString(value: unknown, fieldName: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  return parseRequiredString(value, fieldName);
}

function parseOptionalString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }

  if (value === null) {
    return null;
  }

  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }

  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

async function validateServiceUrls(
  serviceType: FleetServiceType,
  urls: Array<string | null | undefined>,
  metricsUrl: string | null | undefined
): Promise<string | null> {
  const cfg = await getConfig();

  for (const url of urls) {
    if (!url) {
      continue;
    }

    const error = validateOutboundUrl(url, cfg.allowPrivateServiceUrls);
    if (error) {
      return error;
    }
  }

  // A database type keeps its connection string in metricsUrl.
  if (metricsUrl) {
    return DSN_PROTOCOLS[serviceType]
      ? validateServiceDsn(serviceType, metricsUrl, cfg.allowPrivateServiceUrls)
      : validateOutboundUrl(metricsUrl, cfg.allowPrivateServiceUrls);
  }

  return null;
}

/** Null when a DSN may be saved for the type, else why not. */
export function validateServiceDsn(serviceType: FleetServiceType, value: string, allowPrivate: boolean): string | null {
  const protocols = DSN_PROTOCOLS[serviceType] ?? [];
  if (!isDsnFor(serviceType, value)) {
    return `Connection string must use ${protocols.map((protocol) => `${protocol}//`).join(' or ')}`;
  }
  let url: URL;
  try { url = new URL(value.trim()); } catch { return 'Connection string must be a valid URL'; }
  if (url.hash) return 'Connection strings must not contain fragments';
  for (const [key, target] of url.searchParams) {
    if (!['host', 'hostaddr', 'socket', 'socketPath'].includes(key)) continue;
    if (key === 'socket' || key === 'socketPath' || target.startsWith('/')) {
      if (!allowPrivate) return 'Private service URLs are disabled';
    } else {
      for (const host of target.split(',')) {
        const error = validateOutboundUrl(`http://${host.includes(':') && !host.startsWith('[') ? `[${host}]` : host}`, allowPrivate);
        if (error) return error;
      }
    }
  }
  if (serviceType === 'mariadb' && [...url.searchParams.keys()].some(key => !['socket', 'ssl'].includes(key))) return 'MariaDB connection string contains unsupported options';
  if (serviceType === 'mariadb' && !['', 'true', 'required', 'skip-verify', 'false'].includes(url.searchParams.get('ssl')?.toLowerCase() ?? '')) return 'Unsupported MariaDB TLS mode';
  return validateOutboundUrl(value.trim(), allowPrivate, protocols);
}

// Types whose health check and client reach the service through apiUrl.
const API_URL_TYPES: readonly FleetServiceType[] = ['robin', 'rspamd', 'clamav'];

function buildHealthCheckUrl(service: FleetService): string | null {
  if (service.healthUrl) {
    return service.healthUrl;
  }

  if (service.serviceType === 'rspamd') {
    if (service.controllerUrl) {
      return `${service.controllerUrl.replace(/\/$/, '')}/healthy`;
    }

    if (service.normalUrl) {
      return `${service.normalUrl.replace(/\/$/, '')}/ping`;
    }
  }

  if (!service.apiUrl) {
    return null;
  }

  return `${service.apiUrl.replace(/\/$/, '')}/health`;
}

function logRouteError(message: string, error: unknown, serviceId?: string) {
  logger.error(message, {
    serviceId,
    error: (error as Error).message,
  });
}

/**
 * GET /
 * List fleet services.
 */
router.get('/', requireAuth, async (req: Request, res: Response) => {
  try {
    const serviceType = parseServiceType(req.query.serviceType);
    const enabled = parseOptionalBoolean(req.query.enabled, 'enabled');
    const services = enabled === true
      ? await getEnabledFleetServices(serviceType)
      : await getAllFleetServices();

    const filteredServices = serviceType || enabled === false
      ? services.filter((service) => (
        (serviceType ? service.serviceType === serviceType : true) &&
        (enabled !== undefined ? service.enabled === enabled : true)
      ))
      : services;

    res.json({
      success: true,
      data: filteredServices.map(toPublicFleetService),
    });
  } catch (error) {
    if ((error as Error).message.includes('serviceType') || (error as Error).message.includes('enabled')) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }

    logRouteError('Failed to list fleet services', error);
    res.status(500).json({ success: false, error: 'Failed to list fleet services' });
  }
});

/**
 * GET /enabled
 * List enabled fleet services.
 */
router.get('/enabled', requireAuth, async (req: Request, res: Response) => {
  try {
    const serviceType = parseServiceType(req.query.serviceType);
    const services = await getEnabledFleetServices(serviceType);
    res.json({
      success: true,
      data: services.map(toPublicFleetService),
    });
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }

    logRouteError('Failed to list enabled fleet services', error);
    res.status(500).json({ success: false, error: 'Failed to list fleet services' });
  }
});

/**
 * GET /count
 * Get fleet service counts.
 */
router.get('/count', requireAuth, async (req: Request, res: Response) => {
  try {
    const serviceType = parseServiceType(req.query.serviceType);
    const counts = await getFleetServiceCount();
    const data = serviceType
      ? {
        serviceType,
        total: counts.byType[serviceType].total,
        enabled: counts.byType[serviceType].enabled,
      }
      : counts;

    res.json({
      success: true,
      data,
    });
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }

    logRouteError('Failed to get fleet service counts', error);
    res.status(500).json({ success: false, error: 'Failed to get counts' });
  }
});

/**
 * GET /:serviceId/health
 * Check a service health endpoint.
 */
router.get('/:serviceId/health', requireAuth, async (req: Request, res: Response) => {
  const serviceId = routeParam(req, 'serviceId');

  try {
    const service = await getFleetServiceById(serviceId);

    if (!service) {
      return res.status(404).json({
        success: false,
        error: 'Service not found',
      });
    }

    if (service.serviceType === 'clamav') {
      const startedAt = Date.now();
      try {
        const metrics = await getLiveClamavMetrics(service.serviceId);
        return res.json({
          success: true,
          data: {
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            healthy: Boolean(metrics?.pingOk),
            status: metrics?.pingOk ? 200 : 503,
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            ...(!metrics ? { error: 'ClamD did not respond' } : {}),
          },
        });
      } catch (clamavError) {
        return res.json({
          success: true,
          data: {
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            healthy: false,
            status: 503,
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            error: (clamavError as Error).message,
          },
        });
      }
    }

    if (service.serviceType === 'dovecot') {
      const startedAt = Date.now();
      try {
        const metrics = await getLiveDovecotMetrics(service.serviceId);
        return res.json({
          success: true,
          data: {
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            healthy: Boolean(metrics?.reachable),
            status: metrics?.reachable ? 200 : 503,
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            ...(!metrics?.reachable ? { error: 'Dovecot did not respond (doveadm/OpenMetrics unreachable)' } : {}),
          },
        });
      } catch (dovecotError) {
        return res.json({
          success: true,
          data: {
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            healthy: false,
            status: 503,
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            error: (dovecotError as Error).message,
          },
        });
      }
    }

    if (service.serviceType === 'postfix') {
      const startedAt = Date.now();
      try {
        const metrics = await getLivePostfixMetrics(service.serviceId);
        return res.json({
          success: true,
          data: {
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            healthy: Boolean(metrics?.reachable),
            status: metrics?.reachable ? 200 : 503,
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            ...(!metrics?.reachable ? { error: 'Postfix did not respond (postqueue/exporter unreachable)' } : {}),
          },
        });
      } catch (postfixError) {
        return res.json({
          success: true,
          data: {
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            healthy: false,
            status: 503,
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            error: (postfixError as Error).message,
          },
        });
      }
    }

    if (service.serviceType === 'redis' || service.serviceType === 'postgres' || service.serviceType === 'mariadb') {
      const startedAt = Date.now();
      const label = { redis: 'Redis', postgres: 'PostgreSQL', mariadb: 'MariaDB' }[service.serviceType];
      try {
        const metrics = service.serviceType === 'redis'
          ? await getLiveRedisMetrics(service.serviceId)
          : service.serviceType === 'postgres'
            ? await getLivePostgresMetrics(service.serviceId)
            : await getLiveMariadbMetrics(service.serviceId);
        return res.json({
          success: true,
          data: {
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            healthy: Boolean(metrics?.reachable),
            status: metrics?.reachable ? 200 : 503,
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            ...(!metrics?.reachable ? { error: `${label} did not respond` } : {}),
          },
        });
      } catch (serviceError) {
        return res.json({
          success: true,
          data: {
            serviceId: service.serviceId,
            serviceType: service.serviceType,
            healthy: false,
            status: 503,
            latency: Date.now() - startedAt,
            checkedAt: new Date().toISOString(),
            error: (serviceError as Error).message,
          },
        });
      }
    }

    const healthUrl = buildHealthCheckUrl(service);
    if (!healthUrl) {
      return res.status(400).json({
        success: false,
        error: 'Service has no health endpoint configured',
      });
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const startedAt = Date.now();

    try {
      const response = await fetch(healthUrl, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const payload = {
        healthy: response.ok,
        status: response.status,
        latency: Date.now() - startedAt,
        checkedAt: new Date().toISOString(),
      };

      res.json({
        success: true,
        data: { serviceId: service.serviceId, serviceType: service.serviceType, ...payload },
      });
    } catch (fetchError) {
      clearTimeout(timeout);

      res.json({
        success: true,
        data: {
          serviceId: service.serviceId,
          serviceType: service.serviceType,
          healthy: false,
          error: (fetchError as Error).message,
        },
      });
    }
  } catch (error) {
    logRouteError('Failed to check fleet service health', error, serviceId);
    res.status(500).json({ success: false, error: 'Failed to check health' });
  }
});

/**
 * GET /:serviceId
 * Get a specific fleet service.
 */
router.get('/:serviceId', requireAuth, async (req: Request, res: Response) => {
  const serviceId = routeParam(req, 'serviceId');

  try {
    const service = await getFleetServiceById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    const syncStatus = await getFleetServiceSyncStatus(serviceId);
    res.json({
      success: true,
      data: {
        ...toPublicFleetService(service),
        syncStatus,
      },
    });
  } catch (error) {
    logRouteError('Failed to get fleet service', error, serviceId);
    res.status(500).json({ success: false, error: 'Failed to get service' });
  }
});

/**
 * GET /:serviceId/sync
 * Current config-sync status for a service plus the most recent audit log. Admin only.
 */
router.get('/:serviceId/sync', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const serviceId = routeParam(req, 'serviceId');
    const service = await getFleetServiceById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    const [status, log] = await Promise.all([
      getFleetServiceSyncStatus(serviceId),
      listFleetServiceSyncLog(serviceId, 25),
    ]);
    res.json({ success: true, data: { status, log } });
  } catch (error) {
    logRouteError('Failed to load fleet sync status', error);
    res.status(500).json({ success: false, error: 'Failed to load sync status' });
  }
});

/**
 * POST /:serviceId/sync/request
 * Force sync now — stamp sync_requested_at so the agent re-pulls + re-applies
 * this service's config on its next poll (even if unchanged). Admin only.
 */
router.post('/:serviceId/sync/request', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const serviceId = routeParam(req, 'serviceId');
    const service = await getFleetServiceById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    const status = await requestFleetServiceSync(serviceId);
    await appendFleetServiceSyncLog({
      serviceId,
      eventType: 'sync_requested',
      message: 'Force sync requested — agent will re-apply on next poll',
    });
    res.json({ success: true, data: status });
  } catch (error) {
    logRouteError('Failed to request fleet sync', error);
    res.status(500).json({ success: false, error: 'Failed to request sync' });
  }
});

/**
 * GET /:serviceId/sync/log?limit=100
 * Full append-only config-sync audit log for a service. Admin only.
 */
router.get('/:serviceId/sync/log', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const serviceId = routeParam(req, 'serviceId');
    const service = await getFleetServiceById(serviceId);
    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    const limit = Number.parseInt(String(req.query.limit ?? '100'), 10) || 100;
    const log = await listFleetServiceSyncLog(serviceId, limit);
    res.json({ success: true, data: { log } });
  } catch (error) {
    logRouteError('Failed to load fleet sync log', error);
    res.status(500).json({ success: false, error: 'Failed to load sync log' });
  }
});

/**
 * POST /
 * Create a new fleet service. Admin only.
 */
router.post('/', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const serviceId = parseRequiredString(req.body.serviceId, 'serviceId');
    const serviceType = parseServiceType(req.body.serviceType);
    const name = parseRequiredString(req.body.name, 'name');
    const apiUrl = serviceType && API_URL_TYPES.includes(serviceType)
      ? parseRequiredString(req.body.apiUrl, 'apiUrl')
      : parseOptionalString(req.body.apiUrl, 'apiUrl');
    const description = parseOptionalString(req.body.description, 'description');
    const healthUrl = parseOptionalString(req.body.healthUrl, 'healthUrl');
    const metricsUrl = parseOptionalString(req.body.metricsUrl, 'metricsUrl');
    const controllerUrl = parseOptionalString(req.body.controllerUrl, 'controllerUrl');
    const normalUrl = parseOptionalString(req.body.normalUrl, 'normalUrl');
    const telemetrySource = parseOptionalString(req.body.telemetrySource, 'telemetrySource');
    if (telemetrySource && telemetrySource.trim().length > 255) throw new Error('telemetrySource must be at most 255 characters');
    const enabled = parseOptionalBoolean(req.body.enabled, 'enabled');

    if (!serviceType) {
      return res.status(400).json({
        success: false,
        error: 'serviceType is required',
      });
    }

    if (!SERVICE_ID_PATTERN.test(serviceId)) {
      return res.status(400).json({
        success: false,
        error: 'serviceId must contain only letters, numbers, hyphens, and underscores',
      });
    }

    const urlError = await validateServiceUrls(serviceType, [apiUrl, healthUrl, controllerUrl, normalUrl], metricsUrl);
    if (urlError) {
      return res.status(400).json({ success: false, error: urlError });
    }

    const exists = await fleetServiceExists(serviceId);
    if (exists) {
      return res.status(409).json({
        success: false,
        error: 'Service with this ID already exists',
      });
    }

    const service = await createFleetService({
      serviceId,
      serviceType,
      name,
      description,
      apiUrl,
      healthUrl,
      metricsUrl,
      controllerUrl,
      normalUrl,
      telemetrySource,
      enabled,
    });

    if (service.serviceType === 'robin') {
      clearInstanceCache(service.serviceId);
    }

    // Record the registration event so the sync log opens with the join.
    await appendFleetServiceSyncLog({
      serviceId: service.serviceId,
      eventType: 'registered',
      message: `Registered ${service.serviceType} service in fleet`,
    });

    logger.info('Fleet service created', { serviceId, serviceType });
    res.status(201).json({
      success: true,
      data: toPublicFleetService(service),
    });
  } catch (error) {
    if ((error as Error).message.includes('required') || (error as Error).message.includes('must be')) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }

    logRouteError('Failed to create fleet service', error);
    res.status(500).json({ success: false, error: 'Failed to create service' });
  }
});

/**
 * PUT /:serviceId
 * Update an existing fleet service. Admin only.
 */
router.put('/:serviceId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const serviceId = routeParam(req, 'serviceId');

  try {
    const nextServiceId = parseOptionalNonEmptyString(req.body.serviceId, 'serviceId');
    const name = parseOptionalNonEmptyString(req.body.name, 'name');
    const description = parseOptionalString(req.body.description, 'description');
    const apiUrl = parseOptionalString(req.body.apiUrl, 'apiUrl');
    const healthUrl = parseOptionalString(req.body.healthUrl, 'healthUrl');
    const requestedMetricsUrl = parseOptionalString(req.body.metricsUrl, 'metricsUrl');
    const controllerUrl = parseOptionalString(req.body.controllerUrl, 'controllerUrl');
    const normalUrl = parseOptionalString(req.body.normalUrl, 'normalUrl');
    const telemetrySource = parseOptionalString(req.body.telemetrySource, 'telemetrySource');
    if (telemetrySource && telemetrySource.trim().length > 255) throw new Error('telemetrySource must be at most 255 characters');
    const enabled = parseOptionalBoolean(req.body.enabled, 'enabled');

    const current = await getFleetServiceById(serviceId);
    if (!current) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }
    // The API hands DSNs out masked; an edit that keeps the mask keeps the password.
    const metricsUrl = requestedMetricsUrl ? restoreDsnPassword(requestedMetricsUrl, current.metricsUrl) : requestedMetricsUrl;

    const urlError = await validateServiceUrls(current.serviceType, [apiUrl, healthUrl, controllerUrl, normalUrl], metricsUrl);
    if (urlError) {
      return res.status(400).json({ success: false, error: urlError });
    }

    if (nextServiceId && !SERVICE_ID_PATTERN.test(nextServiceId)) {
      return res.status(400).json({
        success: false,
        error: 'serviceId must contain only letters, numbers, hyphens, and underscores',
      });
    }

    const service = await updateFleetService(serviceId, {
      serviceId: nextServiceId,
      name,
      description,
      apiUrl,
      healthUrl,
      metricsUrl,
      controllerUrl,
      normalUrl,
      telemetrySource,
      enabled,
    });

    if (!service) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    if (service.serviceType === 'robin') {
      clearInstanceCache(serviceId);
      if (nextServiceId && nextServiceId !== serviceId) {
        clearInstanceCache(nextServiceId);
      }
    }

    logger.info('Fleet service updated', {
      serviceId,
      nextServiceId: service.serviceId,
      serviceType: service.serviceType,
    });
    res.json({
      success: true,
      data: toPublicFleetService(service),
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      return res.status(409).json({ success: false, error: 'Service with this ID already exists' });
    }
    if ((error as Error).message.includes('must be')) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }

    logRouteError('Failed to update fleet service', error, serviceId);
    res.status(500).json({ success: false, error: 'Failed to update service' });
  }
});

/**
 * DELETE /:serviceId
 * Delete a fleet service. Admin only.
 */
router.delete('/:serviceId', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  const serviceId = routeParam(req, 'serviceId');

  try {
    const deleted = await deleteFleetService(serviceId);
    if (!deleted) {
      return res.status(404).json({ success: false, error: 'Service not found' });
    }

    clearInstanceCache(serviceId);
    logger.info('Fleet service deleted', { serviceId });
    res.json({
      success: true,
      message: 'Service deleted',
    });
  } catch (error) {
    logRouteError('Failed to delete fleet service', error, serviceId);
    res.status(500).json({ success: false, error: 'Failed to delete service' });
  }
});

export default router;
