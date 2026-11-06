import { Router, type Request, type Response } from 'express';
import { getCurrentAdmin, requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import { logAudit, AuditActions } from '../middleware/audit.js';
import { hasApiKeyScope } from '../middleware/security.js';
import { config } from '../config.js';
import { getServiceLogs } from '../services/service-logs.js';
import { parseServiceType } from '../services/service-types.js';
import { logger } from '../logger.js';
import { getConfig } from '../db/queries/config.js';
import {
  createLogsAlertRule,
  createLogsSavedSearch,
  deleteLogsSavedSearch,
  listLogsAlertRules,
  listLogsSavedSearches,
  LogsCapacityError,
  updateLogsAlertRule,
  updateLogsSavedSearch,
} from '../db/queries/logs.js';
import {
  discardRejectedLogsBatch,
  getRejectedLogsBatch,
  listRejectedLogsBatches,
  retryRejectedLogsBatch,
} from '../db/queries/logs-spool.js';
import { deleteLogsAlertRuleWithRecovery, previewLogsAlertRule } from '../services/alerts/logs-rules.js';
import { LOGS_ALERT_COMPARATORS, LOGS_RANGE_PRESETS, type LogsAlertRuleInput, type LogsSavedSearchInput, type LogsSearchFilters } from '../types/logs.js';
import { countLogs, getLogsSources, getLogsStoreStatus, ingestExternalLogs, LogsBatchTooLargeError, LogsQueryError, LogsStoreUnavailableError, MAX_QUERY_LENGTH, searchLogs, validateUserQuery } from '../services/logs-store.js';
import {
  LogsIngestBodyTooLargeError,
  LogsIngestPayloadError,
  MAX_INGEST_BODY_BYTES,
  normalizeHttpLogs,
  normalizeSentryWebhook,
  verifySentrySignature,
} from '../services/logs-ingestion.js';

const router = Router();

class LogsIngestBodyTimeoutError extends Error {}
class LogsRequestError extends Error {}

function requiredString(value: unknown, field: string, maximum: number): string {
  if (typeof value !== 'string' || value.trim() === '') throw new LogsRequestError(`${field} is required`);
  const result = value.trim();
  if (result.length > maximum) throw new LogsRequestError(`${field} must be ${maximum} characters or fewer`);
  return result;
}

function optionalString(value: unknown, field: string, maximum: number): string {
  if (value === undefined) return '';
  if (typeof value !== 'string') throw new LogsRequestError(`${field} must be a string`);
  const result = value.trim();
  if (result.length > maximum) throw new LogsRequestError(`${field} must be ${maximum} characters or fewer`);
  return result;
}

function readLimitedBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(new LogsIngestBodyTimeoutError());
      req.resume();
    }, 15_000);
    timeout.unref?.();
    req.on('data', (chunk: Buffer) => {
      if (settled) return;
      size += chunk.length;
      if (size > limit) {
        settled = true;
        clearTimeout(timeout);
        chunks.length = 0;
        reject(new LogsIngestBodyTooLargeError());
        req.resume();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve(Buffer.concat(chunks, size));
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
  });
}

async function checkLogsEnabled(res: Response): Promise<boolean> {
  if ((await getConfig()).logsEnabled) return true;
  res.status(403).json({ success: false, error: 'Logs are disabled. Enable Logs under Administration -> Logs.' });
  return false;
}

async function ingestBodyLimit(): Promise<number> {
  const value = (await getConfig()).logsIngestBodyLimitBytes;
  return Number.isInteger(value) && value > 0 ? value : MAX_INGEST_BODY_BYTES;
}

