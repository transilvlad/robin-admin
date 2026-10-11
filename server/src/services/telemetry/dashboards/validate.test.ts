import { describe, expect, it } from 'vitest';
import { parseDashboardContent, TelemetryValidationError } from './validate.js';

const panel = (overrides: Record<string, unknown> = {}) => ({
  id: 'p1',
  title: 'CPU',
  type: 'timeseries',
  unit: 'percent',
  queries: [{ expr: 'avg(rate(host_cpu_seconds_total{host=~"$host"}[$__rate_interval]))', legend: '{{host}}' }],
  layout: { x: 0, y: 0, w: 6, h: 8 },
  ...overrides,
});

const dashboard = (overrides: Record<string, unknown> = {}) => ({
  title: 'Hosts',
  description: 'Every host.',
  variables: [{ name: 'host', label: 'Host', source: 'host' }],
  rows: [{ id: 'cpu', title: 'CPU', panels: [panel()] }],
  ...overrides,
});

function problems(input: unknown): string[] {
  try {
    parseDashboardContent(input);
  } catch (error) {
    if (error instanceof TelemetryValidationError) return error.problems;
    throw error;
  }
  return [];
}

describe('parseDashboardContent', () => {
  it('accepts a valid dashboard, trims text and drops unknown fields', () => {
    const parsed = parseDashboardContent({ ...dashboard({ title: '  Hosts  ' }), owner: 'x', rows: [{ id: 'cpu', title: 'CPU', extra: 1, panels: [panel({ colour: 'red' })] }] });
    expect(parsed.title).toBe('Hosts');
    expect(parsed).not.toHaveProperty('owner');
    expect(parsed.rows[0]).not.toHaveProperty('extra');
    expect(parsed.rows[0].panels[0]).not.toHaveProperty('colour');
  });

  it('allows an empty dashboard', () => {
    expect(parseDashboardContent({ title: 'Empty', rows: [] })).toEqual({ title: 'Empty', description: '', variables: [], rows: [] });
  });

  it('rejects queries using undeclared variables or broken syntax', () => {
    expect(problems(dashboard({ variables: [] }))).toEqual([expect.stringContaining('Unknown variable $host')]);
    expect(problems(dashboard({ rows: [{ id: 'cpu', title: 'CPU', panels: [panel({ queries: [{ expr: 'sum(up' }] })] }] })))
      .toEqual([expect.stringContaining('unbalanced')]);
  });

  it('only lets a variable selector use earlier variables', () => {
    expect(problems(dashboard({
      variables: [
        { name: 'host', label: 'Host', source: 'host', match: 'up{role=~"$role"}' },
        { name: 'role', label: 'Role', source: 'role' },
      ],
    }))).toEqual([expect.stringContaining('Unknown variable $role')]);
  });

  it('keeps panels inside the grid and ids unique', () => {
    expect(problems(dashboard({ rows: [{ id: 'cpu', title: 'CPU', panels: [panel({ layout: { x: 8, y: 0, w: 6, h: 8 } })] }] })))
      .toEqual([expect.stringContaining('must fit within 12 columns')]);
    expect(problems(dashboard({ rows: [{ id: 'cpu', title: 'CPU', panels: [panel(), panel()] }] })))
      .toEqual([expect.stringContaining('panel id p1 is used twice')]);
    expect(problems(dashboard({ rows: [{ id: 'cpu', title: 'A', panels: [] }, { id: 'cpu', title: 'B', panels: [] }] })))
      .toEqual([expect.stringContaining('duplicates cpu')]);
  });

  it('reports every bad field at once', () => {
    const found = problems({
      title: '',
      variables: [{ name: '__bad', label: 'x', source: 'not a label' }],
      rows: [{ id: 'r', title: 'R', panels: [panel({ type: 'pie', unit: 'furlongs', layout: { x: 0, y: 0, w: 0, h: 1 } })] }],
    });
    expect(found).toEqual(expect.arrayContaining([
      'title: is required',
      expect.stringContaining('variables[0].name'),
      expect.stringContaining('variables[0].source'),
      expect.stringContaining('.type'),
      expect.stringContaining('.unit'),
      expect.stringContaining('layout.w'),
      expect.stringContaining('layout.h'),
    ]));
  });

  it('rejects non-objects', () => {
    expect(problems('nope')).toEqual(['dashboard: must be an object']);
  });

  it('accepts display options, links, repeats and defaults', () => {
    const parsed = parseDashboardContent(dashboard({
      defaults: { range: '24h', refresh: 60 },
      rows: [{
        id: 'cpu',
        title: 'CPU',
        repeat: 'host',
        panels: [panel({
          legend: 'max',
          decimals: 2,
          logScale: true,
          tableBy: 'host',
          link: { dashboardUid: 'host', variable: 'host', label: 'host' },
          queries: [{ expr: 'up{host=~"$host"}', legend: 'Up', unit: 'count' }],
        })],
      }],
    }));
    expect(parsed.defaults).toEqual({ range: '24h', refresh: 60 });
    expect(parsed.rows[0].repeat).toBe('host');
    expect(parsed.rows[0].panels[0]).toMatchObject({
      legend: 'max', decimals: 2, logScale: true, tableBy: 'host',
      link: { dashboardUid: 'host', variable: 'host', label: 'host' },
      queries: [{ expr: 'up{host=~"$host"}', legend: 'Up', unit: 'count' }],
    });
  });

  it('drops default display options and rejects bad ones', () => {
    const parsed = parseDashboardContent(dashboard({ defaults: { refresh: 0 }, rows: [{ id: 'cpu', title: 'CPU', panels: [panel({ legend: 'last' })] }] }));
    expect(parsed).not.toHaveProperty('defaults');
    expect(parsed.rows[0].panels[0]).not.toHaveProperty('legend');
    expect(problems(dashboard({
      defaults: { range: '2y', refresh: 7 },
      rows: [{ id: 'cpu', title: 'CPU', repeat: 'vm', panels: [panel({ legend: 'median', decimals: 9, tableBy: 'not a label', link: { dashboardUid: 'a b', variable: '1x', label: '' } })] }],
    }))).toEqual(expect.arrayContaining([
      expect.stringContaining('defaults.range'),
      expect.stringContaining('defaults.refresh'),
      expect.stringContaining('uses unknown variable vm'),
      expect.stringContaining('.legend'),
      expect.stringContaining('.decimals'),
      expect.stringContaining('.tableBy'),
      expect.stringContaining('link.dashboardUid'),
      expect.stringContaining('link.variable'),
      expect.stringContaining('link.label'),
    ]));
  });

  it('packs panels upwards so stored layouts match the grid', () => {
    const parsed = parseDashboardContent(dashboard({
      rows: [{
        id: 'cpu',
        title: 'CPU',
        panels: [
          panel({ id: 'a', layout: { x: 0, y: 5, w: 6, h: 4 } }),
          panel({ id: 'b', layout: { x: 0, y: 6, w: 6, h: 4 } }),
          panel({ id: 'c', layout: { x: 6, y: 20, w: 6, h: 4 } }),
        ],
      }],
    }));
    expect(parsed.rows[0].panels.map((item) => [item.id, item.layout.y])).toEqual([['a', 0], ['b', 4], ['c', 0]]);
  });
});
