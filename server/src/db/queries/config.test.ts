import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../connection.js';
import { logger } from '../../logger.js';
import { reportingPolicy } from '../../services/reporting-settings.js';
import { operationsPolicy, OPERATIONS_KEYS } from '../../services/operations-settings.js';
import {
  getConfig,
  getConfigValidationError,
  updateConfig,
  cleanupOldAuditLog,
  invalidateConfigCache,
  resetConfigCacheForTests,
  startReportingMaintenanceScheduler,
  stopReportingMaintenanceScheduler,
} from './config.js';

vi.mock('../connection.js');
vi.mock('../../services/reporting-cache.js', () => ({ invalidateReportingCache: vi.fn() }));
vi.mock('../../logger.js', () => ({ logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() } }));

const mockQuery = vi.fn();

beforeEach(() => {
  resetConfigCacheForTests();
  mockQuery.mockReset();
  (connection.query as unknown as typeof mockQuery) = mockQuery;
  vi.mocked(connection.getClient).mockResolvedValue({ query: mockQuery, release: vi.fn() } as never);
});

describe('Robin config-store setting persistence', () => {
  it('persists Mailboxes enablement across cache resets', async () => {
    let enabled = 'false';
    mockQuery.mockImplementation(async (sql: string, params?: string[][]) => {
      if (sql.includes('INSERT INTO admin_config')) enabled = params![1][0];
      return { rows: sql.includes('SELECT key, value FROM admin_config') ? [{ key: 'mailboxesEnabled', value: enabled }] : [] };
    });
    expect((await getConfig()).mailboxesEnabled).toBe(false);
    await updateConfig({ mailboxesEnabled: true });
    resetConfigCacheForTests();
    expect((await getConfig()).mailboxesEnabled).toBe(true);
    await updateConfig({ mailboxesEnabled: false });
    expect((await getConfig()).mailboxesEnabled).toBe(false);
  });

  it('rejects malformed enablement without writing to the database', async () => {
    await expect(updateConfig({ mailboxesEnabled: 'false' as never })).rejects.toThrow('must be a boolean');
    expect(mockQuery).not.toHaveBeenCalled();
  });
  it('saves related operations settings atomically and activates only successful writes', async () => {
    const stored = new Map<string, string>();
    mockQuery.mockImplementation(async (sql: string, params?: string[][]) => {
      if (sql.includes('INSERT INTO admin_config')) {
        params![0].forEach((key, index) => stored.set(key, params![1][index]));
      }
      return { rows: sql.includes('SELECT key, value FROM admin_config')
        ? [...stored].map(([key, value]) => ({ key, value })) : [] };
    });
    await updateConfig({ alertsEnabled: true, alertInstanceName: ' Example ', fleetCommandPollWaitMs: 1000, fleetCommandLeaseMs: 5000 });
    const writes = mockQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO admin_config'));
    expect(writes).toHaveLength(1);
    expect(writes[0][1][0]).toEqual(expect.arrayContaining(OPERATIONS_KEYS));
    const notification = mockQuery.mock.calls.find(([sql]) => sql.includes("pg_notify('config_changed'"));
    expect(JSON.parse(notification?.[1][0] as string).keys).toEqual(expect.arrayContaining(OPERATIONS_KEYS));
    expect(operationsPolicy()).toMatchObject({ alertsEnabled: true, alertInstanceName: 'Example', fleetCommandLeaseMs: 5000 });
    mockQuery.mockRejectedValueOnce(new Error('database unavailable'));
    await expect(updateConfig({ alertsEnabled: false })).rejects.toThrow('database unavailable');
    expect(operationsPolicy().alertsEnabled).toBe(true);
    expect((await getConfig()).alertsEnabled).toBe(true);
    await expect(updateConfig({ fleetCommandPollWaitMs: 25000 })).rejects.toThrow('lease');
    expect(operationsPolicy().fleetCommandPollWaitMs).toBe(1000);
  });

  it('loads bounded reporting capacity, activates it and ignores malformed persisted values', async () => {
    mockQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT key, value FROM admin_config') ? [
      { key: 'reportingCacheMiB', value: '64' }, { key: 'reportingSourceQueueSize', value: '0' },
      { key: 'reportingSourceConcurrency', value: '99' }, { key: 'reportingCacheTtlSeconds', value: '20x' },
    ] : [] }));
    expect(await getConfig()).toMatchObject({ reportingCacheMiB: 64, reportingSourceQueueSize: 0, reportingSourceConcurrency: 2, reportingCacheTtlSeconds: 300 });
    expect(reportingPolicy()).toMatchObject({ reportingCacheMiB: 64, reportingSourceQueueSize: 0 });
  });
  it('loads persisted observability policy and ignores malformed values', async () => {
    mockQuery.mockImplementation(async (sql: string) => ({ rows: sql.includes('SELECT key, value FROM admin_config') ? [
      { key: 'telemetrySourceWindowDays', value: '14' },
      { key: 'telemetrySilentAfterSeconds', value: '1800' },
      { key: 'monitoringConcurrency', value: '32' },
      { key: 'telemetrySourceLimit', value: '100000' },
      { key: 'telemetryRequestTimeoutMs', value: '1500x' },
    ] : [] }));
    expect(await getConfig()).toMatchObject({ telemetrySourceWindowDays: 14, telemetrySilentAfterSeconds: 1800, monitoringConcurrency: 32, telemetrySourceLimit: 2000, telemetryRequestTimeoutMs: 10000 });
  });
  it('retains the last valid policy when persisted observability settings become inconsistent', async () => {
    vi.mocked(logger.error).mockClear();
    vi.mocked(logger.info).mockClear();
    const stored = new Map([['monitoringConcurrency', '8'], ['monitoringManualConcurrency', '4']]);
    mockQuery.mockImplementation(async (sql: string, params?: string[][]) => {
      if (sql.includes('INSERT INTO admin_config')) {
        params![0].forEach((key, index) => stored.set(key, params![1][index]));
      }
      return { rows: sql.includes('SELECT key, value FROM admin_config') ? [...stored].map(([key, value]) => ({ key, value })) : [] };
    });

    vi.useFakeTimers();
    try {
      const valid = await getConfig();
      expect(valid).toMatchObject({ monitoringConcurrency: 8, monitoringManualConcurrency: 4 });
      stored.set('monitoringManualConcurrency', '8');
      await vi.advanceTimersByTimeAsync(5001);

      await expect(getConfig()).resolves.toBe(valid);
      expect(getConfigValidationError()).toContain('Manual probe concurrency');
      expect(logger.error).toHaveBeenCalledTimes(1);
      expect(operationsPolicy()).toMatchObject({ fleetCommandPollWaitMs: valid.fleetCommandPollWaitMs });

      stored.set('monitoringManualConcurrency', '7');
      await vi.advanceTimersByTimeAsync(5001);
      expect((await getConfig()).monitoringManualConcurrency).toBe(7);
      expect(getConfigValidationError()).toBeNull();
      expect(logger.info).toHaveBeenCalledWith('Persisted observability configuration is valid again');
    } finally { vi.useRealTimers(); }
  });
  it('fails closed on invalid persisted observability settings before a valid policy loads', async () => {
    mockQuery.mockResolvedValue({ rows: [
      { key: 'monitoringConcurrency', value: '8' },
      { key: 'monitoringManualConcurrency', value: '8' },
    ] });
    await expect(getConfig()).rejects.toThrow('Invalid persisted observability configuration');
    expect(getConfigValidationError()).toContain('Manual probe concurrency');
  });
  it('defaults to robin_config_store when no override exists', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [] });

    await expect(getConfig()).resolves.toMatchObject({
      robinConfigTableName: 'robin_config_store',
      fleetEnabled: false,
      mailboxesEnabled: false,
      monitoringEnabled: false,
      telemetryEnabled: false,
      modulesEnabled: false,
      reportingIntegrationEnabled: false,
    });
  });

  it('persists and returns a custom table name', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT key, value FROM admin_config')) {
        return {
          rows: [{ key: 'robinConfigTableName', value: 'existing_robin_configs' }],
        };
      }
      return { rows: [] };
    });

    await expect(
      updateConfig({ robinConfigTableName: 'existing_robin_configs' })
    ).resolves.toMatchObject({
      robinConfigTableName: 'existing_robin_configs',
    });
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO admin_config'),
      [['robinConfigTableName'], ['existing_robin_configs']]
    );
  });

  it('falls back safely when a persisted table name is invalid', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT key, value FROM admin_config')) {
        return {
          rows: [{ key: 'robinConfigTableName', value: 'unsafe;table' }],
        };
      }
      return { rows: [] };
    });

    await expect(getConfig()).resolves.toMatchObject({
      robinConfigTableName: 'robin_config_store',
    });
  });
});