// Generic HTTP/JSON intake uses the existing API-key manager and a write-only
// scope. Raw bytes are parsed here only after authentication and size checks.
router.post('/ingest', async (req: Request, res: Response) => {
  if (!req.apiKey) {
    return res.status(401).json({ success: false, error: req.apiKeyAuthError ?? 'Logs ingest requires an API key' });
  }
  if (!hasApiKeyScope(req, 'logs:write')) {
    return res.status(403).json({ success: false, error: 'API key scope required: logs:write' });
  }
  try {
    if (!(await checkLogsEnabled(res))) return;
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      return res.status(415).json({ success: false, error: 'Compressed Logs payloads are not supported' });
    }
    const bodyLimit = await ingestBodyLimit();
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
      req.resume();
      return res.status(413).json({ success: false, error: 'Logs payload exceeds the ingestion size limit' });
    }
    const idempotencyKey = req.headers['idempotency-key'];
    if (idempotencyKey !== undefined && (typeof idempotencyKey !== 'string' || !/^[\x21-\x7e]{1,128}$/.test(idempotencyKey))) {
      return res.status(400).json({ success: false, error: 'Idempotency-Key must be 1 to 128 visible ASCII characters' });
    }
    const body = await readLimitedBody(req, bodyLimit);
    const entries = normalizeHttpLogs(body, req.headers['content-type'], req.apiKey.name, bodyLimit);
    // Keys are scoped to the API key so senders cannot collide with each other.
    await ingestExternalLogs(entries, { origin: 'http', idempotencyKey: idempotencyKey ? `${req.apiKey.id}:${idempotencyKey}` : null });
    res.status(204).end();
  } catch (error) {
    if (error instanceof LogsIngestBodyTooLargeError) {
      return res.status(413).set('Connection', 'close').json({ success: false, error: error.message || 'Logs payload exceeds the ingestion size limit' });
    }
    if (error instanceof LogsIngestBodyTimeoutError) {
      return res.status(408).json({ success: false, error: 'Logs request body timed out' });
    }
    if (error instanceof LogsIngestPayloadError || error instanceof LogsQueryError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (error instanceof LogsBatchTooLargeError) {
      return res.status(413).json({ success: false, error: error.message });
    }
    if (error instanceof LogsStoreUnavailableError) {
      return res.status(503).set('Retry-After', '5').json({ success: false, error: error.message });
    }
    logger.error('External Logs request failed', { error: (error as Error).message });
    return res.status(500).json({ success: false, error: 'Logs ingestion failed' });
  }
});

// Sentry's integration webhook signs the exact request bytes with HMAC-SHA256.
// The client secret is deployment-managed and never returned by the API.
router.post('/sentry', async (req: Request, res: Response) => {
  try {
    const secret = config.logs.sentryClientSecret;
    if (!secret) return res.status(503).json({ success: false, error: 'Sentry Logs webhook is not configured' });
    if (!(await checkLogsEnabled(res))) return;
    if (req.headers['content-encoding'] && req.headers['content-encoding'] !== 'identity') {
      return res.status(415).json({ success: false, error: 'Compressed Sentry webhook payloads are not supported' });
    }
    const bodyLimit = await ingestBodyLimit();
    const declaredLength = Number(req.headers['content-length']);
    if (Number.isFinite(declaredLength) && declaredLength > bodyLimit) {
      req.resume();
      return res.status(413).json({ success: false, error: 'Sentry webhook payload exceeds the ingestion size limit' });
    }
    const body = await readLimitedBody(req, bodyLimit);
    const signature = req.headers['sentry-hook-signature'];
    if (!verifySentrySignature(body, typeof signature === 'string' ? signature : undefined, secret)) {
      return res.status(401).json({ success: false, error: 'Invalid Sentry webhook signature' });
    }
    const requestId = req.headers['request-id'];
    const resource = req.headers['sentry-hook-resource'];
    const entry = normalizeSentryWebhook(
      body,
      typeof requestId === 'string' ? requestId : undefined,
      typeof resource === 'string' ? resource : undefined,
    );
    await ingestExternalLogs([entry], {
      origin: 'sentry',
      idempotencyKey: typeof requestId === 'string' && requestId ? requestId.slice(0, 200) : null,
    });
    res.status(204).end();
  } catch (error) {
    if (error instanceof LogsIngestBodyTooLargeError) {
      return res.status(413).set('Connection', 'close').json({ success: false, error: 'Sentry webhook payload exceeds the ingestion size limit' });
    }
    if (error instanceof LogsIngestBodyTimeoutError) {
      return res.status(408).json({ success: false, error: 'Sentry webhook request body timed out' });
    }
    if (error instanceof LogsIngestPayloadError) {
      return res.status(400).json({ success: false, error: error.message });
    }
    if (error instanceof LogsBatchTooLargeError) {
      return res.status(413).json({ success: false, error: error.message });
    }
    if (error instanceof LogsStoreUnavailableError) {
      return res.status(503).set('Retry-After', '5').json({ success: false, error: error.message });
    }
    logger.error('Sentry Logs webhook failed', { error: (error as Error).message });
    return res.status(500).json({ success: false, error: 'Sentry Logs webhook failed' });
  }
});

