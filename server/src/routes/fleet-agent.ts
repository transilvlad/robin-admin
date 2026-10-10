import { Router, type NextFunction, type Request, type Response } from 'express';
import { getFleetServiceById, getAgentServiceResponsibilities, type FleetService } from '../db/queries/fleet-services.js';
import {
  enrollFleetAgent,
  fleetAgentCredentialMatches,
  recordFleetAgentHeartbeat,
} from '../db/queries/fleet-agents.js';
import { ingestAgentMetrics, ingestPostfixLogLines } from '../services/metrics-poller.js';
import { recordFleetServiceObservation } from '../db/queries/fleet-service-observations.js';
import { ingestAgentLogs } from '../services/service-logs.js';
import {
  appendFleetServiceSyncLog,
  getFleetServiceSyncStatus,
  upsertFleetServiceSyncStatus,
  type FleetSyncLogEventType,
} from '../db/queries/fleet-agent-sync.js';
import {
  buildManagedServiceManifest,
  etagMatches,
  getManagedServiceConfigFile,
  type FleetAgentStatusReport,
} from '../services/fleet-agent-sync.js';
import { completeAgentCommand, pollAgentCommands, requeueAgentCommands } from '../services/agent-commands.js';
import { logger } from '../logger.js';
import { routeParam } from './params.js';
import { invalidateFleetCapabilities } from '../services/service-capabilities.js';
import { operationsPolicy } from '../services/operations-settings.js';
import rateLimit from 'express-rate-limit';
import {
  getMonitoringProbeManifest,
  isProbeOnlyAgent,
  ProbeRequestError,
  recordRemoteProbeObservations,
  updateMonitoringProbeHeartbeat,
  type RemoteProbeObservation,
} from '../db/queries/monitoring-probes.js';

declare global {
  namespace Express {
    interface Request {
      fleetAgentService?: FleetService;
      fleetAgentId?: string;
    }
  }
}

const router = Router();
const probeManifestLimiter = rateLimit({
  windowMs: 60_000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.fleetAgentId ?? 'unresolved-agent',
});
const probeObservationLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.fleetAgentId ?? 'unresolved-agent',
});

// Any change to services or agents can change what the UI may show.
router.use((req, res, next) => {
  if (req.method !== 'GET') res.on('finish', invalidateFleetCapabilities);
  next();
});
const SHA256_RE = /^[a-f0-9]{64}$/i;

function getBearerToken(req: Request): string | null {
  const auth = req.headers.authorization;
  if (!auth?.startsWith('Bearer ')) {
    return null;
  }

  const token = auth.slice('Bearer '.length).trim();
  return token || null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseOptionalSha256(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string' || !SHA256_RE.test(value)) {
    throw new Error(`${fieldName} must be a 64-character sha256 hex string`);
  }
  return value.toLowerCase();
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

function parseOptionalDate(value: unknown, fieldName: string): Date | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  if (typeof value !== 'string') {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${fieldName} must be an ISO timestamp`);
  }
  return parsed;
}

function parseOptionalInteger(value: unknown, fieldName: string): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null || value === '') {
    return null;
  }
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${fieldName} must be a non-negative integer`);
  }
  return parsed;
}

function parseOptionalApplyStatus(
  value: unknown
): FleetAgentStatusReport['applyStatus'] {
  if (value === undefined) {
    return undefined;
  }
  if (value === 'pending' || value === 'succeeded' || value === 'failed' || value === 'unknown') {
    return value;
  }
  throw new Error('applyStatus must be one of unknown, pending, succeeded, or failed');
}

