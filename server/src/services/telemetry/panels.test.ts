import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RangeResult } from './query.js';
import { templateContent, getTemplate } from './dashboards/index.js';
import type { TelemetryDashboard } from './dashboards/types.js';

vi.mock('./query.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('./query.js')>();
  return { ...original, queryRange: vi.fn(), labelValues: vi.fn() };
});
vi.mock('../../db/queries/telemetry-dashboards.js', () => ({ getTelemetryDashboard: vi.fn() }));

const query = await import('./query.js');
const { getTelemetryDashboard } = await import('../../db/queries/telemetry-dashboards.js');
const { previewPanel, previewVariableOptions, runPanel, variableOptions } = await import('./panels.js');

const mockQueryRange = vi.mocked(query.queryRange);
const mockLabelValues = vi.mocked(query.labelValues);
const HOST: TelemetryDashboard = {
  ...templateContent(getTemplate('host')!),
  uid: 'host',
  templateKey: 'host',
  version: 1,
  updatedAt: new Date(0).toISOString(),
  updatedBy: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getTelemetryDashboard).mockImplementation(async (uid) => (uid === 'host' ? HOST : null));
});

function range(timestamps: number[], series: RangeResult['series']): RangeResult {
  return { start: 100, end: 220, step: 60, timestamps, series, truncated: false };
}

describe('runPanel', () => {
  it('renders every query of a saved panel with one step and merges results', async () => {
    mockQueryRange
      .mockResolvedValueOnce(range([100, 160], [{ labels: { host: 'h' }, values: [1, 2] }]))
      .mockResolvedValueOnce(range([160, 220], [{ labels: { host: 'h' }, values: [5, 6] }]))
      .mockResolvedValueOnce(range([], []))
      .mockResolvedValueOnce(range([], []));
    const result = await runPanel({ dashboardUid: 'host', panelId: 'load', start: 100, end: 220, step: 60, values: { host: ['h'] } });

    expect(mockQueryRange).toHaveBeenCalledTimes(4);
    expect(mockQueryRange.mock.calls[0][0]).toMatchObject({ query: 'sum(host_load1{host=~"h"})', step: 60 });
    expect(result.timestamps).toEqual([100, 160, 220]);
    expect(result.series).toEqual([
      { name: '1m', query: 0, labels: { host: 'h' }, values: [1, 2, null] },
      { name: '5m', query: 1, labels: { host: 'h' }, values: [null, 5, 6] },
    ]);
  });

  it('reports unknown dashboards and panels', async () => {
    await expect(runPanel({ dashboardUid: 'nope', panelId: 'x', start: 1, end: 2, values: {} })).rejects.toThrow('Dashboard not found');
    await expect(runPanel({ dashboardUid: 'host', panelId: 'nope', start: 1, end: 2, values: {} })).rejects.toThrow('Panel not found');
  });
});

describe('previewPanel', () => {
  const panel = {
    id: 'draft', title: 'Draft', type: 'timeseries', unit: 'count',
    queries: [{ expr: 'sum(up{host=~"$host"})', legend: 'Up' }], layout: { x: 0, y: 0, w: 6, h: 8 },
  };

  it('runs an unsaved panel with its variables', async () => {
    mockQueryRange.mockResolvedValueOnce(range([100], [{ labels: {}, values: [3] }]));
    const result = await previewPanel({ panel, variables: [{ name: 'host', label: 'Host', source: 'host' }], values: { host: ['a'] }, start: 100, end: 220 });
    expect(mockQueryRange.mock.calls[0][0]).toMatchObject({ query: 'sum(up{host=~"a"})' });
    expect(result.series[0].name).toBe('Up');
  });

  it('validates the panel before running anything', async () => {
    await expect(previewPanel({ panel: { ...panel, queries: [] }, variables: [], values: {}, start: 1, end: 2 })).rejects.toThrow('needs at least one query');
    await expect(previewPanel({ panel, variables: [], values: {}, start: 1, end: 2 })).rejects.toThrow('Unknown variable $host');
    expect(mockQueryRange).not.toHaveBeenCalled();
  });
});

describe('variable options', () => {
  it('renders a saved variable match with earlier selections and sorts naturally', async () => {
    mockLabelValues.mockResolvedValue(['host-10', 'host-2']);
    const values = await variableOptions({ dashboardUid: 'host', name: 'host', values: { role: ['worker', 'service'] } });
    expect(values).toEqual(['host-2', 'host-10']);
    expect(mockLabelValues).toHaveBeenCalledWith(expect.objectContaining({ name: 'host', match: 'host_uptime{role=~"(worker|service)"}' }));
  });

  it('previews options for a variable that is not saved yet', async () => {
    mockLabelValues.mockResolvedValue(['b', 'a']);
    const values = await previewVariableOptions({
      variables: [{ name: 'vm', label: 'VM', source: 'vmname', match: 'vmhealth_status' }],
      name: 'vm',
      values: {},
    });
    expect(values).toEqual(['a', 'b']);
    expect(mockLabelValues).toHaveBeenCalledWith(expect.objectContaining({ name: 'vmname', match: 'vmhealth_status' }));
  });

  it('reports unknown variables', async () => {
    await expect(variableOptions({ dashboardUid: 'host', name: 'nope', values: {} })).rejects.toThrow('Variable not found');
  });
});
