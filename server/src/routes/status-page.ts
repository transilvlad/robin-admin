import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../middleware/auth.js';
import { requireAdmin } from '../middleware/rbac.js';
import {
  addStatusPageReportUpdate,
  createStatusPageReport,
  deleteStatusPageComponent,
  deleteStatusPageMaintenance,
  deleteStatusPageReport,
  deleteStatusPageSection,
  getPublicIncident,
  getPublicIncidentArchive,
  getPublicMaintenanceSchedule,
  getPublicStatusPage,
  getStatusPageAdminSummary,
  getStatusPageFeed,
  importStatusPageReports,
  updateStatusPageSettings,
  upsertStatusPageComponent,
  upsertStatusPageMaintenance,
  upsertStatusPageSection,
} from '../db/queries/status-page.js';
import {
  STATUS_PAGE_MAINTENANCE_STATUSES,
  STATUS_PAGE_REPORT_IMPACTS,
  STATUS_PAGE_UPDATE_STATUSES,
  type StatusPageReportImport,
  type StatusPageSettings,
  type StatusPageMaintenanceStatus,
  type StatusPageReportImpact,
  type StatusPageUpdateStatus,
} from '../types/status-page.js';
import { logger } from '../logger.js';
import { config } from '../config.js';
import { renderStatusJsonFeed, renderStatusRss, type StatusFeedLinks } from '../services/status-page-feeds.js';
import { routeParam } from './params.js';

const router = Router();

function parseRequiredString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${fieldName} is required`);
  return value.trim();
}

function parseOptionalString(value: unknown, fieldName: string): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string') throw new Error(`${fieldName} must be a string`);
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function parseOptionalPublicUrl(value: unknown, fieldName: string): string | null | undefined {
  const parsed = parseOptionalString(value, fieldName);
  if (!parsed) return parsed;
  let url: URL;
  try {
    url = new URL(parsed);
  } catch {
    throw new Error(`${fieldName} must be an absolute HTTP(S) URL`);
  }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) {
    throw new Error(`${fieldName} must be an absolute HTTP(S) URL without credentials`);
  }
  return url.href;
}

function parseOptionalHostname(value: unknown, fieldName: string): string | null | undefined {
  const parsed = parseOptionalString(value, fieldName);
  if (!parsed) return parsed;
  if (parsed.length > 255 || parsed.includes('/') || parsed.includes(':') || parsed.includes('@')) {
    throw new Error(`${fieldName} must be a hostname without a scheme or path`);
  }
  if (!/^(?=.{1,255}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/i.test(parsed)) {
    throw new Error(`${fieldName} must be a valid hostname`);
  }
  return parsed.toLowerCase();
}

function parseBoolean(value: unknown, fieldName: string): boolean | undefined {
  if (value === undefined) return undefined;
  if (typeof value === 'boolean') return value;
  throw new Error(`${fieldName} must be true or false`);
}

function parseNumber(value: unknown, fieldName: string, min: number, max: number): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < min || parsed > max) {
    throw new Error(`${fieldName} must be an integer between ${min} and ${max}`);
  }
  return parsed;
}

function parseOptionalNumber(value: unknown, fieldName: string, min: number, max: number): number | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  return parseNumber(value, fieldName, min, max);
}

function parseIdArray(value: unknown, fieldName: string): number[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${fieldName} must be an array`);
  return value.map((entry) => parseNumber(entry, fieldName, 1, 2_147_483_647));
}

function parseDate(value: unknown, fieldName: string): Date {
  const raw = parseRequiredString(value, fieldName);
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) throw new Error(`${fieldName} must be a valid date`);
  return parsed;
}

function parseReportImpact(value: unknown): StatusPageReportImpact {
  if (STATUS_PAGE_REPORT_IMPACTS.includes(value as StatusPageReportImpact)) return value as StatusPageReportImpact;
  throw new Error(`impact must be one of: ${STATUS_PAGE_REPORT_IMPACTS.join(', ')}`);
}

function parseUpdateStatus(value: unknown): StatusPageUpdateStatus {
  if (STATUS_PAGE_UPDATE_STATUSES.includes(value as StatusPageUpdateStatus)) return value as StatusPageUpdateStatus;
  throw new Error(`status must be one of: ${STATUS_PAGE_UPDATE_STATUSES.join(', ')}`);
}

