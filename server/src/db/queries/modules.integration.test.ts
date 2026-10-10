import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { PoolClient } from 'pg';
import { pool } from '../connection.js';
import {
  getModuleSummaryBySlug, listModuleSummaries, recordModuleInstall,
  removeModuleCatalogEntriesNotIn, snapshotInstalledModulesFromCatalog,
  refreshInstalledModuleRelease,
  replaceBootstrapInstalledModules,
  upsertModuleCatalogEntries, upsertModuleLicense, getModuleLicense, recordModuleLicenseRefreshError,
} from './modules.js';

const db = vi.hoisted(() => ({ client: null as PoolClient | null }));
vi.mock('../connection.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../connection.js')>();
  return { ...actual, query: (sql: string, params?: unknown[]) => db.client!.query(sql, params) };
});

// Uses an isolated schema in an initialized development database.
describe.skipIf(process.env.MODULES_IT_DB !== '1')('module catalogue and runtime ownership', () => {
  const schema = `module_test_${randomUUID().replaceAll('-', '')}`;
  beforeAll(async () => {
    db.client = await pool.connect();
    await db.client.query(`CREATE SCHEMA ${schema}`);
    for (const table of ['modules_catalog', 'modules_installed', 'module_licenses']) {
      await db.client.query(`CREATE TABLE ${schema}.${table} (LIKE public.${table} INCLUDING ALL)`);
    }
    await db.client.query(`SET search_path TO ${schema}`);
  });
  afterAll(async () => {
    if (db.client) {
      await db.client.query('SET search_path TO public');
      await db.client.query(`DROP SCHEMA ${schema} CASCADE`);
      db.client.release();
    }
    await pool.end();
  });

  it('refreshes images, keeps runtime targets, and retains snapshots after unpublishing', async () => {
    await recordModuleInstall({
      moduleSlug: 'tools', displayName: 'Old name', tier: 'free',
      remoteEntryUrl: '/modules/tools/remoteEntry.js', backendUrl: 'http://tools:3003',
      metadata: { imageUrls: [], operatorSetting: true },
    });
    await upsertModuleCatalogEntries([{
      slug: 'tools', displayName: 'Robin Tools', tier: 'free', remoteScope: 'tools',
      metadata: { imageUrl: 'https://example.test/tools.jpg', imageUrls: ['https://example.test/one.jpg'] },
    }]);
    const summary = await getModuleSummaryBySlug('tools');
    expect(summary?.displayName).toBe('Robin Tools');
    expect(summary?.metadata.imageUrls).toEqual(['https://example.test/one.jpg']);
    expect(summary?.metadata.operatorSetting).toBe(true);
    expect(summary?.backendUrl).toBe('http://tools:3003');
    await snapshotInstalledModulesFromCatalog();
    await removeModuleCatalogEntriesNotIn([]);
    const retained = await getModuleSummaryBySlug('tools');
    expect(retained?.installed).toBe(true);
    expect(retained?.displayName).toBe('Robin Tools');
    expect(retained?.metadata.imageUrl).toBe('https://example.test/tools.jpg');
  });

  it('prunes bootstrap catalogue leftovers and hides license-only modules', async () => {
    await upsertModuleCatalogEntries([{
      slug: 'qa', displayName: 'Robin QA', tier: 'paid', remoteScope: 'qa',
      metadata: { source: 'bootstrap' },
    }]);
    await db.client!.query("INSERT INTO module_licenses (module_slug, license_key, status) VALUES ('qa', 'test-only', 'active')");
    await recordModuleInstall({
      moduleSlug: 'sheriff', displayName: 'Robin Sheriff', tier: 'free',
      remoteEntryUrl: '/modules/sheriff/remoteEntry.js', metadata: { operatorConsole: true },
    });
    await removeModuleCatalogEntriesNotIn([]);
    expect(await getModuleSummaryBySlug('qa')).toBeNull();
    const summaries = await listModuleSummaries();
    expect(summaries.map((module) => module.slug)).toEqual(expect.arrayContaining(['tools', 'sheriff']));
    expect(summaries.some((module) => module.slug === 'qa')).toBe(false);
  });

  it('stores the issuing authority and preserves the last successful validation on failure', async () => {
    await upsertModuleLicense({
      moduleSlug: 'qa', licenseKey: 'test-only', status: 'active',
      authorityUrl: 'https://sheriff.example.test',
      lastValidatedAt: new Date('2026-09-30T12:00:00Z'),
    });
    const validated = await getModuleLicense('qa');
    expect(validated?.authorityUrl).toBe('https://sheriff.example.test');
    await recordModuleLicenseRefreshError('qa', 'Rejected', true);
    const rejected = await getModuleLicense('qa');
    expect(rejected?.lastValidatedAt).toEqual(validated?.lastValidatedAt);
    expect(rejected?.refreshFailureTerminal).toBe(true);
    expect(rejected?.lastValidationError).toBe('Rejected');
  });

  it('refreshes an entitled draft without creating catalogue or changing the installation', async () => {
    await recordModuleInstall({ moduleSlug: 'private-qa', displayName: 'Old QA', tier: 'paid',
      latestVersion: '0.1.5', installedVersion: '0.1.5', installedSource: 'installer',
      remoteEntryUrl: '/modules/private-qa/remoteEntry.js', backendUrl: 'http://qa:3002',
      assetBaseUrl: 'http://qa-ui:80', probeUrl: 'http://qa:3002/health' });
    await refreshInstalledModuleRelease({ slug: 'private-qa', displayName: 'Robin QA', tier: 'paid',
      remoteScope: 'robinQa', latestVersion: '0.1.6', metadata: { status: 'draft', delivery: { available: true } } });
    // A stale public snapshot cannot replace a newer private release on authority failure.
    await upsertModuleCatalogEntries([{ slug: 'private-qa', displayName: 'Stale QA', tier: 'paid',
      remoteScope: 'robinQa', latestVersion: '0.1.4', metadata: { status: 'published' } }]);
    await snapshotInstalledModulesFromCatalog();
    const updated = await getModuleSummaryBySlug('private-qa');
    expect(updated).toMatchObject({ displayName: 'Robin QA', latestVersion: '0.1.6', installedVersion: '0.1.5',
      installedSource: 'installer', backendUrl: 'http://qa:3002', assetBaseUrl: 'http://qa-ui:80',
      metadata: expect.objectContaining({ status: 'draft', releaseSource: 'entitlement' }) });
    await removeModuleCatalogEntriesNotIn([]);
    expect((await getModuleSummaryBySlug('private-qa'))?.latestVersion).toBe('0.1.6');
    await refreshInstalledModuleRelease({ slug: 'not-installed', displayName: 'Hidden', tier: 'paid', remoteScope: 'hidden' });
    expect(await getModuleSummaryBySlug('not-installed')).toBeNull();
  });

  it('bootstrap refresh preserves release caches and never takes ownership of installer runtimes', async () => {
    const bootstrap = { moduleSlug: 'local-qa', displayName: 'Bootstrap QA', tier: 'paid' as const,
      installedSource: 'bootstrap', remoteEntryUrl: '/modules/local-qa/remoteEntry.js', backendUrl: 'http://local:3002' };
    await replaceBootstrapInstalledModules([bootstrap]);
    await refreshInstalledModuleRelease({ slug: 'local-qa', displayName: 'Robin QA', tier: 'paid',
      remoteScope: 'robinQa', latestVersion: '0.1.6', metadata: { status: 'draft' } });
    await replaceBootstrapInstalledModules([bootstrap, { ...bootstrap, moduleSlug: 'private-qa', backendUrl: 'http://wrong:3002' }]);
    expect(await getModuleSummaryBySlug('local-qa')).toMatchObject({ displayName: 'Robin QA', latestVersion: '0.1.6', installedSource: 'bootstrap' });
    expect(await getModuleSummaryBySlug('private-qa')).toMatchObject({ installedSource: 'installer', backendUrl: 'http://qa:3002' });
    await replaceBootstrapInstalledModules([]);
    expect(await getModuleSummaryBySlug('local-qa')).toBeNull();
    expect((await getModuleSummaryBySlug('private-qa'))?.installed).toBe(true);
  });
});
