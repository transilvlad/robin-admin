import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import {
  createMonitoringCheck,
  createMonitoringTarget,
  closeStaleMonitoringIssue,
  deleteClosedMonitoringIssue,
  getMonitoringCheckHistory,
  getMonitoringCheckLocationHistory,
  getMonitoringCheckObservations,
  requestMonitoringEvaluation,
  deleteMonitoringCheck,
  deleteMonitoringTarget,
  getMonitoringCheck,
  getMonitoringSummary,
  pauseMonitoringCheck,
  resumeMonitoringCheck,
  updateMonitoringCheck,
  updateMonitoringTarget,
  getMonitoringCheckPushToken,
  rotateMonitoringCheckPushToken,
} from '../db/queries/monitoring.js';
import { runMonitoringCheckNow } from '../services/monitoring/scheduler.js';
import {
  MONITORING_CHECK_TYPES,
  MONITORING_CERTIFICATE_ERROR_MODES,
  MONITORING_TLS_MODES,
  MONITORING_TARGET_TYPES,
  type MonitoringCertificateErrorMode,
  type MonitoringCheckType,
  type MonitoringTargetType,
  type MonitoringTlsMode,
} from '../types/monitoring.js';
import { logger } from '../logger.js';
import { getConfig } from '../db/queries/config.js';
import { routeParam } from './params.js';
import { logAudit } from '../middleware/audit.js';
import { MonitoringInputError, parseMonitoringOptions, validateMonitoringEndpoint, validateMonitoringHeaders, validateMonitoringProtocol } from '../services/monitoring/options.js';
import { exportMonitoringConfiguration, importMonitoringConfiguration } from '../services/monitoring/config-transfer.js';
import { deleteHeartbeatTarget, getHeartbeatHealth, listHeartbeatTargets, saveHeartbeatTarget, sendHeartbeatTest } from '../services/monitoring/heartbeat.js';
import {
  grantMonitoringProbeLocation,
  listMonitoringProbeLocations,
  ProbeRequestError,
  updateMonitoringProbeLocation,
} from '../db/queries/monitoring-probes.js';
import { getFleetAgentById, listFleetAgents } from '../db/queries/fleet-agents.js';
import { PUSH_INTERVAL_MAX_SECONDS } from '../services/monitoring/push.js';
import { pushUrl } from './monitoring-ping.js';

const router = Router();

function validateCheckFields(body: unknown): void {
  const fields = ['targetId', 'name', 'checkType', 'endpoint', 'port', 'intervalSeconds', 'timeoutSeconds', 'confirmationSeconds', 'recoverySeconds', 'placementMode', 'locationIds', 'quorum', 'certExpiryDays', 'tlsMode', 'certificateErrorMode', 'allowPrivate', 'options', 'secretHeaders', 'enabled'];
  if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => !fields.includes(key))) throw new MonitoringInputError('Check contains unsupported settings');
  if (typeof (body as Record<string, unknown>).name === 'string' && String((body as Record<string, unknown>).name).length > 160) throw new MonitoringInputError('Check name exceeds 160 characters');
}

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`${fieldName} is required`);
  }
  return value.trim();
}

function parseOptionalString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`${fieldName} must be true or false`);
}