router.use(requireAuth);
router.use(requireAdmin);

// GET /api/logs?serviceType=<type>&serviceId=<id>&lines=<n>
// Returns recent log lines for a co-located fleet service.
router.get('/', async (req: Request, res: Response) => {
  try {
    const serviceType = parseServiceType(req.query.serviceType);
    if (!serviceType) {
      return res.status(400).json({ success: false, error: 'serviceType is required' });
    }
    const serviceId = typeof req.query.serviceId === 'string' ? req.query.serviceId.trim() : '';
    if (!serviceId) {
      return res.status(400).json({ success: false, error: 'serviceId is required' });
    }
    const lines = Number.parseInt(String(req.query.lines ?? ''), 10);

    const result = await getServiceLogs(serviceType, serviceId, lines);
    res.json({ success: true, data: result });
  } catch (error) {
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({ success: false, error: (error as Error).message });
    }
    logger.error('Failed to read service logs', { error: (error as Error).message });
    res.status(400).json({
      success: false,
      error: error instanceof Error ? error.message : 'Failed to read service logs',
    });
  }
});

function listParam(value: unknown, splitCommas = true): string[] {
  const raw = Array.isArray(value) ? value : value === undefined ? [] : [value];
  return raw
    .flatMap((v) => (typeof v === 'string' ? (splitCommas ? v.split(',') : [v]) : []))
    .map((v) => v.trim())
    .filter(Boolean);
}

function dateParam(value: unknown, fallback: Date): Date {
  if (typeof value !== 'string' || !value.trim()) return fallback;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? new Date(numeric) : new Date(value);
}

function positiveId(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (!/^[1-9]\d*$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseSavedSearchInput(value: unknown): LogsSavedSearchInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LogsRequestError('Request body must be an object');
  const body = value as Record<string, unknown>;
  const name = requiredString(body.name, 'name', 120);
  const description = body.description === undefined || body.description === null || body.description === ''
    ? null
    : requiredString(body.description, 'description', 500);
  if (!body.filters || typeof body.filters !== 'object' || Array.isArray(body.filters)) {
    throw new LogsRequestError('filters must be an object');
  }
  const rawFilters = body.filters as Record<string, unknown>;
  const query = validateUserQuery(optionalString(rawFilters.query, 'filters.query', MAX_QUERY_LENGTH));
  const serviceId = optionalString(rawFilters.serviceId, 'filters.serviceId', 200);
  const sourceName = optionalString(rawFilters.sourceName, 'filters.sourceName', 120);
  const rangePreset = rawFilters.rangePreset;
  if (typeof rangePreset !== 'string' || !(LOGS_RANGE_PRESETS as readonly string[]).includes(rangePreset)) {
    throw new LogsRequestError('rangePreset is invalid');
  }
  const filters: LogsSearchFilters = { query, serviceId, sourceName, rangePreset: rangePreset as LogsSearchFilters['rangePreset'] };
  return { name, description, filters };
}

function parseLogsAlertInput(value: unknown): LogsAlertRuleInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new LogsRequestError('Request body must be an object');
  const body = value as Record<string, unknown>;
  const query = validateUserQuery(optionalString(body.query, 'query', MAX_QUERY_LENGTH));
  const comparator = body.comparator;
  if (typeof comparator !== 'string' || !(LOGS_ALERT_COMPARATORS as readonly string[]).includes(comparator)) {
    throw new LogsRequestError('comparator is invalid');
  }
  const windowSeconds = body.windowSeconds;
  if (typeof windowSeconds !== 'number' || !Number.isInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 86400) {
    throw new LogsRequestError('windowSeconds must be between 60 and 86400');
  }
  const forSeconds = body.forSeconds;
  if (typeof forSeconds !== 'number' || !Number.isInteger(forSeconds) || forSeconds < 60 || forSeconds > 86400) {
    throw new LogsRequestError('forSeconds must be between 60 and 86400');
  }
  const threshold = body.threshold;
  if (typeof threshold !== 'number' || !Number.isFinite(threshold) || threshold < 0 || threshold > 1_000_000_000) {
    throw new LogsRequestError('threshold must be between 0 and 1000000000');
  }
  if (body.enabled !== undefined && typeof body.enabled !== 'boolean') throw new LogsRequestError('enabled must be a boolean');
  return {
    name: requiredString(body.name, 'name', 120),
    description: body.description === undefined || body.description === null || body.description === ''
      ? null
      : requiredString(body.description, 'description', 500),
    query,
    windowSeconds,
    comparator: comparator as LogsAlertRuleInput['comparator'],
    threshold,
    forSeconds,
    enabled: body.enabled !== false,
  };
}

