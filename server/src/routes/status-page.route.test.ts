import express, { type NextFunction, type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPublicIncidentArchive, getStatusPageFeed, importStatusPageReports, updateStatusPageSettings } from '../db/queries/status-page.js';
import router from './status-page.js';

vi.mock('../middleware/auth.js', () => ({
  requireAuth: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: vi.fn((_req: Request, _res: Response, next: NextFunction) => next()),
}));

vi.mock('../db/queries/status-page.js', () => ({
  addStatusPageReportUpdate: vi.fn(),
  createStatusPageReport: vi.fn(),
  deleteStatusPageComponent: vi.fn(),
  deleteStatusPageMaintenance: vi.fn(),
  deleteStatusPageReport: vi.fn(),
  deleteStatusPageSection: vi.fn(),
  getPublicIncident: vi.fn(),
  getPublicIncidentArchive: vi.fn(),
  getPublicMaintenanceSchedule: vi.fn(),
  getPublicStatusPage: vi.fn(),
  getStatusPageAdminSummary: vi.fn(),
  getStatusPageFeed: vi.fn(),
  importStatusPageReports: vi.fn(),
  updateStatusPageSettings: vi.fn(),
  upsertStatusPageComponent: vi.fn(),
  upsertStatusPageMaintenance: vi.fn(),
  upsertStatusPageSection: vi.fn(),
}));

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/status-page', router);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/status-page`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
});

describe('status page settings validation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateStatusPageSettings).mockResolvedValue({} as never);
  });

  it.each([
    ['companyUrl', 'javascript:alert(1)', 'companyUrl must be an absolute HTTP(S) URL without credentials'],
    ['logoUrl', 'data:image/svg+xml;base64,AAAA', 'logoUrl must be an absolute HTTP(S) URL without credentials'],
    ['customDomain', 'https://status.example.test/path', 'customDomain must be a hostname without a scheme or path'],
  ])('rejects unsafe %s values', async (field, value, message) => {
    const response = await fetch(`${baseUrl}/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: message });
    expect(updateStatusPageSettings).not.toHaveBeenCalled();
  });

  it('normalizes accepted public URLs and custom domains before persisting', async () => {
    const response = await fetch(`${baseUrl}/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        companyUrl: 'https://Example.test/status',
        logoUrl: 'http://cdn.example.test/logo.png',
        customDomain: 'Status.Example.Test',
      }),
    });

    expect(response.status).toBe(200);
    expect(updateStatusPageSettings).toHaveBeenCalledWith(expect.objectContaining({
      companyUrl: 'https://example.test/status',
      logoUrl: 'http://cdn.example.test/logo.png',
      customDomain: 'status.example.test',
    }));
  });
});

describe('status page feature settings', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(updateStatusPageSettings).mockResolvedValue({} as never);
  });

  it('saves the page feature switches and limits', async () => {
    const response = await fetch(`${baseUrl}/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ incidentHistoryEnabled: false, maintenancePageEnabled: true, feedsEnabled: false, incidentGroupingMinutes: 0, homeIncidentDays: 14 }),
    });

    expect(response.status).toBe(200);
    expect(updateStatusPageSettings).toHaveBeenCalledWith(expect.objectContaining({
      incidentHistoryEnabled: false, maintenancePageEnabled: true, feedsEnabled: false, incidentGroupingMinutes: 0, homeIncidentDays: 14,
    }));
  });

  it.each([
    ['incidentGroupingMinutes', 1441, 'incidentGroupingMinutes must be an integer between 0 and 1440'],
    ['homeIncidentDays', -1, 'homeIncidentDays must be an integer between 0 and 90'],
    ['feedsEnabled', 'yes', 'feedsEnabled must be true or false'],
  ])('rejects an invalid %s', async (field, value, message) => {
    const response = await fetch(`${baseUrl}/admin/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [field]: value }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: message });
  });
});

describe('public incident history and feeds', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('answers 404 while incident history is off and rejects a malformed month', async () => {
    vi.mocked(getPublicIncidentArchive).mockResolvedValue(null);
    expect((await fetch(`${baseUrl}/public/incidents`)).status).toBe(404);
    const bad = await fetch(`${baseUrl}/public/incidents?month=2026-13`);
    expect(bad.status).toBe(400);
    expect(await bad.json()).toMatchObject({ error: 'month must be YYYY-MM' });
  });

  it('renders incidents as RSS with escaped titles and incident links', async () => {
    vi.mocked(getStatusPageFeed).mockResolvedValue({
      settings: { companyName: 'Acme & Co', incidentHistoryEnabled: true } as never,
      reports: [{
        id: 9,
        title: 'SMTP <mx1> is down',
        status: 'resolved',
        impact: 'outage',
        openedAt: new Date('2026-09-03T01:02:00Z'),
        resolvedAt: new Date('2026-09-03T01:24:00Z'),
        components: [{ id: 1, publicName: 'SMTP mx1', status: 'outage' }],
        updates: [{ id: 1, status: 'resolved', message: 'SMTP mx1 recovered.', createdAt: new Date('2026-09-03T01:24:00Z') }],
      }],
    });

    const response = await fetch(`${baseUrl}/public/feed.rss`);
    const body = await response.text();

    expect(response.headers.get('content-type')).toContain('application/rss+xml');
    expect(body).toContain('<title>SMTP &lt;mx1&gt; is down</title>');
    expect(body).toContain('<title>Acme &amp; Co status</title>');
    expect(body).toMatch(/<link>[^<]*\/status\/incidents\/9<\/link>/);
    expect(body).toContain('Resolved. SMTP mx1 recovered. Affected: SMTP mx1.');
  });

  it('answers 404 for feeds while they are off', async () => {
    vi.mocked(getStatusPageFeed).mockResolvedValue(null);
    expect((await fetch(`${baseUrl}/public/feed.json`)).status).toBe(404);
  });
});

describe('status page report import', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(importStatusPageReports).mockResolvedValue({ imported: 1, skipped: 0, unknownComponents: [] });
  });

  it('imports past incidents with their timeline', async () => {
    const response = await fetch(`${baseUrl}/admin/reports/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reports: [{
        title: 'SMTP mx1 is down',
        impact: 'outage',
        openedAt: '2026-09-03T01:02:00Z',
        resolvedAt: '2026-09-03T01:24:00Z',
        components: [' SMTP mx1 '],
        updates: [{ status: 'resolved', message: 'Recovered.', createdAt: '2026-09-03T01:24:00Z' }],
      }] }),
    });

    expect(response.status).toBe(201);
    expect(importStatusPageReports).toHaveBeenCalledWith([expect.objectContaining({
      title: 'SMTP mx1 is down',
      components: ['SMTP mx1'],
      resolvedAt: new Date('2026-09-03T01:24:00Z'),
    })]);
  });

  it.each([
    [{ reports: [] }, 'reports must be a non-empty array'],
    [{ reports: [{ title: 'x', impact: 'outage', openedAt: '2026-09-03T02:00:00Z', resolvedAt: '2026-09-03T01:00:00Z' }] }, 'reports[0].resolvedAt must be on or after openedAt'],
    [{ reports: [{ title: 'x', impact: 'bad', openedAt: '2026-09-03T02:00:00Z' }] }, 'impact must be one of: degraded, outage, maintenance'],
  ])('rejects an invalid import', async (body, message) => {
    const response = await fetch(`${baseUrl}/admin/reports/import`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ success: false, error: message });
    expect(importStatusPageReports).not.toHaveBeenCalled();
  });
});
