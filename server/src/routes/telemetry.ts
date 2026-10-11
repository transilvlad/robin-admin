/**
 * Telemetry routes.
 *
 * POST /write  - Prometheus remote write (Vector `prometheus_remote_write`).
 * POST /import - Prometheus text exposition with optional timestamps, for
 *                scripts and backfills.
 * GET  /write, /import - Sender health check (Vector probes its endpoint).
 *
 * Ingest is machine-only: it requires an API key with `telemetry:write`, never
 * an admin session. Bodies are forwarded unparsed to the configured store.
 *
 * Everything else needs the Telemetry capability (except /status). Reads need
 * a signed-in admin of any role or an API key with `telemetry:read`:
 *
 * GET  /status                              - Store reachability and size.
 * GET  /dashboards                          - Dashboard list, in navigation order.
 * GET  /dashboards/:uid                     - One dashboard.
 * GET  /dashboards/:uid/panels/:panel       - One panel's series (start, end,
 *                                             step, var-<name>=value...).
 * GET  /dashboards/:uid/variables/:name     - A variable's options.
 * GET  /dashboards/:uid/versions[/:version] - Saved versions.
 * GET  /dashboards/:uid/panels/:panel/queries - The panel's PromQL with variables filled in.
 * GET  /templates                           - Optional exporter templates.
 * GET  /sources                             - Bounded discovered sources and effective policy.
 * GET  /store                               - Store health (editors).
 * GET  /annotations                         - Monitoring issues within start..end.
 * GET  /query_range, /query                 - Ad-hoc PromQL for Explore.
 * GET  /labels/:name/values                 - Label values (match, start, end).
 *
 * Changes need the editor role (or an API key with `telemetry:manage`):
 *
 * POST   /dashboards                        - Create (blank, imported JSON,
 *                                             { templateKey } or { duplicateOf }).
 * PUT    /dashboards/:uid                   - Save; must send the edited version.
 * DELETE /dashboards/:uid
 * POST   /dashboards/:uid/restore-default   - Reset to its template.
 * POST   /dashboards/:uid/versions/:version/restore
 * PUT    /dashboard-order                   - { uids } in navigation order.
 * POST   /preview/panel, /preview/variable  - Run unsaved editor state.
 */

import { Router, type NextFunction, type Request, type Response } from 'express';
import { hasApiKeyScope } from '../middleware/security.js';
import { getCurrentAdmin, requireAuth } from '../middleware/auth.js';
import { requireAdmin, requireEditor } from '../middleware/rbac.js';
import { AuditActions, logAudit } from '../middleware/audit.js';
import { getConfig } from '../db/queries/config.js';
import {
  checkTelemetryStore,
  forwardTelemetryIngest,
  telemetryStoreConfigured,
  TelemetryQueryError,
  TelemetryStoreUnavailableError,
  type TelemetryIngestFormat,
} from '../services/telemetry/store-client.js';
import { labelNames, labelValues, queryInstant, queryRange, telemetryStatus } from '../services/telemetry/query.js';
import { discoverySelector } from '../services/telemetry/discovery.js';
import { previewPanel, previewVariableOptions, renderPanelQueries, runPanel, TelemetryNotFoundError, variableOptions } from '../services/telemetry/panels.js';
import { listTelemetrySources, telemetryStoreHealth } from '../services/telemetry/sources.js';
import { listMonitoringIssueSpans } from '../db/queries/monitoring.js';
import { checkVariableValues, parseVariableValues, type VariableValues } from '../services/telemetry/expressions.js';
import {
  getTemplate,
  parseDashboardContent,
  templateContent,
  TelemetryValidationError,
  TEMPLATES,
} from '../services/telemetry/dashboards/index.js';
import {
  createTelemetryDashboard,
  deleteTelemetryDashboard,
  getTelemetryDashboard,
  getTelemetryDashboardVersion,
  keepTelemetryDashboardContent,
  listTelemetryDashboards,
  listTelemetryDashboardVersions,
  reorderTelemetryDashboards,
  TelemetryConflictError,
  updateTelemetryDashboard,
} from '../db/queries/telemetry-dashboards.js';
import type { DashboardContent, TelemetryDashboard } from '../services/telemetry/dashboards/types.js';
import { routeParam } from './params.js';
import { logger } from '../logger.js';

const router = Router();

function requireTelemetryWriter(req: Request, res: Response, next: NextFunction): void {
  if (!req.apiKey) {
    res.status(401).json({ success: false, error: req.apiKeyAuthError ?? 'Telemetry ingest requires an API key' });
    return;
  }
  if (!hasApiKeyScope(req, 'telemetry:write')) {
    res.status(403).json({ success: false, error: 'API key scope required: telemetry:write' });
    return;
  }
  next();
}