function parseNumber(value: unknown, fieldName: string, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const parsed = value;
  if (typeof parsed !== 'number' || !Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

// Route parameters arrive as strings; parseNumber validates JSON numbers.
function parseRouteId(req: Request): number {
  const raw = routeParam(req, 'id');
  return parseNumber(/^\d{1,10}$/.test(raw) ? Number(raw) : Number.NaN, 'id', 1, 2_147_483_647)!;
}

function parseNullableNumber(value: unknown, fieldName: string, min: number, max: number): number | null | undefined {
  if (value === null) return null;
  return parseNumber(value, fieldName, min, max);
}

function parseLocationIds(value: unknown): number[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new MonitoringInputError('locationIds must be an array of positive integers');
  return value.map((id, index) => parseNumber(id, `locationIds[${index}]`, 1, 2_147_483_647)!);
}

function parsePlacementMode(value: unknown): 'all' | 'selected' | undefined {
  if (value === undefined) return undefined;
  if (value === 'all' || value === 'selected') return value;
  throw new MonitoringInputError('placementMode must be all or selected');
}

function parseTargetType(value: unknown): MonitoringTargetType {
  if (MONITORING_TARGET_TYPES.includes(value as MonitoringTargetType)) {
    return value as MonitoringTargetType;
  }
  throw new Error(`targetType must be one of: ${MONITORING_TARGET_TYPES.join(', ')}`);
}

function parseCheckType(value: unknown): MonitoringCheckType {
  if (MONITORING_CHECK_TYPES.includes(value as MonitoringCheckType)) {
    return value as MonitoringCheckType;
  }
  throw new Error(`checkType must be one of: ${MONITORING_CHECK_TYPES.join(', ')}`);
}

function parseTlsMode(value: unknown): MonitoringTlsMode | undefined {
  if (value === undefined) return undefined;
  if (MONITORING_TLS_MODES.includes(value as MonitoringTlsMode)) {
    return value as MonitoringTlsMode;
  }
  throw new Error(`tlsMode must be one of: ${MONITORING_TLS_MODES.join(', ')}`);
}

function parseCertificateErrorMode(value: unknown): MonitoringCertificateErrorMode | undefined {
  if (value === undefined) return undefined;
  if (MONITORING_CERTIFICATE_ERROR_MODES.includes(value as MonitoringCertificateErrorMode)) return value as MonitoringCertificateErrorMode;
  throw new Error(`certificateErrorMode must be one of: ${MONITORING_CERTIFICATE_ERROR_MODES.join(', ')}`);
}

function parseEndpoint(value: unknown, checkType: MonitoringCheckType): string {
  if (checkType === 'push') return 'push';
  const endpoint = parseRequiredString(value, 'endpoint');
  validateMonitoringEndpoint(endpoint, checkType);
  return endpoint;
}

function routeError(res: Response, message: string, error: unknown): void {
  const detail = (error as Error).message;
  if (error instanceof MonitoringInputError || detail.includes('required') || detail.includes('must be') || detail.includes('one of')) {
    res.status(400).json({ success: false, error: detail });
    return;
  }
  logger.error(message, { error: detail });
  res.status(500).json({ success: false, error: message });
}

router.use(requireAuth);
router.use(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await getConfig()).monitoringEnabled) {
      return res.status(403).json({
        success: false,
        error: 'Monitoring is disabled. Enable Monitoring under Administration -> Integrations before managing checks.',
      });
    }
    next();
  } catch (error) {
    routeError(res, 'Failed to verify monitoring capability state', error);
  }
});

router.get('/', requireAuth, async (_req: Request, res: Response) => {
  try {
    const [summary, config] = await Promise.all([getMonitoringSummary(), getConfig()]);
    res.json({ success: true, data: { ...summary, alertsEnabled: config.alertsEnabled, monitoringEnabled: config.monitoringEnabled } });
  } catch (error) {
    routeError(res, 'Failed to load monitoring summary', error);
  }
});

router.get('/heartbeats', requireAdmin, async (_req: Request, res: Response) => {
  try { res.json({ success: true, data: await listHeartbeatTargets() }); }
  catch (error) { routeError(res, 'Failed to load monitoring heartbeats', error); }
});

router.get('/locations', requireAdmin, async (_req: Request, res: Response) => {
  try {
    const [locations, agents] = await Promise.all([listMonitoringProbeLocations(), listFleetAgents()]);
    const assigned = new Set(locations.map(location => location.agentId).filter((id): id is string => id !== null));
    res.json({
      success: true,
      data: {
        locations,
        availableAgents: agents.filter(agent => agent.enrolledAt && !assigned.has(agent.agentId)).map(agent => ({
          agentId: agent.agentId,
          name: agent.name,
          hostname: agent.hostname,
          status: agent.status,
        })),
      },
    });
  } catch (error) { routeError(res, 'Failed to load monitoring locations', error); }
});

