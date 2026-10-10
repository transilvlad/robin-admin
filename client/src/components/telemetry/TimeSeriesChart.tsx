/**
 * Time-series chart for Telemetry panels, drawn with uPlot.
 *
 * Charts sharing a `syncKey` share one crosshair. Dragging across the plot
 * selects a time window and calls `onZoom`. The legend toggles series on click
 * and highlights them on hover; the tooltip lists every visible series at the
 * cursor, largest first. Warning and critical thresholds draw as dashed lines
 * and Monitoring incidents as shaded spans.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { ExternalLink } from 'lucide-react';
import { useTheme } from '../../context/ThemeContext';
import type { TelemetryLegendMode, TelemetryRangeData, TelemetrySeries, TelemetryUnit } from '../../types/telemetry';
import { formatTelemetryValue } from '../../utils/telemetry';
import { chartChrome, MAX_COLORED_SERIES, seriesColor, STATUS_COLORS, withAlpha } from './chartTheme';
import { stackValues, summarize } from './chartData';

/** A shaded time span, such as a Monitoring incident. */
export interface ChartSpan {
  start: number;
  end: number;
  severity: 'warning' | 'critical';
  label: string;
}

interface TimeSeriesChartProps {
  data: TelemetryRangeData;
  unit: TelemetryUnit;
  stacked?: boolean;
  min?: number;
  max?: number;
  /** Fixed plot height; without it the chart fills its container's height. */
  height?: number;
  syncKey?: string;
  onZoom?: (start: number, end: number) => void;
  decimals?: number;
  legendMode?: TelemetryLegendMode;
  logScale?: boolean;
  thresholds?: { warning?: number; critical?: number };
  annotations?: ChartSpan[];
  /** Offer a click-through next to each legend entry. */
  onOpenSeries?: (series: TelemetrySeries) => void;
}

interface TooltipState {
  left: number;
  top: number;
  index: number;
}

const FONT = '11px Arial, Helvetica, sans-serif';
const TOOLTIP_ROWS = 12;
const LEGEND_LABELS: Record<Exclude<TelemetryLegendMode, 'hidden'>, string> = { last: '', min: 'min ', max: 'max ', mean: 'avg ' };