describe('configuration cache under database pressure', () => {
  const configReads = () => mockQuery.mock.calls.filter(([sql]) => String(sql).includes('SELECT key, value FROM admin_config')).length;

  it('shares one database read between requests that arrive while it runs', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    await Promise.all(Array.from({ length: 25 }, () => getConfig()));
    expect(configReads()).toBe(1);
  });

  it('keeps serving the last loaded configuration when a refresh cannot reach the database', async () => {
    mockQuery.mockResolvedValue({ rows: [{ key: 'mailboxesEnabled', value: 'true' }] });
    expect((await getConfig()).mailboxesEnabled).toBe(true);
    invalidateConfigCache();
    mockQuery.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    expect((await getConfig()).mailboxesEnabled).toBe(true);
    expect(logger.warn).toHaveBeenCalledWith('Reading the configuration failed; using the last loaded one', { error: 'timeout exceeded when trying to connect' });
  });

  it('fails when nothing has loaded yet', async () => {
    mockQuery.mockRejectedValue(new Error('timeout exceeded when trying to connect'));
    await expect(getConfig()).rejects.toThrow('timeout exceeded when trying to connect');
  });

  it('reads again after a write instead of reusing a refresh that started before it', async () => {
    // The first read sees the value from before the write and finishes late.
    let reads = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    mockQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes('SELECT key, value FROM admin_config')) {
        reads += 1;
        if (reads === 1) {
          await gate;
          return { rows: [{ key: 'mailboxesEnabled', value: 'false' }] };
        }
        return { rows: [{ key: 'mailboxesEnabled', value: 'true' }] };
      }
      return { rows: [] };
    });
    const stale = getConfig();
    invalidateConfigCache();
    const fresh = getConfig();
    release();
    expect((await stale).mailboxesEnabled).toBe(false);
    expect((await fresh).mailboxesEnabled).toBe(true);
  });
});

