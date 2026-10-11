/**
 * Strict validation of dashboard content saved from the UI or imported as
 * JSON. Unknown fields are dropped, limits keep a dashboard renderable, and
 * every query must use only declared variables and balanced syntax.
 */

import { balancedExpr, renderExpr } from '../expressions.js';
import {
  GRID_COLUMNS,
  LEGEND_MODES,
  PANEL_TYPES,
  RANGE_PRESETS,
  REFRESH_INTERVALS,
  TELEMETRY_UNITS,
  type DashboardContent,
  type DashboardDefaults,
  type DashboardPanel,
  type DashboardRow,
  type DashboardVariable,
  type PanelLayout,
  type PanelLink,
  type PanelQuery,
} from './types.js';

export const DASHBOARD_LIMITS = {
  title: 120,
  description: 500,
  variables: 10,
  rows: 30,
  panelsPerDashboard: 150,
  queriesPerPanel: 10,
  expr: 4000,
  legend: 200,
  match: 1000,
  maxPanelHeight: 30,
  maxY: 1000,
} as const;

const NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;
const ID_RE = /^[a-zA-Z0-9_-]{1,40}$/;

export class TelemetryValidationError extends Error {
  constructor(public readonly problems: string[]) {
    super(problems.slice(0, 5).join('; ') + (problems.length > 5 ? ` (and ${problems.length - 5} more)` : ''));
    this.name = 'TelemetryValidationError';
  }
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

class Checker {
  readonly problems: string[] = [];

  fail(path: string, message: string): void {
    if (this.problems.length < 50) this.problems.push(`${path}: ${message}`);
  }

  string(value: unknown, path: string, max: number, required = true): string | undefined {
    if (value === undefined || value === null || value === '') {
      if (required) this.fail(path, 'is required');
      return undefined;
    }
    if (typeof value !== 'string') {
      this.fail(path, 'must be text');
      return undefined;
    }
    const trimmed = value.trim();
    if (required && !trimmed) {
      this.fail(path, 'is required');
      return undefined;
    }
    if (trimmed.length > max) this.fail(path, `must be at most ${max} characters`);
    return trimmed || undefined;
  }

  number(value: unknown, path: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(path, 'must be a number');
      return undefined;
    }
    return value;
  }

  integer(value: unknown, path: string, min: number, max: number): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      this.fail(path, `must be a whole number from ${min} to ${max}`);
      return min;
    }
    return value;
  }

  flag(value: unknown, path: string): true | undefined {
    if (value === undefined || value === null || value === false) return undefined;
    if (value !== true) this.fail(path, 'must be true or false');
    return value === true ? true : undefined;
  }

  array(value: unknown, path: string, max: number): unknown[] {
    if (value === undefined) return [];
    if (!Array.isArray(value)) {
      this.fail(path, 'must be a list');
      return [];
    }
    if (value.length > max) this.fail(path, `may have at most ${max} entries`);
    return value.slice(0, max);
  }

  expr(value: string | undefined, path: string, allowed: Set<string>): void {
    if (!value) return;
    try {
      const rendered = renderExpr(value, {}, 60, allowed);
      if (!balancedExpr(rendered)) this.fail(path, 'has unbalanced brackets or quotes');
    } catch (error) {
      this.fail(path, (error as Error).message);
    }
  }
}

function parseVariables(check: Checker, raw: unknown): DashboardVariable[] {
  const variables: DashboardVariable[] = [];
  const names = new Set<string>();
  check.array(raw, 'variables', DASHBOARD_LIMITS.variables).forEach((entry, index) => {
    const path = `variables[${index}]`;
    if (!isRecord(entry)) {
      check.fail(path, 'must be an object');
      return;
    }
    const name = check.string(entry.name, `${path}.name`, 40) ?? '';
    if (name && (!NAME_RE.test(name) || name.startsWith('__'))) check.fail(`${path}.name`, 'must be letters, digits and underscores, not starting with a digit or __');
    if (names.has(name)) check.fail(`${path}.name`, `duplicates ${name}`);
    const source = check.string(entry.source, `${path}.source`, 100) ?? '';
    if (source && !NAME_RE.test(source)) check.fail(`${path}.source`, 'must be a label name');
    const match = check.string(entry.match, `${path}.match`, DASHBOARD_LIMITS.match, false);
    check.expr(match, `${path}.match`, new Set(names));
    names.add(name);
    variables.push({
      name,
      label: check.string(entry.label, `${path}.label`, 60) ?? name,
      source,
      ...(match ? { match } : {}),
      ...(check.flag(entry.multi, `${path}.multi`) ? { multi: true } : {}),
    });
  });
  return variables;
}