// GET /api/logs/configuration — deployment-managed Logs settings (no secrets).
router.get('/configuration', async (_req: Request, res: Response) => {
  try {
    const settings = await getConfig();
    res.json({
      success: true,
      data: {
        enabled: settings.logsEnabled,
        storeUrl: config.logs.storeUrl,
        retentionDays: config.logs.retentionDays,
        maxDiskBytes: config.logs.maxDiskBytes,
        sentryWebhookConfigured: Boolean(config.logs.sentryClientSecret),
        endpoints: { ingest: '/api/logs/ingest', sentry: '/api/logs/sentry' },
      },
    });
  } catch (error) {
    logger.error('Failed to read Logs configuration', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to read Logs configuration' });
  }
});

// GET /api/logs/status — Logs store reachability and write-queue counters.
router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getLogsStoreStatus() });
  } catch (error) {
    logger.error('Failed to read logs store status', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to read logs store status' });
  }
});

router.get('/quarantine', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listRejectedLogsBatches() });
  } catch (error) {
    logger.error('Failed to list quarantined Logs batches', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list quarantined Logs batches' });
  }
});

router.get('/quarantine/:id', async (req: Request, res: Response) => {
  const parsedId = positiveId(req.params.id);
  if (!parsedId) return res.status(400).json({ success: false, error: 'Invalid quarantine batch id' });
  const id = String(parsedId);
  try {
    const entries = await getRejectedLogsBatch(id);
    if (!entries) return res.status(404).json({ success: false, error: 'Quarantined Logs batch not found' });
    res.json({ success: true, data: entries });
  } catch (error) {
    logger.error('Failed to read quarantined Logs batch', { id, error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to read quarantined Logs batch' });
  }
});

router.post('/quarantine/:id/retry', async (req: Request, res: Response) => {
  const parsedId = positiveId(req.params.id);
  if (!parsedId) return res.status(400).json({ success: false, error: 'Invalid quarantine batch id' });
  const id = String(parsedId);
  try {
    if (!(await retryRejectedLogsBatch(id))) return res.status(404).json({ success: false, error: 'Quarantined Logs batch not found' });
    await logAudit(req, AuditActions.LOGS_QUARANTINE_RETRY, { entityType: 'logs_ingest_batch', entityId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to retry quarantined Logs batch', { id, error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to retry quarantined Logs batch' });
  }
});

router.delete('/quarantine/:id', async (req: Request, res: Response) => {
  const parsedId = positiveId(req.params.id);
  if (!parsedId) return res.status(400).json({ success: false, error: 'Invalid quarantine batch id' });
  const id = String(parsedId);
  try {
    if (!(await discardRejectedLogsBatch(id))) return res.status(404).json({ success: false, error: 'Quarantined Logs batch not found' });
    await logAudit(req, AuditActions.LOGS_QUARANTINE_DISCARD, { entityType: 'logs_ingest_batch', entityId: id });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to discard quarantined Logs batch', { id, error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to discard quarantined Logs batch' });
  }
});

