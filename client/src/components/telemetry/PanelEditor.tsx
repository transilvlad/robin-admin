/**
 * Edit one panel: title, visualisation, unit, PromQL queries with legends,
 * thresholds and display options, and the row it belongs to, with a live
 * preview against the current time range and variables.
 */

import { useEffect, useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { ApiError, telemetryApi } from '../../api/client';
import { Modal } from '../ui/Modal';
import { SegmentedFilter } from '../ui/SegmentedFilter';
import {
  GRID_COLUMNS,
  LEGEND_MODES,
  PANEL_TYPES,
  TELEMETRY_UNITS,
  type TelemetryDashboardSummary,
  type TelemetryLegendMode,
  type TelemetryPanel,
  type TelemetryPanelType,
  type TelemetryRangeData,
  type TelemetryRow,
  type TelemetryUnit,
  type TelemetryVariable,
  type TelemetryVariableValues,
} from '../../types/telemetry';
import { defaultSize } from '../../utils/telemetryDashboard';
import { PanelBody } from './TelemetryPanel';

export const UNIT_LABELS: Record<TelemetryUnit, string> = {
  none: 'Number',
  count: 'Count',
  percent: 'Percent (0-100)',
  percentunit: 'Ratio (0-1)',
  bytes: 'Bytes',
  bytes_per_second: 'Bytes per second',
  bits_per_second: 'Bits per second',
  per_second: 'Per second',
  seconds: 'Seconds',
  milliseconds: 'Milliseconds',
  up_down: 'Up / down',
};

const TYPE_LABELS: Record<TelemetryPanelType, string> = {
  timeseries: 'Time series',
  stat: 'Stat',
  table: 'Table',
};

interface PanelEditorProps {
  panel: TelemetryPanel;
  rowId: string;
  rows: TelemetryRow[];
  variables: TelemetryVariable[];
  values: TelemetryVariableValues;
  start: number;
  end: number;
  isNew: boolean;
  /** Targets for a panel link. */
  dashboards: TelemetryDashboardSummary[];
  onSave: (rowId: string, panel: TelemetryPanel) => void;
  onClose: () => void;
}

const LEGEND_LABELS: Record<TelemetryLegendMode, string> = {
  last: 'Latest value',
  min: 'Minimum',
  max: 'Maximum',
  mean: 'Average',
  hidden: 'No legend',
};

function clampInt(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function numberOrUndefined(value: string): number | undefined {
  if (value.trim() === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Drop empty optional fields so saved panels stay tidy. */
export function cleanPanel(panel: TelemetryPanel): TelemetryPanel {
  const { thresholds, ...rest } = panel;
  const cleaned: TelemetryPanel = {
    ...rest,
    title: panel.title.trim(),
    description: panel.description?.trim() || undefined,
    queries: panel.queries.map((query) => ({
      expr: query.expr.trim(),
      legend: query.legend?.trim() || undefined,
      unit: panel.type === 'table' && panel.tableBy && query.unit && query.unit !== panel.unit ? query.unit : undefined,
    })),
    stacked: panel.type === 'timeseries' && panel.stacked ? true : undefined,
    legend: panel.type === 'timeseries' && panel.legend && panel.legend !== 'last' ? panel.legend : undefined,
    logScale: panel.type === 'timeseries' && panel.logScale ? true : undefined,
    tableBy: panel.type === 'table' ? panel.tableBy?.trim() || undefined : undefined,
    link: panel.link && panel.link.dashboardUid && panel.link.variable.trim() && panel.link.label.trim()
      ? { dashboardUid: panel.link.dashboardUid, variable: panel.link.variable.trim(), label: panel.link.label.trim() }
      : undefined,
    invertThresholds: panel.invertThresholds || undefined,
    optional: panel.optional || undefined,
  };
  if (thresholds && (thresholds.warning !== undefined || thresholds.critical !== undefined)) cleaned.thresholds = thresholds;
  return JSON.parse(JSON.stringify(cleaned)) as TelemetryPanel;
}

export function PanelEditor({ panel: initial, rowId: initialRow, rows, variables, values, start, end, isNew, dashboards, onSave, onClose }: PanelEditorProps) {
  const [panel, setPanel] = useState<TelemetryPanel>(initial);
  const [rowId, setRowId] = useState(initialRow);
  const [preview, setPreview] = useState<TelemetryRangeData | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const update = (patch: Partial<TelemetryPanel>) => setPanel((current) => ({ ...current, ...patch }));
  const ready = panel.title.trim() !== '' && panel.queries.length > 0 && panel.queries.every((query) => query.expr.trim() !== '');
  const previewKey = JSON.stringify(cleanPanel(panel));

  useEffect(() => {
    if (!ready) {
      setPreview(null);
      setPreviewError(null);
      return undefined;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      telemetryApi.previewPanel({ panel: JSON.parse(previewKey) as TelemetryPanel, variables, values, start, end })
        .then((response) => {
          if (cancelled) return;
          setPreview(response.data ?? null);
          setPreviewError(null);
        })
        .catch((err: unknown) => {
          if (!cancelled) setPreviewError(err instanceof ApiError ? err.message : 'Preview failed');
        });
    }, 500);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [previewKey, ready, variables, values, start, end]);

  const setQuery = (index: number, patch: Partial<TelemetryPanel['queries'][number]>) => {
    update({ queries: panel.queries.map((query, i) => (i === index ? { ...query, ...patch } : query)) });
  };

  const setType = (type: TelemetryPanelType) => {
    // A new panel takes the natural size of its type until it is resized.
    update(isNew ? { type, layout: { ...panel.layout, ...defaultSize(type) } } : { type });
  };

  return (
    <Modal isOpen onClose={onClose} title={isNew ? 'Add panel' : `Edit ${initial.title}`} size="xl">
      <form
        className="grid gap-6 lg:grid-cols-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (ready) onSave(rowId, cleanPanel(panel));
        }}
      >
        <div className="space-y-4">
          <label className="block text-sm">
            <span className="form-label">Title</span>
            <input className="input" value={panel.title} maxLength={120} onChange={(event) => update({ title: event.target.value })} required />
          </label>
          <label className="block text-sm">
            <span className="form-label">Description</span>
            <input className="input" value={panel.description ?? ''} maxLength={300} placeholder="Shown as a tooltip on the panel title" onChange={(event) => update({ description: event.target.value })} />
          </label>
          <div className="flex flex-wrap gap-4">
            <div className="text-sm">
              <span className="form-label">Visualisation</span>
              <SegmentedFilter<TelemetryPanelType>
                ariaLabel="Visualisation"
                options={PANEL_TYPES.map((type) => ({ value: type, label: TYPE_LABELS[type] }))}
                value={panel.type}
                onChange={setType}
              />
            </div>
            <label className="text-sm">
              <span className="form-label">Unit</span>
              <select className="input w-auto" value={panel.unit} onChange={(event) => update({ unit: event.target.value as TelemetryUnit })}>
                {TELEMETRY_UNITS.map((unit) => <option key={unit} value={unit}>{UNIT_LABELS[unit]}</option>)}
              </select>
            </label>
            <label className="text-sm">
              <span className="form-label">Row</span>
              <select className="input w-auto" value={rowId} onChange={(event) => setRowId(event.target.value)}>
                {rows.map((row) => <option key={row.id} value={row.id}>{row.title || 'Untitled row'}</option>)}
              </select>
            </label>
          </div>

          <fieldset className="space-y-3">
            <legend className="form-label">Queries</legend>
            {panel.queries.map((query, index) => (
              <div key={index} className="space-y-2 rounded-lg border border-gray-200 p-3 dark:border-robin-gray-700">
                <div className="flex items-start gap-2">
                  <textarea
                    className="input min-h-16 flex-1 font-mono text-xs"
                    value={query.expr}
                    placeholder={'sum by (host) (rate(host_network_receive_bytes_total{host=~"$host"}[$__rate_interval]))'}
                    aria-label={`Query ${index + 1}`}
                    spellCheck={false}
                    maxLength={4000}
                    onChange={(event) => setQuery(index, { expr: event.target.value })}
                  />
                  <button
                    type="button"
                    className="rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 disabled:opacity-30 dark:hover:bg-robin-gray-700"
                    onClick={() => update({ queries: panel.queries.filter((_query, i) => i !== index) })}
                    disabled={panel.queries.length === 1}
                    aria-label={`Remove query ${index + 1}`}
                    title="Remove query"
                  >
                    <Trash2 className="h-4 w-4" />
                  </button>
                </div>
                <input
                  className="input py-1.5 text-sm"
                  value={query.legend ?? ''}
                  placeholder="Legend, for example {{host}} in"
                  aria-label={`Legend ${index + 1}`}
                  maxLength={200}
                  onChange={(event) => setQuery(index, { legend: event.target.value })}
                />
                {panel.type === 'table' && panel.tableBy && (
                  <label className="flex items-center gap-2 text-xs text-gray-600 dark:text-gray-300">
                    Column unit
                    <select
                      className="input w-auto py-1 text-xs"
                      aria-label={`Unit ${index + 1}`}
                      value={query.unit ?? panel.unit}
                      onChange={(event) => setQuery(index, { unit: event.target.value as TelemetryUnit })}
                    >
                      {TELEMETRY_UNITS.map((unit) => <option key={unit} value={unit}>{UNIT_LABELS[unit]}</option>)}
                    </select>
                  </label>
                )}
              </div>
            ))}
            {panel.queries.length < 10 && (
              <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => update({ queries: [...panel.queries, { expr: '' }] })}>
                <Plus aria-hidden="true" className="h-4 w-4" />
                Add query
              </button>
            )}
            <p className="form-hint">
              Use <code>$name</code> for a dashboard variable inside a regex matcher (<code>host=~"$host"</code>),
              <code> $__rate_interval</code> as the <code>rate()</code> window and <code>$__interval</code> for the step.
              {variables.length > 0 && <> Variables: {variables.map((variable) => <code key={variable.name} className="mr-1">${variable.name}</code>)}</>}
            </p>
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <legend className="form-label col-span-full">Display</legend>
            <label className="text-sm">
              <span className="form-hint">Minimum</span>
              <input className="input py-1.5" aria-label="Minimum" inputMode="decimal" defaultValue={panel.min ?? ''} onChange={(event) => update({ min: numberOrUndefined(event.target.value) })} />
            </label>
            <label className="text-sm">
              <span className="form-hint">Maximum</span>
              <input className="input py-1.5" aria-label="Maximum" inputMode="decimal" defaultValue={panel.max ?? ''} onChange={(event) => update({ max: numberOrUndefined(event.target.value) })} />
            </label>
            <label className="text-sm">
              <span className="form-hint">Warning at</span>
              <input
                aria-label="Warning at"
                className="input py-1.5"
                inputMode="decimal"
                defaultValue={panel.thresholds?.warning ?? ''}
                onChange={(event) => update({ thresholds: { ...panel.thresholds, warning: numberOrUndefined(event.target.value) } })}
              />
            </label>
            <label className="text-sm">
              <span className="form-hint">Critical at</span>
              <input
                aria-label="Critical at"
                className="input py-1.5"
                inputMode="decimal"
                defaultValue={panel.thresholds?.critical ?? ''}
                onChange={(event) => update({ thresholds: { ...panel.thresholds, critical: numberOrUndefined(event.target.value) } })}
              />
            </label>
            <label className="col-span-full flex items-center gap-2 text-sm sm:col-span-2">
              <input type="checkbox" checked={Boolean(panel.invertThresholds)} onChange={(event) => update({ invertThresholds: event.target.checked })} />
              Lower values are worse
            </label>
            {panel.type === 'timeseries' && (
              <label className="col-span-full flex items-center gap-2 text-sm sm:col-span-2">
                <input type="checkbox" checked={Boolean(panel.stacked)} onChange={(event) => update({ stacked: event.target.checked })} />
                Stack series
              </label>
            )}
            <label className="col-span-full flex items-center gap-2 text-sm">
              <input type="checkbox" checked={Boolean(panel.optional)} onChange={(event) => update({ optional: event.target.checked })} />
              May be empty on some hosts (optional service)
            </label>
            <label className="text-sm">
              <span className="form-hint">Decimals</span>
              <select
                className="input py-1.5"
                aria-label="Decimals"
                value={panel.decimals ?? ''}
                onChange={(event) => update({ decimals: event.target.value === '' ? undefined : Number(event.target.value) })}
              >
                <option value="">Automatic</option>
                {[0, 1, 2, 3, 4, 5, 6].map((count) => <option key={count} value={count}>{count}</option>)}
              </select>
            </label>
            {panel.type === 'timeseries' && (
              <>
                <label className="text-sm">
                  <span className="form-hint">Legend</span>
                  <select className="input py-1.5" aria-label="Legend" value={panel.legend ?? 'last'} onChange={(event) => update({ legend: event.target.value as TelemetryLegendMode })}>
                    {LEGEND_MODES.map((mode) => <option key={mode} value={mode}>{LEGEND_LABELS[mode]}</option>)}
                  </select>
                </label>
                <label className="col-span-full flex items-center gap-2 text-sm sm:col-span-2">
                  <input type="checkbox" checked={Boolean(panel.logScale)} onChange={(event) => update({ logScale: event.target.checked })} />
                  Logarithmic scale
                </label>
              </>
            )}
            {panel.type === 'table' && (
              <label className="col-span-full text-sm sm:col-span-2">
                <span className="form-hint">One row per label (optional)</span>
                <input
                  className="input py-1.5 font-mono"
                  aria-label="Table rows by label"
                  placeholder="host"
                  value={panel.tableBy ?? ''}
                  maxLength={100}
                  onChange={(event) => update({ tableBy: event.target.value })}
                />
              </label>
            )}
          </fieldset>

          <fieldset className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <legend className="form-label col-span-full">Position and size</legend>
            <p className="form-hint col-span-full -mt-1">In grid units: 12 columns across the row. Dragging and resizing on the dashboard changes these too.</p>
            <label className="text-sm">
              <span className="form-hint">Column</span>
              <input
                className="input py-1.5"
                type="number"
                aria-label="Column"
                min={1}
                max={GRID_COLUMNS - panel.layout.w + 1}
                value={panel.layout.x + 1}
                onChange={(event) => update({ layout: { ...panel.layout, x: clampInt(event.target.value, 1, GRID_COLUMNS - panel.layout.w + 1, panel.layout.x + 1) - 1 } })}
              />
            </label>
            <label className="text-sm">
              <span className="form-hint">Row position</span>
              <input
                className="input py-1.5"
                type="number"
                aria-label="Row position"
                min={0}
                value={panel.layout.y}
                onChange={(event) => update({ layout: { ...panel.layout, y: clampInt(event.target.value, 0, 1000, panel.layout.y) } })}
              />
            </label>
            <label className="text-sm">
              <span className="form-hint">Width</span>
              <input
                className="input py-1.5"
                type="number"
                aria-label="Width"
                min={1}
                max={GRID_COLUMNS}
                value={panel.layout.w}
                onChange={(event) => {
                  const w = clampInt(event.target.value, 1, GRID_COLUMNS, panel.layout.w);
                  update({ layout: { ...panel.layout, w, x: Math.min(panel.layout.x, GRID_COLUMNS - w) } });
                }}
              />
            </label>
            <label className="text-sm">
              <span className="form-hint">Height</span>
              <input
                className="input py-1.5"
                type="number"
                aria-label="Height"
                min={2}
                max={30}
                value={panel.layout.h}
                onChange={(event) => update({ layout: { ...panel.layout, h: clampInt(event.target.value, 2, 30, panel.layout.h) } })}
              />
            </label>
          </fieldset>

          <fieldset className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <legend className="form-label col-span-full">Link to another dashboard (optional)</legend>
            <p className="form-hint col-span-full -mt-1">
              Clicking a legend entry or table row opens the dashboard with one of its variables set from a label of that series.
            </p>
            <label className="text-sm">
              <span className="form-hint">Dashboard</span>
              <select
                className="input py-1.5"
                aria-label="Link dashboard"
                value={panel.link?.dashboardUid ?? ''}
                onChange={(event) => update({ link: event.target.value ? { variable: 'host', label: 'host', ...panel.link, dashboardUid: event.target.value } : undefined })}
              >
                <option value="">No link</option>
                {dashboards.map((dashboard) => <option key={dashboard.uid} value={dashboard.uid}>{dashboard.title}</option>)}
              </select>
            </label>
            {panel.link && (
              <>
                <label className="text-sm">
                  <span className="form-hint">Set its variable</span>
                  <input className="input py-1.5 font-mono" aria-label="Link variable" value={panel.link.variable} maxLength={40} onChange={(event) => update({ link: { ...panel.link!, variable: event.target.value } })} />
                </label>
                <label className="text-sm">
                  <span className="form-hint">From this label</span>
                  <input className="input py-1.5 font-mono" aria-label="Link label" value={panel.link.label} maxLength={100} onChange={(event) => update({ link: { ...panel.link!, label: event.target.value } })} />
                </label>
              </>
            )}
          </fieldset>
        </div>

        <div className="flex flex-col gap-4">
          <div className="card flex h-80 flex-col p-4">
            <h3 className="mb-3 truncate text-sm font-semibold">{panel.title || 'Preview'}</h3>
            <div className="min-h-0 flex-1">
              {ready ? (
                <PanelBody panel={panel} data={preview} error={previewError} />
              ) : (
                <p className="py-10 text-center text-sm text-gray-500 dark:text-gray-400">Add a title and a query to see a preview.</p>
              )}
            </div>
          </div>
          <p className="text-xs text-gray-500 dark:text-gray-400">
            The preview uses the dashboard's current time range and variable selections. Drag the panel's header on the
            dashboard to move it and its corner to resize it.
          </p>
          <div className="mt-auto flex justify-end gap-2">
            <button type="button" className="btn btn-secondary" onClick={onClose}>Cancel</button>
            <button type="submit" className="btn btn-primary" disabled={!ready}>{isNew ? 'Add panel' : 'Apply'}</button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
