/**
 * Telemetry Explore: run ad-hoc PromQL over the store and chart or tabulate
 * the result. Several queries can run together. The queries, display unit and
 * range live in the URL; recent queries are remembered in this browser.
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSearchParamsUpdater } from '../hooks/useSearchParamsUpdater';
import { LayoutPanelTop, ListTree, Play, Plus, Trash2 } from 'lucide-react';
import { ApiError, telemetryApi } from '../api/client';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { SegmentedFilter } from '../components/ui/SegmentedFilter';
import { TelemetryStatusGate } from '../components/telemetry/TelemetryStatusGate';
import { TimeRangePicker } from '../components/telemetry/TimeRangePicker';
import { TimeSeriesChart } from '../components/telemetry/TimeSeriesChart';
import { AddToDashboardModal } from '../components/telemetry/AddToDashboardModal';
import { LabelBrowser } from '../components/telemetry/LabelBrowser';
import { useCanEdit } from '../hooks/useAuth';
import { sortSeries, summarize } from '../components/telemetry/chartData';
import { appIcons } from '../constants/appIcons';
import type { TelemetryRangeData, TelemetryUnit } from '../types/telemetry';
import { formatTelemetryValue, parseTimeRange, REFRESH_OPTIONS, resolveRange, writeTimeRange, type TimeRange } from '../utils/telemetry';

const UNITS: Array<{ value: TelemetryUnit; label: string }> = [
  { value: 'none', label: 'Number' },
  { value: 'count', label: 'Count' },
  { value: 'percent', label: 'Percent (0-100)' },
  { value: 'percentunit', label: 'Ratio (0-1)' },
  { value: 'bytes', label: 'Bytes' },
  { value: 'bytes_per_second', label: 'Bytes per second' },
  { value: 'bits_per_second', label: 'Bits per second' },
  { value: 'per_second', label: 'Per second' },
  { value: 'seconds', label: 'Seconds' },
  { value: 'milliseconds', label: 'Milliseconds' },
  { value: 'up_down', label: 'Up / down' },
];

const HISTORY_KEY = 'telemetry-explore-history';
const HISTORY_LIMIT = 20;
const LETTERS = 'ABCDE';

/** `{a="b", c="d"}` without the metric name, or the name alone. */
export function seriesLabel(labels: Record<string, string>): string {
  const { __name__: name, ...rest } = labels;
  const pairs = Object.entries(rest).map(([key, value]) => `${key}="${value}"`).join(', ');
  if (!pairs) return name ?? 'value';
  return name ? `${name}{${pairs}}` : `{${pairs}}`;
}

function loadHistory(): string[][] {
  try {
    const stored = JSON.parse(localStorage.getItem(HISTORY_KEY) ?? '[]') as unknown;
    if (!Array.isArray(stored)) return [];
    return stored.filter((entry): entry is string[] => Array.isArray(entry) && entry.length > 0 && entry.every((item) => typeof item === 'string'));
  } catch {
    return [];
  }
}

function remember(queries: string[]): string[][] {
  const key = JSON.stringify(queries);
  const next = [queries, ...loadHistory().filter((entry) => JSON.stringify(entry) !== key)].slice(0, HISTORY_LIMIT);
  try {
    localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
  } catch {
    // History is a convenience; a browser that blocks storage simply has none.
  }
  return next;
}

/** Run every query over the same range and merge the results onto one time axis. */
export async function runQueries(queries: string[], span: { start: number; end: number }): Promise<TelemetryRangeData> {
  const results = await Promise.all(queries.map((query) => telemetryApi.queryRange(query, span).then((response) => response.data!)));
  const timestamps = [...new Set(results.flatMap((result) => result.timestamps))].sort((a, b) => a - b);
  const index = new Map(timestamps.map((timestamp, i) => [timestamp, i]));
  const series = results.flatMap((result, queryIndex) => result.series.map((item) => {
    const values: Array<number | null> = new Array<number | null>(timestamps.length).fill(null);
    result.timestamps.forEach((timestamp, i) => {
      values[index.get(timestamp)!] = item.values[i];
    });
    const name = seriesLabel(item.labels);
    return { ...item, query: queryIndex, name: queries.length > 1 ? `${LETTERS[queryIndex]}: ${name}` : name, values };
  }));
  return {
    start: results[0]?.start ?? span.start,
    end: results[0]?.end ?? span.end,
    step: Math.max(0, ...results.map((result) => result.step)),
    timestamps,
    series: sortSeries(series),
    truncated: results.some((result) => result.truncated),
  };
}

