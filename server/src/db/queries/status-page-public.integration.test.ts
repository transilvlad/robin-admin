/**
 * Integration test for the public status page against a REAL Postgres: the
 * unauthenticated payload must carry public names and statuses only, never
 * the monitoring checks behind them. Skipped by default; run like the other
 * *.integration.test.ts files, one at a time.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeSchema } from '../schema.js';
import { closePool, query } from '../connection.js';
import { createMonitoringCheck, createMonitoringTarget } from './monitoring.js';
import {
  deleteStatusPageReport,
  getPublicIncident,
  getPublicIncidentArchive,
  getPublicStatusPage,
  getStatusPageFeed,
  importStatusPageReports,
  resetPublicStatusPageSyncForTests,
  syncAutomaticStatusPageReports,
  updateStatusPageSettings,
  upsertStatusPageComponent,
  upsertStatusPageSection,
} from './status-page.js';

const RUN = process.env.ROLLUP_IT_DB === '1';

describe.skipIf(!RUN)('public status page (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
    await query('TRUNCATE status_page_sections, monitoring_targets RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await closePool();
  });
  beforeEach(() => {
    resetPublicStatusPageSyncForTests();
  });

  it('shows public names and statuses, and nothing about the checks behind them', async () => {
    const target = await createMonitoringTarget({ name: 'Internal MX target', targetType: 'host', environment: 'prod-eu' });
    const check = await createMonitoringCheck({ targetId: target.id, name: 'mx1 internal SMTP', checkType: 'smtp', endpoint: 'mx1.internal.example', port: 25 });
    await query(`UPDATE monitoring_checks SET current_status = 'down', last_error = 'connect ECONNREFUSED 10.1.2.3:25' WHERE id = $1`, [check.id]);
    const section = await upsertStatusPageSection({ name: 'Mail', position: 0, enabled: true });
    await upsertStatusPageComponent({ sectionId: section.id, publicName: 'Outbound mail', description: null, position: 0, enabled: true, showHistory: false, checkIds: [check.id] });

    await updateStatusPageSettings({ published: false });
    expect(await getPublicStatusPage()).toBeNull();

    await updateStatusPageSettings({ published: true });
    const page = await getPublicStatusPage();
    const component = page!.sections.flatMap((entry) => entry.components).find((entry) => entry.publicName === 'Outbound mail');
    expect(component).toMatchObject({ status: 'outage', statusReason: 'Unavailable' });
    // History is hidden for this component, so is its uptime.
    expect(component?.uptimePercent).toBeNull();

    const payload = JSON.stringify(page);
    for (const internal of ['mx1 internal SMTP', 'mx1.internal.example', '10.1.2.3', 'Internal MX target', 'prod-eu', 'checkId', 'monitoringIssueId']) {
      expect(payload).not.toContain(internal);
    }
  });

  it('reports uptime from the daily rollups of linked checks', async () => {
    const target = await createMonitoringTarget({ name: 'Uptime target', targetType: 'host', environment: 'prod' });
    const check = await createMonitoringCheck({ targetId: target.id, name: 'uptime HTTPS', checkType: 'http', endpoint: 'https://up.example.test' });
    await query(
      `INSERT INTO monitoring_check_daily (check_id, day, up_count, warning_count, down_count, unavailable_warning_count)
       VALUES ($1, CURRENT_DATE - 1, 990, 5, 5, 3), ($1, CURRENT_DATE - 500, 0, 0, 100, 0)`,
      [check.id]
    );
    const section = await upsertStatusPageSection({ name: 'Web', position: 1, enabled: true });
    await upsertStatusPageComponent({ sectionId: section.id, publicName: 'Website', description: null, position: 0, enabled: true, showHistory: true, checkIds: [check.id] });
    const page = await getPublicStatusPage();
    const component = page!.sections.flatMap((entry) => entry.components).find((entry) => entry.publicName === 'Website');
    // Three certificate-error warnings are unavailable; the 500-day-old row is outside the window.
    expect(component?.uptimePercent).toBe(99.2);
  });

  it('groups simultaneous failures into one incident with a per-service timeline', async () => {
    await query('TRUNCATE status_page_reports RESTART IDENTITY CASCADE');
    await updateStatusPageSettings({ published: true, incidentGroupingMinutes: 15, incidentHistoryEnabled: true, feedsEnabled: true });
    const target = await createMonitoringTarget({ name: 'Cube', targetType: 'host', environment: 'prod' });
    const imap = await createMonitoringCheck({ targetId: target.id, name: 'cube IMAP', checkType: 'tcp', endpoint: 'cube.example.test', port: 993 });
    const smtp = await createMonitoringCheck({ targetId: target.id, name: 'cube SMTP', checkType: 'tcp', endpoint: 'cube.example.test', port: 465 });
    const section = await upsertStatusPageSection({ name: 'Cube', position: 2, enabled: true });
    await upsertStatusPageComponent({ sectionId: section.id, publicName: 'IMAP cube', description: null, position: 0, enabled: true, showHistory: true, checkIds: [imap.id] });
    await upsertStatusPageComponent({ sectionId: section.id, publicName: 'SMTP cube', description: null, position: 1, enabled: true, showHistory: true, checkIds: [smtp.id] });

    await query(`INSERT INTO monitoring_issues (check_id, summary, opened_at) VALUES ($1, 'down', NOW() - INTERVAL '10 minutes')`, [imap.id]);
    await syncAutomaticStatusPageReports();
    await query(`INSERT INTO monitoring_issues (check_id, summary, opened_at) VALUES ($1, 'down', NOW() - INTERVAL '8 minutes')`, [smtp.id]);
    await syncAutomaticStatusPageReports();

    let reports = await query<{ id: string; title: string; status: string }>('SELECT id, title, status FROM status_page_reports');
    expect(reports.rows).toHaveLength(1);
    expect(reports.rows[0]).toMatchObject({ title: 'IMAP cube and SMTP cube are down', status: 'open' });

    await query(`UPDATE monitoring_issues SET status = 'closed', closed_at = NOW() - INTERVAL '2 minutes' WHERE check_id = ANY($1::int[])`, [[imap.id, smtp.id]]);
    await syncAutomaticStatusPageReports();
    await syncAutomaticStatusPageReports();

    const incident = await getPublicIncident(Number(reports.rows[0].id));
    expect(incident).toMatchObject({ status: 'resolved', components: [{ publicName: 'IMAP cube' }, { publicName: 'SMTP cube' }] });
    expect(incident!.updates.map((update) => [update.status, update.message])).toEqual([
      ['investigating', 'IMAP cube went down.'],
      ['investigating', 'SMTP cube went down.'],
      ['resolved', 'IMAP cube and SMTP cube recovered.'],
    ]);

    // A failure long after the incident resolved is a new incident.
    await query(`UPDATE monitoring_issues SET opened_at = NOW() - INTERVAL '3 hours', closed_at = NOW() - INTERVAL '2 hours' WHERE check_id = ANY($1::int[])`, [[imap.id, smtp.id]]);
    await syncAutomaticStatusPageReports();
    await query(`INSERT INTO monitoring_issues (check_id, summary, opened_at) VALUES ($1, 'down', NOW())`, [imap.id]);
    await syncAutomaticStatusPageReports();
    reports = await query('SELECT id, title, status FROM status_page_reports ORDER BY id');
    expect(reports.rows.map((row) => row.status)).toEqual(['resolved', 'open']);

    const archive = await getPublicIncidentArchive();
    expect(archive!.months[0].reports.map((report) => report.status)).toEqual(['open', 'resolved']);

    // A deleted incident stays deleted, though its issues are recent.
    expect(await deleteStatusPageReport(Number(reports.rows[0].id))).toBe(true);
    await syncAutomaticStatusPageReports();
    reports = await query('SELECT id, title, status FROM status_page_reports ORDER BY id');
    expect(reports.rows.map((row) => row.status)).toEqual(['open']);
    expect(archive!.hasNewer).toBe(false);

    await updateStatusPageSettings({ incidentHistoryEnabled: false, feedsEnabled: false });
    expect(await getPublicIncidentArchive()).toBeNull();
    expect(await getStatusPageFeed()).toBeNull();
    await updateStatusPageSettings({ incidentHistoryEnabled: true, feedsEnabled: true });
  });

  it('imports past incidents once, matching components by name', async () => {
    const item = {
      title: 'IMAP cube is down',
      impact: 'outage' as const,
      openedAt: new Date('2026-08-21T19:00:00Z'),
      resolvedAt: new Date('2026-08-21T19:30:00Z'),
      components: ['imap CUBE', 'Retired service'],
      updates: [
        { status: 'resolved' as const, message: 'IMAP cube recovered.', createdAt: new Date('2026-08-21T19:30:00Z') },
        { status: 'investigating' as const, message: 'IMAP cube went down.', createdAt: new Date('2026-08-21T19:00:00Z') },
      ],
    };
    expect(await importStatusPageReports([item])).toEqual({ imported: 1, skipped: 0, unknownComponents: ['Retired service'] });
    expect(await importStatusPageReports([item])).toEqual({ imported: 0, skipped: 1, unknownComponents: [] });

    const archive = await getPublicIncidentArchive('2026-08');
    const august = archive!.months.find((month) => month.month === '2026-08');
    expect(august!.reports).toHaveLength(1);
    expect(august!.reports[0]).toMatchObject({ components: [{ publicName: 'IMAP cube' }], updates: [{ status: 'investigating' }, { status: 'resolved' }] });
  });
});