function parseMaintenanceStatus(value: unknown): StatusPageMaintenanceStatus {
  if (STATUS_PAGE_MAINTENANCE_STATUSES.includes(value as StatusPageMaintenanceStatus)) return value as StatusPageMaintenanceStatus;
  throw new Error(`status must be one of: ${STATUS_PAGE_MAINTENANCE_STATUSES.join(', ')}`);
}

function parseTheme(value: unknown): StatusPageSettings['theme'] | undefined {
  if (value === undefined) return undefined;
  if (value === 'system' || value === 'light' || value === 'dark') return value;
  throw new Error('theme must be one of: system, light, dark');
}

const IMPORT_MAX_REPORTS = 500;

function parseImportedReports(value: unknown): StatusPageReportImport[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('reports must be a non-empty array');
  if (value.length > IMPORT_MAX_REPORTS) throw new Error(`reports must be ${IMPORT_MAX_REPORTS} incidents or fewer`);
  return value.map((entry, index) => {
    if (!entry || typeof entry !== 'object') throw new Error(`reports[${index}] must be an object`);
    const item = entry as Record<string, unknown>;
    const title = parseRequiredString(item.title, `reports[${index}].title`);
    if (title.length > 255) throw new Error(`reports[${index}].title must be at most 255 characters`);
    const openedAt = parseDate(item.openedAt, `reports[${index}].openedAt`);
    const resolvedAt = item.resolvedAt === undefined || item.resolvedAt === null ? null : parseDate(item.resolvedAt, `reports[${index}].resolvedAt`);
    if (resolvedAt && resolvedAt < openedAt) throw new Error(`reports[${index}].resolvedAt must be on or after openedAt`);
    const components = item.components === undefined ? [] : item.components;
    if (!Array.isArray(components) || components.some((name) => typeof name !== 'string' || !name.trim())) {
      throw new Error(`reports[${index}].components must be an array of component names`);
    }
    const updates = item.updates === undefined ? [] : item.updates;
    if (!Array.isArray(updates)) throw new Error(`reports[${index}].updates must be an array`);
    return {
      title,
      impact: parseReportImpact(item.impact),
      openedAt,
      resolvedAt,
      components: components.map((name: string) => name.trim()),
      updates: updates.map((update: unknown, updateIndex: number) => {
        const raw = (update ?? {}) as Record<string, unknown>;
        return {
          status: parseUpdateStatus(raw.status),
          message: parseRequiredString(raw.message, `reports[${index}].updates[${updateIndex}].message`),
          createdAt: parseDate(raw.createdAt, `reports[${index}].updates[${updateIndex}].createdAt`),
        };
      }),
    };
  });
}

function optionalMonth(value: unknown): string | undefined {
  if (value === undefined || value === '') return undefined;
  if (typeof value !== 'string' || !/^\d{4}-(0[1-9]|1[0-2])$/.test(value)) throw new Error('month must be YYYY-MM');
  return value;
}

function feedLinks(incidentPages: boolean, self: string): StatusFeedLinks {
  const base = config.publicBaseUrl.replace(/\/$/, '');
  return {
    home: `${base}/status`,
    self: `${base}/api/status-page/public/${self}`,
    incident: (id) => (incidentPages ? `${base}/status/incidents/${id}` : null),
  };
}

function routeError(res: Response, message: string, error: unknown): void {
  const detail = (error as Error).message;
  if (detail.includes('required') || detail.includes('must be') || detail.includes('one of')) {
    res.status(400).json({ success: false, error: detail });
    return;
  }
  logger.error(message, { error: detail });
  res.status(500).json({ success: false, error: message });
}

router.get('/public', async (_req: Request, res: Response) => {
  try {
    const page = await getPublicStatusPage();
    if (!page) {
      res.status(404).json({ success: false, error: 'Status page is not published' });
      return;
    }
    res.json({ success: true, data: page });
  } catch (error) {
    routeError(res, 'Failed to load public status page', error);
  }
});

