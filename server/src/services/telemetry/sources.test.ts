import { beforeEach, describe, expect, it, vi } from 'vitest';
import { observabilityDefaults } from '../observability-settings.js';
import { DISCOVERY_DEFAULTS } from './discovery.js';
vi.mock('../../db/queries/config.js', () => ({ getConfig: vi.fn() }));
const { getConfig } = await import('../../db/queries/config.js');

const telemetryConfig = vi.hoisted(() => ({ storeUrl: 'http://user:secret@store.internal:8428/prefix', ingestBodyLimitBytes: 64, requestTimeoutMs: 1000 }));
vi.mock('./connection.js', () => ({ getStoreConnection: vi.fn(async () => ({ url: telemetryConfig.storeUrl })), connectionUrl: (value: { url: string }) => value.url }));
vi.mock('./query.js', () => ({ labelNames: vi.fn(), labelValues: vi.fn(), queryInstant: vi.fn(), MAX_LABEL_VALUES: 5000 }));
vi.mock('./store-client.js', () => ({ readTelemetryStore: vi.fn(), readTelemetryStoreText: vi.fn() }));

const query = await import('./query.js');
const store = await import('./store-client.js');
const { listTelemetrySources, parseExposition, telemetryStoreHealth } = await import('./sources.js');

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(query.labelNames).mockResolvedValue([]);
  vi.mocked(getConfig).mockResolvedValue({ ...observabilityDefaults(), ...DISCOVERY_DEFAULTS, telemetrySourceLabel: 'host', telemetryGroupLabel: 'role' } as never);
});

