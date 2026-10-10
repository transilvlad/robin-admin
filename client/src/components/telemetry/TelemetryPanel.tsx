/**
 * One dashboard panel: loads its series for the current range and variables
 * and renders it as a time-series chart, a stat, or a table. Saved panels load
 * through the dashboard endpoint; panels of an unsaved draft load through the
 * preview endpoint, so edits show live.
 */

import { useEffect, useMemo, useState } from 'react';
import { AlertTriangle, Compass, Copy, ExternalLink, GripVertical, Info, Maximize2, OctagonAlert, Pencil, Trash2 } from 'lucide-react';
import { ApiError, telemetryApi } from '../../api/client';
import type {
  TelemetryPanel as PanelDefinition,
  TelemetryRangeData,
  TelemetrySeries,
  TelemetryVariable,
  TelemetryVariableValues,
} from '../../types/telemetry';
import { currentValue, formatSpan, formatTelemetryValue, thresholdLevel, type CurrentValue, type ThresholdLevel } from '../../utils/telemetry';
import { Spinner } from '../ui/Spinner';
import { sortSeries } from './chartData';
import { STATUS_COLORS } from './chartTheme';
import { TimeSeriesChart, type ChartSpan } from './TimeSeriesChart';

/** Where a panel's data comes from. */
export type PanelSource =
  | { kind: 'saved'; dashboardUid: string }
  | { kind: 'draft'; variables: TelemetryVariable[] };

/** Follow a panel's link with the labels of the series or row that was chosen. */
export type OpenLink = (panel: PanelDefinition, labels: Record<string, string>) => void;

interface TelemetryPanelProps {
  panel: PanelDefinition;
  source: PanelSource;
  start: number;
  end: number;
  values: TelemetryVariableValues;
  /** Changes when the dashboard asks every panel to reload. */
  refreshKey: number;
  syncKey?: string;
  onZoom?: (start: number, end: number) => void;
  annotations?: ChartSpan[];
  onOpenLink?: OpenLink;
  /** View mode: full screen and Explore. */
  viewActions?: { onFullscreen: () => void; onExplore?: () => void };
  /** Edit mode: show the drag handle and panel actions. */
  editActions?: { onEdit: () => void; onDuplicate: () => void; onRemove: () => void };
}

const LEVEL_LABELS: Record<Exclude<ThresholdLevel, 'ok'>, string> = {
  warning: 'Warning',
  critical: 'Critical',
};

/** Class of the element that starts a drag in edit mode. */
export const DRAG_HANDLE_CLASS = 'telemetry-drag-handle';

const ICON_BUTTON = 'rounded-sm p-1 text-gray-500 hover:bg-gray-100 dark:hover:bg-robin-gray-700';

function LevelBadge({ level, compact }: { level: ThresholdLevel; compact?: boolean }) {
  if (level === 'ok') return null;
  const Icon = level === 'critical' ? OctagonAlert : AlertTriangle;
  return (
    <span className="inline-flex items-center gap-1 text-xs font-medium text-gray-700 dark:text-gray-200" title={LEVEL_LABELS[level]}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" style={{ color: STATUS_COLORS[level] }} />
      {compact ? <span className="sr-only">{LEVEL_LABELS[level]}</span> : LEVEL_LABELS[level]}
    </span>
  );
}

