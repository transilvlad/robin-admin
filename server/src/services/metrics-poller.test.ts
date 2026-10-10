import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as connection from '../db/connection.js';
import * as serviceMetrics from '../db/queries/service-metrics.js';
import * as secrets from '../db/queries/fleet-service-secrets.js';
import { getLiveRspamdMetrics, getRobinMetricsHistory, buildRspamdSnapshotFromRaw, buildRobinSnapshotFromRaw, withRobinProcessCpu } from './metrics-poller.js';

vi.mock('../db/connection.js');
vi.mock('../db/queries/service-metrics.js');
vi.mock('../db/queries/fleet-service-secrets.js', () => ({
  getFleetServiceSecret: vi.fn(),
  RSPAMD_CONTROLLER_PASSWORD_SECRET: 'controller_password',
  RSPAMD_ENABLE_PASSWORD_SECRET: 'enable_password',
}));

const mockFetch = vi.fn();
global.fetch = mockFetch as typeof fetch;

const mockQuery = vi.mocked(connection.query);
const mockGetMetricsFleetServiceById = vi.mocked(serviceMetrics.getMetricsFleetServiceById);
const mockGetPrimaryMetricsFleetService = vi.mocked(serviceMetrics.getPrimaryMetricsFleetService);
const mockGetFleetServiceSecret = vi.mocked(secrets.getFleetServiceSecret);

function buildRobinHistoryRow() {
  return {
    fleet_service_id: 7,
    timestamp: new Date('2024-01-01T00:00:00Z'),
    service_id: 'robin-east',
    current_service_id: 'robin-role-a',
    email_receipt_start: '10',
    email_receipt_success: '9',
    email_receipt_limit: '1',
    email_receipt_exception: '0',
    rbl_rejections: '2',
    virus_rejections: '1',
    spam_rejections: '3',
    dos_ratelimit_rejections: '4',
    dos_connlimit_rejections: '5',
    dos_tarpit_count: '6',
    dos_slowtransfer_rejections: '7',
    dos_commandflood_rejections: '8',
    whitelist_bypasses: '1',
    adaptive_ratelimit_applied: '2',
    geoip_block_rejections: '3',
    geoip_limit_applied: '4',
    distributed_store_errors: '5',
    jvm_memory_used: '1048576',
    jvm_memory_max: '2097152',
    jvm_memory_committed: '1572864',
    jvm_threads_live: '10',
    jvm_threads_daemon: '9',
    jvm_threads_peak: '12',
    jvm_threads_started: '20',
    jvm_gc_pause_seconds: '1.5',
    jvm_gc_pause_count: '2',
    jvm_gc_memory_allocated: '4096',
    jvm_gc_memory_promoted: '2048',
    jvm_gc_live_data_size: '1024',
    jvm_gc_max_data_size: '2048',
    jvm_buffer_count: '3',
    jvm_buffer_memory_used: '4096',
    jvm_buffer_total_capacity: '8192',
    cpu_usage: '0.5',
    process_cpu_usage: '0.25',
    system_cpu_count: '8',
    system_load_average: '1.25',
    rate_email_start: '4.5',
    rate_email_success: '4.2',
    rate_rejections: '0.3',
  };
}

