import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Database, RefreshCw } from 'lucide-react';
import { ApiError, telemetryApi } from '../../api/client';
import type { TelemetryStoreHealth } from '../../types/telemetry';
import { formatTelemetryValue } from '../../utils/telemetry';
import { Spinner } from '../ui/Spinner';

export function TelemetryStoreHealthView() {
  const [health, setHealth] = useState<TelemetryStoreHealth | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await telemetryApi.store();
      setHealth(response.data ?? null);
      setError(null);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to read the store');
    } finally { setLoading(false); }
  }, []);
  useEffect(() => { void load(); }, [load]);
  const bytes = (value: number | null) => value === null ? 'Unknown' : formatTelemetryValue(value, 'bytes');
  const rate = (value: number | null) => value === null ? 'Unknown' : `${formatTelemetryValue(value, 'none', 1)} samples/s`;
  const stats = health ? [
    ['Address', health.address], ['Kind', `${health.kind === 'victoriametrics' ? 'VictoriaMetrics' : 'Prometheus-compatible'}${health.version ? ` ${health.version}` : ''}`],
    ['Retention', health.retention ?? 'Unknown'], ['Active series', health.totalSeries.toLocaleString()],
    ['Data on disk', bytes(health.dataSizeBytes)], ['Free disk', bytes(health.freeDiskBytes)],
    ['Ingest rate', rate(health.ingestRate)], ['Rejected rate', rate(health.rejectRate)],
  ] : [];
  return (
    <section className="card overflow-hidden p-0" aria-label="Store">
      <div className="flex items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700"><h2 className="flex items-center gap-2 text-base font-semibold"><Database aria-hidden="true" className="h-4 w-4 text-robin-orange" />Store</h2>
        <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading} title="Refresh store" aria-label="Refresh store"><RefreshCw className="h-4 w-4" aria-hidden="true" /></button>
      </div>
      {error && <p role="alert" className="px-4 pt-4 text-sm text-red-600 dark:text-red-400">{error}</p>}
      {!health ? (!error && <div className="flex justify-center p-8"><Spinner label="Reading the store" /></div>) : <div className="space-y-5 p-4">
        <dl className="grid grid-cols-2 gap-3 text-sm md:grid-cols-4">{stats.map(([label, value]) => <div key={label} className="min-w-0 rounded-lg bg-gray-50 px-3 py-2 dark:bg-robin-gray-800/60"><dt className="text-xs text-gray-500 dark:text-gray-400">{label}</dt><dd className="mt-0.5 wrap-break-word font-medium tabular-nums">{value}</dd></div>)}</dl>
        {health.topMetrics.length > 0 && <div><h3 className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-200">Metrics with the most series</h3>
          <ul className="grid gap-x-6 text-sm md:grid-cols-2">{health.topMetrics.map(metric => <li key={metric.name} className="flex min-w-0 justify-between gap-3 border-b border-gray-100 py-1 dark:border-robin-gray-700">
            <Link className="truncate font-mono text-xs hover:text-robin-orange" to={`/telemetry/explore?q=${encodeURIComponent(`count by (host) (${metric.name})`)}`}>{metric.name}</Link><span className="tabular-nums">{metric.series.toLocaleString()}</span>
          </li>)}</ul>
        </div>}
      </div>}
    </section>
  );
}