function Sparkline({ values, color }: { values: Array<number | null>; color: string }) {
  const points = values
    .map((value, index) => ({ value, index }))
    .filter((point): point is { value: number; index: number } => point.value !== null);
  if (points.length < 2) return null;
  const min = Math.min(...points.map((point) => point.value));
  const max = Math.max(...points.map((point) => point.value));
  const span = max - min || 1;
  const last = values.length - 1 || 1;
  const path = points
    .map((point) => `${((point.index / last) * 100).toFixed(2)},${(28 - ((point.value - min) / span) * 26).toFixed(2)}`)
    .join(' ');
  return (
    <svg viewBox="0 0 100 30" preserveAspectRatio="none" className="h-8 w-full" aria-hidden="true">
      <polyline points={path} fill="none" stroke={color} strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/** Shown in place of a value for a series that stopped before the range ends. */
function Stopped({ at, end }: { at: number; end: number }) {
  return (
    <span className="text-xs text-gray-500 dark:text-gray-400" title={`Last sample ${new Date(at * 1000).toLocaleString()}`}>
      No data for {formatSpan(end - at)}
    </span>
  );
}

function LinkedName({ panel, series, onOpenLink }: { panel: PanelDefinition; series: Pick<TelemetrySeries, 'name' | 'labels'>; onOpenLink?: OpenLink }) {
  if (!panel.link || !onOpenLink || !series.labels[panel.link.label]) return <>{series.name}</>;
  return (
    <button type="button" className="inline-flex items-center gap-1 text-left hover:text-robin-orange hover:underline" onClick={() => onOpenLink(panel, series.labels)}>
      {series.name}
      <ExternalLink aria-hidden="true" className="h-3 w-3" />
    </button>
  );
}

function StatView({ panel, data, onOpenLink }: { panel: PanelDefinition; data: TelemetryRangeData; onOpenLink?: OpenLink }) {
  if (data.series.length > 1) {
    // Several series (for example several hosts selected): one line each, not just the first.
    return (
      <ul className="h-full space-y-1 overflow-y-auto text-sm">
        {data.series.map((series) => {
          const { value, stoppedAt } = currentValue(data, series.values);
          return (
            <li key={series.name} className="flex items-center justify-between gap-3">
              <span className="min-w-0 truncate text-gray-600 dark:text-gray-300"><LinkedName panel={panel} series={series} onOpenLink={onOpenLink} /></span>
              {stoppedAt !== null ? <Stopped at={stoppedAt} end={data.end} /> : (
                <span className="flex items-center gap-2">
                  <span className="font-semibold tabular-nums text-gray-900 dark:text-gray-100">{formatTelemetryValue(value, panel.unit, panel.decimals)}</span>
                  <LevelBadge level={thresholdLevel(value, panel)} compact />
                </span>
              )}
            </li>
          );
        })}
      </ul>
    );
  }
  const values = data.series[0]?.values ?? [];
  const { value, stoppedAt } = currentValue(data, values);
  const level = thresholdLevel(value, panel);
  const sparkColor = level === 'ok' ? '#9ca3af' : STATUS_COLORS[level];
  return (
    <div className="flex h-full flex-col justify-between gap-2">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-3xl font-semibold tracking-tight text-gray-900 dark:text-gray-100">
          {formatTelemetryValue(value, panel.unit, panel.decimals)}
        </span>
        <LevelBadge level={level} />
      </div>
      {stoppedAt !== null && <Stopped at={stoppedAt} end={data.end} />}
      <Sparkline values={values} color={sparkColor} />
    </div>
  );
}

/** One row per value of `panel.tableBy`, one column per query. */
export function joinTable(panel: PanelDefinition, data: TelemetryRangeData) {
  const by = panel.tableBy!;
  const columns = panel.queries.map((query, index) => ({ title: query.legend?.replace(/\{\{[^}]*\}\}/g, '').trim() || `Query ${index + 1}`, unit: query.unit ?? panel.unit }));
  const rows = new Map<string, { key: string; labels: Record<string, string>; cells: CurrentValue[] }>();
  for (const series of data.series) {
    const key = series.labels[by];
    if (key === undefined || series.query === undefined) continue;
    const row = rows.get(key) ?? { key, labels: { [by]: key }, cells: columns.map((): CurrentValue => ({ value: null, stoppedAt: null })) };
    row.cells[series.query] = currentValue(data, series.values);
    rows.set(key, row);
  }
  return { columns, rows: [...rows.values()].sort((a, b) => a.key.localeCompare(b.key, undefined, { numeric: true })) };
}

function TableView({ panel, data, onOpenLink }: { panel: PanelDefinition; data: TelemetryRangeData; onOpenLink?: OpenLink }) {
  if (panel.tableBy) {
    const { columns, rows } = joinTable(panel, data);
    if (rows.length === 0) return <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">No data in this range</p>;
    return (
      <div className="h-full overflow-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-gray-200 text-left text-xs text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
              <th className="py-1.5 pr-3 font-medium">{panel.tableBy}</th>
              {columns.map((column) => <th key={column.title} className="py-1.5 pr-3 text-right font-medium">{column.title}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.key} className="border-b border-gray-100 last:border-0 dark:border-robin-gray-700/60">
                <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300"><LinkedName panel={panel} series={{ name: row.key, labels: row.labels }} onOpenLink={onOpenLink} /></td>
                {row.cells.map(({ value, stoppedAt }, index) => (
                  <td key={columns[index].title} className="py-1.5 pr-3 text-right tabular-nums text-gray-900 dark:text-gray-100">
                    {stoppedAt !== null ? <Stopped at={stoppedAt} end={data.end} /> : (
                      <span className="inline-flex items-center gap-1">
                        {formatTelemetryValue(value, columns[index].unit, panel.decimals)}
                        {columns[index].unit === panel.unit && <LevelBadge level={thresholdLevel(value, panel)} compact />}
                      </span>
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    );
  }
  const rows = data.series
    .map((series) => ({ series, ...currentValue(data, series.values) }))
    .sort((a, b) => (panel.invertThresholds ? (a.value ?? Infinity) - (b.value ?? Infinity) : (b.value ?? -Infinity) - (a.value ?? -Infinity)));
  if (rows.length === 0) {
    return <p className="py-6 text-center text-sm text-gray-500 dark:text-gray-400">No data in this range</p>;
  }
  return (
    <div className="h-full overflow-y-auto">
      <table className="w-full text-sm">
        <tbody>
          {rows.map(({ series, value, stoppedAt }) => (
            <tr key={series.name} className="border-b border-gray-100 last:border-0 dark:border-robin-gray-700/60">
              <td className="py-1.5 pr-3 text-gray-600 dark:text-gray-300"><LinkedName panel={panel} series={series} onOpenLink={onOpenLink} /></td>
              <td className="py-1.5 pr-3 text-right tabular-nums text-gray-900 dark:text-gray-100">
                {stoppedAt !== null ? <Stopped at={stoppedAt} end={data.end} /> : formatTelemetryValue(value, panel.unit, panel.decimals)}
              </td>
              <td className="w-20 py-1.5 text-right"><LevelBadge level={thresholdLevel(value, panel)} /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** A panel's content for data that has already been loaded. */
export function PanelBody({ panel, data, error, syncKey, onZoom, annotations, onOpenLink, height }: {
  panel: PanelDefinition;
  data: TelemetryRangeData | null;
  error: string | null;
  syncKey?: string;
  onZoom?: (start: number, end: number) => void;
  annotations?: ChartSpan[];
  onOpenLink?: OpenLink;
  height?: number;
}) {
  const sorted = useMemo(() => (data ? { ...data, series: sortSeries(data.series) } : null), [data]);
  if (error) return <p role="alert" className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>;
  if (!sorted) return <div className="flex justify-center py-10"><Spinner size="sm" label={`Loading ${panel.title}`} /></div>;
  if (panel.type === 'stat') return <StatView panel={panel} data={sorted} onOpenLink={onOpenLink} />;
  if (panel.type === 'table') return <TableView panel={panel} data={sorted} onOpenLink={onOpenLink} />;
  return (
    <TimeSeriesChart
      data={sorted}
      unit={panel.unit}
      stacked={panel.stacked}
      min={panel.min}
      max={panel.max}
      height={height}
      syncKey={syncKey}
      onZoom={onZoom}
      decimals={panel.decimals}
      legendMode={panel.legend}
      logScale={panel.logScale}
      thresholds={panel.thresholds}
      annotations={annotations}
      onOpenSeries={panel.link && onOpenLink ? (series) => onOpenLink(panel, series.labels) : undefined}
    />
  );
}

/** Everything that changes a panel's data, but not its title or position. */
function queryKey(panel: PanelDefinition): string {
  return JSON.stringify([panel.type, panel.queries]);
}

/** Load a panel's data for a range, from the saved dashboard or the draft. */
export function usePanelData(panel: PanelDefinition, source: PanelSource, start: number, end: number, values: TelemetryVariableValues, refreshKey: number) {
  const [data, setData] = useState<TelemetryRangeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const valuesKey = JSON.stringify(values);
  const panelKey = queryKey(panel);
  const sourceKey = source.kind === 'saved' ? `saved:${source.dashboardUid}` : `draft:${JSON.stringify(source.variables)}`;

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const currentValues = JSON.parse(valuesKey) as TelemetryVariableValues;
    const request = source.kind === 'saved'
      ? telemetryApi.panel(source.dashboardUid, panel.id, { start, end }, currentValues)
      : telemetryApi.previewPanel({ panel, variables: source.variables, values: currentValues, start, end });
    request
      .then((response) => {
        if (cancelled) return;
        setData(response.data ?? null);
        setError(null);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof ApiError ? err.message : 'Failed to load panel');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // The panel and source objects change identity on every edit; their keys
    // only change when the data would.
  }, [sourceKey, panel.id, panelKey, start, end, valuesKey, refreshKey]);

  return { data, error, loading };
}

export function TelemetryPanel({ panel, source, start, end, values, refreshKey, syncKey, onZoom, annotations, onOpenLink, viewActions, editActions }: TelemetryPanelProps) {
  const { data, error, loading } = usePanelData(panel, source, start, end, values, refreshKey);

  return (
    <section className="card flex h-full min-w-0 flex-col p-4" aria-label={panel.title}>
      <header className={`mb-3 flex items-center justify-between gap-2 ${editActions ? `${DRAG_HANDLE_CLASS} cursor-move` : ''}`}>
        <div className="flex min-w-0 items-center gap-1.5">
          {editActions && <GripVertical aria-hidden="true" className="h-4 w-4 shrink-0 text-gray-400" />}
          <h3 className="truncate text-sm font-semibold text-gray-900 dark:text-gray-100">{panel.title}</h3>
          {panel.description && (
            <span title={panel.description} className="text-gray-400">
              <Info aria-label={panel.description} className="h-3.5 w-3.5" />
            </span>
          )}
        </div>
        <div className="flex items-center gap-1">
          {data?.truncated && <span className="text-xs text-gray-500 dark:text-gray-400">First 100 series</span>}
          {loading && data && <Spinner size="sm" label="Refreshing" className="text-gray-400" />}
          {viewActions && (
            <div className="flex items-center gap-0.5">
              {viewActions.onExplore && (
                <button type="button" className={ICON_BUTTON} onClick={viewActions.onExplore} aria-label={`Open ${panel.title} in Explore`} title="Open in Explore">
                  <Compass className="h-3.5 w-3.5" />
                </button>
              )}
              <button type="button" className={ICON_BUTTON} onClick={viewActions.onFullscreen} aria-label={`View ${panel.title}`} title="View">
                <Maximize2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
          {editActions && (
            // Buttons must not start a drag.
            <div className="flex items-center gap-0.5" onMouseDown={(event) => event.stopPropagation()}>
              <button type="button" className={ICON_BUTTON} onClick={editActions.onEdit} aria-label={`Edit ${panel.title}`} title="Edit">
                <Pencil className="h-3.5 w-3.5" />
              </button>
              <button type="button" className={ICON_BUTTON} onClick={editActions.onDuplicate} aria-label={`Duplicate ${panel.title}`} title="Duplicate">
                <Copy className="h-3.5 w-3.5" />
              </button>
              <button type="button" className={ICON_BUTTON} onClick={editActions.onRemove} aria-label={`Remove ${panel.title}`} title="Remove">
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </div>
          )}
        </div>
      </header>
      <div className="min-h-0 flex-1">
        <PanelBody
          panel={panel}
          data={data}
          error={error}
          syncKey={syncKey}
          onZoom={editActions ? undefined : onZoom}
          annotations={annotations}
          onOpenLink={editActions ? undefined : onOpenLink}
        />
      </div>
    </section>
  );
}