router.get('/public/incidents', async (req: Request, res: Response) => {
  try {
    const archive = await getPublicIncidentArchive(optionalMonth(req.query.month));
    if (!archive) {
      res.status(404).json({ success: false, error: 'Incident history is not published' });
      return;
    }
    res.json({ success: true, data: archive });
  } catch (error) {
    routeError(res, 'Failed to load incident history', error);
  }
});

router.get('/public/incidents/:id', async (req: Request, res: Response) => {
  try {
    const incident = await getPublicIncident(parseNumber(routeParam(req, 'id'), 'id', 1, Number.MAX_SAFE_INTEGER));
    if (!incident) {
      res.status(404).json({ success: false, error: 'Incident not found' });
      return;
    }
    res.json({ success: true, data: incident });
  } catch (error) {
    routeError(res, 'Failed to load incident', error);
  }
});

router.get('/public/maintenance', async (req: Request, res: Response) => {
  try {
    const schedule = await getPublicMaintenanceSchedule(optionalMonth(req.query.month));
    if (!schedule) {
      res.status(404).json({ success: false, error: 'Maintenance is not published' });
      return;
    }
    res.json({ success: true, data: schedule });
  } catch (error) {
    routeError(res, 'Failed to load maintenance', error);
  }
});

router.get('/public/feed.rss', async (_req: Request, res: Response) => {
  try {
    const feed = await getStatusPageFeed();
    if (!feed) {
      res.status(404).type('text/plain').send('Feed is not published');
      return;
    }
    res.type('application/rss+xml').send(renderStatusRss(feed.settings, feed.reports, feedLinks(feed.settings.incidentHistoryEnabled, 'feed.rss')));
  } catch (error) {
    routeError(res, 'Failed to render the RSS feed', error);
  }
});

router.get('/public/feed.json', async (_req: Request, res: Response) => {
  try {
    const feed = await getStatusPageFeed();
    if (!feed) {
      res.status(404).json({ success: false, error: 'Feed is not published' });
      return;
    }
    res.type('application/feed+json').send(JSON.stringify(renderStatusJsonFeed(feed.settings, feed.reports, feedLinks(feed.settings.incidentHistoryEnabled, 'feed.json'))));
  } catch (error) {
    routeError(res, 'Failed to render the JSON feed', error);
  }
});

router.get('/admin', requireAuth, requireAdmin, async (_req: Request, res: Response) => {
  try {
    res.json({ success: true, data: await getStatusPageAdminSummary() });
  } catch (error) {
    routeError(res, 'Failed to load status page admin summary', error);
  }
});

router.put('/admin/settings', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const settings = await updateStatusPageSettings({
      companyName: req.body.companyName === undefined ? undefined : parseRequiredString(req.body.companyName, 'companyName'),
      companyUrl: parseOptionalPublicUrl(req.body.companyUrl, 'companyUrl'),
      logoUrl: parseOptionalPublicUrl(req.body.logoUrl, 'logoUrl'),
      customDomain: parseOptionalHostname(req.body.customDomain, 'customDomain'),
      published: parseBoolean(req.body.published, 'published'),
      historyDays: parseOptionalNumber(req.body.historyDays, 'historyDays', 1, 365),
      timezone: req.body.timezone === undefined ? undefined : parseRequiredString(req.body.timezone, 'timezone'),
      theme: parseTheme(req.body.theme),
      announcement: parseOptionalString(req.body.announcement, 'announcement'),
      subscribable: parseBoolean(req.body.subscribable, 'subscribable'),
      incidentHistoryEnabled: parseBoolean(req.body.incidentHistoryEnabled, 'incidentHistoryEnabled'),
      maintenancePageEnabled: parseBoolean(req.body.maintenancePageEnabled, 'maintenancePageEnabled'),
      feedsEnabled: parseBoolean(req.body.feedsEnabled, 'feedsEnabled'),
      incidentGroupingMinutes: parseOptionalNumber(req.body.incidentGroupingMinutes, 'incidentGroupingMinutes', 0, 1440),
      homeIncidentDays: parseOptionalNumber(req.body.homeIncidentDays, 'homeIncidentDays', 0, 90),
    });
    res.json({ success: true, data: settings });
  } catch (error) {
    routeError(res, 'Failed to update status page settings', error);
  }
});