router.get('/saved-searches', async (_req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    res.json({ success: true, data: await listLogsSavedSearches() });
  } catch (error) {
    logger.error('Failed to list Logs saved searches', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list Logs saved searches' });
  }
});

router.post('/saved-searches', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const input = parseSavedSearchInput(req.body);
    const adminId = getCurrentAdmin(req)?.adminId ?? null;
    const saved = await createLogsSavedSearch(input, adminId);
    await logAudit(req, AuditActions.LOGS_SAVED_SEARCH_CREATE, {
      entityType: 'logs_saved_search',
      entityId: String(saved.id),
      newValues: { name: saved.name, rangePreset: saved.filters.rangePreset },
    });
    res.status(201).json({ success: true, data: saved });
  } catch (error) {
    if (error instanceof LogsQueryError) return res.status(400).json({ success: false, error: error.message });
    if (error instanceof LogsRequestError) return res.status(400).json({ success: false, error: error.message });
    if (error instanceof LogsCapacityError) return res.status(409).json({ success: false, error: error.message });
    logger.error('Failed to create Logs saved search', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to create Logs saved search' });
  }
});

router.put('/saved-searches/:id', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'id is invalid' });
    const input = parseSavedSearchInput(req.body);
    const saved = await updateLogsSavedSearch(id, input);
    if (!saved) return res.status(404).json({ success: false, error: 'Saved search not found' });
    await logAudit(req, AuditActions.LOGS_SAVED_SEARCH_UPDATE, {
      entityType: 'logs_saved_search',
      entityId: String(saved.id),
      newValues: { name: saved.name, rangePreset: saved.filters.rangePreset },
    });
    res.json({ success: true, data: saved });
  } catch (error) {
    if (error instanceof LogsQueryError) return res.status(400).json({ success: false, error: error.message });
    if (error instanceof LogsRequestError) return res.status(400).json({ success: false, error: error.message });
    logger.error('Failed to update Logs saved search', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to update Logs saved search' });
  }
});

router.delete('/saved-searches/:id', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'id is invalid' });
    if (!(await deleteLogsSavedSearch(id))) return res.status(404).json({ success: false, error: 'Saved search not found' });
    await logAudit(req, AuditActions.LOGS_SAVED_SEARCH_DELETE, {
      entityType: 'logs_saved_search',
      entityId: String(id),
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete Logs saved search', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to delete Logs saved search' });
  }
});

router.get('/sources', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const windowDays = Number.parseInt(String(req.query.windowDays ?? '7'), 10);
    const result = await getLogsSources(windowDays);
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof LogsQueryError || error instanceof LogsStoreUnavailableError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    logger.error('Failed to list Logs sources', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list Logs sources' });
  }
});

router.get('/alerts', async (_req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    res.json({ success: true, data: await listLogsAlertRules() });
  } catch (error) {
    logger.error('Failed to list Logs alert rules', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to list Logs alert rules' });
  }
});

router.post('/alerts/preview', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const input = parseLogsAlertInput({ ...req.body, enabled: true });
    res.json({ success: true, data: await previewLogsAlertRule(input) });
  } catch (error) {
    if (error instanceof LogsQueryError || error instanceof LogsStoreUnavailableError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    if (error instanceof LogsRequestError) return res.status(400).json({ success: false, error: error.message });
    logger.error('Failed to preview Logs alert rule', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to preview Logs alert rule' });
  }
});