router.post('/locations', requireAdmin, async (req: Request, res: Response) => {
  try {
    const allowed = ['agentId', 'name', 'region', 'probeConcurrency'];
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some(key => !allowed.includes(key))) {
      throw new MonitoringInputError('Location contains unsupported settings');
    }
    const agentId = parseRequiredString(req.body.agentId, 'agentId');
    if (agentId.length > 64) throw new MonitoringInputError('agentId exceeds 64 characters');
    const agent = await getFleetAgentById(agentId);
    if (!agent?.enrolledAt) throw new ProbeRequestError('An enrolled agent is required', 404);
    const name = req.body.name === undefined ? agent.name : parseRequiredString(req.body.name, 'name');
    if (name.length > 100) throw new MonitoringInputError('Location name exceeds 100 characters');
    const region = parseOptionalString(req.body.region, 'region') ?? null;
    if (region && region.length > 100) throw new MonitoringInputError('Region exceeds 100 characters');
    const probeConcurrency = req.body.probeConcurrency === undefined
      ? 4
      : parseNumber(req.body.probeConcurrency, 'probeConcurrency', 1, 128)!;
    const id = await grantMonitoringProbeLocation({ agentId, name, region, probeConcurrency });
    requestMonitoringEvaluation();
    const location = (await listMonitoringProbeLocations()).find(item => item.id === id);
    await logAudit(req, 'monitoring.location_grant', {
      entityType: 'monitoring_location',
      entityId: String(id),
      newValues: { agentId, name, region, probeConcurrency, enabled: true },
    });
    res.status(201).json({ success: true, data: location });
  } catch (error) {
    if (error instanceof ProbeRequestError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    routeError(res, 'Failed to grant monitoring probe capability', error);
  }
});

router.put('/locations/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const allowed = ['name', 'region', 'enabled', 'shadow', 'probeConcurrency'];
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some(key => !allowed.includes(key))) {
      throw new MonitoringInputError('Location contains unsupported settings');
    }
    const id = parseRouteId(req);
    const current = (await listMonitoringProbeLocations()).find(location => location.id === id);
    if (!current) { res.status(404).json({ success: false, error: 'Location not found' }); return; }
    const input = {
      ...(req.body.name === undefined ? {} : { name: parseRequiredString(req.body.name, 'name') }),
      ...(req.body.region === undefined ? {} : { region: parseOptionalString(req.body.region, 'region') ?? null }),
      ...(req.body.enabled === undefined ? {} : { enabled: parseBoolean(req.body.enabled, 'enabled')! }),
      ...(req.body.shadow === undefined ? {} : { shadow: parseBoolean(req.body.shadow, 'shadow')! }),
      ...(req.body.probeConcurrency === undefined ? {} : { probeConcurrency: parseNumber(req.body.probeConcurrency, 'probeConcurrency', 1, 128)! }),
    };
    if (input.name !== undefined && input.name.length > 100) throw new MonitoringInputError('Location name exceeds 100 characters');
    if (input.region && input.region.length > 100) throw new MonitoringInputError('Region exceeds 100 characters');
    if (input.shadow === true && current.locationType === 'local') throw new MonitoringInputError('The Local location always votes and cannot be put in shadow mode');
    if (!await updateMonitoringProbeLocation(id, input)) { res.status(404).json({ success: false, error: 'Location not found' }); return; }
    requestMonitoringEvaluation();
    const location = (await listMonitoringProbeLocations()).find(item => item.id === id);
    await logAudit(req, 'monitoring.location_update', {
      entityType: 'monitoring_location',
      entityId: String(id),
      oldValues: { name: current.name, region: current.region, enabled: current.enabled, shadow: current.shadow, probeConcurrency: current.probeConcurrency },
      newValues: input,
    });
    res.json({ success: true, data: location });
  } catch (error) {
    if (error instanceof ProbeRequestError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    routeError(res, 'Failed to update monitoring location', error);
  }
});

router.delete('/locations/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseRouteId(req);
    const current = (await listMonitoringProbeLocations()).find(location => location.id === id);
    if (!current) { res.status(404).json({ success: false, error: 'Location not found' }); return; }
    if (!await updateMonitoringProbeLocation(id, { enabled: false })) { res.status(404).json({ success: false, error: 'Location not found' }); return; }
    requestMonitoringEvaluation();
    await logAudit(req, 'monitoring.location_revoke', {
      entityType: 'monitoring_location',
      entityId: String(id),
      oldValues: { enabled: current.enabled },
      newValues: { enabled: false },
    });
    res.json({ success: true });
  } catch (error) { routeError(res, 'Failed to revoke monitoring probe capability', error); }
});