function parseStatusReport(body: unknown): FleetAgentStatusReport {
  if (!isRecord(body)) {
    throw new Error('Status payload must be an object');
  }

  const metadata = body.metadata;
  if (metadata !== undefined && !isRecord(metadata)) {
    throw new Error('metadata must be an object');
  }

  return {
    manifestSha256: parseOptionalSha256(body.manifestSha256, 'manifestSha256'),
    manifestEtag: parseOptionalString(body.manifestEtag, 'manifestEtag'),
    manifestFileCount: parseOptionalInteger(body.manifestFileCount, 'manifestFileCount'),
    applyStartedAt: parseOptionalDate(body.applyStartedAt, 'applyStartedAt'),
    applyFinishedAt: parseOptionalDate(body.applyFinishedAt, 'applyFinishedAt'),
    applyStatus: parseOptionalApplyStatus(body.applyStatus),
    applyError: parseOptionalString(body.applyError, 'applyError'),
    appliedSha256: parseOptionalSha256(body.appliedSha256, 'appliedSha256'),
    appliedFileCount: parseOptionalInteger(body.appliedFileCount, 'appliedFileCount'),
    agentVersion: parseOptionalString(body.agentVersion, 'agentVersion'),
    metadata: metadata as Record<string, unknown> | undefined,
  };
}

type FleetAgentAxis = 'metrics' | 'config' | 'logs';

/**
 * Builds an auth middleware scoped to ONE axis (metrics/config/logs). The
 * caller authenticates with its enrolled agent credential (bearer token plus
 * X-Robin-Agent-Id) and only satisfies the axis it's actually assigned:
 *
 *   ownsMetrics  collection_mode='agent' AND agent_id = caller
 *   ownsConfig   ownsMetrics OR config_agent_id = caller
 *   ownsLogs     ownsMetrics OR log_agent_id = caller
 *
 * A full metrics-mode agent (the common case, no separate config/log
 * override) still owns every axis. A logs-only or config-only agent — one
 * assigned via log_agent_id/config_agent_id alone, without also being the
 * service's metrics agent — owns only that axis: e.g. a logs-only agent
 * cannot fetch managed configuration (which can contain credentials), and a
 * config-only agent cannot push metrics or logs. Each route below requires
 * exactly the axis it needs, rather than one shared "any axis" gate.
 */
function requireFleetAgentAuth(requiredAxis: FleetAgentAxis) {
  return async function fleetAgentAuth(req: Request, res: Response, next: NextFunction): Promise<void> {
    try {
      const serviceId = routeParam(req, 'serviceId');
      const token = getBearerToken(req);

      if (!token) {
        res.status(401).json({ success: false, error: 'Fleet agent bearer token required' });
        return;
      }

      const service = await getFleetServiceById(serviceId);
      if (!service) {
        res.status(404).json({ success: false, error: 'Service not found' });
        return;
      }

      const headerId = req.headers['x-robin-agent-id'];
      const agentId = typeof headerId === 'string' ? headerId.trim() : '';
      const ownsMetrics = service.collectionMode === 'agent' && service.agentId === agentId;
      const ownsAxis: Record<FleetAgentAxis, boolean> = {
        metrics: ownsMetrics,
        config: ownsMetrics || service.configAgentId === agentId,
        logs: ownsMetrics || service.logAgentId === agentId,
      };
      const valid = Boolean(agentId) && ownsAxis[requiredAxis] && await fleetAgentCredentialMatches(agentId, token);
      if (!valid) {
        res.status(401).json({ success: false, error: 'Invalid fleet agent token' });
        return;
      }

      req.fleetAgentId = agentId;
      req.fleetAgentService = service;
      req.apiKeyAuthError = undefined;
      next();
    } catch (error) {
      next(error);
    }
  };
}

const requireFleetAgentConfigAuth = requireFleetAgentAuth('config');
const requireFleetAgentMetricsAuth = requireFleetAgentAuth('metrics');
const requireFleetAgentLogsAuth = requireFleetAgentAuth('logs');
async function rejectProbeOnlyCommandAgent(req: Request, res: Response): Promise<boolean> {
  if (!await isProbeOnlyAgent(req.fleetAgentId!)) return false;
  res.status(403).json({ success: false, error: 'Probe-only agents cannot use the command channel' });
  return true;
}