router.post('/alerts', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const input = parseLogsAlertInput(req.body);
    const rule = await createLogsAlertRule(input);
    await logAudit(req, AuditActions.LOGS_ALERT_RULE_CREATE, {
      entityType: 'logs_alert_rule',
      entityId: String(rule.id),
      newValues: {
        name: rule.name,
        windowSeconds: rule.windowSeconds,
        comparator: rule.comparator,
        threshold: rule.threshold,
        forSeconds: rule.forSeconds,
        enabled: rule.enabled,
      },
    });
    res.status(201).json({ success: true, data: rule });
  } catch (error) {
    if (error instanceof LogsQueryError) return res.status(400).json({ success: false, error: error.message });
    if (error instanceof LogsRequestError) return res.status(400).json({ success: false, error: error.message });
    if (error instanceof LogsCapacityError) return res.status(409).json({ success: false, error: error.message });
    logger.error('Failed to create Logs alert rule', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to create Logs alert rule' });
  }
});

router.put('/alerts/:id', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'id is invalid' });
    const input = parseLogsAlertInput(req.body);
    const rule = await updateLogsAlertRule(id, input);
    if (!rule) return res.status(404).json({ success: false, error: 'Logs alert rule not found' });
    await logAudit(req, AuditActions.LOGS_ALERT_RULE_UPDATE, {
      entityType: 'logs_alert_rule',
      entityId: String(rule.id),
      newValues: {
        name: rule.name,
        windowSeconds: rule.windowSeconds,
        comparator: rule.comparator,
        threshold: rule.threshold,
        forSeconds: rule.forSeconds,
        enabled: rule.enabled,
      },
    });
    res.json({ success: true, data: rule });
  } catch (error) {
    if (error instanceof LogsQueryError) return res.status(400).json({ success: false, error: error.message });
    if (error instanceof LogsRequestError) return res.status(400).json({ success: false, error: error.message });
    logger.error('Failed to update Logs alert rule', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to update Logs alert rule' });
  }
});

router.delete('/alerts/:id', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const id = positiveId(req.params.id);
    if (!id) return res.status(400).json({ success: false, error: 'id is invalid' });
    if (!(await deleteLogsAlertRuleWithRecovery(id))) return res.status(404).json({ success: false, error: 'Logs alert rule not found' });
    await logAudit(req, AuditActions.LOGS_ALERT_RULE_DELETE, {
      entityType: 'logs_alert_rule',
      entityId: String(id),
    });
    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete Logs alert rule', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Failed to delete Logs alert rule' });
  }
});

// GET /api/logs/search?start&end&serviceId=a,b&serviceType=t&q=&limit=
// Searches stored Fleet and external logs, newest first.
router.get('/search', async (req: Request, res: Response) => {
  try {
    if (!(await checkLogsEnabled(res))) return;
    const end = dateParam(req.query.end, new Date());
    const start = dateParam(req.query.start, new Date(end.getTime() - 60 * 60 * 1000));
    const serviceTypes = listParam(req.query.serviceType);
    for (const type of serviceTypes) {
      if (!parseServiceType(type)) return res.status(400).json({ success: false, error: 'serviceType is invalid' });
    }
    const result = await searchLogs({
      start,
      end,
      serviceIds: [...listParam(req.query.serviceId), ...listParam(req.query.serviceIds, false)],
      serviceTypes,
      sourceNames: [...listParam(req.query.sourceName), ...listParam(req.query.sourceNames, false)],
      query: typeof req.query.q === 'string' ? req.query.q : undefined,
      limit: Number.parseInt(String(req.query.limit ?? ''), 10),
    });
    res.json({ success: true, data: result });
  } catch (error) {
    if (error instanceof LogsQueryError || error instanceof LogsStoreUnavailableError) {
      return res.status(error.status).json({ success: false, error: error.message });
    }
    if ((error as Error).message.includes('serviceType')) {
      return res.status(400).json({ success: false, error: 'serviceType is invalid' });
    }
    logger.error('Logs search failed', { error: (error as Error).message });
    res.status(500).json({ success: false, error: 'Logs search failed' });
  }
});

export default router;