router.get('/heartbeats/health', requireAdmin, async (_req: Request, res: Response) => {
  res.json({ success: true, data: await getHeartbeatHealth() });
});

router.post('/heartbeats', requireAdmin, async (req: Request, res: Response) => {
  try {
    const allowed = ['name', 'format', 'pingUrl', 'failureUrl', 'intervalSeconds', 'minimumFreshLocations', 'enabled'];
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => !allowed.includes(key))) {
      throw new MonitoringInputError('Heartbeat contains unsupported settings');
    }
    const target = await saveHeartbeatTarget(req.body);
    await logAudit(req, 'monitoring.heartbeat_create', {
      entityType: 'monitoring_heartbeat', entityId: String(target.id),
      newValues: { name: target.name, intervalSeconds: target.intervalSeconds, minimumFreshLocations: target.minimumFreshLocations, failureUrlConfigured: target.failureUrlConfigured },
    });
    res.status(201).json({ success: true, data: target });
  } catch (error) { routeError(res, 'Failed to save monitoring heartbeat', error); }
});

router.put('/heartbeats/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const allowed = ['name', 'format', 'pingUrl', 'failureUrl', 'intervalSeconds', 'minimumFreshLocations', 'enabled'];
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body) || Object.keys(req.body).some(key => !allowed.includes(key))) {
      throw new MonitoringInputError('Heartbeat contains unsupported settings');
    }
    const target = await saveHeartbeatTarget({ ...req.body, id: parseRouteId(req) });
    await logAudit(req, 'monitoring.heartbeat_update', {
      entityType: 'monitoring_heartbeat', entityId: String(target.id),
      newValues: { name: target.name, intervalSeconds: target.intervalSeconds, minimumFreshLocations: target.minimumFreshLocations, failureUrlConfigured: target.failureUrlConfigured },
    });
    res.json({ success: true, data: target });
  } catch (error) { routeError(res, 'Failed to save monitoring heartbeat', error); }
});

router.post('/heartbeats/:id/test', requireAdmin, async (req: Request, res: Response) => {
  try {
    const accepted = await sendHeartbeatTest(parseRouteId(req));
    await logAudit(req, 'monitoring.heartbeat_test', { entityType: 'monitoring_heartbeat', entityId: routeParam(req, 'id'), newValues: { accepted } });
    res.status(accepted ? 200 : 502).json({ success: accepted, data: { accepted }, ...(accepted ? {} : { error: 'Heartbeat service did not accept the test ping' }) });
  } catch (error) { routeError(res, 'Failed to send monitoring heartbeat test', error); }
});

router.delete('/heartbeats/:id', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = routeParam(req, 'id');
    if (!(await deleteHeartbeatTarget(parseNumber(id, 'id', 1, 2_147_483_647)!))) { res.status(404).json({ success: false, error: 'Heartbeat not found' }); return; }
    await logAudit(req, 'monitoring.heartbeat_delete', { entityType: 'monitoring_heartbeat', entityId: id });
    res.json({ success: true });
  } catch (error) { routeError(res, 'Failed to delete monitoring heartbeat', error); }
});

router.get('/export', requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await exportMonitoringConfiguration() });
  } catch (error) {
    routeError(res, 'Failed to export Monitoring configuration', error);
  }
});

router.post('/import', requireAdmin, async (req: Request, res: Response) => {
  try {
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)
      || Object.keys(req.body).some(key => !['configuration', 'dryRun'].includes(key))) {
      throw new MonitoringInputError('Import request must contain only configuration and dryRun');
    }
    const dryRun = req.body.dryRun === undefined ? true : req.body.dryRun;
    if (typeof dryRun !== 'boolean') throw new MonitoringInputError('dryRun must be a boolean');
    const report = await importMonitoringConfiguration(req.body.configuration, dryRun);
    if (!dryRun && !report.errors.length && !report.conflicts.length) {
      await logAudit(req, 'monitoring.config_import', {
        entityType: 'monitoring_config',
        newValues: {
          created: report.changes.filter(change => change.action === 'create').length,
          updated: report.changes.filter(change => change.action === 'update').length,
        },
      });
    }
    const status = dryRun || (!report.errors.length && !report.conflicts.length)
      ? 200 : report.conflicts.length ? 409 : 400;
    res.status(status).json({
      success: status === 200,
      ...(status === 200 ? { data: report } : { error: 'Monitoring import was not applied', data: report }),
    });
  } catch (error) {
    routeError(res, 'Failed to import Monitoring configuration', error);
  }
});

