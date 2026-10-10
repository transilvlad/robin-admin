/**
 * Pure edits on dashboard content for the dashboard editor. Every function
 * returns new content and leaves its input untouched.
 */

import {
  GRID_COLUMNS,
  type TelemetryDashboard,
  type TelemetryDashboardContent,
  type TelemetryPanel,
  type TelemetryPanelLayout,
  type TelemetryPanelType,
  type TelemetryRow,
} from '../types/telemetry';

export function newId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${random}`;
}

/** The editable part of a stored dashboard. */
export function contentOf(dashboard: TelemetryDashboard | TelemetryDashboardContent): TelemetryDashboardContent {
  return {
    title: dashboard.title,
    description: dashboard.description,
    variables: dashboard.variables,
    rows: dashboard.rows,
    ...(dashboard.defaults ? { defaults: dashboard.defaults } : {}),
  };
}

export function defaultSize(type: TelemetryPanelType): Pick<TelemetryPanelLayout, 'w' | 'h'> {
  return type === 'stat' ? { w: 3, h: 4 } : { w: 6, h: 8 };
}

/** A position below everything already in the row. */
export function bottomOf(row: TelemetryRow, size: Pick<TelemetryPanelLayout, 'w' | 'h'>): TelemetryPanelLayout {
  const y = row.panels.reduce((max, panel) => Math.max(max, panel.layout.y + panel.layout.h), 0);
  return { x: 0, y, w: size.w, h: size.h };
}

export function blankPanel(row: TelemetryRow, type: TelemetryPanelType = 'timeseries'): TelemetryPanel {
  return {
    id: newId('panel'),
    title: 'New panel',
    type,
    unit: 'none',
    queries: [{ expr: '' }],
    layout: bottomOf(row, defaultSize(type)),
  };
}

function mapRows(content: TelemetryDashboardContent, map: (row: TelemetryRow) => TelemetryRow): TelemetryDashboardContent {
  return { ...content, rows: content.rows.map(map) };
}

export function findPanel(content: TelemetryDashboardContent, panelId: string): { row: TelemetryRow; panel: TelemetryPanel } | null {
  for (const row of content.rows) {
    const panel = row.panels.find((candidate) => candidate.id === panelId);
    if (panel) return { row, panel };
  }
  return null;
}

/** Add a panel to a row, or replace it (same id) and optionally move it to another row. */
export function upsertPanel(content: TelemetryDashboardContent, rowId: string, panel: TelemetryPanel): TelemetryDashboardContent {
  const existing = findPanel(content, panel.id);
  const moving = existing && existing.row.id !== rowId;
  return mapRows(content, (row) => {
    if (row.id === rowId) {
      if (existing && !moving) {
        return { ...row, panels: row.panels.map((candidate) => (candidate.id === panel.id ? panel : candidate)) };
      }
      const layout = moving || !existing ? bottomOf(row, { w: panel.layout.w, h: panel.layout.h }) : panel.layout;
      return { ...row, panels: [...row.panels, { ...panel, layout }] };
    }
    if (moving && row.id === existing.row.id) {
      return { ...row, panels: row.panels.filter((candidate) => candidate.id !== panel.id) };
    }
    return row;
  });
}

export function removePanel(content: TelemetryDashboardContent, panelId: string): TelemetryDashboardContent {
  return mapRows(content, (row) => ({ ...row, panels: row.panels.filter((panel) => panel.id !== panelId) }));
}

export function duplicatePanel(content: TelemetryDashboardContent, panelId: string): TelemetryDashboardContent {
  const found = findPanel(content, panelId);
  if (!found) return content;
  const copy: TelemetryPanel = {
    ...structuredClone(found.panel),
    id: newId('panel'),
    title: `${found.panel.title} (copy)`.slice(0, 120),
    layout: bottomOf(found.row, { w: found.panel.layout.w, h: found.panel.layout.h }),
  };
  return mapRows(content, (row) => (row.id === found.row.id ? { ...row, panels: [...row.panels, copy] } : row));
}

/** Apply positions from the grid after a drag or resize. */
export function applyLayout(content: TelemetryDashboardContent, rowId: string, layout: ReadonlyArray<{ i: string } & TelemetryPanelLayout>): TelemetryDashboardContent {
  const byId = new Map(layout.map((item) => [item.i, item]));
  let changed = false;
  const next = mapRows(content, (row) => {
    if (row.id !== rowId) return row;
    return {
      ...row,
      panels: row.panels.map((panel) => {
        const item = byId.get(panel.id);
        if (!item) return panel;
        const w = Math.max(1, Math.min(GRID_COLUMNS, item.w));
        const updated = { x: Math.max(0, Math.min(GRID_COLUMNS - w, item.x)), y: Math.max(0, item.y), w, h: Math.max(2, item.h) };
        if (updated.x === panel.layout.x && updated.y === panel.layout.y && updated.w === panel.layout.w && updated.h === panel.layout.h) {
          return panel;
        }
        changed = true;
        return { ...panel, layout: updated };
      }),
    };
  });
  return changed ? next : content;
}

export function addRow(content: TelemetryDashboardContent, title = 'New row'): TelemetryDashboardContent {
  return { ...content, rows: [...content.rows, { id: newId('row'), title, panels: [] }] };
}

export function updateRow(content: TelemetryDashboardContent, rowId: string, patch: Partial<Pick<TelemetryRow, 'title' | 'collapsed' | 'repeat'>>): TelemetryDashboardContent {
  return mapRows(content, (row) => (row.id === rowId ? { ...row, ...patch } : row));
}

export function moveRow(content: TelemetryDashboardContent, rowId: string, delta: -1 | 1): TelemetryDashboardContent {
  const index = content.rows.findIndex((row) => row.id === rowId);
  const target = index + delta;
  if (index < 0 || target < 0 || target >= content.rows.length) return content;
  const rows = [...content.rows];
  [rows[index], rows[target]] = [rows[target], rows[index]];
  return { ...content, rows };
}

export function removeRow(content: TelemetryDashboardContent, rowId: string): TelemetryDashboardContent {
  return { ...content, rows: content.rows.filter((row) => row.id !== rowId) };
}

export function exportFileName(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'dashboard';
  return `${slug}.json`;
}

/** Dashboard JSON for download: the editable content only. */
export function exportJson(dashboard: TelemetryDashboard | TelemetryDashboardContent): string {
  return `${JSON.stringify(contentOf(dashboard), null, 2)}\n`;
}

/** Read an exported dashboard; the server validates it fully on create. */
export function parseImport(text: string): TelemetryDashboardContent {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error('The file is not valid JSON.');
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error('The file does not contain a dashboard.');
  }
  const record = value as Partial<TelemetryDashboardContent>;
  if (typeof record.title !== 'string' || !Array.isArray(record.rows)) {
    throw new Error('The file does not contain a dashboard: it needs a title and rows.');
  }
  return {
    title: record.title,
    description: typeof record.description === 'string' ? record.description : '',
    variables: Array.isArray(record.variables) ? record.variables : [],
    rows: record.rows,
    ...(record.defaults && typeof record.defaults === 'object' ? { defaults: record.defaults } : {}),
  };
}

export interface DashboardDiff {
  /** Plain-language changes from `from` to `to`, most significant first. */
  changes: string[];
}

/** What changed between two versions of a dashboard, in words. */
export function diffDashboards(from: TelemetryDashboardContent, to: TelemetryDashboardContent): DashboardDiff {
  const changes: string[] = [];
  if (from.title !== to.title) changes.push(`Title changed from "${from.title}" to "${to.title}"`);
  if (from.description !== to.description) changes.push('Description changed');
  if (JSON.stringify(from.defaults ?? {}) !== JSON.stringify(to.defaults ?? {})) changes.push('Default range or refresh changed');

  const fromVariables = new Map(from.variables.map((variable) => [variable.name, variable]));
  const toVariables = new Map(to.variables.map((variable) => [variable.name, variable]));
  for (const name of toVariables.keys()) if (!fromVariables.has(name)) changes.push(`Variable $${name} added`);
  for (const name of fromVariables.keys()) if (!toVariables.has(name)) changes.push(`Variable $${name} removed`);
  for (const [name, variable] of toVariables) {
    const before = fromVariables.get(name);
    if (before && JSON.stringify(before) !== JSON.stringify(variable)) changes.push(`Variable $${name} changed`);
  }

  const fromRows = new Map(from.rows.map((row) => [row.id, row]));
  const toRows = new Map(to.rows.map((row) => [row.id, row]));
  for (const [id, row] of toRows) if (!fromRows.has(id)) changes.push(`Row "${row.title}" added`);
  for (const [id, row] of fromRows) if (!toRows.has(id)) changes.push(`Row "${row.title}" removed`);
  for (const [id, row] of toRows) {
    const before = fromRows.get(id);
    if (!before) continue;
    if (before.title !== row.title) changes.push(`Row "${before.title}" renamed to "${row.title}"`);
    if ((before.repeat ?? '') !== (row.repeat ?? '')) changes.push(`Row "${row.title}" repeat changed`);
  }
  if (from.rows.map((row) => row.id).filter((id) => toRows.has(id)).join() !== to.rows.map((row) => row.id).filter((id) => fromRows.has(id)).join()) {
    changes.push('Rows reordered');
  }

  const panelsOf = (content: TelemetryDashboardContent) => new Map(content.rows.flatMap((row) => row.panels.map((panel) => [panel.id, { panel, rowId: row.id }] as const)));
  const fromPanels = panelsOf(from);
  const toPanels = panelsOf(to);
  for (const [id, { panel }] of toPanels) if (!fromPanels.has(id)) changes.push(`Panel "${panel.title}" added`);
  for (const [id, { panel }] of fromPanels) if (!toPanels.has(id)) changes.push(`Panel "${panel.title}" removed`);
  let moved = 0;
  for (const [id, { panel, rowId }] of toPanels) {
    const before = fromPanels.get(id);
    if (!before) continue;
    const { layout: beforeLayout, ...beforeRest } = before.panel;
    const { layout, ...rest } = panel;
    if (JSON.stringify(beforeRest) !== JSON.stringify(rest)) changes.push(`Panel "${panel.title}" changed`);
    else if (before.rowId !== rowId || JSON.stringify(beforeLayout) !== JSON.stringify(layout)) moved++;
  }
  if (moved > 0) changes.push(`${moved} panel(s) moved or resized`);
  return { changes };
}
