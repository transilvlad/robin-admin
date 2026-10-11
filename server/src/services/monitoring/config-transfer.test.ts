import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getClient } from '../../db/connection.js';
import { exportMonitoringConfiguration, importMonitoringConfiguration } from './config-transfer.js';

vi.mock('../../db/connection.js', () => ({ getClient: vi.fn() }));

const query = vi.fn();
const release = vi.fn();

function exportRows(targets: unknown[] = [], checks: unknown[] = []) {
  query.mockImplementation((sql: string) => {
    if (sql.includes('FROM monitoring_targets ORDER BY')) return Promise.resolve({ rows: targets });
    if (sql.includes('FROM monitoring_checks c JOIN monitoring_targets')) return Promise.resolve({ rows: checks });
    if (sql.includes('FROM status_page_sections ORDER BY')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM status_page_components c JOIN status_page_sections')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM status_page_component_checks scc JOIN monitoring_checks')) return Promise.resolve({ rows: [] });
    throw new Error(`Unexpected query: ${sql}`);
  });
}

function importExisting(state: { targets?: unknown[]; checks?: unknown[]; sections?: unknown[]; components?: unknown[] } = {}) {
  query.mockImplementation((sql: string) => {
    if (sql === 'BEGIN' || sql === 'ROLLBACK' || sql.includes('pg_advisory_xact_lock')) return Promise.resolve({ rows: [] });
    if (sql.includes('FROM monitoring_targets ORDER BY id')) return Promise.resolve({ rows: state.targets ?? [] });
    if (sql.includes('FROM monitoring_checks ORDER BY id')) return Promise.resolve({ rows: state.checks ?? [] });
    if (sql.includes('FROM status_page_sections ORDER BY id')) return Promise.resolve({ rows: state.sections ?? [] });
    if (sql.includes('FROM status_page_components c JOIN status_page_sections')) return Promise.resolve({ rows: state.components ?? [] });
    throw new Error(`Unexpected query: ${sql}`);
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getClient).mockResolvedValue({ query, release } as never);
});

describe('Monitoring configuration export limits', () => {
  it('reports when exported row counts exceed the import limit', async () => {
    exportRows(Array.from({ length: 501 }, (_, index) => ({
      name: `Target ${index}`,
      targetType: 'host',
      environment: 'test',
      description: null,
      enabled: true,
    })));
    await expect(exportMonitoringConfiguration()).rejects.toThrow('targets exceeds the import limit of 500 entries');
    expect(release).toHaveBeenCalledOnce();
  });

  it('reports when the serialized export exceeds the import byte limit', async () => {
    exportRows([{
      name: 'Large target',
      targetType: 'host',
      environment: 'test',
      description: 'x'.repeat(1_000_001),
      enabled: true,
    }]);
    await expect(exportMonitoringConfiguration()).rejects.toThrow(/the import limit is \d[\d,]* bytes/);
    expect(release).toHaveBeenCalledOnce();
  });

  it('refuses exports with check identities that make component links ambiguous', async () => {
    const duplicate = {
      name: 'Duplicate check',
      target_name: 'Target',
      target_environment: 'test',
      check_type: 'tcp',
      endpoint: 'service.example.test',
      port: 443,
      interval_seconds: 60,
      timeout_seconds: 5,
      confirmation_seconds: 180,
      recovery_seconds: 180,
      cert_expiry_days: null,
      tls_mode: 'strict',
      certificate_error_mode: 'down',
      allow_private: false,
      options_json: { tcp: { tls: false, bannerContains: '' } },
      enabled: true,
    };
    exportRows([], [duplicate, duplicate]);
    await expect(exportMonitoringConfiguration()).rejects.toThrow('makes component links ambiguous');
    expect(release).toHaveBeenCalledOnce();
  });

  it('reports oversized imports without planning or applying changes', async () => {
    query.mockResolvedValue({ rows: [] });
    const report = await importMonitoringConfiguration({
      format: 'robin-admin-monitoring',
      version: 1,
      targets: [],
      checks: [],
      sections: [],
      components: [],
      extra: 'x'.repeat(1_000_000),
    }, true);
    expect(report.errors).toEqual([expect.objectContaining({
      path: 'configuration',
      message: expect.stringContaining('configuration cannot exceed'),
    })]);
    expect(report.changes).toEqual([]);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('reports imported headers that overlap existing credential header names', async () => {
    importExisting({
      targets: [{ id: 1, name: 'Target', environment: 'test' }],
      checks: [{ id: 2, target_id: 1, name: 'Check', secret_header_names: ['x-custom'] }],
    });
    const report = await importMonitoringConfiguration({
      format: 'robin-admin-monitoring',
      version: 1,
      targets: [],
      checks: [{
        target: { name: 'Target', environment: 'test' },
        name: 'Check',
        checkType: 'http',
        endpoint: 'https://service.example.test/health',
        options: { http: { headers: { 'X-Custom': 'public-value' } } },
      }],
      sections: [],
      components: [],
    }, true);
    expect(report.conflicts).toEqual([expect.objectContaining({
      message: expect.stringContaining('already stored as a credential header'),
    })]);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });

  it('reports ambiguous existing component check links', async () => {
    importExisting({
      targets: [{ id: 1, name: 'Target', environment: 'test' }],
      checks: [
        { id: 2, target_id: 1, name: 'Duplicate', secret_header_names: [] },
        { id: 3, target_id: 1, name: 'Duplicate', secret_header_names: [] },
      ],
    });
    const report = await importMonitoringConfiguration({
      format: 'robin-admin-monitoring',
      version: 1,
      targets: [],
      checks: [],
      sections: [{ name: 'Section', position: 0, enabled: true }],
      components: [{
        section: 'Section',
        publicName: 'Component',
        description: null,
        position: 0,
        enabled: true,
        showHistory: true,
        checks: [{ target: { name: 'Target', environment: 'test' }, name: 'Duplicate' }],
      }],
    }, true);
    expect(report.conflicts).toEqual([expect.objectContaining({
      message: expect.stringContaining('Check identity is ambiguous'),
    })]);
    expect(query).toHaveBeenCalledWith('ROLLBACK');
  });
});