class BodyTooLargeError extends Error {}

function readBody(req: Request, limit: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > limit) {
        req.pause();
        reject(new BodyTooLargeError());
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function ingest(format: TelemetryIngestFormat) {
  return async (req: Request, res: Response) => {
    if (!(await telemetryStoreConfigured())) {
      res.status(503).json({ success: false, error: 'Telemetry store is not configured' });
      return;
    }
    const limit = (await getConfig()).telemetryIngestBodyLimitBytes;
    const contentLength = Number(req.headers['content-length']);
    if (Number.isFinite(contentLength) && contentLength > limit) {
      res.status(413).json({ success: false, error: 'Telemetry payload exceeds the ingestion size limit' });
      return;
    }

    if (req.readableEnded) {
      res.status(415).json({ success: false, error: 'Unsupported telemetry content type' });
      return;
    }

    try {
      const body = await readBody(req, limit);
      if (body.length === 0) {
        res.status(400).json({ success: false, error: 'Telemetry payload is empty' });
        return;
      }
      const result = await forwardTelemetryIngest(format, body, req.headers);
      if (result.error) {
        res.status(result.status).json({ success: false, error: result.error });
        return;
      }
      res.status(204).end();
    } catch (error) {
      if (error instanceof BodyTooLargeError) {
        res.status(413).set('Connection', 'close').json({ success: false, error: 'Telemetry payload exceeds the ingestion size limit' });
        return;
      }
      if (error instanceof TelemetryStoreUnavailableError) {
        logger.warn('Telemetry ingest could not reach the store', { error: error.message });
        res.status(503).set('Retry-After', '5').json({ success: false, error: 'Telemetry store is unavailable' });
        return;
      }
      logger.error('Telemetry ingest failed', { error: (error as Error).message });
      res.status(500).json({ success: false, error: 'Telemetry ingest failed' });
    }
  };
}

async function ingestHealth(_req: Request, res: Response) {
  try {
    await checkTelemetryStore();
    res.json({ success: true });
  } catch (error) {
    if (error instanceof TelemetryStoreUnavailableError) {
      res.status(503).json({ success: false, error: 'Telemetry store is unavailable' });
      return;
    }
    res.status(500).json({ success: false, error: 'Telemetry health check failed' });
  }
}

router.get(['/write', '/import'], requireTelemetryWriter, ingestHealth);
router.post('/write', requireTelemetryWriter, ingest('remote-write'));
router.post('/import', requireTelemetryWriter, ingest('prometheus-text'));

// ── Reads ────────────────────────────────────────────────────────────────────

function readError(res: Response, message: string, error: unknown): void {
  if (error instanceof TelemetryValidationError) {
    res.status(400).json({ success: false, error: error.message, problems: error.problems });
    return;
  }
  if (error instanceof TelemetryQueryError) {
    res.status(400).json({ success: false, error: error.message });
    return;
  }
  if (error instanceof TelemetryNotFoundError) {
    res.status(404).json({ success: false, error: error.message });
    return;
  }
  if (error instanceof TelemetryConflictError) {
    res.status(409).json({ success: false, error: error.message, currentVersion: error.currentVersion });
    return;
  }
  if (error instanceof TelemetryStoreUnavailableError) {
    logger.warn('Telemetry read could not reach the store', { error: error.message });
    res.status(503).set('Retry-After', '5').json({ success: false, error: 'Telemetry store is unavailable' });
    return;
  }
  logger.error(message, { error: (error as Error).message });
  res.status(500).json({ success: false, error: message });
}

function queryString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function actorName(req: Request): string | null {
  const admin = getCurrentAdmin(req);
  return admin ? admin.name || admin.email : null;
}

/** `values` from a JSON body: { name: [value, ...] }. */
function bodyVariableValues(raw: unknown): VariableValues {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TelemetryQueryError('values must be an object');
  return Object.fromEntries(Object.entries(raw).map(([name, list]) => [name, checkVariableValues(list)]));
}

async function requireStore(_req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!(await telemetryStoreConfigured())) {
    res.status(503).json({ success: false, error: 'Telemetry store is not configured' });
    return;
  }
  next();
}

router.use(requireAuth);