function parseQueries(check: Checker, raw: unknown, path: string, allowed: Set<string>): PanelQuery[] {
  const entries = check.array(raw, path, DASHBOARD_LIMITS.queriesPerPanel);
  if (entries.length === 0) check.fail(path, 'needs at least one query');
  return entries.map((entry, index) => {
    const queryPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      check.fail(queryPath, 'must be an object');
      return { expr: '' };
    }
    const expr = check.string(entry.expr, `${queryPath}.expr`, DASHBOARD_LIMITS.expr) ?? '';
    check.expr(expr, `${queryPath}.expr`, allowed);
    const legend = check.string(entry.legend, `${queryPath}.legend`, DASHBOARD_LIMITS.legend, false);
    const unit = entry.unit === undefined || entry.unit === null || entry.unit === '' ? undefined : entry.unit as PanelQuery['unit'];
    if (unit !== undefined && !TELEMETRY_UNITS.includes(unit)) check.fail(`${queryPath}.unit`, 'is not a known unit');
    return { expr, ...(legend ? { legend } : {}), ...(unit ? { unit } : {}) };
  });
}

function parsePanel(check: Checker, raw: unknown, path: string, allowed: Set<string>): DashboardPanel | null {
  if (!isRecord(raw)) {
    check.fail(path, 'must be an object');
    return null;
  }
  const id = check.string(raw.id, `${path}.id`, 40) ?? '';
  if (id && !ID_RE.test(id)) check.fail(`${path}.id`, 'must be letters, digits, - or _');
  const type = raw.type as DashboardPanel['type'];
  if (!PANEL_TYPES.includes(type)) check.fail(`${path}.type`, `must be one of ${PANEL_TYPES.join(', ')}`);
  const unit = raw.unit as DashboardPanel['unit'];
  if (!TELEMETRY_UNITS.includes(unit)) check.fail(`${path}.unit`, 'is not a known unit');

  const layout = isRecord(raw.layout) ? raw.layout : {};
  if (!isRecord(raw.layout)) check.fail(`${path}.layout`, 'is required');
  const w = check.integer(layout.w, `${path}.layout.w`, 1, GRID_COLUMNS);
  const x = check.integer(layout.x, `${path}.layout.x`, 0, GRID_COLUMNS - 1);
  if (x + w > GRID_COLUMNS) check.fail(`${path}.layout`, `must fit within ${GRID_COLUMNS} columns`);

  const thresholds = isRecord(raw.thresholds) ? raw.thresholds : undefined;
  const warning = check.number(thresholds?.warning, `${path}.thresholds.warning`);
  const critical = check.number(thresholds?.critical, `${path}.thresholds.critical`);
  const min = check.number(raw.min, `${path}.min`);
  const max = check.number(raw.max, `${path}.max`);
  const description = check.string(raw.description, `${path}.description`, 300, false);
  const legend = raw.legend === undefined || raw.legend === null || raw.legend === 'last' ? undefined : raw.legend as DashboardPanel['legend'];
  if (legend !== undefined && !LEGEND_MODES.includes(legend)) check.fail(`${path}.legend`, `must be one of ${LEGEND_MODES.join(', ')}`);
  const decimals = raw.decimals === undefined || raw.decimals === null ? undefined : check.integer(raw.decimals, `${path}.decimals`, 0, 6);
  const tableBy = check.string(raw.tableBy, `${path}.tableBy`, 100, false);
  if (tableBy && !NAME_RE.test(tableBy)) check.fail(`${path}.tableBy`, 'must be a label name');
  const link = parseLink(check, raw.link, `${path}.link`);

  return {
    id,
    title: check.string(raw.title, `${path}.title`, DASHBOARD_LIMITS.title) ?? '',
    ...(description ? { description } : {}),
    type,
    unit,
    queries: parseQueries(check, raw.queries, `${path}.queries`, allowed),
    layout: {
      x,
      y: check.integer(layout.y, `${path}.layout.y`, 0, DASHBOARD_LIMITS.maxY),
      w,
      h: check.integer(layout.h, `${path}.layout.h`, 2, DASHBOARD_LIMITS.maxPanelHeight),
    },
    ...(check.flag(raw.stacked, `${path}.stacked`) ? { stacked: true } : {}),
    ...(min !== undefined ? { min } : {}),
    ...(max !== undefined ? { max } : {}),
    ...(warning !== undefined || critical !== undefined
      ? { thresholds: { ...(warning !== undefined ? { warning } : {}), ...(critical !== undefined ? { critical } : {}) } }
      : {}),
    ...(check.flag(raw.invertThresholds, `${path}.invertThresholds`) ? { invertThresholds: true } : {}),
    ...(check.flag(raw.optional, `${path}.optional`) ? { optional: true } : {}),
    ...(legend ? { legend } : {}),
    ...(decimals !== undefined ? { decimals } : {}),
    ...(check.flag(raw.logScale, `${path}.logScale`) ? { logScale: true } : {}),
    ...(tableBy ? { tableBy } : {}),
    ...(link ? { link } : {}),
  };
}

function parseLink(check: Checker, raw: unknown, path: string): PanelLink | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    check.fail(path, 'must be an object');
    return undefined;
  }
  const dashboardUid = check.string(raw.dashboardUid, `${path}.dashboardUid`, 40) ?? '';
  if (dashboardUid && !ID_RE.test(dashboardUid)) check.fail(`${path}.dashboardUid`, 'is not a dashboard id');
  const variable = check.string(raw.variable, `${path}.variable`, 40) ?? '';
  if (variable && !NAME_RE.test(variable)) check.fail(`${path}.variable`, 'must be a variable name');
  const label = check.string(raw.label, `${path}.label`, 100) ?? '';
  if (label && !NAME_RE.test(label)) check.fail(`${path}.label`, 'must be a label name');
  return { dashboardUid, variable, label };
}