export function TimeSeriesChart(props: TimeSeriesChartProps) {
  const { data, unit, stacked, min, max, height, syncKey, onZoom, decimals, legendMode = 'last', logScale, thresholds, annotations, onOpenSeries } = props;
  const { theme } = useTheme();
  const fill = height === undefined;
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const plotRef = useRef<uPlot | null>(null);
  const onZoomRef = useRef(onZoom);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [tooltip, setTooltip] = useState<TooltipState | null>(null);
  // Synced charts follow the crosshair; only the hovered one shows a tooltip.
  const [hovered, setHovered] = useState(false);
  onZoomRef.current = onZoom;

  const visible = useMemo(() => data.series.map((series) => !hidden.has(series.name)), [data.series, hidden]);
  const colors = useMemo(() => data.series.map((_series, index) => seriesColor(index, theme)), [data.series, theme]);
  const summaries = useMemo(() => data.series.map((series) => summarize(series.values)), [data.series]);
  const annotationsKey = JSON.stringify(annotations ?? []);
  const thresholdsKey = JSON.stringify(thresholds ?? {});
  const format = (value: number | null) => formatTelemetryValue(value, unit, decimals);

  useEffect(() => {
    const container = containerRef.current;
    const wrapper = wrapperRef.current;
    if (!container || !wrapper || data.series.length === 0) return undefined;
    const size = () => ({
      width: container.clientWidth || 300,
      height: height ?? Math.max(80, wrapper.clientHeight),
    });
    const chrome = chartChrome(theme);
    const plotted = stacked ? stackValues(data.series.map((series) => series.values), visible) : data.series.map((series) => series.values);
    const firstVisible = visible.indexOf(true);
    const spans = JSON.parse(annotationsKey) as ChartSpan[];
    const lines = JSON.parse(thresholdsKey) as { warning?: number; critical?: number };

    const bands: uPlot.Band[] = [];
    if (stacked) {
      let below = -1;
      data.series.forEach((_series, index) => {
        if (!visible[index]) return;
        if (below >= 0) bands.push({ series: [index + 1, below + 1], fill: withAlpha(colors[index], 0.3) });
        below = index;
      });
    }

    const options: uPlot.Options = {
      ...size(),
      legend: { show: false },
      focus: { alpha: 0.25 },
      cursor: {
        sync: syncKey ? { key: syncKey } : undefined,
        drag: { x: Boolean(onZoomRef.current), y: false, setScale: false },
        points: { size: 6 },
        focus: { prox: 16 },
      },
      scales: {
        x: { time: true },
        y: logScale ? { distr: 3, log: 10 } : {
          range: (_plot, dataMin, dataMax) => {
            if (dataMin === null || dataMax === null || !Number.isFinite(dataMin) || !Number.isFinite(dataMax)) {
              return [min ?? 0, max ?? 1];
            }
            const low = min !== undefined ? Math.min(min, dataMin) : dataMin;
            let high = max !== undefined ? Math.max(max, dataMax) : dataMax + (dataMax - low) * 0.08;
            if (high <= low) high = low + 1;
            return [low, high];
          },
        },
      },
      axes: [
        {
          stroke: chrome.axis,
          font: FONT,
          grid: { stroke: chrome.grid, width: 1 },
          ticks: { stroke: chrome.grid, width: 1, size: 4 },
        },
        {
          stroke: chrome.axis,
          font: FONT,
          grid: { stroke: chrome.grid, width: 1 },
          ticks: { show: false },
          splits: unit === 'up_down' ? () => [0, 1] : undefined,
          values: (_plot, splits) => splits.map((value) => formatTelemetryValue(value, unit, decimals)),
          size: (_plot, values) => (values ? Math.max(...values.map((value) => value.length)) * 6.5 + 16 : 40),
        },
      ],
      series: [
        {},
        ...data.series.map((series, index) => ({
          label: series.name,
          show: visible[index],
          stroke: colors[index],
          width: index < MAX_COLORED_SERIES ? 2 : 1,
          fill: stacked && index === firstVisible ? withAlpha(colors[index], 0.3) : undefined,
          paths: unit === 'up_down' ? uPlot.paths.stepped?.({ align: 1 }) : undefined,
          points: { show: series.values.filter(value => value !== null).length === 1, size: 5 },
          spanGaps: false,
        })),
      ],
      bands,
      hooks: {
        // Incidents go under the lines.
        drawClear: [
          (plot) => {
            if (spans.length === 0) return;
            const { ctx, bbox } = plot;
            ctx.save();
            for (const span of spans) {
              const left = Math.max(bbox.left, plot.valToPos(span.start, 'x', true));
              const right = Math.min(bbox.left + bbox.width, plot.valToPos(span.end, 'x', true));
              if (right <= left) continue;
              ctx.fillStyle = withAlpha(STATUS_COLORS[span.severity], 0.14);
              ctx.fillRect(left, bbox.top, Math.max(1, right - left), bbox.height);
            }
            ctx.restore();
          },
        ],
        // Thresholds go over them.
        draw: [
          (plot) => {
            const { ctx, bbox } = plot;
            ctx.save();
            ctx.setLineDash([6, 4]);
            ctx.lineWidth = 1;
            for (const [level, value] of [['warning', lines.warning], ['critical', lines.critical]] as const) {
              if (value === undefined) continue;
              const y = plot.valToPos(value, 'y', true);
              if (y < bbox.top || y > bbox.top + bbox.height) continue;
              ctx.strokeStyle = STATUS_COLORS[level];
              ctx.beginPath();
              ctx.moveTo(bbox.left, y);
              ctx.lineTo(bbox.left + bbox.width, y);
              ctx.stroke();
            }
            ctx.restore();
          },
        ],
        setCursor: [
          (plot) => {
            const index = plot.cursor.idx;
            const left = plot.cursor.left ?? -1;
            const top = plot.cursor.top ?? -1;
            setTooltip(index === null || index === undefined || left < 0
              ? null
              : { index, left: left + plot.over.offsetLeft, top: top + plot.over.offsetTop });
          },
        ],
        setSelect: [
          (plot) => {
            if (plot.select.width > 4 && onZoomRef.current) {
              const start = plot.posToVal(plot.select.left, 'x');
              const end = plot.posToVal(plot.select.left + plot.select.width, 'x');
              onZoomRef.current(Math.floor(start), Math.ceil(end));
            }
            plot.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
          },
        ],
      },
    };

    const plot = new uPlot(options, [data.timestamps, ...plotted] as uPlot.AlignedData, container);
    plotRef.current = plot;
    const observer = new ResizeObserver(() => {
      plot.setSize(size());
    });
    observer.observe(fill ? wrapper : container);
    return () => {
      observer.disconnect();
      plot.destroy();
      plotRef.current = null;
    };
  }, [data, unit, stacked, min, max, height, fill, syncKey, theme, visible, colors, decimals, logScale, annotationsKey, thresholdsKey]);

  if (data.series.length === 0) {
    return (
      <div className={`flex items-center justify-center text-sm text-gray-500 dark:text-gray-400 ${fill ? 'h-full' : ''}`} style={fill ? undefined : { height }}>
        No data in this range
      </div>
    );
  }

  const toggle = (name: string) => {
    setHidden((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const focus = (index: number | null) => {
    plotRef.current?.setSeries(index === null ? null : index + 1, { focus: index !== null });
  };

  const tooltipTime = tooltip ? data.timestamps[tooltip.index] : null;
  const tooltipRows = tooltip
    ? data.series
      .map((series, index) => ({ name: series.name, color: colors[index], value: series.values[tooltip.index] ?? null, index }))
      .filter((row) => visible[row.index] && row.value !== null)
      .sort((a, b) => (b.value ?? 0) - (a.value ?? 0))
    : [];
  const activeSpans = tooltipTime === null ? [] : (annotations ?? []).filter((span) => span.start <= tooltipTime && span.end >= tooltipTime);
  const width = containerRef.current?.clientWidth ?? 0;

  return (
    <div className={fill ? 'flex h-full min-h-0 flex-col' : undefined}>
      <div
        ref={wrapperRef}
        className={`relative ${fill ? 'min-h-0 flex-1' : ''}`}
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      >
        <div ref={containerRef} className="telemetry-chart w-full" />
        {hovered && tooltip && (tooltipRows.length > 0 || activeSpans.length > 0) && (
          <div
            role="tooltip"
            className="pointer-events-none absolute z-10 min-w-40 max-w-[18rem] rounded-lg border border-gray-200 bg-white/95 p-2 text-xs shadow-lg dark:border-robin-gray-700 dark:bg-robin-gray-900/95"
            style={{
              top: Math.max(0, tooltip.top - 10),
              left: tooltip.left > width / 2 ? undefined : tooltip.left + 12,
              right: tooltip.left > width / 2 ? Math.max(0, width - tooltip.left + 12) : undefined,
            }}
          >
            <div className="mb-1 font-medium text-gray-700 dark:text-gray-200">
              {new Date((tooltipTime ?? 0) * 1000).toLocaleString()}
            </div>
            {activeSpans.map((span) => (
              <div key={`${span.label}-${span.start}`} className="mb-1 flex items-center gap-1.5 text-gray-700 dark:text-gray-200">
                <span className="h-2 w-2 shrink-0 rounded-xs" style={{ backgroundColor: STATUS_COLORS[span.severity] }} />
                <span className="truncate">{span.label}</span>
              </div>
            ))}
            {tooltipRows.slice(0, TOOLTIP_ROWS).map((row) => (
              <div key={row.name} className="flex items-center gap-2 py-0.5">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: row.color }} />
                <span className="min-w-0 flex-1 truncate text-gray-600 dark:text-gray-300">{row.name}</span>
                <span className="tabular-nums text-gray-900 dark:text-gray-100">{format(row.value)}</span>
              </div>
            ))}
            {tooltipRows.length > TOOLTIP_ROWS && (
              <div className="pt-0.5 text-gray-500 dark:text-gray-400">+{tooltipRows.length - TOOLTIP_ROWS} more</div>
            )}
          </div>
        )}
      </div>
      {legendMode !== 'hidden' && (data.series.length > 1 || data.series[0]?.name) && (
        <ul className={`mt-2 flex shrink-0 flex-wrap gap-x-4 gap-y-1 overflow-y-auto text-xs ${fill ? 'max-h-14' : 'max-h-24'}`} aria-label="Series">
          {data.series.map((series, index) => (
            <li key={series.name} className="flex items-center">
              <button
                type="button"
                onClick={() => toggle(series.name)}
                onMouseEnter={() => focus(index)}
                onMouseLeave={() => focus(null)}
                aria-pressed={visible[index]}
                className={`flex items-center gap-1.5 rounded-sm px-1 text-left hover:bg-gray-100 dark:hover:bg-robin-gray-700/50 ${visible[index] ? '' : 'opacity-40'}`}
                title={visible[index] ? 'Hide series' : 'Show series'}
              >
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: colors[index] }} />
                <span className="text-gray-600 dark:text-gray-300">{series.name}</span>
                <span className="tabular-nums text-gray-900 dark:text-gray-100">
                  {LEGEND_LABELS[legendMode]}{format(summaries[index][legendMode])}
                </span>
              </button>
              {onOpenSeries && (
                <button
                  type="button"
                  className="rounded-sm p-0.5 text-gray-400 hover:bg-gray-100 hover:text-gray-700 dark:hover:bg-robin-gray-700"
                  onClick={() => onOpenSeries(series)}
                  aria-label={`Open ${series.name}`}
                  title="Open its dashboard"
                >
                  <ExternalLink className="h-3 w-3" />
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