router.get('/status', async (_req: Request, res: Response) => {
  try {
    const settings = await getConfig();
    const enabled = settings.telemetryEnabled;
    const silentAfterSeconds = settings.telemetrySilentAfterSeconds;
    const configured = await telemetryStoreConfigured();
    if (!configured) {
      res.json({ success: true, data: { enabled, configured, reachable: false, totalSeries: 0, sources: [], silentAfterSeconds } });
      return;
    }
    try {
      const status = await telemetryStatus();
      res.json({ success: true, data: { enabled, configured, reachable: true, ...status, silentAfterSeconds } });
    } catch (error) {
      if (!(error instanceof TelemetryStoreUnavailableError)) throw error;
      res.json({ success: true, data: { enabled, configured, reachable: false, totalSeries: 0, sources: [], silentAfterSeconds } });
    }
  } catch (error) {
    readError(res, 'Failed to load Telemetry status', error);
  }
});

router.use(async (_req: Request, res: Response, next: NextFunction) => {
  try {
    if (!(await getConfig()).telemetryEnabled) {
      res.status(403).json({
        success: false,
        error: 'Telemetry is disabled. Enable Telemetry under Administration -> Integrations.',
      });
      return;
    }
    next();
  } catch (error) {
    next(error);
  }
});

router.get('/dashboards', async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listTelemetryDashboards() });
  } catch (error) {
    readError(res, 'Failed to list Telemetry dashboards', error);
  }
});

router.get('/templates', (_req: Request, res: Response) => {
  res.json({ success: true, data: TEMPLATES.map(({ key, title, description }) => ({ key, title, description })) });
});

router.get('/dashboards/:uid', async (req: Request, res: Response) => {
  try {
    const dashboard = await getTelemetryDashboard(routeParam(req, 'uid'));
    if (!dashboard) {
      res.status(404).json({ success: false, error: 'Dashboard not found' });
      return;
    }
    res.json({ success: true, data: dashboard });
  } catch (error) {
    readError(res, 'Failed to load Telemetry dashboard', error);
  }
});

router.get('/dashboards/:uid/versions', async (req: Request, res: Response) => {
  try {
    const versions = await listTelemetryDashboardVersions(routeParam(req, 'uid'));
    if (!versions) {
      res.status(404).json({ success: false, error: 'Dashboard not found' });
      return;
    }
    res.json({ success: true, data: versions });
  } catch (error) {
    readError(res, 'Failed to list dashboard versions', error);
  }
});

router.get('/dashboards/:uid/versions/:version', async (req: Request, res: Response) => {
  try {
    const content = await getTelemetryDashboardVersion(routeParam(req, 'uid'), Number(routeParam(req, 'version')));
    if (!content) {
      res.status(404).json({ success: false, error: 'Version not found' });
      return;
    }
    res.json({ success: true, data: content });
  } catch (error) {
    readError(res, 'Failed to load dashboard version', error);
  }
});

router.get('/dashboards/:uid/panels/:panel', requireStore, async (req: Request, res: Response) => {
  try {
    const data = await runPanel({
      dashboardUid: routeParam(req, 'uid'),
      panelId: routeParam(req, 'panel'),
      start: req.query.start,
      end: req.query.end,
      step: req.query.step,
      values: parseVariableValues(req.query),
    });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to load Telemetry panel', error);
  }
});

router.get('/dashboards/:uid/variables/:name', requireStore, async (req: Request, res: Response) => {
  try {
    const data = await variableOptions({
      dashboardUid: routeParam(req, 'uid'),
      name: routeParam(req, 'name'),
      start: req.query.start,
      end: req.query.end,
      values: parseVariableValues(req.query),
    });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to load Telemetry variable options', error);
  }
});

router.get('/dashboards/:uid/panels/:panel/queries', async (req: Request, res: Response) => {
  try {
    const data = await renderPanelQueries({
      dashboardUid: routeParam(req, 'uid'),
      panelId: routeParam(req, 'panel'),
      start: req.query.start,
      end: req.query.end,
      step: req.query.step,
      values: parseVariableValues(req.query),
    });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to render Telemetry panel queries', error);
  }
});

router.get('/sources', requireStore, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await listTelemetrySources() });
  } catch (error) {
    readError(res, 'Failed to list Telemetry sources', error);
  }
});

router.get('/store', requireEditor, requireStore, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await telemetryStoreHealth() });
  } catch (error) {
    readError(res, 'Failed to read Telemetry store health', error);
  }
});

// Monitoring is admin-only, and issue summaries can name internal endpoints.
router.get('/annotations', requireAdmin, async (req: Request, res: Response) => {
  try {
    const start = Number(req.query.start);
    const end = Number(req.query.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      res.status(400).json({ success: false, error: 'start and end must be Unix seconds with end after start' });
      return;
    }
    if (!(await getConfig()).monitoringEnabled) {
      res.json({ success: true, data: [] });
      return;
    }
    res.json({ success: true, data: await listMonitoringIssueSpans(new Date(start * 1000), new Date(end * 1000)) });
  } catch (error) {
    readError(res, 'Failed to load Telemetry annotations', error);
  }
});

