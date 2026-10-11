import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { initializeSchema } from '../../db/schema.js';
import { closePool, query } from '../../db/connection.js';
import { createMonitoringCheck, createMonitoringTarget, deleteMonitoringTarget, getMonitoringCheckSecrets } from '../../db/queries/monitoring.js';
import { deleteStatusPageSection, upsertStatusPageComponent, upsertStatusPageSection } from '../../db/queries/status-page.js';
import { exportMonitoringConfiguration, importMonitoringConfiguration } from './config-transfer.js';

describe.skipIf(process.env.OBSERVABILITY_IT_DB !== '1')('Monitoring configuration transfer (real PostgreSQL)', () => {
  const previousEncryptionKey = process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
  let targetId: number | null = null;
  let sectionId: number | null = null;

  beforeAll(async () => {
    process.env.ROBIN_ADMIN_ENCRYPTION_KEY ??= 'isolated-monitoring-transfer-test-key-at-least-32-characters';
    await initializeSchema();
  }, 30000);

  afterAll(async () => {
    if (sectionId !== null) await deleteStatusPageSection(sectionId);
    if (targetId !== null) await deleteMonitoringTarget(targetId);
    await closePool();
    if (previousEncryptionKey === undefined) delete process.env.ROBIN_ADMIN_ENCRYPTION_KEY;
    else process.env.ROBIN_ADMIN_ENCRYPTION_KEY = previousEncryptionKey;
  });

  it('round-trips only non-secret configuration and keeps dry-runs read-only', async () => {
    const suffix = Date.now().toString();
    const targetName = `Transfer target ${suffix}`;
    const sectionName = `Transfer section ${suffix}`;
    const componentName = `Transfer component ${suffix}`;
    const target = await createMonitoringTarget({ name: targetName, targetType: 'endpoint', environment: 'test', description: 'original' });
    targetId = target.id;
    const check = await createMonitoringCheck({
      targetId: target.id,
      name: `Transfer check ${suffix}`,
      checkType: 'http',
      endpoint: 'https://transfer.example.test/health',
      secretHeaders: { 'x-tenant': 'transfer-test-secret-value' },
    });
    const section = await upsertStatusPageSection({ name: sectionName, position: 7, enabled: true });
    sectionId = section.id;
    await upsertStatusPageComponent({
      sectionId: section.id,
      publicName: componentName,
      description: 'Transfer fixture',
      position: 2,
      enabled: true,
      showHistory: true,
      checkIds: [check.id],
    });

    const exported = await exportMonitoringConfiguration();
    expect(JSON.stringify(exported)).not.toContain('transfer-test-secret-value');
    expect(JSON.stringify(exported)).not.toContain('secretHeaderNames');
    const input = {
      ...exported,
      targets: exported.targets.filter(item => item.name === targetName),
      checks: exported.checks.filter(item => item.target.name === targetName),
      sections: exported.sections.filter(item => item.name === sectionName),
      components: exported.components.filter(item => item.publicName === componentName),
    };
    input.targets[0]!.description = 'updated from export';

    const dryRun = await importMonitoringConfiguration(input, true);
    expect(dryRun.errors).toEqual([]);
    expect(dryRun.conflicts).toEqual([]);
    expect(dryRun.changes).toHaveLength(4);
    expect((await query<{ description: string }>('SELECT description FROM monitoring_targets WHERE id = $1', [target.id])).rows[0]?.description).toBe('original');

    const incompatible = {
      ...input,
      checks: input.checks.map(item => ({
        ...item,
        checkType: 'smtp' as const,
        endpoint: 'mail.example.test',
        port: 25,
        certExpiryDays: null,
        options: { smtp: { startTls: false } },
      })),
    };
    const secretConflict = await importMonitoringConfiguration(incompatible, true);
    expect(secretConflict.conflicts).toEqual([expect.objectContaining({ message: expect.stringContaining('Existing secret headers') })]);

    const headerOverlap = {
      ...input,
      checks: input.checks.map(item => ({
        ...item,
        options: { http: { ...item.options.http!, headers: { 'x-tenant': 'public-value' } } },
      })),
    };
    const overlapReport = await importMonitoringConfiguration(headerOverlap, true);
    expect(overlapReport.conflicts).toEqual([expect.objectContaining({ message: expect.stringContaining('already stored as a credential header') })]);

    const invalidPublicCredential = {
      ...input,
      checks: input.checks.map(item => ({
        ...item,
        options: { http: { ...item.options.http!, headers: { authorization: 'public-value' } } },
      })),
    };
    const invalidPublicReport = await importMonitoringConfiguration(invalidPublicCredential, true);
    expect(invalidPublicReport.errors).toEqual([expect.objectContaining({ message: 'Credential headers must use secretHeaders' })]);

    const applied = await importMonitoringConfiguration(input, false);
    expect(applied.errors).toEqual([]);
    expect(applied.conflicts).toEqual([]);
    expect((await query<{ description: string }>('SELECT description FROM monitoring_targets WHERE id = $1', [target.id])).rows[0]?.description).toBe('updated from export');
    expect(await getMonitoringCheckSecrets(check.id)).toEqual({ 'x-tenant': 'transfer-test-secret-value' });
    expect((await query<{ count: number }>('SELECT COUNT(*)::int AS count FROM status_page_component_checks WHERE component_id = (SELECT id FROM status_page_components WHERE public_name = $1) AND check_id = $2', [componentName, check.id])).rows[0]?.count).toBe(1);
  });

  it('reports multiple invalid rows together and makes no changes', async () => {
    const report = await importMonitoringConfiguration({
      format: 'robin-admin-monitoring',
      version: 1,
      targets: [{ name: '', targetType: 'host', environment: 'test' }, { name: 'Invalid target', targetType: 'unknown', environment: 'test' }],
      checks: [],
      sections: [],
      components: [],
    }, false);
    expect(report.errors).toHaveLength(2);
    expect(report.changes).toEqual([]);
  });

  it('rejects ambiguous component check links instead of selecting an arbitrary check', async () => {
    const suffix = Date.now().toString();
    const target = await createMonitoringTarget({ name: `Ambiguous target ${suffix}`, targetType: 'host', environment: 'test' });
    try {
      await createMonitoringCheck({ targetId: target.id, name: 'Duplicate check', checkType: 'http', endpoint: 'https://one.example.test/health' });
      await createMonitoringCheck({ targetId: target.id, name: 'Duplicate check', checkType: 'http', endpoint: 'https://two.example.test/health' });
      const report = await importMonitoringConfiguration({
        format: 'robin-admin-monitoring',
        version: 1,
        targets: [],
        checks: [],
        sections: [{ name: `Ambiguous section ${suffix}`, position: 0, enabled: true }],
        components: [{
          section: `Ambiguous section ${suffix}`,
          publicName: `Ambiguous component ${suffix}`,
          description: null,
          position: 0,
          enabled: true,
          showHistory: true,
          checks: [{ target: { name: target.name, environment: target.environment }, name: 'Duplicate check' }],
        }],
      }, true);
      expect(report.conflicts).toEqual([expect.objectContaining({ message: expect.stringContaining('Check identity is ambiguous') })]);
    } finally {
      await deleteMonitoringTarget(target.id);
    }
  });
});