router.post('/targets', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const target = await createMonitoringTarget({
      name: parseRequiredString(req.body.name, 'name'),
      targetType: parseTargetType(req.body.targetType),
      environment: parseOptionalString(req.body.environment, 'environment') ?? 'production',
      description: parseOptionalString(req.body.description, 'description'),
      enabled: parseBoolean(req.body.enabled, 'enabled') ?? true,
    });
    res.status(201).json({ success: true, data: target });
  } catch (error) {
    routeError(res, 'Failed to create monitoring target', error);
  }
});

router.put('/targets/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(routeParam(req, 'id'));
    const target = await updateMonitoringTarget(id, {
      name: req.body.name === undefined ? undefined : parseRequiredString(req.body.name, 'name'),
      targetType: req.body.targetType === undefined ? undefined : parseTargetType(req.body.targetType),
      environment: parseOptionalString(req.body.environment, 'environment') ?? undefined,
      description: parseOptionalString(req.body.description, 'description'),
      enabled: parseBoolean(req.body.enabled, 'enabled'),
    });
    if (!target) {
      res.status(404).json({ success: false, error: 'Target not found' });
      return;
    }
    res.json({ success: true, data: target });
  } catch (error) {
    routeError(res, 'Failed to update monitoring target', error);
  }
});

router.delete('/targets/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteMonitoringTarget(Number(routeParam(req, 'id')));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Target not found' });
      return;
    }
    await logAudit(req, 'monitoring.target_delete', { entityType: 'monitoring_target', entityId: routeParam(req, 'id') });
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete monitoring target', error);
  }
});

router.post('/checks', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    validateCheckFields(req.body);
    const checkType = parseCheckType(req.body.checkType);
    const input = {
      targetId: parseNumber(req.body.targetId, 'targetId', 1, 2_147_483_647)!,
      name: parseRequiredString(req.body.name, 'name'),
      checkType,
      endpoint: parseEndpoint(req.body.endpoint, checkType),
      port: parseNullableNumber(req.body.port, 'port', 1, 65535) ?? null,
      intervalSeconds: parseNumber(req.body.intervalSeconds, 'intervalSeconds', 10, checkType === 'push' ? PUSH_INTERVAL_MAX_SECONDS : 86400),
      timeoutSeconds: parseNumber(req.body.timeoutSeconds, 'timeoutSeconds', 1, 120),
      confirmationSeconds: parseNumber(req.body.confirmationSeconds, 'confirmationSeconds', 0, 86400),
      recoverySeconds: parseNumber(req.body.recoverySeconds, 'recoverySeconds', 0, 86400),
      certExpiryDays: parseNullableNumber(req.body.certExpiryDays, 'certExpiryDays', 1, 365) ?? null,
      tlsMode: parseTlsMode(req.body.tlsMode) ?? 'strict',
      certificateErrorMode: parseCertificateErrorMode(req.body.certificateErrorMode) ?? 'down',
      allowPrivate: parseBoolean(req.body.allowPrivate, 'allowPrivate') ?? false,
      options: parseMonitoringOptions(checkType, req.body.options, parseNullableNumber(req.body.port, 'port', 1, 65535) ?? null),
      secretHeaders: req.body.secretHeaders === undefined ? undefined : validateMonitoringHeaders(req.body.secretHeaders, true),
      enabled: parseBoolean(req.body.enabled, 'enabled') ?? true,
      placementMode: parsePlacementMode(req.body.placementMode) ?? 'all',
      locationIds: parseLocationIds(req.body.locationIds) ?? [],
      quorum: parseNumber(req.body.quorum, 'quorum', 0, 128) ?? 0,
    };
    if (!input.targetId) throw new MonitoringInputError('targetId is required');
    validateMonitoringProtocol(input);
    const check = await createMonitoringCheck(input);
    requestMonitoringEvaluation();
    await logAudit(req, 'monitoring.check_create', {
      entityType: 'monitoring_check',
      entityId: String(check.id),
      newValues: {
        name: check.name,
        checkType,
        allowPrivate: input.allowPrivate,
        placementMode: check.placementMode,
        locationIds: check.locationIds,
        quorum: check.quorum,
        secretHeadersChanged: input.secretHeaders !== undefined,
      },
    });
    res.status(201).json({ success: true, data: check });
  } catch (error) {
    routeError(res, 'Failed to create monitoring check', error);
  }
});