describe('listTelemetrySources', () => {
  it.each([
    [[], [], 'no-data'],
    [['up'], [], 'selector-mismatch'],
    [['up'], ['up'], 'missing-source-label'],
  ])('diagnoses empty discovery: %s / %s -> %s', async (all, matching, emptyReason) => {
    vi.mocked(query.labelValues).mockResolvedValueOnce([]).mockResolvedValueOnce(all).mockResolvedValueOnce(matching);
    vi.mocked(query.queryInstant).mockResolvedValue({ truncated: false, series: [] });
    const result = await listTelemetrySources(1_000_000);
    expect(result).toMatchObject({ sources: [], emptyReason });
    expect(query.labelValues).toHaveBeenCalledWith({ name: '__name__', start: 1_000_000 - 7 * 86400, end: 1_000_000, match: '{__name__=~".+"}' });
  });
  it('suggests labels that exist on matching metric series', async () => {
    vi.mocked(query.labelValues).mockResolvedValueOnce([]).mockResolvedValueOnce(['up']).mockResolvedValueOnce(['up']);
    vi.mocked(query.labelNames).mockResolvedValue(['__name__', 'host', 'role', 'zone']);
    vi.mocked(query.queryInstant).mockResolvedValue({ truncated: false, series: [] });
    await expect(listTelemetrySources(1000)).resolves.toMatchObject({
      emptyReason: 'missing-source-label',
      suggestedSourceLabels: ['zone'],
    });
  });
  it('warns when discovery reaches the store label ceiling', async () => {
    vi.mocked(getConfig).mockResolvedValue({ ...observabilityDefaults(), ...DISCOVERY_DEFAULTS, telemetrySourceLimit: 5000 } as never);
    vi.mocked(query.labelValues).mockResolvedValue(Array.from({ length: 5000 }, (_, i) => `sender-${i}`));
    vi.mocked(query.queryInstant).mockResolvedValue({ truncated: false, series: [] });
    const result = await listTelemetrySources();
    expect(result.truncated).toBe(true);
    expect(result.emptyReason).toBeNull();
    expect(query.labelValues).toHaveBeenCalledTimes(1);
  });
  it('applies configured windows and silence and bounds the union of query results', async () => {
    vi.mocked(getConfig).mockResolvedValue({ ...observabilityDefaults(), ...DISCOVERY_DEFAULTS, telemetrySourceLabel: 'host', telemetryGroupLabel: 'role', telemetrySourceWindowDays: 14, telemetrySilentAfterSeconds: 60, telemetrySourceLimit: 100 } as never);
    vi.mocked(query.labelValues).mockResolvedValue(Array.from({ length: 101 }, (_, i) => `sender-${i}`));
    vi.mocked(query.queryInstant).mockResolvedValue({ truncated: false, series: [{ labels: { host: 'outside' }, value: 900 }] });
    const result = await listTelemetrySources(1000);
    expect(result.sources).toHaveLength(100);
    expect(result.sources.every(source => source.silent)).toBe(true);
    expect(result).toMatchObject({ sourceWindowDays: 14, silentAfterSeconds: 60, limit: 100, truncated: true });
    expect(query.labelValues).toHaveBeenCalledWith({ name: 'host', match: '{__name__=~".+",host!=""}', start: 1000 - 14 * 86400, end: 1000 });
    expect(query.queryInstant).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining('[1209600s:1h]') }));
    expect(result.sources.some(source => source.name === 'outside')).toBe(false);
  });
  it('merges known hosts, series per role and last-seen times', async () => {
    vi.mocked(query.labelValues).mockResolvedValue(['worker-10', 'worker-2', 'gone']);
    vi.mocked(query.queryInstant).mockImplementation(async ({ query: expr }) => {
      if (String(expr).startsWith('count by')) {
        return { truncated: false, series: [
          { labels: { host: 'worker-2', role: 'worker' }, value: 40 },
          { labels: { host: 'worker-10', role: 'worker' }, value: 30 },
          { labels: { host: 'worker-10', role: 'container' }, value: 5 },
        ] };
      }
      if (String(expr).startsWith('group by (host, role)')) {
        return { truncated: false, series: [{ labels: { host: 'gone', role: 'service' }, value: 1 }, { labels: { host: 'worker-2', role: 'worker' }, value: 1 }] };
      }
      if (String(expr).startsWith('max by (host) (timestamp')) {
        return { truncated: false, series: [{ labels: { host: 'worker-2' }, value: 1000.7 }, { labels: { host: 'worker-10' }, value: 990 }] };
      }
      return { truncated: false, series: [{ labels: { host: 'gone' }, value: 500 }, { labels: { host: 'worker-2' }, value: 900 }] };
    });

    expect((await listTelemetrySources(1100)).sources).toEqual([
      { name: 'gone', groups: ['service'], query: '{__name__=~".+",host!="",host="gone"}', series: 0, lastSeen: 500, silent: false },
      { name: 'worker-2', groups: ['worker'], query: '{__name__=~".+",host!="",host="worker-2"}', series: 40, lastSeen: 1000, silent: false },
      { name: 'worker-10', groups: ['container', 'worker'], query: '{__name__=~".+",host!="",host="worker-10"}', series: 35, lastSeen: 990, silent: false },
    ]);
    expect(query.labelValues).toHaveBeenCalledWith({ name: 'host', match: '{__name__=~".+",host!=""}', start: 1100 - 7 * 86400, end: 1100 });
  });
  it('supports instance/job, optional grouping and scoped escaped source links', async () => {
    vi.mocked(getConfig).mockResolvedValue({ ...observabilityDefaults(), ...DISCOVERY_DEFAULTS, telemetryGroupLabel: '', telemetrySourceSelector: 'up{job="app"}' } as never);
    vi.mocked(query.labelValues).mockResolvedValue(['node"a']);
    vi.mocked(query.queryInstant).mockImplementation(async input => ({ truncated: false, series: [{ labels: { instance: 'node"a' }, value: String(input.query).startsWith('count') ? 2 : 1000 }] }));
    const result = await listTelemetrySources(1100);
    expect(result).toMatchObject({ sourceLabel: 'instance', groupLabel: '' });
    expect(result.sources[0]).toMatchObject({ name: 'node"a', groups: [], series: 2, silent: false, query: '{__name__="up",job="app",instance!="",instance="node\\"a"}' });
    expect(query.queryInstant).toHaveBeenCalledWith(expect.objectContaining({ query: expect.stringContaining('count by (instance)') }));
  });
});

describe('parseExposition', () => {
  it('reads names, labels and values and skips comments', () => {
    const metrics = parseExposition([
      '# HELP x',
      'vm_rows_inserted_total{type="promremotewrite"} 12',
      'vm_rows_inserted_total{type="prometheus"} 3',
      'flag{name="retentionPeriod", value="90d", is_set="true"} 1',
      'plain 4.5',
      'broken line',
    ].join('\n'));
    expect(metrics.get('vm_rows_inserted_total')).toEqual([
      { labels: { type: 'promremotewrite' }, value: 12 },
      { labels: { type: 'prometheus' }, value: 3 },
    ]);
    expect(metrics.get('flag')?.[0].labels).toEqual({ name: 'retentionPeriod', value: '90d', is_set: 'true' });
    expect(metrics.get('plain')).toEqual([{ labels: {}, value: 4.5 }]);
  });
});

