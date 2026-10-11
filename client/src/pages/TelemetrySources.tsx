import { useCallback, useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { CalendarClock, CircleAlert, CircleCheck, KeyRound, RadioTower, RefreshCw, Settings } from 'lucide-react';
import { ApiError, telemetryApi } from '../api/client';
import { MetricCard } from '../components/ui/MetricCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { TelemetryStatusGate } from '../components/telemetry/TelemetryStatusGate';
import { TelemetryStoreHealthView } from '../components/telemetry/TelemetryStoreHealthView';
import { useCanEdit, useIsAdmin } from '../hooks/useAuth';
import { appIcons } from '../constants/appIcons';
import type { TelemetrySource, TelemetrySources } from '../types/telemetry';
import { formatSpan } from '../utils/telemetry';

export function ago(seconds: number): string {
  return seconds < 60 ? 'just now' : `${formatSpan(seconds)} ago`;
}

function SourcesTable({ sources, sourceLabel, groupLabel, sourceWindowDays }: { sources: TelemetrySource[]; sourceLabel: string; groupLabel: string; sourceWindowDays: number }) {
  const now = Date.now() / 1000;
  return (
    <div className="max-h-[640px] overflow-auto">
      <table className="min-w-full text-left text-sm">
        <thead className="sticky top-0 z-10 bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300"><tr>
          {[sourceLabel, groupLabel || 'Group', 'Series now', 'Last sample', 'Status'].map(label => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}
        </tr></thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">{sources.map(source => (
          <tr key={source.name} className="hover:bg-gray-50 dark:hover:bg-robin-gray-800/60">
            <td className="px-4 py-3"><Link className="font-medium hover:text-robin-orange hover:underline" to={`/telemetry/explore?q=${encodeURIComponent(source.query)}${source.silent ? `&from=${Math.floor(now - sourceWindowDays * 86400)}&to=${Math.floor(now)}` : ''}`}>{source.name}</Link></td>
            <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{source.groups.join(', ') || 'None'}</td>
            <td className="px-4 py-3 tabular-nums">{source.series.toLocaleString()}</td>
            <td className="whitespace-nowrap px-4 py-3">{source.lastSeen === null ? 'Unknown' : ago(Math.max(0, now - source.lastSeen))}</td>
            <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${source.silent ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200'}`}>
              {source.silent ? 'Silent' : 'Reporting'}
            </span></td>
          </tr>
        ))}</tbody>
      </table>
    </div>
  );
}

function SourcesView() {
  const canEdit = useCanEdit();
  const isAdmin = useIsAdmin();
  const [data, setData] = useState<TelemetrySources | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const busy = useRef(false);
  const load = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setLoading(true);
    try {
      const response = await telemetryApi.sources();
      setData(response.data ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to list sources');
    } finally {
      busy.current = false;
      setLoading(false);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const refreshSeconds = data?.refreshSeconds;
  useEffect(() => {
    if (!refreshSeconds) return;
    const timer = window.setInterval(() => void load(), refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [load, refreshSeconds]);
  const silent = data?.sources.filter(source => source.silent).length ?? 0;
  return (
    <div className="space-y-6">
      {data && <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard icon={<RadioTower className="h-5 w-5" />} label="Sources" value={data.sources.length.toLocaleString()} tone="info" />
        <MetricCard icon={<CircleCheck className="h-5 w-5" />} label="Reporting" value={(data.sources.length - silent).toLocaleString()} tone="success" />
        <MetricCard icon={<CircleAlert className="h-5 w-5" />} label="Silent" value={silent.toLocaleString()} sub={`After ${formatSpan(data.silentAfterSeconds)} without a sample`} tone={silent > 0 ? 'warning' : 'neutral'} />
        <MetricCard icon={<CalendarClock className="h-5 w-5" />} label="Discovery window" value={`${data.sourceWindowDays} days`} />
      </div>}
      <section className="card overflow-hidden p-0" aria-label="Sources">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
          <div><h2 className="flex items-center gap-2 text-base font-semibold"><RadioTower aria-hidden="true" className="h-4 w-4 text-robin-orange" />Sources</h2>
            {data && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{data.sources.length - silent} reporting, {silent} silent. Discovery window: {data.sourceWindowDays} days. Silent after {formatSpan(data.silentAfterSeconds)}.</p>}
          </div>
          <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading} title="Refresh sources" aria-label="Refresh sources"><RefreshCw className="h-4 w-4" aria-hidden="true" /></button>
        </div>
        {error && <p role="alert" className="px-4 pt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!data ? (!error && <div className="flex justify-center p-8"><Spinner label="Loading sources" /></div>) : data.sources.length === 0 ? (
          <div className="space-y-3 p-6 text-sm text-gray-500 dark:text-gray-400">
            <p>{data.emptyReason === 'no-data' ? `No metrics found in the last ${data.sourceWindowDays} days.`
              : data.emptyReason === 'selector-mismatch' ? 'Metrics exist, but none match the discovery series selector.'
              : `Matching metrics have no non-empty ${data.sourceLabel} source identity.`}</p>
            {data.emptyReason === 'missing-source-label' && data.suggestedSourceLabels?.length ? <p>
              Labels found on matching series: {data.suggestedSourceLabels.join(', ')}. One may be a better source identity.
            </p> : null}
            <div className="flex flex-wrap gap-4">
              <Link className="text-robin-blue hover:underline" to="/telemetry/explore">Explore metrics</Link>
              {isAdmin && <Link className="text-robin-blue hover:underline" to={data.emptyReason === 'no-data' ? '/administration/access?tab=apiKeys&preset=telemetry' : '/administration/telemetry?tab=discovery'}>{data.emptyReason === 'no-data' ? 'Ingest API keys' : 'Discovery settings'}</Link>}
            </div>
          </div>
        ) : <SourcesTable sources={data.sources} sourceLabel={data.sourceLabel} groupLabel={data.groupLabel} sourceWindowDays={data.sourceWindowDays} />}
        {data?.truncated && <p role="status" className="border-t border-gray-200 px-4 py-3 text-sm text-amber-700 dark:border-gray-700 dark:text-amber-400">Source results are limited. At most {data.limit.toLocaleString()} sources are shown; counts may be incomplete.</p>}
      </section>
      {canEdit && <TelemetryStoreHealthView />}
    </div>
  );
}

export function TelemetrySourcesPage() {
  const isAdmin = useIsAdmin();
  return (
    <div className="space-y-6">
      <PageHeader icon={appIcons.telemetrySources} title="Sources" description="Discovered senders and telemetry store health." actions={isAdmin ? <div className="flex gap-2">
        <Link className="btn btn-secondary" to="/administration/access?tab=apiKeys&preset=telemetry"><KeyRound className="h-4 w-4" aria-hidden="true" />API keys</Link>
        <Link className="btn btn-secondary" to="/administration/telemetry" title="Telemetry settings" aria-label="Telemetry settings"><Settings className="h-4 w-4" aria-hidden="true" /></Link>
      </div> : undefined} />
      <TelemetryStatusGate><SourcesView /></TelemetryStatusGate>
    </div>
  );
}