router.put('/checks/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    validateCheckFields(req.body);
    const id = Number(routeParam(req, 'id'));
    const current = await getMonitoringCheck(id);
    if (!current) { res.status(404).json({ success: false, error: 'Check not found' }); return; }
    const checkType = req.body.checkType === undefined ? current.checkType : parseCheckType(req.body.checkType);
    const input = {
      targetId: parseNumber(req.body.targetId, 'targetId', 1, 2_147_483_647),
      name: req.body.name === undefined ? undefined : parseRequiredString(req.body.name, 'name'),
      checkType,
      endpoint: req.body.endpoint === undefined
        ? current.endpoint
        : parseEndpoint(req.body.endpoint, checkType),
      port: req.body.port === undefined ? current.port : parseNullableNumber(req.body.port, 'port', 1, 65535) ?? null,
      intervalSeconds: parseNumber(req.body.intervalSeconds, 'intervalSeconds', 10, checkType === 'push' ? PUSH_INTERVAL_MAX_SECONDS : 86400),
      timeoutSeconds: parseNumber(req.body.timeoutSeconds, 'timeoutSeconds', 1, 120),
      confirmationSeconds: parseNumber(req.body.confirmationSeconds, 'confirmationSeconds', 0, 86400),
      recoverySeconds: parseNumber(req.body.recoverySeconds, 'recoverySeconds', 0, 86400),
      certExpiryDays: req.body.certExpiryDays === undefined ? current.certExpiryDays : parseNullableNumber(req.body.certExpiryDays, 'certExpiryDays', 1, 365) ?? null,
      tlsMode: parseTlsMode(req.body.tlsMode) ?? current.tlsMode,
      certificateErrorMode: parseCertificateErrorMode(req.body.certificateErrorMode) ?? current.certificateErrorMode,
      allowPrivate: parseBoolean(req.body.allowPrivate, 'allowPrivate'),
      options: parseMonitoringOptions(checkType, req.body.options === undefined ? current.options : req.body.options,
        req.body.port === undefined ? current.port : parseNullableNumber(req.body.port, 'port', 1, 65535) ?? null),
      secretHeaders: req.body.secretHeaders === undefined ? undefined : validateMonitoringHeaders(req.body.secretHeaders, true),
      enabled: parseBoolean(req.body.enabled, 'enabled'),
      placementMode: parsePlacementMode(req.body.placementMode),
      locationIds: parseLocationIds(req.body.locationIds),
      quorum: parseNumber(req.body.quorum, 'quorum', 0, 128),
    };
    validateMonitoringProtocol(input);
    const check = await updateMonitoringCheck(id, input);
    if (!check) {
      res.status(404).json({ success: false, error: 'Check not found' });
      return;
    }
    requestMonitoringEvaluation();
    await logAudit(req, 'monitoring.check_update', {
      entityType: 'monitoring_check',
      entityId: String(id),
      newValues: {
        name: check.name,
        checkType,
        allowPrivate: input.allowPrivate,
        placementMode: check.placementMode,
        locationIds: check.locationIds,
        quorum: check.quorum,
        secretHeadersChanged: input.secretHeaders !== undefined,
      },
    });
    res.json({ success: true, data: check });
  } catch (error) {
    routeError(res, 'Failed to update monitoring check', error);
  }
});

router.get('/checks/:id/push-url', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const token = await getMonitoringCheckPushToken(parseRouteId(req));
    if (!token) { res.status(404).json({ success: false, error: 'Push check not found' }); return; }
    res.json({ success: true, data: { url: pushUrl(token) } });
  } catch (error) { routeError(res, 'Failed to load the push URL', error); }
});

router.post('/checks/:id/push-url/rotate', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseRouteId(req);
    const token = await rotateMonitoringCheckPushToken(id);
    if (!token) { res.status(404).json({ success: false, error: 'Push check not found' }); return; }
    await logAudit(req, 'monitoring.check_push_url_rotate', { entityType: 'monitoring_check', entityId: String(id) });
    res.json({ success: true, data: { url: pushUrl(token) } });
  } catch (error) { routeError(res, 'Failed to rotate the push URL', error); }
});