describe('Audit log retention cleanup', () => {
  it('skips deletion when retention is disabled (0 days)', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT key, value FROM admin_config')) {
        return { rows: [{ key: 'auditLogRetentionDays', value: '0' }] };
      }
      return { rows: [] };
    });

    await expect(cleanupOldAuditLog()).resolves.toBe(0);
    expect(mockQuery).not.toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM admin_audit_log'),
      expect.anything()
    );
  });

  it('deletes entries older than the configured retention window', async () => {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT key, value FROM admin_config')) {
        return { rows: [{ key: 'auditLogRetentionDays', value: '90' }] };
      }
      if (sql.includes('DELETE FROM admin_audit_log')) {
        return { rows: [{ count: '7' }] };
      }
      return { rows: [] };
    });

    await expect(cleanupOldAuditLog()).resolves.toBe(7);
    expect(mockQuery).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM admin_audit_log'),
      [90]
    );
  });
});

describe('Scheduled reporting maintenance', () => {
  beforeEach(() => {
    // The logger mock is created once at module load (vi.mock above), so its
    // call history otherwise leaks across every test in this file.
    vi.mocked(logger.info).mockClear();
    vi.mocked(logger.error).mockClear();
  });

  afterEach(() => {
    stopReportingMaintenanceScheduler();
    vi.useRealTimers();
  });

  // Both cleanup functions call getConfig() then prune; make every retention
  // window "on", every DELETE report `count` rows, and (for a non-zero count)
  // each DMARC table list one expired month holding `count` rows, so a single
  // mock covers cleanupOldReportingReports + cleanupOldAuditLog.
  function mockActiveRetentionWithDeletes(count: string) {
    mockQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('SELECT key, value FROM admin_config')) {
        return {
          rows: [
            { key: 'reportingRetentionDays', value: '90' },
            { key: 'auditLogRetentionDays', value: '90' },
          ],
        };
      }
      if (sql.includes('FROM pg_inherits')) {
        return { rows: count === '0' ? [] : [{ child: 'dmarc_month_200001', upper: '2000-02-01', rows_est: count }] };
      }
      if (sql.includes('DELETE FROM')) {
        return { rows: [{ count }] };
      }
      return { rows: [] };
    });
  }

  it('runs immediately on start and logs a summary when something was deleted', async () => {
    mockActiveRetentionWithDeletes('3');

    startReportingMaintenanceScheduler();
    // Wait for the run's terminal action, not just its first query — a
    // fire-and-forget run is still in flight after its first query fires,
    // and would otherwise leak into whichever test runs next.
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalled());

    expect(logger.info).toHaveBeenCalledWith(
      'Scheduled retention cleanup completed',
      expect.objectContaining({ dmarc: 3, auditLog: 3 })
    );
  });

  it('stays quiet when nothing needed cleanup', async () => {
    mockActiveRetentionWithDeletes('0');

    startReportingMaintenanceScheduler();
    // No log call to wait on for the quiet path — wait for the full query
    // sequence includes the atomic DMARC retention transaction so it finishes before
    // asserting silence.
    await vi.waitFor(() => expect(mockQuery).toHaveBeenCalledTimes(10));

    expect(logger.info).not.toHaveBeenCalled();
  });

  it('catches and logs a failure instead of throwing', async () => {
    mockQuery.mockRejectedValue(new Error('connection reset'));

    expect(() => startReportingMaintenanceScheduler()).not.toThrow();
    await vi.waitFor(() => expect(logger.error).toHaveBeenCalled());

    expect(logger.error).toHaveBeenCalledWith(
      'Scheduled retention cleanup failed',
      expect.objectContaining({ error: expect.any(String) })
    );
  });

  it('does not schedule a second interval on a repeated start', async () => {
    vi.useFakeTimers();
    mockActiveRetentionWithDeletes('1');

    startReportingMaintenanceScheduler();
    await vi.advanceTimersByTimeAsync(0);
    mockQuery.mockClear();
    resetConfigCacheForTests(); // isolate the next run's query count from getConfig()'s own cache

    startReportingMaintenanceScheduler(); // no-op: timer already set
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);

    // One run's worth of queries (1 config read + 2 DMARC partition listings
    // + 2 partition drops + 2 report deletes + 1 audit-log delete = 8),
    // not two runs' worth — if the repeated start() above had wrongly
    // scheduled a second interval, this would be double.
    expect(mockQuery).toHaveBeenCalledTimes(12);
  });

  it('stop() clears the interval so no further runs happen', async () => {
    vi.useFakeTimers();
    mockActiveRetentionWithDeletes('1');

    startReportingMaintenanceScheduler();
    await vi.advanceTimersByTimeAsync(0);
    stopReportingMaintenanceScheduler();
    mockQuery.mockClear();

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(mockQuery).not.toHaveBeenCalled();
  });
});
