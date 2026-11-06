import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { CalendarClock, CircleAlert, CircleCheck, KeyRound, PlugZap, RadioTower, RefreshCw, Settings } from 'lucide-react';
import { ApiError, logsApi } from '../api/client';
import { MetricCard } from '../components/ui/MetricCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import type { LogsSource, LogsSourcesResult } from '../types';
import { formatSpan } from '../utils/telemetry';

const SOURCE_TYPE_LABELS: Record<string, string> = {
  fleet: 'Fleet agent',
  http: 'HTTP ingest',
  sentry: 'Sentry webhook',
};

export function sourceTypeLabel(type: string): string {
  return SOURCE_TYPE_LABELS[type] ?? (type || 'Unattributed');
}

function ago(value: string | null): string {
  if (!value) return 'Never';
  const time = new Date(value).getTime();
  if (!Number.isFinite(time)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - time) / 1000));
  return seconds < 60 ? 'just now' : `${formatSpan(seconds)} ago`;
}

function sourceSearchUrl(source: LogsSource, windowDays: number): string {
  const filters = [source.serviceType ? `service_type:in(${JSON.stringify(source.serviceType)})` : 'service_type:""'];
  if (!source.serviceId) filters.push('service_id:""');
  if (source.sourceType === 'fleet') {
    filters.push('(source_type:in("fleet") OR (source_name:"" agent_id:* service_id:*))');
  } else if (source.sourceType) {
    filters.push(`source_type:in(${JSON.stringify(source.sourceType)})`);
  } else {
    filters.push('(source_type:"" NOT (source_name:"" agent_id:* service_id:*))');
  }
  if (source.sourceName === 'Unknown source') {
    filters.push('(source_name:"" OR source_name:in("Unknown source"))');
  }
  const params = new URLSearchParams({ q: filters.join(' '), range: windowDays === 1 ? '24h' : `${windowDays}d` });
  if (source.sourceName !== 'Unknown source') params.set('source', source.sourceName);
  if (source.serviceId) params.set('service', source.serviceId);
  return `/logs?${params}`;
}

