/**
 * Telemetry dashboards against a REAL Postgres: optimistic versioning, the
 * bounded version history, explicit creation and ordering. Skipped by
 * default; run like the other *.integration.test.ts files, one at a time.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../schema.js';
import { closePool, query } from '../connection.js';
import { templateContent, TEMPLATES } from '../../services/telemetry/dashboards/index.js';
import {
  createTelemetryDashboard,
  deleteTelemetryDashboard,
  getTelemetryDashboard,
  getTelemetryDashboardVersion,
  keepTelemetryDashboardContent,
  listTelemetryDashboards,
  listTelemetryDashboardVersions,
  MAX_VERSIONS,
  reorderTelemetryDashboards,
  TelemetryConflictError,
  updateTelemetryDashboard,
} from './telemetry-dashboards.js';

const RUN = process.env.ROLLUP_IT_DB === '1';
const EMPTY = { description: '', variables: [], rows: [] };

describe.skipIf(!RUN)('telemetry dashboards (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
    await query('TRUNCATE telemetry_dashboards RESTART IDENTITY CASCADE');
  });
  afterAll(async () => {
    await closePool();
  });

  it('starts empty, creates templates only explicitly, and never resurrects deleted dashboards', async () => {
    expect(await listTelemetryDashboards()).toEqual([]);
    for (const template of TEMPLATES) {
      await createTelemetryDashboard(templateContent(template), { actor: 'Ana', templateKey: template.key, preferredUid: template.key });
    }
    const host = await getTelemetryDashboard('host');
    expect(host).toMatchObject({ templateKey: 'host', version: 1, title: 'Linux host' });
    expect(host!.rows[0].panels[0].layout).toEqual({ x: 0, y: 0, w: 3, h: 4 });

    const removed = await createTelemetryDashboard({ title: 'Deleted', ...EMPTY }, { actor: 'Ana', preferredUid: 'removed' });
    expect(await deleteTelemetryDashboard(removed.uid)).toBe(true);
    await initializeSchema();
    expect(await getTelemetryDashboard(removed.uid)).toBeNull();
  });

  it('refuses a save based on an old version and keeps the last versions', async () => {
    const created = await createTelemetryDashboard({ title: 'Draft', ...EMPTY }, { actor: 'Ana' });
    const saved = await updateTelemetryDashboard(created.uid, { title: 'Draft 2', ...EMPTY }, 1, 'Ben');
    expect(saved).toMatchObject({ version: 2, title: 'Draft 2', updatedBy: 'Ben' });

    await expect(updateTelemetryDashboard(created.uid, { title: 'Stale', ...EMPTY }, 1, 'Ana'))
      .rejects.toEqual(new TelemetryConflictError(2));
    expect(await updateTelemetryDashboard('missing', { title: 'x', ...EMPTY }, 1, null)).toBeNull();

    for (let version = 2; version < MAX_VERSIONS + 5; version++) {
      await updateTelemetryDashboard(created.uid, { title: `Draft ${version + 1}`, ...EMPTY }, version, 'Ben');
    }
    const versions = await listTelemetryDashboardVersions(created.uid);
    expect(versions).toHaveLength(MAX_VERSIONS);
    expect(versions![0]).toMatchObject({ version: MAX_VERSIONS + 5, savedBy: 'Ben' });
    expect(await getTelemetryDashboardVersion(created.uid, 1)).toBeNull();
    expect(await getTelemetryDashboardVersion(created.uid, MAX_VERSIONS + 5)).toMatchObject({ title: `Draft ${MAX_VERSIONS + 5}` });
  });

  it('allocates a fresh id when a preferred one is taken', async () => {
    const copy = await createTelemetryDashboard({ title: 'Another host', ...EMPTY }, { actor: null, preferredUid: 'host' });
    expect(copy.uid).not.toBe('host');
    expect(copy.uid).toMatch(/^[a-z0-9]{6,10}$/);
  });

  it('orders the listed dashboards first and keeps the rest after them', async () => {
    const before = (await listTelemetryDashboards()).map((dashboard) => dashboard.uid);
    await reorderTelemetryDashboards(['docker', 'host']);
    const after = (await listTelemetryDashboards()).map((dashboard) => dashboard.uid);
    expect(after.slice(0, 2)).toEqual(['docker', 'host']);
    expect(after.slice(2)).toEqual(before.filter((uid) => uid !== 'docker' && uid !== 'host'));
  });

  it('flags a newer default until it is restored or kept', async () => {
    const host = await getTelemetryDashboard('host');
    expect(host?.templateUpdated).toBe(false);
    // Set from an older default: different hash and different content.
    const older = { ...templateContent(TEMPLATES[0]), rows: templateContent(TEMPLATES[0]).rows.slice(1) };
    const saved = await updateTelemetryDashboard('host', older, host!.version, 'Ana');
    await query(`UPDATE telemetry_dashboards SET template_hash = 'old' WHERE uid = 'host'`);
    expect((await getTelemetryDashboard('host'))?.templateUpdated).toBe(true);
    expect((await listTelemetryDashboards()).find((dashboard) => dashboard.uid === 'host')?.templateUpdated).toBe(true);
    const restored = await updateTelemetryDashboard('host', templateContent(TEMPLATES[0]), saved!.version, 'Ana', 'host');
    expect(restored?.templateUpdated).toBe(false);

    // Kept as it is: the notice goes until the default changes again.
    await updateTelemetryDashboard('host', older, restored!.version, 'Ana');
    await query(`UPDATE telemetry_dashboards SET template_hash = 'old' WHERE uid = 'host'`);
    expect((await keepTelemetryDashboardContent('host'))?.templateUpdated).toBe(false);
    expect(await keepTelemetryDashboardContent('missing')).toBeNull();
  });

  it('compares content when no hash was recorded', async () => {
    const host = await getTelemetryDashboard('host');
    const current = await updateTelemetryDashboard('host', templateContent(TEMPLATES[0]), host!.version, 'Ana');
    await query(`UPDATE telemetry_dashboards SET template_hash = NULL WHERE uid = 'host'`);
    expect((await getTelemetryDashboard('host'))?.templateUpdated).toBe(false);
    const changed = { ...templateContent(TEMPLATES[0]), rows: templateContent(TEMPLATES[0]).rows.slice(1) };
    await updateTelemetryDashboard('host', changed, current!.version, 'Ana');
    expect((await getTelemetryDashboard('host'))?.templateUpdated).toBe(true);
  });

  it('keeps default range and refresh in saved versions', async () => {
    const created = await createTelemetryDashboard({ title: 'With defaults', ...EMPTY, defaults: { range: '24h', refresh: 60 } }, { actor: 'Ana' });
    expect(await getTelemetryDashboardVersion(created.uid, 1)).toMatchObject({ defaults: { range: '24h', refresh: 60 } });
  });
});