function setQueries(params: URLSearchParams, queries: string[]) {
  params.delete('q');
  for (const query of queries) params.append('q', query);
}

function ExploreView() {
  const [params, update] = useSearchParamsUpdater();
  const navigate = useNavigate();
  const canEdit = useCanEdit();
  const paramsKey = params.toString();
  const range = useMemo(() => parseTimeRange(new URLSearchParams(paramsKey)), [paramsKey]);
  const queriesKey = JSON.stringify(new URLSearchParams(paramsKey).getAll('q').filter((query) => query.trim()).slice(0, LETTERS.length));
  const queries = useMemo(() => JSON.parse(queriesKey) as string[], [queriesKey]);
  const unitParam = params.get('unit') as TelemetryUnit | null;
  const unit = UNITS.some((option) => option.value === unitParam) ? unitParam! : 'none';
  const refreshParam = Number(params.get('refresh'));
  const refreshSeconds = REFRESH_OPTIONS.some((option) => option.value === refreshParam) ? refreshParam : 0;

  const [drafts, setDrafts] = useState<string[]>(queries.length > 0 ? queries : ['']);
  const [focused, setFocused] = useState(0);
  const [metricNames, setMetricNames] = useState<string[]>([]);
  const [metricsError, setMetricsError] = useState<string | null>(null);
  const [data, setData] = useState<TelemetryRangeData | null>(null);
  const [error, setError] = useState<string | null>(null);
  const sourceName = params.get('source');
  const [loading, setLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const [view, setView] = useState<'chart' | 'table'>('chart');
  const [showBrowser, setShowBrowser] = useState(false);
  const [history, setHistory] = useState<string[][]>(loadHistory);
  const [adding, setAdding] = useState(false);
  const editors = useRef<Array<HTMLTextAreaElement | null>>([]);
  // Editors the user has placed a cursor in; others get selectors appended.
  const touched = useRef(new Set<HTMLTextAreaElement>());


  // The editors follow the URL when it changes underneath them (history, links).
  useEffect(() => {
    if (!sourceName) return;
    let cancelled = false;
    telemetryApi.sourceQuery(sourceName).then(response => {
      if (cancelled) return;
      if (!response.data) throw new Error('Source query missing');
      update(next => { next.delete('source'); setQueries(next, [response.data!.query]); });
    }).catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to resolve source'); });
    return () => { cancelled = true; };
  }, [sourceName, update]);

  // Only on a later change: the editors already start from the URL, and a
  // mount-time reset that runs late would wipe what was typed meanwhile.
  const syncedQueries = useRef(queries);
  useEffect(() => {
    if (syncedQueries.current === queries) return;
    syncedQueries.current = queries;
    setDrafts(queries.length > 0 ? queries : ['']);
  }, [queries]);

  useEffect(() => {
    let cancelled = false;
    setMetricNames([]); setMetricsError(null);
    telemetryApi.labelValues('__name__', resolveRange(range))
      .then((response) => { if (!cancelled) setMetricNames(response.data ?? []); })
      .catch((err: unknown) => { if (!cancelled) setMetricsError(err instanceof ApiError ? err.message : 'Metric suggestions unavailable'); });
    return () => { cancelled = true; };
  }, [range, refreshKey]);

  useEffect(() => {
    if (queries.length === 0) {
      setData(null);
      setError(null);
      return undefined;
    }
    let cancelled = false;
    setLoading(true);
    runQueries(queries, resolveRange(range))
      .then((result) => {
        if (cancelled) return;
        setData(result);
        setError(null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Query failed');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queries, range, refreshKey]);

  useEffect(() => {
    if (!refreshSeconds || range.kind === 'absolute') return undefined;
    const timer = setInterval(() => setRefreshKey((key) => key + 1), refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [refreshSeconds, range.kind]);

  const run = () => {
    const list = drafts.map((draft) => draft.trim()).filter(Boolean);
    if (list.length > 0) setHistory(remember(list));
    if (JSON.stringify(list) === queriesKey) setRefreshKey((key) => key + 1);
    else update((next) => setQueries(next, list));
  };

  const insert = (selector: string) => {
    const index = Math.min(focused, drafts.length - 1);
    const editor = editors.current[index];
    const placed = editor !== null && editor !== undefined && touched.current.has(editor);
    setDrafts((current) => current.map((draft, i) => {
      if (i !== index) return draft;
      const startAt = placed ? editor.selectionStart : draft.length;
      const endAt = placed ? editor.selectionEnd : draft.length;
      return `${draft.slice(0, startAt)}${selector}${draft.slice(endAt)}`;
    }));
  };

  const setRange = (next: TimeRange) => update((current) => writeTimeRange(current, next, true));
  // Stable between renders so the label browser keeps its selection while results arrive.
  const span = useMemo(() => resolveRange(range), [range, refreshKey]);
  const summaries = data?.series.map((series) => summarize(series.values)) ?? [];

  return (
    <div className="space-y-4">
      <form
        className="card space-y-3 p-4"
        onSubmit={(event) => {
          event.preventDefault();
          run();
        }}
      >
        {drafts.map((draft, index) => (
          <div key={index} className="flex items-start gap-2">
            <label className="block flex-1 text-sm">
              <span className="form-label">{drafts.length > 1 ? `Query ${LETTERS[index]}` : 'PromQL query'}</span>
              <textarea
                ref={(element) => {
                  editors.current[index] = element;
                }}
                className="input min-h-16 font-mono text-sm"
                value={draft}
                placeholder='{__name__=~".+"}'
                onFocus={(event) => {
                  setFocused(index);
                  touched.current.add(event.currentTarget);
                }}
                onChange={(event) => setDrafts((current) => current.map((item, i) => (i === index ? event.target.value : item)))}
                onKeyDown={(event) => {
                  if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                    event.preventDefault();
                    run();
                  }
                }}
                spellCheck={false}
              />
            </label>
            {drafts.length > 1 && (
              <button
                type="button"
                className="mt-6 rounded-sm p-1.5 text-gray-500 hover:bg-gray-100 dark:hover:bg-robin-gray-700"
                onClick={() => setDrafts((current) => current.filter((_draft, i) => i !== index))}
                aria-label={`Remove query ${LETTERS[index]}`}
                title="Remove query"
              >
                <Trash2 aria-hidden="true" className="h-4 w-4" />
              </button>
            )}
          </div>
        ))}
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" className="btn btn-primary px-3 py-1.5 text-sm">
            <Play aria-hidden="true" className="h-4 w-4" />
            Run
          </button>
          {drafts.length < LETTERS.length && (
            <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => setDrafts((current) => [...current, ''])}>
              <Plus aria-hidden="true" className="h-4 w-4" />
              Add query
            </button>
          )}
          <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" aria-expanded={showBrowser} onClick={() => setShowBrowser((current) => !current)}>
            <ListTree aria-hidden="true" className="h-4 w-4" />
            Metrics and labels
          </button>
          {history.length > 0 && (
            <select
              className="input w-56 py-1.5 text-sm"
              aria-label="Recent queries"
              value=""
              onChange={(event) => {
                const entry = history[Number(event.target.value)];
                if (!entry) return;
                setDrafts(entry);
                update((next) => setQueries(next, entry));
              }}
            >
              <option value="">Recent queries…</option>
              {history.map((entry, index) => <option key={JSON.stringify(entry)} value={index}>{entry.join(' | ').slice(0, 90)}</option>)}
            </select>
          )}
          <select
            className="input w-auto py-1.5 text-sm"
            aria-label="Display as"
            value={unit}
            onChange={(event) => update((next) => next.set('unit', event.target.value))}
          >
            {UNITS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {canEdit && (
            <button type="button" className="btn btn-secondary px-3 py-1.5 text-sm" onClick={() => setAdding(true)} disabled={queries.length === 0 || Boolean(error)}>
              <LayoutPanelTop aria-hidden="true" className="h-4 w-4" />
              Add to dashboard
            </button>
          )}
        </div>
        {metricsError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{metricsError}</p>}
        {showBrowser && <LabelBrowser metricNames={metricNames} start={span.start} end={span.end} onInsert={insert} />}
      </form>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <TimeRangePicker
          range={range}
          onRangeChange={setRange}
          refreshSeconds={refreshSeconds}
          onRefreshSecondsChange={(seconds) => update((next) => {
            if (seconds) next.set('refresh', String(seconds));
            else next.delete('refresh');
          })}
          onRefresh={() => setRefreshKey((key) => key + 1)}
        />
        <div className="flex items-center gap-3">
          {data && (
            <span className="text-xs text-gray-500 dark:text-gray-400">
              {data.series.length} series · step {data.step}s{data.truncated ? ' · first 100 series per query' : ''}
            </span>
          )}
          <SegmentedFilter<'chart' | 'table'>
            ariaLabel="View"
            options={[{ value: 'chart', label: 'Chart' }, { value: 'table', label: 'Table' }]}
            value={view}
            onChange={setView}
          />
        </div>
      </div>

      <div className="card p-4">
        {error ? (
          <p role="alert" className="py-6 text-center text-sm text-red-600 dark:text-red-400">{error}</p>
        ) : loading && !data ? (
          <div className="flex justify-center py-16"><Spinner label="Running query" /></div>
        ) : !data ? (
          <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">Enter a PromQL query to chart it.</p>
        ) : view === 'chart' ? (
          <TimeSeriesChart
            data={data}
            unit={unit}
            height={320}
            onZoom={(start, end) => setRange({ kind: 'absolute', from: start, to: end })}
          />
        ) : data.series.length === 0 ? (
          <p className="py-12 text-center text-sm text-gray-500 dark:text-gray-400">No data in this range</p>
        ) : (
          <div className="max-h-112 overflow-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="border-b border-gray-200 text-left text-xs text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                  <th className="py-1.5 pr-3 font-medium">Series</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Latest</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Min</th>
                  <th className="py-1.5 pr-3 text-right font-medium">Max</th>
                  <th className="py-1.5 text-right font-medium">Average</th>
                </tr>
              </thead>
              <tbody>
                {data.series.map((series, index) => (
                  <tr key={series.name} className="border-b border-gray-100 last:border-0 dark:border-robin-gray-700/60">
                    <td className="py-1.5 pr-3 font-mono text-xs text-gray-600 dark:text-gray-300">{series.name}</td>
                    {(['last', 'min', 'max', 'mean'] as const).map((key) => (
                      <td key={key} className="py-1.5 pr-3 text-right tabular-nums text-gray-900 dark:text-gray-100">
                        {formatTelemetryValue(summaries[index][key], unit)}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {adding && (
        <AddToDashboardModal
          queries={queries}
          unit={unit}
          onAdded={(uid) => navigate(`/telemetry?dashboard=${encodeURIComponent(uid)}`)}
          onClose={() => setAdding(false)}
        />
      )}
    </div>
  );
}

export function TelemetryExplorePage() {
  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.telemetryExplore}
        title="Explore"
      />
      <TelemetryStatusGate>
        <ExploreView />
      </TelemetryStatusGate>
    </div>
  );
}