describe('metrics-poller', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    mockQuery.mockReset();
    mockGetMetricsFleetServiceById.mockReset();
    mockGetPrimaryMetricsFleetService.mockReset();
    mockGetFleetServiceSecret.mockReset();
  });

  it('parses live Rspamd metrics for a fleet service', async () => {
    mockGetMetricsFleetServiceById.mockResolvedValue({
      id: 5,
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
      name: 'Rspamd Core',
      description: null,
      apiUrl: 'https://rspamd.example.test',
      healthUrl: null,
      metricsUrl: null,
      controllerUrl: 'https://rspamd.example.test',
      normalUrl: 'https://rspamd-normal.example.test',
      enabled: true,
    });
    mockGetFleetServiceSecret.mockResolvedValue('super-secret');

    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => [
          'rspamd_stats_scanned 100',
          'rspamd_actions_reject 5',
          'rspamd_actions_add_header 7',
          'rspamd_stats_spam_count 12',
          'rspamd_stats_ham_count 88',
          'rspamd_stats_connections 9',
          'rspamd_stats_uptime 3600',
          'rspamd_statfiles_learned_spam{symbol="BAYES_SPAM"} 4',
          'rspamd_statfiles_learned_ham{symbol="BAYES_HAM"} 8',
          'rspamd_stats_bytes_allocated 10485760',
          'process_resident_memory_bytes 5242880',
        ].join('\n'),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({}),
      })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await getLiveRspamdMetrics('rspamd-core');

    expect(result).toMatchObject({
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
      controllerReachable: true,
      controllerAuthenticated: true,
      scannedMessages: 100,
      actionsReject: 5,
      actionsAddHeader: 7,
      spamMessages: 12,
      hamMessages: 88,
      learnedSpam: 4,
      learnedHam: 8,
      connections: 9,
      uptimeSeconds: 3600,
      memoryAllocatedBytes: 10485760,
      memoryResidentBytes: 5242880,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://rspamd-normal.example.test/metrics',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/plain',
        }),
      })
    );
  });

  it('maps Robin history rows to service-aware metric objects', async () => {
    mockQuery
      .mockResolvedValueOnce({
        rows: [{ count: '1' }],
        rowCount: 1,
      } as never)
      .mockResolvedValueOnce({
        rows: [buildRobinHistoryRow()],
        rowCount: 1,
      } as never);

    mockGetMetricsFleetServiceById.mockResolvedValueOnce({
      id: 7,
      serviceId: 'robin-role-a',
      serviceType: 'robin',
      name: 'Robin Role A',
      description: null,
      apiUrl: 'https://robin-east.example.test',
      healthUrl: null,
      metricsUrl: 'https://robin-east.example.test/metrics',
      controllerUrl: null,
      normalUrl: null,
      enabled: true,
    });

    const result = await getRobinMetricsHistory(24, 500, 'robin-role-a');

    expect(result).toEqual([
      expect.objectContaining({
        serviceId: 'robin-role-a',
        serviceType: 'robin',
        emailReceiptStart: 10,
        emailReceiptSuccess: 9,
        rateEmailStart: 4.5,
        rateEmailSuccess: 4.2,
        rateRejections: 0.3,
      }),
    ]);

    expect(mockQuery).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('SELECT COUNT(*) AS count FROM robin_metrics_history'),
      [24, 7]
    );
  });

  it('falls back to Rspamd controller stat payloads when Prometheus counters are missing', async () => {
    mockGetMetricsFleetServiceById.mockResolvedValue({
      id: 6,
      serviceId: 'rspamd-fallback',
      serviceType: 'rspamd',
      name: 'Rspamd Fallback',
      description: null,
      apiUrl: 'https://rspamd.example.test',
      healthUrl: null,
      metricsUrl: null,
      controllerUrl: 'https://rspamd-controller.example.test',
      normalUrl: 'https://rspamd-normal.example.test',
      enabled: true,
    });
    mockGetFleetServiceSecret
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce('enable-secret');

    mockFetch
      .mockResolvedValueOnce({
        ok: false,
        status: 403,
        text: async () => '',
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: async () => ({
          scanned: 120,
          spam: 12,
          ham: 108,
          connections: 7,
          uptime: 7200,
          memory: {
            virtual: 2048,
            resident: 1024,
          },
          actions: {
            'add-header': { count: 5 },
            'soft reject': 3,
            'no-action': 1,
            rewrite_subject: { value: 2 },
            quarantine: { total: 4 },
          },
          statfiles: [
            { learned_spam: 6 },
            { learned_ham: 9 },
          ],
        }),
      })
      .mockResolvedValueOnce({ ok: false, status: 404 })
      .mockResolvedValueOnce({ ok: true, status: 200 })
      .mockResolvedValueOnce({ ok: true, status: 200 });

    const result = await getLiveRspamdMetrics('rspamd-fallback');

    expect(result).toMatchObject({
      serviceId: 'rspamd-fallback',
      serviceType: 'rspamd',
      controllerReachable: true,
      controllerAuthenticated: true,
      controllerHealthyOk: true,
      normalWorkerPingOk: true,
      scannedMessages: 120,
      spamMessages: 12,
      hamMessages: 108,
      learnedSpam: 6,
      learnedHam: 9,
      actionsAddHeader: 5,
      actionsSoftReject: 3,
      actionsNoAction: 1,
      actionsRewriteSubject: 2,
      actionsQuarantine: 4,
      memoryAllocatedBytes: 2048,
      memoryResidentBytes: 1024,
    });

    expect(mockFetch).toHaveBeenCalledWith(
      'https://rspamd-normal.example.test/metrics',
      expect.objectContaining({
        headers: expect.objectContaining({
          Accept: 'text/plain',
        }),
      })
    );
  });
});