export function LogsSourcesPage() {
  const [data, setData] = useState<LogsSourcesResult | null>(null);
  const [params, setParams] = useSearchParams();
  const requestedWindow = Number(params.get('windowDays'));
  const windowDays = [1, 7, 30].includes(requestedWindow) ? requestedWindow : 7;
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const requestRef = useRef(0);
  const load = useCallback(async () => {
    const request = ++requestRef.current;
    setLoading(true);
    try {
      const response = await logsApi.listSources(windowDays);
      if (request !== requestRef.current) return;
      setData(response.data ?? null);
      setError('');
    } catch (err) {
      if (request === requestRef.current) setError(err instanceof ApiError ? err.message : 'Failed to load Logs sources');
    } finally {
      if (request === requestRef.current) setLoading(false);
    }
  }, [windowDays]);

  useEffect(() => {
    void load();
    return () => { requestRef.current += 1; };
  }, [load]);

  const quietAfterMs = (data?.quietAfterSeconds ?? 900) * 1000;
  const isQuiet = (lastSeen: string | null) => !lastSeen || !Number.isFinite(Date.parse(lastSeen)) || Date.now() - Date.parse(lastSeen) > quietAfterMs;
  const quiet = data?.sources.filter(source => isQuiet(source.lastSeen)).length ?? 0;

  return (
    <div className="space-y-6">
      <PageHeader icon={appIcons.telemetrySources} title="Log sources" description="Senders observed in the Logs store, their recent volume and last-seen time." actions={<div className="flex gap-2">
        <Link className="btn btn-secondary" to="/administration/access?tab=apiKeys&preset=logs"><KeyRound className="h-4 w-4" aria-hidden="true" />API keys</Link>
        <Link className="btn btn-secondary" to="/administration/logs" title="Logs settings" aria-label="Logs settings"><Settings className="h-4 w-4" aria-hidden="true" /></Link>
      </div>} />
      {data && <div className="grid grid-cols-2 gap-4 lg:grid-cols-4">
        <MetricCard icon={<RadioTower className="h-5 w-5" />} label="Sources" value={data.sources.length.toLocaleString()} tone="info" />
        <MetricCard icon={<CircleCheck className="h-5 w-5" />} label="Active" value={(data.sources.length - quiet).toLocaleString()} tone="success" />
        <MetricCard icon={<CircleAlert className="h-5 w-5" />} label="Quiet" value={quiet.toLocaleString()} sub={`After ${formatSpan(data.quietAfterSeconds)} without logs`} tone={quiet > 0 ? 'warning' : 'neutral'} />
        <MetricCard icon={<CalendarClock className="h-5 w-5" />} label="Inventory window" value={`${data.windowDays} ${data.windowDays === 1 ? 'day' : 'days'}`} />
      </div>}
      <section className="card overflow-hidden p-0" aria-label="Observed log sources">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
          <div>
            <h2 className="flex items-center gap-2 text-base font-semibold"><RadioTower className="h-4 w-4 text-robin-orange" aria-hidden="true" />Observed sources</h2>
            {data && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{data.sources.length - quiet} active, {quiet} quiet. The {data.limit.toLocaleString()} busiest sources are listed.</p>}
          </div>
          <div className="flex items-center gap-2">
            <label className="sr-only" htmlFor="logs-source-window">Inventory window</label>
            <select id="logs-source-window" name="windowDays" className="input" value={windowDays} onChange={(event) => setParams({ windowDays: event.target.value }, { replace: true })}><option value={1}>1 day</option><option value={7}>7 days</option><option value={30}>30 days</option></select>
            <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading} title="Refresh sources" aria-label="Refresh sources"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
          </div>
        </div>
        {error && <p role="alert" className="px-4 pt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
        {!data ? (!error && <div className="flex justify-center p-8"><Spinner label="Loading log sources" /></div>) : data.sources.length === 0 ? (
          <div className="space-y-3 p-6 text-sm text-gray-500 dark:text-gray-400">
            <p>No sources have sent logs in this window. Sources are discovered from ingested data; configure Fleet agents or push integrations to populate this page.</p>
            <div className="flex flex-wrap gap-4"><Link className="text-robin-orange hover:underline" to="/fleet/agents">Fleet agents</Link><Link className="text-robin-orange hover:underline" to="/logs">Search logs</Link></div>
          </div>
        ) : (
          <div className="max-h-[640px] overflow-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="sticky top-0 z-10 bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300"><tr>
                {['Source', 'Type', 'Service', `Logs · ${data.windowDays}d`, 'Last seen', 'Status'].map((label) => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {data.sources.map((source) => {
                  const sourceQuiet = isQuiet(source.lastSeen);
                  return <tr key={JSON.stringify([source.sourceType, source.sourceName, source.serviceType, source.serviceId])} className="hover:bg-gray-50 dark:hover:bg-robin-gray-800/60" style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 48px' }}>
                    <td className="max-w-72 break-words px-4 py-3"><Link className="font-medium hover:text-robin-orange hover:underline" to={sourceSearchUrl(source, data.windowDays)}>{source.sourceName}</Link></td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{sourceTypeLabel(source.sourceType)}</td>
                    <td className="px-4 py-3 text-gray-600 dark:text-gray-300">{source.serviceType ? <><span className="font-medium text-gray-900 dark:text-gray-100">{source.serviceType}</span> · {source.serviceId}</> : source.serviceId || '—'}</td>
                    <td className="px-4 py-3 tabular-nums">{source.count.toLocaleString()}</td>
                    <td className="whitespace-nowrap px-4 py-3">{ago(source.lastSeen)}</td>
                    <td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${sourceQuiet ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200'}`}>{sourceQuiet ? 'Quiet' : 'Active'}</span></td>
                  </tr>;
                })}
              </tbody>
            </table>
          </div>
        )}
        {data?.truncated && <p role="status" className="border-t border-gray-200 px-4 py-3 text-sm text-amber-700 dark:border-gray-700 dark:text-amber-400">Source results are limited. At most {data.limit.toLocaleString()} sources are shown; counts may be incomplete.</p>}
      </section>
      <section className="card" aria-labelledby="logs-connect-title">
        <div className="card-header"><h2 id="logs-connect-title" className="card-title flex items-center gap-2"><PlugZap className="h-4 w-4 text-robin-orange" aria-hidden="true" />Connect a source</h2></div>
        <div className="card-body grid gap-6 text-sm md:grid-cols-3">
          <div className="space-y-1.5">
            <h3 className="font-medium">Fleet agents</h3>
            <p className="text-gray-600 dark:text-gray-400">Agents forward the logs of the services they manage automatically.</p>
            <Link className="inline-block text-robin-orange hover:underline" to="/fleet/agents">Manage Fleet agents</Link>
          </div>
          <div className="space-y-1.5">
            <h3 className="font-medium">HTTP collectors</h3>
            <p className="text-gray-600 dark:text-gray-400"><code>POST /api/logs/ingest</code> with a <code>logs:write</code> API key. JSON object, array or NDJSON.</p>
            <Link className="inline-block text-robin-orange hover:underline" to="/administration/access?tab=apiKeys&preset=logs">Create a Logs API key</Link>
          </div>
          <div className="space-y-1.5">
            <h3 className="font-medium">Sentry</h3>
            <p className="text-gray-600 dark:text-gray-400">Point a Sentry internal integration webhook at <code>/api/logs/sentry</code>.</p>
            <Link className="inline-block text-robin-orange hover:underline" to="/administration/logs?tab=ingestion">Ingestion settings</Link>
          </div>
        </div>
      </section>
    </div>
  );
}