// ── Agent enrollment + check-in ─────────────────────────────────────────────
// POST /api/fleet/agent/enroll — an agent exchanges its one-time enrollment
// token for a long-lived credential. No session; auth is the enrollment token.
router.post('/enroll', async (req: Request, res: Response) => {
  try {
    const body = req.body;
    if (!isRecord(body) || typeof body.agentId !== 'string' || typeof body.enrollmentToken !== 'string') {
      res.status(400).json({ success: false, error: 'agentId and enrollmentToken are required' });
      return;
    }

    const result = await enrollFleetAgent({
      agentId: body.agentId,
      enrollmentToken: body.enrollmentToken,
      hostname: typeof body.hostname === 'string' ? body.hostname : null,
      os: typeof body.os === 'string' ? body.os : null,
      arch: typeof body.arch === 'string' ? body.arch : null,
      agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion : null,
      discovered: body.discovered,
    });

    if (!result.ok) {
      res.status(result.reason === 'not_found' ? 404 : 401).json({ success: false, error: `Enrollment ${result.reason}` });
      return;
    }

    res.json({ success: true, data: { agentId: result.agentId, credential: result.credential, heartbeatIntervalSecs: 30 } });
  } catch (error) {
    logger.error('Fleet agent enrollment failed', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Enrollment failed' });
  }
});

// Bearer <agent_credential> + X-Robin-Agent-Id (or body.agentId) authenticates
// an enrolled agent's channel calls (heartbeat today; telemetry/commands later).
async function requireFleetAgentCredential(req: Request, res: Response, next: NextFunction): Promise<void> {
  try {
    const headerId = req.headers['x-robin-agent-id'];
    const agentId = (typeof headerId === 'string' && headerId.trim())
      || (isRecord(req.body) && typeof req.body.agentId === 'string' ? req.body.agentId : '');
    const token = getBearerToken(req);
    if (!agentId || !token) {
      res.status(401).json({ success: false, error: 'Agent credential required' });
      return;
    }
    if (!(await fleetAgentCredentialMatches(agentId, token))) {
      res.status(401).json({ success: false, error: 'Invalid agent credential' });
      return;
    }
    req.fleetAgentId = agentId;
    next();
  } catch (error) {
    next(error);
  }
}

// POST /api/fleet/agent/heartbeat — periodic liveness + discovery refresh.
router.post('/heartbeat', requireFleetAgentCredential, async (req: Request, res: Response) => {
  try {
    const body = isRecord(req.body) ? req.body : {};
    const agent = await recordFleetAgentHeartbeat(req.fleetAgentId!, {
      agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion : null,
      hostname: typeof body.hostname === 'string' ? body.hostname : null,
      os: typeof body.os === 'string' ? body.os : null,
      arch: typeof body.arch === 'string' ? body.arch : null,
      discovered: body.discovered,
      services: body.services,
    });
    const clientTime = typeof body.clientTime === 'string' && !Number.isNaN(Date.parse(body.clientTime))
      ? new Date(body.clientTime)
      : null;
    const probeProtocolVersion = body.probeProtocolVersion === 1 ? 1 : null;
    const probeEnabled = await updateMonitoringProbeHeartbeat({
      agentId: req.fleetAgentId!,
      agentVersion: typeof body.agentVersion === 'string' ? body.agentVersion : null,
      protocolVersion: probeProtocolVersion,
      clientTime,
    });
    res.json({ success: true, data: { heartbeatIntervalSecs: 30, agentStatus: agent?.status ?? 'online', probeEnabled } });
  } catch (error) {
    logger.error('Fleet agent heartbeat failed', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Heartbeat failed' });
  }
});

// GET /api/fleet/agent/probes/manifest — scoped to the probe capability grant.
router.get('/probes/manifest', requireFleetAgentCredential, probeManifestLimiter, async (req: Request, res: Response) => {
  try {
    const { manifest, etag } = await getMonitoringProbeManifest(req.fleetAgentId!);
    const ifNoneMatch = req.headers['if-none-match'];
    res.setHeader('ETag', etag);
    res.setHeader('Cache-Control', 'private, no-cache, no-store');
    if (typeof ifNoneMatch === 'string' && ifNoneMatch.split(',').some(value => value.trim() === etag || value.trim() === '*')) {
      res.status(304).end();
      return;
    }
    const payload = JSON.stringify({ success: true, data: manifest });
    if (Buffer.byteLength(payload) > 5 * 1024 * 1024) {
      res.status(413).json({ success: false, error: 'Probe manifest exceeds the response size limit' });
      return;
    }
    res.type('application/json').send(payload);
  } catch (error) {
    if (error instanceof ProbeRequestError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    logger.error('Failed to build remote probe manifest', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to build probe manifest' });
  }
});

function parseRemoteProbeObservations(value: unknown): RemoteProbeObservation[] {
  if (!isRecord(value) || Object.keys(value).some(key => key !== 'observations')
    || !Array.isArray(value.observations) || value.observations.length < 1 || value.observations.length > 100) {
    throw new ProbeRequestError('Request must contain between 1 and 100 observations', 400);
  }
  if (Buffer.byteLength(JSON.stringify(value)) > 1024 * 1024) {
    throw new ProbeRequestError('Observation batch exceeds the size limit', 400);
  }
  return value.observations.map((item): RemoteProbeObservation => {
    const allowed = ['checkId', 'manifestRevision', 'startedAt', 'finishedAt', 'status', 'errorCode', 'warning', 'responseTimeMs', 'dnsTimeMs', 'details'];
    if (!isRecord(item) || Object.keys(item).some(key => !allowed.includes(key))
      || !Number.isInteger(item.checkId) || Number(item.checkId) < 1
      || !Number.isInteger(item.manifestRevision) || Number(item.manifestRevision) < 1
      || typeof item.startedAt !== 'string' || Number.isNaN(Date.parse(item.startedAt))
      || typeof item.finishedAt !== 'string' || Number.isNaN(Date.parse(item.finishedAt))
      || !['up', 'down', 'warning'].includes(String(item.status))
      || !Number.isInteger(item.responseTimeMs) || Number(item.responseTimeMs) < 0 || Number(item.responseTimeMs) > 120_000
      || !Number.isInteger(item.dnsTimeMs) || Number(item.dnsTimeMs) < 0 || Number(item.dnsTimeMs) > 120_000
      || !isRecord(item.details) || Object.keys(item.details).length > 32
      || Buffer.byteLength(JSON.stringify(item.details)) > 8192) {
      throw new ProbeRequestError('Observation payload is invalid or exceeds limits', 400);
    }
    if (item.errorCode !== undefined && item.errorCode !== null && item.errorCode !== ''
      && (typeof item.errorCode !== 'string' || item.errorCode.length > 64 || !/^[a-z][a-z0-9_]*(?::[0-9]+)?$/.test(item.errorCode))) {
      throw new ProbeRequestError('Observation errorCode is invalid', 400);
    }
    if (item.warning !== undefined && item.warning !== null
      && (typeof item.warning !== 'string' || item.warning.length > 500)) {
      throw new ProbeRequestError('Observation warning is invalid', 400);
    }
    return {
      checkId: Number(item.checkId),
      manifestRevision: Number(item.manifestRevision),
      startedAt: new Date(item.startedAt),
      finishedAt: new Date(item.finishedAt),
      status: item.status as RemoteProbeObservation['status'],
      errorCode: typeof item.errorCode === 'string' && item.errorCode ? item.errorCode : null,
      warning: typeof item.warning === 'string' ? item.warning : null,
      responseTimeMs: Number(item.responseTimeMs),
      dnsTimeMs: Number(item.dnsTimeMs),
      details: item.details,
    };
  });
}

// POST /api/fleet/agent/probes/observations — history-only shadow-mode ingest.
router.post('/probes/observations', requireFleetAgentCredential, probeObservationLimiter, async (req: Request, res: Response) => {
  try {
    const observations = parseRemoteProbeObservations(req.body);
    const result = await recordRemoteProbeObservations(req.fleetAgentId!, observations);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof ProbeRequestError) {
      res.status(error.status).json({ success: false, error: error.message });
      return;
    }
    logger.error('Failed to ingest remote probe observations', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to ingest observations' });
  }
});

// GET /api/fleet/agent/services — the services this agent is responsible for,
// each with per-axis capability flags: metrics/config (collection_mode='agent',
// agent_id = caller) and/or logs (its metrics agent, or an explicit log agent).
router.get('/services', requireFleetAgentCredential, async (req: Request, res: Response) => {
  try {
    const services = await getAgentServiceResponsibilities(req.fleetAgentId!);
    res.json({
      success: true,
      data: services.map((s) => ({
        serviceId: s.serviceId,
        serviceType: s.serviceType,
        name: s.name,
        enabled: s.enabled,
        collectMetrics: s.collectMetrics,
        collectConfig: s.collectConfig,
        collectLogs: s.collectLogs,
      })),
    });
  } catch (error) {
    logger.error('Fleet agent service list failed', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list agent services' });
  }
});

// GET /api/fleet/agent/commands?actions=a,b&ack=id1,id2 — the agent's command
// long-poll. It advertises the actions it can run, confirms the commands its
// previous poll returned, and waits up to ~25s for work.
const MAX_ACKED_COMMANDS = 200;
const csvQuery = (value: unknown) => (typeof value === 'string' ? value.split(',').map((a) => a.trim()).filter(Boolean) : []);
router.get('/commands', requireFleetAgentCredential, async (req: Request, res: Response) => {
  if (await rejectProbeOnlyCommandAgent(req, res)) return;
  const actions = csvQuery(req.query.actions);
  const acked = csvQuery(req.query.ack).slice(0, MAX_ACKED_COMMANDS);
  const poll = pollAgentCommands(req.fleetAgentId!, actions, operationsPolicy().fleetCommandPollWaitMs, acked);
  res.on('close', poll.cancel);
  const commands = await poll.commands;
  if (res.destroyed || res.writableEnded) {
    await requeueAgentCommands(req.fleetAgentId!, commands);
    return;
  }
  res.json({ success: true, data: commands });
});

// POST /api/fleet/agent/commands/:commandId/result — the agent's command output.
router.post('/commands/:commandId/result', requireFleetAgentCredential, async (req: Request, res: Response) => {
  if (await rejectProbeOnlyCommandAgent(req, res)) return;
  const body = isRecord(req.body) ? req.body : {};
  const accepted = await completeAgentCommand(req.fleetAgentId!, routeParam(req, 'commandId'), {
    ok: body.ok === true,
    output: typeof body.output === 'string' ? body.output : undefined,
    error: typeof body.error === 'string' ? body.error : undefined,
  });
  res.status(accepted ? 200 : 404).json({ success: accepted });
});

router.get('/services/:serviceId/manifest', requireFleetAgentConfigAuth, async (req: Request, res: Response) => {
  const serviceId = routeParam(req, 'serviceId');

  try {
    const manifest = await buildManagedServiceManifest(serviceId);
    if (!manifest) {
      res.status(404).json({ success: false, error: 'Service not found' });
      return;
    }

    const now = new Date();
    const prior = await getFleetServiceSyncStatus(serviceId);
    await upsertFleetServiceSyncStatus(serviceId, {
      manifestSha256: manifest.sha256,
      manifestEtag: manifest.etag,
      manifestFileCount: manifest.files.length,
      lastSeenAt: now,
      lastManifestPulledAt: now,
    });
    // Only log a real manifest change (not every poll) to keep the audit useful.
    if (prior?.manifestSha256 !== manifest.sha256) {
      await appendFleetServiceSyncLog({
        serviceId,
        eventType: 'manifest_pulled',
        manifestSha256: manifest.sha256,
        fileCount: manifest.files.length,
        message: prior?.manifestSha256
          ? 'Config changed; new manifest served to agent'
          : 'Initial manifest served to agent',
      });
    }

    res.setHeader('ETag', manifest.etag);
    res.setHeader('Cache-Control', 'no-cache');

    if (etagMatches(req.headers['if-none-match'], manifest.etag)) {
      res.status(304).end();
      return;
    }

    res.json({
      success: true,
      data: manifest,
    });
  } catch (error) {
    logger.error('Failed to build fleet agent manifest', {
      serviceId,
      error: (error as Error).message,
    });
    res.status(500).json({ success: false, error: 'Failed to build manifest' });
  }
});

// A wildcard, not `:fileName`: files in subdirectories (dkim/…, maps/…) arrive
// with a decoded slash when nginx proxies with a URI part.
router.get('/services/:serviceId/files/*fileName', requireFleetAgentConfigAuth, async (req: Request, res: Response) => {
  const serviceId = routeParam(req, 'serviceId');
  const segments = req.params.fileName as unknown;
  const fileName = Array.isArray(segments) ? segments.join('/') : String(segments ?? '');

  try {
    const file = await getManagedServiceConfigFile(serviceId, fileName);
    if (!file) {
      res.status(404).json({ success: false, error: 'Managed config file not found' });
      return;
    }

    const requestedSha256 = parseOptionalSha256(req.query.sha256, 'sha256');
    const now = new Date();
    await upsertFleetServiceSyncStatus(serviceId, {
      lastSeenAt: now,
      lastFilePulledAt: now,
    });

    res.setHeader('ETag', file.etag);
    res.setHeader('Cache-Control', 'no-cache');

    if (requestedSha256 === file.sha256 || etagMatches(req.headers['if-none-match'], file.etag)) {
      res.status(304).end();
      return;
    }

    res.json({
      success: true,
      data: file,
    });
  } catch (error) {
    const message = (error as Error).message;
    if (message.includes('sha256')) {
      res.status(400).json({ success: false, error: message });
      return;
    }

    logger.error('Failed to fetch fleet agent config file', {
      serviceId,
      fileName,
      error: message,
    });
    res.status(500).json({ success: false, error: 'Failed to fetch config file' });
  }
});

router.post('/services/:serviceId/status', requireFleetAgentConfigAuth, async (req: Request, res: Response) => {
  const serviceId = routeParam(req, 'serviceId');

  try {
    const statusReport = parseStatusReport(req.body);
    if (statusReport.applyStatus && statusReport.applyStatus !== 'unknown') {
      const eventByStatus: Record<'pending' | 'succeeded' | 'failed', FleetSyncLogEventType> = {
        pending: 'apply_started',
        succeeded: 'apply_succeeded',
        failed: 'apply_failed',
      };
      await appendFleetServiceSyncLog({
        serviceId,
        eventType: eventByStatus[statusReport.applyStatus],
        applyStatus: statusReport.applyStatus,
        manifestSha256: statusReport.manifestSha256 ?? undefined,
        appliedSha256: statusReport.appliedSha256 ?? undefined,
        fileCount: statusReport.appliedFileCount ?? statusReport.manifestFileCount ?? undefined,
        agentVersion: statusReport.agentVersion ?? undefined,
        message: statusReport.applyError ?? undefined,
      });
    }
    const status = await upsertFleetServiceSyncStatus(serviceId, {
      manifestSha256: statusReport.manifestSha256,
      manifestEtag: statusReport.manifestEtag,
      manifestFileCount: statusReport.manifestFileCount,
      lastSeenAt: new Date(),
      lastApplyStartedAt: statusReport.applyStartedAt,
      lastApplyFinishedAt: statusReport.applyFinishedAt,
      lastApplyStatus: statusReport.applyStatus,
      // A success clears the previous failure's error even when the agent omits it.
      lastApplyError: statusReport.applyStatus === 'succeeded' ? statusReport.applyError ?? null : statusReport.applyError,
      lastAppliedSha256: statusReport.appliedSha256,
      lastAppliedFileCount: statusReport.appliedFileCount,
      agentVersion: statusReport.agentVersion,
      metadataJson: statusReport.metadata,
    });

    res.json({
      success: true,
      data: status,
    });
  } catch (error) {
    const message = (error as Error).message;
    if (
      message.includes('must be')
      || message.includes('Status payload')
      || message.includes('metadata')
    ) {
      res.status(400).json({ success: false, error: message });
      return;
    }

    logger.error('Failed to update fleet agent sync status', {
      serviceId,
      error: message,
    });
    res.status(500).json({ success: false, error: 'Failed to update sync status' });
  }
});

// POST /api/fleet/agent/services/:serviceId/metrics — a co-located agent pushes
// raw collector output for a service it owns; robin-admin parses + stores it.
router.post('/services/:serviceId/metrics', requireFleetAgentMetricsAuth, async (req: Request, res: Response) => {
  const service = req.fleetAgentService!;
  try {
    const body = isRecord(req.body) ? req.body : {};
    if (typeof body.reachable !== 'boolean') {
      return res.status(400).json({ success: false, error: 'reachable must be boolean' });
    }
    if (!body.reachable) {
      const errorCode = typeof body.errorCode === 'string'
        && ['collection_failed', 'collector_unavailable', 'empty_metrics'].includes(body.errorCode)
        ? body.errorCode
        : 'collection_failed';
      await recordFleetServiceObservation({
        fleetServiceId: service.id,
        reachable: false,
        errorCode,
      });
      return res.json({ success: true, data: { stored: true, reachable: false } });
    }
    const snapshot = await ingestAgentMetrics(
      { id: service.id, serviceId: service.serviceId, serviceType: service.serviceType },
      {
        statsDump: typeof body.statsDump === 'string' ? body.statsDump : undefined,
        who: typeof body.who === 'string' ? body.who : undefined,
        postqueue: typeof body.postqueue === 'string' ? body.postqueue : undefined,
        info: typeof body.info === 'string' ? body.info : undefined,
        version: typeof body.version === 'string' ? body.version : undefined,
        stats: typeof body.stats === 'string' ? body.stats : undefined,
        metrics: typeof body.metrics === 'string' ? body.metrics : undefined,
        stat: typeof body.stat === 'string' ? body.stat : undefined,
        prometheus: typeof body.prometheus === 'string' ? body.prometheus : undefined,
        snapshot: typeof body.snapshot === 'string' ? body.snapshot : undefined,
      }
    );
    await recordFleetServiceObservation({
      fleetServiceId: service.id,
      reachable: true,
      observedAt: snapshot.timestamp,
    });
    res.json({ success: true, data: { stored: true, timestamp: snapshot.timestamp } });
  } catch (error) {
    await recordFleetServiceObservation({
      fleetServiceId: service.id,
      reachable: false,
      errorCode: 'invalid_metrics',
    });
    const message = (error as Error).message;
    if (message.includes('required') || message.includes('not yet supported')) {
      res.status(400).json({ success: false, error: message });
      return;
    }
    logger.error('Fleet agent metrics ingest failed', { serviceId: routeParam(req, 'serviceId'), error: message });
    res.status(500).json({ success: false, error: 'Metrics ingest failed' });
  }
});

// POST /api/fleet/agent/services/:serviceId/logs — an agent pushes the log lines
// it read (journald/file/container) for a service it owns: its recent tail with
// reset=true after (re)start, then only new lines. robin-admin keeps a rolling
// buffer for the Logs page and derives Postfix message counters from new lines.
router.post('/services/:serviceId/logs', requireFleetAgentLogsAuth, async (req: Request, res: Response) => {
  try {
    const service = req.fleetAgentService!;
    const body = isRecord(req.body) ? req.body : {};
    const source = typeof body.source === 'string' && body.source.trim() ? body.source.trim() : 'agent';
    if (!Array.isArray(body.lines)) {
      res.status(400).json({ success: false, error: 'lines[] is required' });
      return;
    }
    const lines = body.lines.filter((l): l is string => typeof l === 'string');
    // A reset batch is the agent's recent tail after (re)start — already
    // counted or predating it — so only incremental batches feed counters.
    const reset = body.reset !== false;
    const stored = await ingestAgentLogs(service.serviceId, source, lines, reset);
    if (!reset && service.serviceType === 'postfix') {
      await ingestPostfixLogLines(service.id, lines);
    }
    res.json({ success: true, data: { stored } });
  } catch (error) {
    logger.error('Fleet agent logs ingest failed', { serviceId: routeParam(req, 'serviceId'), error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Logs ingest failed' });
  }
});

export default router;