describe('buildRspamdSnapshotFromRaw (agent mode)', () => {
  it('normalizes current Rspamd Prometheus totals and labeled action counters', () => {
    const prom = [
      'rspamd_scanned_total 87',
      'rspamd_spam_total 41',
      'rspamd_ham_total 46',
      'rspamd_actions_total{type="reject"} 19',
      'rspamd_actions_total{type="add header"} 22',
      'rspamd_actions_total{type="greylist"} 20',
      'rspamd_actions_total{type="no action"} 26',
    ].join('\n');

    const s = buildRspamdSnapshotFromRaw('r1', prom, undefined);

    expect(s.scannedMessages).toBe(87);
    expect(s.spamMessages).toBe(41);
    expect(s.hamMessages).toBe(46);
    expect(s.actionsReject).toBe(19);
    expect(s.actionsAddHeader).toBe(22);
    expect(s.actionsGreylist).toBe(20);
    expect(s.actionsNoAction).toBe(26);
  });

  it('builds a snapshot from the /stat JSON the agent forwarded', () => {
    const stat = JSON.stringify({
      scanned: 100, spam_count: 30, ham_count: 70, connections: 5, uptime: 3600,
      actions: { reject: 3, 'no action': 60, greylist: 2, 'add header': 25 },
    });
    const s = buildRspamdSnapshotFromRaw('r1', undefined, stat);
    expect(s.serviceType).toBe('rspamd');
    expect(s.controllerReachable).toBe(true);
    expect(s.controllerStatAuthenticated).toBe(true);
    expect(s.scannedMessages).toBe(100);
    expect(s.spamMessages).toBe(30);
    expect(s.hamMessages).toBe(70);
    expect(s.connections).toBe(5);
  });

  it('is unreachable when neither metrics nor stat arrived', () => {
    const s = buildRspamdSnapshotFromRaw('r1', undefined, undefined);
    expect(s.controllerReachable).toBe(false);
  });
});

describe('buildRobinSnapshotFromRaw (agent mode)', () => {
  it('builds a robin snapshot from prometheus text', () => {
    const prom = 'email_receipt_start 42\nemail_receipt_success 40\n';
    const s = buildRobinSnapshotFromRaw('robin1', prom);
    expect(s.serviceType).toBe('robin');
    expect(s.serviceId).toBe('robin1');
    expect(s.timestamp).toBeInstanceOf(Date);
  });

  it('sums receipt exceptions across their type labels', () => {
    const prom = [
      'robin_email_receipt_exception_total{exception_type="IOException"} 451.0',
      'robin_email_receipt_exception_total{exception_type="SocketException"} 1082.0',
      'robin_email_receipt_exception_total{exception_type="SmtpException"} 64.0',
    ].join('\n');
    expect(buildRobinSnapshotFromRaw('robin1', prom).emailReceiptException).toBe(1597);
  });
});

describe('withRobinProcessCpu', () => {
  const sample = (at: string, cpuSeconds: number, gauge = 0) => ({
    ...buildRobinSnapshotFromRaw('robin1', `system_cpu_count 4.0\nprocess_cpu_time_ns_total ${cpuSeconds * 1e9}\nprocess_cpu_usage ${gauge}\n`),
    timestamp: new Date(at),
  });

  it('derives the process CPU share from the CPU-time counter between polls', () => {
    // 6 CPU-seconds over 60 seconds on 4 cores is 2.5%.
    const current = withRobinProcessCpu(sample('2026-10-08T00:01:00Z', 106), sample('2026-10-08T00:00:00Z', 100));
    expect(current.processCpuUsage).toBeCloseTo(0.025);
  });

  it('keeps the gauge without a usable previous sample', () => {
    expect(withRobinProcessCpu(sample('2026-10-08T00:01:00Z', 106, 0.25), null).processCpuUsage).toBe(0.25);
    // A restarted JVM resets the counter.
    expect(withRobinProcessCpu(sample('2026-10-08T00:01:00Z', 5, 0.25), sample('2026-10-08T00:00:00Z', 100)).processCpuUsage).toBe(0.25);
  });
});