router.post('/admin/sections', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const section = await upsertStatusPageSection({
      id: req.body.id ?? null,
      name: parseRequiredString(req.body.name, 'name'),
      position: parseNumber(req.body.position ?? 0, 'position', 0, 10_000),
      enabled: parseBoolean(req.body.enabled, 'enabled') ?? true,
    });
    res.status(req.body.id ? 200 : 201).json({ success: true, data: section });
  } catch (error) {
    routeError(res, 'Failed to save status page section', error);
  }
});

router.delete('/admin/sections/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteStatusPageSection(Number(routeParam(req, 'id')));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Section not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete status page section', error);
  }
});

router.post('/admin/components', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const component = await upsertStatusPageComponent({
      id: req.body.id ?? null,
      sectionId: parseNumber(req.body.sectionId, 'sectionId', 1, 2_147_483_647),
      publicName: parseRequiredString(req.body.publicName, 'publicName'),
      description: parseOptionalString(req.body.description, 'description') ?? null,
      position: parseNumber(req.body.position ?? 0, 'position', 0, 10_000),
      enabled: parseBoolean(req.body.enabled, 'enabled') ?? true,
      showHistory: parseBoolean(req.body.showHistory, 'showHistory') ?? true,
      checkIds: parseIdArray(req.body.checkIds, 'checkIds'),
    });
    res.status(req.body.id ? 200 : 201).json({ success: true, data: component });
  } catch (error) {
    routeError(res, 'Failed to save status page component', error);
  }
});

router.delete('/admin/components/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteStatusPageComponent(Number(routeParam(req, 'id')));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Component not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete status page component', error);
  }
});

router.post('/admin/reports', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const report = await createStatusPageReport({
      title: parseRequiredString(req.body.title, 'title'),
      impact: parseReportImpact(req.body.impact),
      componentIds: parseIdArray(req.body.componentIds, 'componentIds'),
      message: parseRequiredString(req.body.message, 'message'),
    });
    res.status(201).json({ success: true, data: report });
  } catch (error) {
    routeError(res, 'Failed to create status page report', error);
  }
});

router.post('/admin/reports/import', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const result = await importStatusPageReports(parseImportedReports(req.body?.reports));
    res.status(201).json({ success: true, data: result });
  } catch (error) {
    routeError(res, 'Failed to import status page reports', error);
  }
});

router.delete('/admin/reports/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteStatusPageReport(Number(routeParam(req, 'id')));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Report not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete status page report', error);
  }
});

router.post('/admin/reports/:id/updates', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const update = await addStatusPageReportUpdate(
      Number(routeParam(req, 'id')),
      parseUpdateStatus(req.body.status),
      parseRequiredString(req.body.message, 'message')
    );
    res.status(201).json({ success: true, data: update });
  } catch (error) {
    routeError(res, 'Failed to add status page report update', error);
  }
});

router.post('/admin/maintenances', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const maintenance = await upsertStatusPageMaintenance({
      id: req.body.id ?? null,
      title: parseRequiredString(req.body.title, 'title'),
      message: parseRequiredString(req.body.message, 'message'),
      status: parseMaintenanceStatus(req.body.status ?? 'scheduled'),
      startsAt: parseDate(req.body.startsAt, 'startsAt'),
      endsAt: parseDate(req.body.endsAt, 'endsAt'),
      componentIds: parseIdArray(req.body.componentIds, 'componentIds'),
    });
    res.status(req.body.id ? 200 : 201).json({ success: true, data: maintenance });
  } catch (error) {
    routeError(res, 'Failed to save status page maintenance', error);
  }
});

router.delete('/admin/maintenances/:id', requireAuth, requireAdmin, async (req: Request, res: Response) => {
  try {
    const deleted = await deleteStatusPageMaintenance(Number(routeParam(req, 'id')));
    if (!deleted) {
      res.status(404).json({ success: false, error: 'Maintenance not found' });
      return;
    }
    res.json({ success: true });
  } catch (error) {
    routeError(res, 'Failed to delete status page maintenance', error);
  }
});

export default router;