describe('telemetryStoreHealth', () => {
  it('summarises VictoriaMetrics, hides credentials and measures rates between reads', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-10-01T00:00:00Z'));
    vi.mocked(store.readTelemetryStore).mockResolvedValue({ totalSeries: 1200, seriesCountByMetricName: [{ name: 'host_cpu_seconds_total', value: 200 }] });
    const text = (inserted: number, invalid: number) => [
      'vm_app_version{version="victoria-metrics-x", short_version="v1.153.0"} 1',
      'flag{name="retentionPeriod", value="90d", is_set="true"} 1',
      'vm_data_size_bytes{type="storage/small"} 1000',
      'vm_data_size_bytes{type="indexdb/file"} 24',
      'vm_free_disk_space_bytes{path="/storage"} 5000',
      'vm_available_memory_bytes 1073741824',
      `vm_rows_inserted_total{type="promremotewrite"} ${inserted}`,
      `vm_rows_invalid_total{type="prometheus"} ${invalid}`,
      'vm_rows_ignored_total{reason="too_many_labels"} 0',
    ].join('\n');
    vi.mocked(store.readTelemetryStoreText)
      .mockResolvedValueOnce(text(1000, 0))
      .mockResolvedValueOnce(text(1010, 0))
      .mockResolvedValueOnce(text(1600, 10))
      .mockResolvedValueOnce(text(2200, 10))
      .mockResolvedValueOnce(text(50, 0))
      .mockResolvedValueOnce(text(650, 0))
      .mockResolvedValueOnce(text(9000, 0))
      .mockResolvedValueOnce(text(9600, 0));

    const first = await telemetryStoreHealth();
    expect(first).toMatchObject({
      address: 'store.internal:8428',
      kind: 'victoriametrics',
      version: 'v1.153.0',
      retention: '90d',
      totalSeries: 1200,
      dataSizeBytes: 1024,
      freeDiskBytes: 5000,
      memoryLimitBytes: 1073741824,
      rowsInserted: 1000,
      rowsRejected: 0,
      ingestRate: null,
      topMetrics: [{ name: 'host_cpu_seconds_total', series: 200 }],
    });
    // Reads within a minute of the baseline report no rate and keep the baseline.
    vi.setSystemTime(new Date('2026-10-01T00:00:30Z'));
    expect((await telemetryStoreHealth()).ingestRate).toBeNull();
    vi.setSystemTime(new Date('2026-10-01T00:01:00Z'));
    const second = await telemetryStoreHealth();
    expect(second.ingestRate).toBe(10);
    expect(second.rejectRate).toBeCloseTo(10 / 60);
    // Later reads keep averaging from the same baseline.
    vi.setSystemTime(new Date('2026-10-01T00:02:00Z'));
    expect((await telemetryStoreHealth()).ingestRate).toBe(10);
    // After a store restart the counters start again.
    vi.setSystemTime(new Date('2026-10-01T00:02:05Z'));
    expect((await telemetryStoreHealth()).ingestRate).toBeNull();
    vi.setSystemTime(new Date('2026-10-01T00:03:05Z'));
    expect((await telemetryStoreHealth()).ingestRate).toBe(10);
    // A baseline older than ten minutes is replaced rather than averaged over.
    vi.setSystemTime(new Date('2026-10-01T00:20:00Z'));
    expect((await telemetryStoreHealth()).ingestRate).toBeNull();
    vi.setSystemTime(new Date('2026-10-01T00:21:00Z'));
    expect((await telemetryStoreHealth()).ingestRate).toBe(10);
    vi.useRealTimers();
  });

  it('works with less detail on other Prometheus-compatible stores', async () => {
    vi.mocked(store.readTelemetryStore).mockResolvedValue({ totalSeries: 5 });
    vi.mocked(store.readTelemetryStoreText).mockResolvedValue(null);
    expect(await telemetryStoreHealth()).toMatchObject({
      kind: 'prometheus-compatible', version: null, retention: null, totalSeries: 5, dataSizeBytes: null, rowsRejected: null, topMetrics: [],
    });
  });
});