function parseDefaults(check: Checker, raw: unknown): DashboardDefaults | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (!isRecord(raw)) {
    check.fail('defaults', 'must be an object');
    return undefined;
  }
  const defaults: DashboardDefaults = {};
  if (raw.range !== undefined && raw.range !== null) {
    if ((RANGE_PRESETS as readonly unknown[]).includes(raw.range)) defaults.range = raw.range as DashboardDefaults['range'];
    else check.fail('defaults.range', `must be one of ${RANGE_PRESETS.join(', ')}`);
  }
  if (raw.refresh !== undefined && raw.refresh !== null && raw.refresh !== 0) {
    if ((REFRESH_INTERVALS as readonly unknown[]).includes(raw.refresh)) defaults.refresh = raw.refresh as number;
    else check.fail('defaults.refresh', `must be one of ${REFRESH_INTERVALS.join(', ')} seconds`);
  }
  return Object.keys(defaults).length > 0 ? defaults : undefined;
}

function collides(a: PanelLayout, b: PanelLayout): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Pack panels upwards the way the dashboard grid does, so a stored layout is
 * exactly what the grid shows and opening edit mode changes nothing.
 */
export function compactPanels(panels: DashboardPanel[]): DashboardPanel[] {
  const order = [...panels].sort((a, b) => a.layout.y - b.layout.y || a.layout.x - b.layout.x);
  const placed: PanelLayout[] = [];
  const positions = new Map<string, number>();
  for (const panel of order) {
    let y = panel.layout.y;
    while (placed.some((other) => collides({ ...panel.layout, y }, other))) y++;
    while (y > 0 && !placed.some((other) => collides({ ...panel.layout, y: y - 1 }, other))) y--;
    placed.push({ ...panel.layout, y });
    positions.set(panel.id, y);
  }
  return panels.map((panel) => (positions.get(panel.id) === panel.layout.y
    ? panel
    : { ...panel, layout: { ...panel.layout, y: positions.get(panel.id)! } }));
}

/** Validate and normalise dashboard content; throws TelemetryValidationError. */
export function parseDashboardContent(input: unknown): DashboardContent {
  const check = new Checker();
  if (!isRecord(input)) throw new TelemetryValidationError(['dashboard: must be an object']);

  const title = check.string(input.title, 'title', DASHBOARD_LIMITS.title) ?? '';
  const description = check.string(input.description, 'description', DASHBOARD_LIMITS.description, false) ?? '';
  const defaults = parseDefaults(check, input.defaults);
  const variables = parseVariables(check, input.variables);
  const allowed = new Set(variables.map((variable) => variable.name));

  const rowIds = new Set<string>();
  const panelIds = new Set<string>();
  let panelCount = 0;
  const rows: DashboardRow[] = check.array(input.rows, 'rows', DASHBOARD_LIMITS.rows).map((entry, index) => {
    const path = `rows[${index}]`;
    if (!isRecord(entry)) {
      check.fail(path, 'must be an object');
      return { id: `row-${index}`, title: '', panels: [] };
    }
    const id = check.string(entry.id, `${path}.id`, 40) ?? '';
    if (id && !ID_RE.test(id)) check.fail(`${path}.id`, 'must be letters, digits, - or _');
    if (rowIds.has(id)) check.fail(`${path}.id`, `duplicates ${id}`);
    rowIds.add(id);
    const panels = check.array(entry.panels, `${path}.panels`, DASHBOARD_LIMITS.panelsPerDashboard)
      .map((panel, panelIndex) => parsePanel(check, panel, `${path}.panels[${panelIndex}]`, allowed))
      .filter((panel): panel is DashboardPanel => panel !== null);
    for (const panel of panels) {
      if (panelIds.has(panel.id)) check.fail(`${path}.panels`, `panel id ${panel.id} is used twice`);
      panelIds.add(panel.id);
    }
    panelCount += panels.length;
    const repeat = check.string(entry.repeat, `${path}.repeat`, 40, false);
    if (repeat && !allowed.has(repeat)) check.fail(`${path}.repeat`, `uses unknown variable ${repeat}`);
    return {
      id,
      title: check.string(entry.title, `${path}.title`, 80) ?? '',
      ...(check.flag(entry.collapsed, `${path}.collapsed`) ? { collapsed: true } : {}),
      ...(repeat ? { repeat } : {}),
      panels: compactPanels(panels),
    };
  });
  if (panelCount > DASHBOARD_LIMITS.panelsPerDashboard) {
    check.fail('rows', `may hold at most ${DASHBOARD_LIMITS.panelsPerDashboard} panels in total`);
  }

  if (check.problems.length > 0) throw new TelemetryValidationError(check.problems);
  return { title, description, ...(defaults ? { defaults } : {}), variables, rows };
}
