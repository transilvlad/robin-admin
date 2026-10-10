import { describe, expect, it } from 'vitest';
import type { TelemetryDashboardContent, TelemetryPanel } from '../types/telemetry';
import {
  addRow,
  applyLayout,
  blankPanel,
  bottomOf,
  diffDashboards,
  duplicatePanel,
  exportFileName,
  exportJson,
  moveRow,
  parseImport,
  removePanel,
  removeRow,
  updateRow,
  upsertPanel,
} from './telemetryDashboard';

const panel = (id: string, layout = { x: 0, y: 0, w: 6, h: 8 }): TelemetryPanel => ({
  id, title: id, type: 'timeseries', unit: 'none', queries: [{ expr: 'up' }], layout,
});

const content = (): TelemetryDashboardContent => ({
  title: 'Hosts',
  description: '',
  variables: [],
  rows: [
    { id: 'a', title: 'A', panels: [panel('p1'), panel('p2', { x: 6, y: 0, w: 6, h: 4 })] },
    { id: 'b', title: 'B', panels: [] },
  ],
});

describe('panels', () => {
  it('places new panels below the row content', () => {
    expect(bottomOf(content().rows[0], { w: 3, h: 4 })).toEqual({ x: 0, y: 8, w: 3, h: 4 });
    expect(blankPanel(content().rows[1], 'stat').layout).toEqual({ x: 0, y: 0, w: 3, h: 4 });
  });

  it('adds, replaces and moves panels between rows', () => {
    const added = upsertPanel(content(), 'b', panel('p3'));
    expect(added.rows[1].panels.map((item) => item.id)).toEqual(['p3']);

    const renamed = upsertPanel(content(), 'a', { ...panel('p1'), title: 'CPU' });
    expect(renamed.rows[0].panels[0].title).toBe('CPU');

    const moved = upsertPanel(content(), 'b', panel('p2'));
    expect(moved.rows[0].panels.map((item) => item.id)).toEqual(['p1']);
    expect(moved.rows[1].panels[0]).toMatchObject({ id: 'p2', layout: { x: 0, y: 0, w: 6, h: 8 } });
  });

  it('duplicates with a new id below and removes', () => {
    const copied = duplicatePanel(content(), 'p1');
    const copy = copied.rows[0].panels[2];
    expect(copy.id).not.toBe('p1');
    expect(copy.title).toBe('p1 (copy)');
    expect(copy.layout.y).toBe(8);
    expect(removePanel(copied, 'p1').rows[0].panels.map((item) => item.id)).toEqual(['p2', copy.id]);
  });

  it('applies grid positions, clamped to the grid, and keeps identity when nothing moved', () => {
    const base = content();
    expect(applyLayout(base, 'a', [{ i: 'p1', x: 0, y: 0, w: 6, h: 8 }])).toBe(base);
    const moved = applyLayout(base, 'a', [{ i: 'p1', x: 10, y: 3, w: 6, h: 1 }]);
    expect(moved.rows[0].panels[0].layout).toEqual({ x: 6, y: 3, w: 6, h: 2 });
    expect(base.rows[0].panels[0].layout).toEqual({ x: 0, y: 0, w: 6, h: 8 });
  });
});

describe('rows', () => {
  it('adds, renames, moves and removes rows', () => {
    const added = addRow(content(), 'C');
    expect(added.rows.map((row) => row.title)).toEqual(['A', 'B', 'C']);
    expect(updateRow(added, 'a', { title: 'Alpha', collapsed: true }).rows[0]).toMatchObject({ title: 'Alpha', collapsed: true });
    expect(moveRow(added, 'b', -1).rows.map((row) => row.id).slice(0, 2)).toEqual(['b', 'a']);
    expect(moveRow(added, 'a', -1)).toBe(added);
    expect(removeRow(added, 'a').rows.map((row) => row.id)).toEqual(['b', added.rows[2].id]);
  });
});

describe('import and export', () => {
  it('round-trips arbitrary labels, groups, units and queries without host bindings', () => {
    const dashboard: TelemetryDashboardContent = {
      title: 'Devices', description: '',
      variables: [{ name: 'device', label: 'Device', source: 'device_id', multi: true }],
      rows: [{ id: 'devices', title: 'Devices', repeat: 'device', panels: [{
        ...panel('latency', { x: 0, y: 0, w: 6, h: 8 }),
        unit: 'milliseconds', queries: [{ expr: 'device_latency{device_id=~"$device"}', legend: '{{device_id}}' }],
      }] }],
    };
    expect(parseImport(exportJson(dashboard as never))).toEqual(dashboard);
  });
  it('exports content only and reads it back', () => {
    const json = exportJson({ ...content(), uid: 'x', version: 3, templateKey: null, updatedAt: '', updatedBy: null } as never);
    expect(JSON.parse(json)).not.toHaveProperty('uid');
    expect(parseImport(json)).toEqual(content());
    expect(exportFileName('Linux host / CPU')).toBe('linux-host-cpu.json');
    const withDefaults = { ...content(), defaults: { range: '24h' as const, refresh: 60 } };
    expect(parseImport(exportJson(withDefaults as never))).toEqual(withDefaults);
  });

  it('explains files that are not dashboards', () => {
    expect(() => parseImport('{')).toThrow('not valid JSON');
    expect(() => parseImport('[]')).toThrow('does not contain a dashboard');
    expect(() => parseImport('{"title":"x"}')).toThrow('needs a title and rows');
  });
});

describe('diffDashboards', () => {
  it('describes what changed between two versions', () => {
    const before = content();
    const after = upsertPanel(
      removePanel(updateRow(addRow({ ...before, title: 'Hosts 2', variables: [{ name: 'host', label: 'Host', source: 'host' }] }, 'Disks'), 'a', { title: 'Alpha' }), 'p2'),
      'a',
      { ...panel('p1', { x: 6, y: 0, w: 6, h: 8 }) },
    );
    expect(diffDashboards(before, after).changes).toEqual([
      'Title changed from "Hosts" to "Hosts 2"',
      'Variable $host added',
      `Row "Disks" added`,
      'Row "A" renamed to "Alpha"',
      'Panel "p2" removed',
      '1 panel(s) moved or resized',
    ]);
    expect(diffDashboards(before, before).changes).toEqual([]);
  });
});