router.get('/source-query', requireStore, async (req: Request, res: Response) => {
  const name = queryString(req.query.name);
  if (!name || name.length > 512) {
    res.status(400).json({ success: false, error: 'Source name must contain 1 to 512 characters' });
    return;
  }
  try {
    const settings = await getConfig();
    res.json({ success: true, data: { query: discoverySelector(settings, [`${settings.telemetrySourceLabel}=${JSON.stringify(name)}`]) } });
  } catch (error) {
    readError(res, 'Failed to resolve source query', error);
  }
});

router.get('/query_range', requireStore, async (req: Request, res: Response) => {
  try {
    const data = await queryRange({ query: req.query.query, start: req.query.start, end: req.query.end, step: req.query.step });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to run Telemetry query', error);
  }
});

router.get('/query', requireStore, async (req: Request, res: Response) => {
  try {
    const data = await queryInstant({ query: req.query.query, time: req.query.time });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to run Telemetry query', error);
  }
});

router.get('/labels', requireStore, async (req: Request, res: Response) => {
  try {
    const data = await labelNames({ match: queryString(req.query.match), start: req.query.start, end: req.query.end });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to load Telemetry label names', error);
  }
});

router.get('/labels/:name/values', requireStore, async (req: Request, res: Response) => {
  try {
    const data = await labelValues({
      name: routeParam(req, 'name'),
      match: queryString(req.query.match),
      start: req.query.start,
      end: req.query.end,
    });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to load Telemetry label values', error);
  }
});

// ── Changes ──────────────────────────────────────────────────────────────────

router.post('/preview/panel', requireEditor, requireStore, async (req: Request, res: Response) => {
  try {
    const data = await previewPanel({
      panel: req.body?.panel,
      variables: req.body?.variables,
      values: bodyVariableValues(req.body?.values),
      start: req.body?.start,
      end: req.body?.end,
      step: req.body?.step,
    });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to preview Telemetry panel', error);
  }
});

router.post('/preview/variable', requireEditor, requireStore, async (req: Request, res: Response) => {
  try {
    const data = await previewVariableOptions({
      variables: req.body?.variables,
      name: String(req.body?.name ?? ''),
      values: bodyVariableValues(req.body?.values),
      start: req.body?.start,
      end: req.body?.end,
    });
    res.json({ success: true, data });
  } catch (error) {
    readError(res, 'Failed to preview Telemetry variable', error);
  }
});

router.post('/dashboards', requireEditor, async (req: Request, res: Response) => {
  try {
    let content;
    let templateKey: string | null = null;
    if (typeof req.body?.templateKey === 'string') {
      const template = getTemplate(req.body.templateKey);
      if (!template) {
        res.status(404).json({ success: false, error: 'Template not found' });
        return;
      }
      content = templateContent(template);
      templateKey = template.key;
    } else if (typeof req.body?.duplicateOf === 'string') {
      const source = await getTelemetryDashboard(req.body.duplicateOf);
      if (!source) {
        res.status(404).json({ success: false, error: 'Dashboard not found' });
        return;
      }
      content = parseDashboardContent({ ...source, title: `${source.title} (copy)`.slice(0, 120) });
    } else {
      content = parseDashboardContent(req.body);
    }
    const dashboard = await createTelemetryDashboard(content, {
      actor: actorName(req),
      templateKey,
      preferredUid: templateKey ?? undefined,
    });
    await logAudit(req, AuditActions.TELEMETRY_DASHBOARD_CREATE, {
      entityType: 'telemetry-dashboard',
      entityId: dashboard.uid,
      newValues: { title: dashboard.title, templateKey, duplicateOf: req.body?.duplicateOf },
    });
    res.status(201).json({ success: true, data: dashboard });
  } catch (error) {
    readError(res, 'Failed to create Telemetry dashboard', error);
  }
});