router.post('/checks/:id/pause', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const check = await pauseMonitoringCheck(Number(routeParam(req, 'id')), parseOptionalString(req.body.reason, 'reason') ?? null);
    if (!check) {
      res.status(404).json({ success: false, error: 'Check not found' });
      return;
    }
    res.json({ success: true, data: check });
  } catch (error) {
    routeError(res, 'Failed to pause monitoring check', error);
  }
});

router.post('/checks/:id/resume', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const check = await resumeMonitoringCheck(Number(routeParam(req, 'id')));
    if (!check) {
      res.status(404).json({ success: false, error: 'Check not found' });
      return;
    }
    res.json({ success: true, data: check });
  } catch (error) {
    routeError(res, 'Failed to resume monitoring check', error);
  }
});

router.get('/checks/:id/history', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const days = req.query.days === undefined ? 90 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 400) {
      res.status(400).json({ success: false, error: 'days must be a whole number from 1 to 400' });
      return;
    }
    res.json({ success: true, data: await getMonitoringCheckHistory(Number(routeParam(req, 'id')), days) });
  } catch (error) {
    routeError(res, 'Failed to load monitoring check history', error);
  }
});

router.get('/checks/:id/location-history', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = parseRouteId(req);
    const days = req.query.days === undefined ? 90 : Number(req.query.days);
    if (!Number.isInteger(days) || days < 1 || days > 400) throw new MonitoringInputError('days must be a whole number from 1 to 400');
    if (!await getMonitoringCheck(id)) { res.status(404).json({ success: false, error: 'Check not found' }); return; }
    res.json({ success: true, data: await getMonitoringCheckLocationHistory(id, days) });
  } catch (error) { routeError(res, 'Failed to load monitoring location history', error); }
});

router.get('/checks/:id/observations', requireAdmin, async (req: Request, res: Response) => {
  try {
    const id = Number(routeParam(req, 'id'));
    if (!Number.isInteger(id) || id < 1) throw new MonitoringInputError('Invalid check ID');
    if (!await getMonitoringCheck(id)) { res.status(404).json({ success: false, error: 'Check not found' }); return; }
    res.json({ success: true, data: await getMonitoringCheckObservations(id) });
  } catch (error) { routeError(res, 'Failed to load check observations', error); }
});

router.post('/checks/:id/run', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const observation = await runMonitoringCheckNow(Number(routeParam(req, 'id')));
    if (!observation) {
      res.status(404).json({ success: false, error: 'Check not found' });
      return;
    }
    res.json({ success: true, data: observation });
  } catch (error) {
    if (error instanceof Error && error.name === 'MonitoringCapacityError') {
      res.setHeader('Retry-After', '1');
      res.status(503).json({ success: false, error: error.message });
      return;
    }
    routeError(res, 'Failed to run monitoring check', error);
  }
});

router.post('/issues/:id/close-stale', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const issue = await closeStaleMonitoringIssue(Number(routeParam(req, 'id')));
    if (issue === 'active') {
      res.status(409).json({ success: false, error: 'Issue is still firing. Run or pause the check instead.' });
      return;
    }
    if (!issue) {
      res.status(404).json({ success: false, error: 'Issue not found' });
      return;
    }
    res.json({ success: true, data: issue });
  } catch (error) {
    routeError(res, 'Failed to close stale monitoring issue', error);
  }
});

router.delete('/issues/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteClosedMonitoringIssue(Number(routeParam(req, 'id')));
    if (deleted === 'open') {
      res.status(409).json({ success: false, error: 'Only closed issues can be deleted.' });
      return;
    }
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Issue not found' });
      return;
    }
    await logAudit(req, 'monitoring.issue_delete', { entityType: 'monitoring_issue', entityId: routeParam(req, 'id') });
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete monitoring issue', error);
  }
});

router.delete('/checks/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteMonitoringCheck(Number(routeParam(req, 'id')));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Check not found' });
      return;
    }
    await logAudit(req, 'monitoring.check_delete', { entityType: 'monitoring_check', entityId: routeParam(req, 'id') });
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete monitoring check', error);
  }
});

export default router;
