/**
 * Runs dashboard panels and variable lookups: substitutes variables into the
 * panel's PromQL, runs each query, and merges the results onto one timestamp
 * array with formatted series names. Saved panels are loaded from the
 * database; previews run an unsaved panel from the editor after validation.
 */

import { labelValues, queryRange, resolveStep, type Labels } from './query.js';
import { formatSeriesName, renderExpr, type VariableValues } from './expressions.js';
import { getPanel, parseDashboardContent, type DashboardPanel, type DashboardVariable } from './dashboards/index.js';
import { getTelemetryDashboard } from '../../db/queries/telemetry-dashboards.js';

export interface PanelResult {
  start: number;
  end: number;
  step: number;
  timestamps: number[];
  series: Array<{ name: string; query: number; labels: Labels; values: Array<number | null> }>;
  truncated: boolean;
}

interface RangeInput {
  start: unknown;
  end: unknown;
  step?: unknown;
}

export class TelemetryNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryNotFoundError';
  }
}

async function loadDashboard(uid: string) {
  const dashboard = await getTelemetryDashboard(uid);
  if (!dashboard) throw new TelemetryNotFoundError('Dashboard not found');
  return dashboard;
}

/** Resolve the step for a range once, so every query and $__rate_interval agree. */
function stepFor(range: RangeInput): number | undefined {
  const start = Number(range.start);
  const end = Number(range.end);
  const requested = range.step === undefined || range.step === '' ? undefined : Number(range.step);
  return Number.isFinite(start) && Number.isFinite(end) && end > start
    ? resolveStep(Math.ceil(end) - Math.floor(start), Number.isFinite(requested) ? requested : undefined)
    : undefined;
}

async function executePanel(panel: DashboardPanel, variables: DashboardVariable[], values: VariableValues, range: RangeInput): Promise<PanelResult> {
  const start = Number(range.start);
  const end = Number(range.end);
  const step = stepFor(range);
  const allowed = new Set(variables.map((variable) => variable.name));

  const results = await Promise.all(panel.queries.map((query) => queryRange({
    query: renderExpr(query.expr, values, step ?? 60, allowed),
    start: range.start,
    end: range.end,
    step,
  })));

  const timestampSet = new Set<number>();
  for (const result of results) for (const timestamp of result.timestamps) timestampSet.add(timestamp);
  const timestamps = [...timestampSet].sort((a, b) => a - b);
  const index = new Map(timestamps.map((timestamp, i) => [timestamp, i]));

  const series: PanelResult['series'] = [];
  results.forEach((result, queryIndex) => {
    const fallback = panel.queries.length > 1 ? `${panel.title} ${queryIndex + 1}` : panel.title;
    for (const item of result.series) {
      const aligned: Array<number | null> = new Array(timestamps.length).fill(null);
      result.timestamps.forEach((timestamp, i) => {
        aligned[index.get(timestamp)!] = item.values[i];
      });
      series.push({
        name: formatSeriesName(panel.queries[queryIndex].legend, item.labels, fallback),
        query: queryIndex,
        labels: item.labels,
        values: aligned,
      });
    }
  });

  return {
    start: results[0]?.start ?? Math.floor(start),
    end: results[0]?.end ?? Math.ceil(end),
    step: results[0]?.step ?? step ?? 0,
    timestamps,
    series,
    truncated: results.some((result) => result.truncated),
  };
}

/** A saved panel's queries with variables and intervals filled in, for Explore. */
export async function renderPanelQueries(input: RangeInput & { dashboardUid: string; panelId: string; values: VariableValues }) {
  const dashboard = await loadDashboard(input.dashboardUid);
  const panel = getPanel(dashboard, input.panelId);
  if (!panel) throw new TelemetryNotFoundError('Panel not found');
  const step = stepFor(input) ?? 60;
  const allowed = new Set(dashboard.variables.map((variable) => variable.name));
  return {
    step,
    unit: panel.unit,
    queries: panel.queries.map((query) => ({ expr: renderExpr(query.expr, input.values, step, allowed), legend: query.legend })),
  };
}

export async function runPanel(input: RangeInput & { dashboardUid: string; panelId: string; values: VariableValues }): Promise<PanelResult> {
  const dashboard = await loadDashboard(input.dashboardUid);
  const panel = getPanel(dashboard, input.panelId);
  if (!panel) throw new TelemetryNotFoundError('Panel not found');
  return executePanel(panel, dashboard.variables, input.values, input);
}

/** Run a panel that has not been saved, validated with the variables it uses. */
export async function previewPanel(input: RangeInput & { panel: unknown; variables: unknown; values: VariableValues }): Promise<PanelResult> {
  const content = parseDashboardContent({
    title: 'Preview',
    variables: input.variables,
    rows: [{ id: 'preview', title: 'Preview', panels: [input.panel] }],
  });
  return executePanel(content.rows[0].panels[0], content.variables, input.values, input);
}

async function optionsFor(variables: DashboardVariable[], name: string, values: VariableValues, range: Partial<RangeInput>): Promise<string[]> {
  const position = variables.findIndex((variable) => variable.name === name);
  if (position < 0) throw new TelemetryNotFoundError('Variable not found');
  const variable = variables[position];
  const earlier = new Set(variables.slice(0, position).map((candidate) => candidate.name));
  const match = variable.match ? renderExpr(variable.match, values, 60, earlier) : undefined;
  const options = await labelValues({ name: variable.source, match, start: range.start, end: range.end });
  return [...options].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
}

/** Options for one saved dashboard variable, honouring earlier variables' selections. */
export async function variableOptions(input: Partial<RangeInput> & { dashboardUid: string; name: string; values: VariableValues }): Promise<string[]> {
  const dashboard = await loadDashboard(input.dashboardUid);
  return optionsFor(dashboard.variables, input.name, input.values, input);
}

/** Options for a variable being edited, before the dashboard is saved. */
export async function previewVariableOptions(input: Partial<RangeInput> & { variables: unknown; name: string; values: VariableValues }): Promise<string[]> {
  const { variables } = parseDashboardContent({ title: 'Preview', variables: input.variables, rows: [] });
  return optionsFor(variables, input.name, input.values, input);
}