router.put('/dashboards/:uid', requireEditor, async (req: Request, res: Response) => {
  try {
    const version = Number(req.body?.version);
    if (!Number.isInteger(version) || version < 1) {
      res.status(400).json({ success: false, error: 'version is required: send the version you edited' });
      return;
    }
    const content = parseDashboardContent(req.body);
    const dashboard = await updateTelemetryDashboard(routeParam(req, 'uid'), content, version, actorName(req));
    if (!dashboard) {
      res.status(404).json({ success: false, error: 'Dashboard not found' });
      return;
    }
    await logAudit(req, AuditActions.TELEMETRY_DASHBOARD_UPDATE, {
      entityType: 'telemetry-dashboard',
      entityId: dashboard.uid,
      newValues: { title: dashboard.title, version: dashboard.version },
    });
    res.json({ success: true, data: dashboard });
  } catch (error) {
    readError(res, 'Failed to save Telemetry dashboard', error);
  }
});

router.delete('/dashboards/:uid', requireEditor, async (req: Request, res: Response) => {
  try {
    const uid = routeParam(req, 'uid');
    const existing = await getTelemetryDashboard(uid);
    if (!existing || !(await deleteTelemetryDashboard(uid))) {
      res.status(404).json({ success: false, error: 'Dashboard not found' });
      return;
    }
    await logAudit(req, AuditActions.TELEMETRY_DASHBOARD_DELETE, {
      entityType: 'telemetry-dashboard',
      entityId: uid,
      oldValues: { title: existing.title, version: existing.version },
    });
    res.json({ success: true });
  } catch (error) {
    readError(res, 'Failed to delete Telemetry dashboard', error);
  }
});

/** Save restored content over a dashboard at its current version and audit it. */
async function restoreContent(
  req: Request,
  res: Response,
  uid: string,
  load: (current: TelemetryDashboard) => Promise<DashboardContent | null> | DashboardContent | null,
  restored: string,
): Promise<void> {
  const current = await getTelemetryDashboard(uid);
  if (!current) {
    res.status(404).json({ success: false, error: 'Dashboard not found' });
    return;
  }
  const content = await load(current);
  if (!content) {
    res.status(404).json({ success: false, error: 'Nothing to restore' });
    return;
  }
  const fromTemplate = restored === 'default' ? current.templateKey ?? undefined : undefined;
  const dashboard = await updateTelemetryDashboard(uid, parseDashboardContent(content), current.version, actorName(req), fromTemplate);
  await logAudit(req, AuditActions.TELEMETRY_DASHBOARD_RESTORE, {
    entityType: 'telemetry-dashboard',
    entityId: uid,
    newValues: { restored, version: dashboard?.version },
  });
  res.json({ success: true, data: dashboard });
}

router.post('/dashboards/:uid/restore-default', requireEditor, async (req: Request, res: Response) => {
  try {
    await restoreContent(req, res, routeParam(req, 'uid'), (current) => {
      const template = current.templateKey ? getTemplate(current.templateKey) : undefined;
      return template ? templateContent(template) : null;
    }, 'default');
  } catch (error) {
    readError(res, 'Failed to restore Telemetry dashboard', error);
  }
});

router.post('/dashboards/:uid/keep', requireEditor, async (req: Request, res: Response) => {
  try {
    const uid = routeParam(req, 'uid');
    const dashboard = await keepTelemetryDashboardContent(uid);
    if (!dashboard) {
      res.status(404).json({ success: false, error: 'Dashboard not found or not from a default' });
      return;
    }
    await logAudit(req, AuditActions.TELEMETRY_DASHBOARD_KEEP, { entityType: 'telemetry-dashboard', entityId: uid });
    res.json({ success: true, data: dashboard });
  } catch (error) {
    readError(res, 'Failed to keep the Telemetry dashboard', error);
  }
});

router.post('/dashboards/:uid/versions/:version/restore', requireEditor, async (req: Request, res: Response) => {
  try {
    const uid = routeParam(req, 'uid');
    const version = Number(routeParam(req, 'version'));
    await restoreContent(req, res, uid, () => getTelemetryDashboardVersion(uid, version), `version ${version}`);
  } catch (error) {
    readError(res, 'Failed to restore Telemetry dashboard version', error);
  }
});

router.put('/dashboard-order', requireEditor, async (req: Request, res: Response) => {
  try {
    const uids = req.body?.uids;
    if (!Array.isArray(uids) || uids.length > 500 || uids.some((uid) => typeof uid !== 'string' || uid.length > 40)) {
      res.status(400).json({ success: false, error: 'uids must be a list of dashboard ids' });
      return;
    }
    await reorderTelemetryDashboards(uids);
    await logAudit(req, AuditActions.TELEMETRY_DASHBOARD_REORDER, { entityType: 'telemetry-dashboard', newValues: { uids } });
    res.json({ success: true, data: await listTelemetryDashboards() });
  } catch (error) {
    readError(res, 'Failed to reorder Telemetry dashboards', error);
  }
});

export default router;
