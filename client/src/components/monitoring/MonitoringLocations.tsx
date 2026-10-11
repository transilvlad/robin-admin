import { useCallback, useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Activity, Clock3, MapPin, Save, Wifi, WifiOff } from 'lucide-react';
import { ApiError, monitoringApi } from '../../api/client';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Spinner } from '../ui/Spinner';
import type { MonitoringProbeLocation, MonitoringProbeLocationsResponse } from '../../types/monitoring';

const EMPTY: MonitoringProbeLocationsResponse = { locations: [], availableAgents: [] };

export function MonitoringLocations() {
  const [data, setData] = useState(EMPTY);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [agentId, setAgentId] = useState('');
  const [region, setRegion] = useState('');
  const [concurrency, setConcurrency] = useState(4);
  const [drafts, setDrafts] = useState<Record<number, { name: string; region: string; concurrency: number }>>({});

  const load = useCallback(async () => {
    try {
      const response = await monitoringApi.listLocations();
      setData(response.data ?? EMPTY);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load monitoring locations');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const run = async (action: () => Promise<unknown>) => {
    setWorking(true);
    setError('');
    try {
      await action();
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Location update failed');
    } finally {
      setWorking(false);
    }
  };

  const grant = (event: FormEvent) => {
    event.preventDefault();
    if (!agentId) return;
    void run(async () => {
      await monitoringApi.grantLocation({
        agentId,
        region: region.trim() || null,
        probeConcurrency: concurrency,
      });
      setAgentId('');
      setRegion('');
      setConcurrency(4);
    });
  };

  const editDraft = (location: MonitoringProbeLocation) => drafts[location.id] ?? {
    name: location.name,
    region: location.region ?? '',
    concurrency: location.probeConcurrency,
  };

  const save = (event: FormEvent, location: MonitoringProbeLocation) => {
    event.preventDefault();
    const draft = editDraft(location);
    void run(() => monitoringApi.updateLocation(location.id, {
      name: draft.name.trim(),
      region: draft.region.trim() || null,
      probeConcurrency: draft.concurrency,
    }));
  };

  if (loading) return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;

  return (
    <div className="space-y-4">
      {error && <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/30 dark:text-red-200">{error}</div>}
      <form onSubmit={grant} className="card grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_8rem_auto] lg:items-end">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-200">
          Enrolled agent
          <select required className="input mt-1 w-full" value={agentId} onChange={event => setAgentId(event.target.value)}>
            <option value="">Choose an agent…</option>
            {data.availableAgents.map(agent => <option key={agent.agentId} value={agent.agentId}>{agent.name}{agent.hostname ? ` · ${agent.hostname}` : ''} ({agent.status})</option>)}
          </select>
        </label>
        <Input label="Region" value={region} maxLength={100} onChange={event => setRegion(event.target.value)} placeholder="e.g. Frankfurt" />
        <Input label="Concurrency" type="number" min={1} max={128} step={1} value={concurrency} onChange={event => setConcurrency(Number(event.target.value))} />
        <Button type="submit" disabled={working || !agentId}>Grant probe capability</Button>
        {!data.availableAgents.length && <p className="text-sm text-gray-500 sm:col-span-2 lg:col-span-4">No enrolled, unassigned agents are available. Enroll an agent in Administration → Agents first.</p>}
      </form>

      <div className="space-y-3">
        {data.locations.map(location => {
          const draft = editDraft(location);
          const online = location.agentStatus === 'online';
          return (
            <article key={location.id} className="card p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="flex min-w-0 items-center gap-3">
                  <span className={`rounded-lg p-2 ${location.locationType === 'local' ? 'bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300' : online ? 'bg-emerald-50 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300' : 'bg-amber-50 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300'}`}>
                    {location.locationType === 'local' ? <MapPin aria-hidden="true" className="h-5 w-5" /> : online ? <Wifi aria-hidden="true" className="h-5 w-5" /> : <WifiOff aria-hidden="true" className="h-5 w-5" />}
                  </span>
                  <div className="min-w-0">
                    <h3 className="truncate font-semibold text-gray-900 dark:text-gray-100">{location.name}</h3>
                    <p className="text-xs text-gray-500 dark:text-gray-400">{location.locationType === 'local' ? 'Robin Admin server' : `${location.agentName ?? location.agentId} · ${location.agentStatus ?? 'unknown'}`}{location.region ? ` · ${location.region}` : ''}</p>
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                {location.locationType === 'remote' && location.enabled && <Button variant="secondary" disabled={working} onClick={() => void run(() => monitoringApi.updateLocation(location.id, { shadow: !location.shadow }))}>
                  {location.shadow ? 'Promote to voting' : 'Return to shadow mode'}
                </Button>}
                <Button variant={location.enabled ? 'secondary' : 'primary'} disabled={working} onClick={() => void run(() => location.enabled
                  ? monitoringApi.revokeLocation(location.id)
                  : monitoringApi.updateLocation(location.id, { enabled: true }))}>
                  {location.enabled ? 'Revoke / disable' : 'Enable'}
                </Button>
                </div>
              </div>
              {location.openIssue && <p role="alert" className="mt-3 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-950/30 dark:text-amber-200">
                {location.openIssue.summary} · since {formatTime(location.openIssue.openedAt)}
              </p>}

              <div className="mt-4 grid grid-cols-2 gap-3 text-sm sm:grid-cols-3 lg:grid-cols-6">
                <Info label="Last check-in" value={location.locationType === 'local' ? 'This server' : formatTime(location.lastSeenAt)} icon={<Clock3 className="h-3.5 w-3.5" />} />
                <Info label="Agent / protocol" value={location.locationType === 'local' ? 'Built-in' : `${location.agentVersion ?? '—'} / ${location.protocolVersion ?? '—'}`} />
                <Info label="Clock offset" value={location.clockOffsetMs === null ? '—' : `${location.clockOffsetMs} ms`} />
                <Info label="Assigned checks" value={String(location.assignedCheckCount)} />
                <Info label="Probe duty" value={`${location.probeDutyPerMinute.toFixed(1)} / min`} icon={<Activity className="h-3.5 w-3.5" />} />
                <Info label="Concurrency" value={String(location.probeConcurrency)} />
              </div>

              <form onSubmit={event => save(event, location)} className="mt-4 grid gap-2 border-t border-gray-100 pt-3 dark:border-robin-gray-800 sm:grid-cols-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_8rem_auto] lg:items-end">
                <Input label="Location name" value={draft.name} maxLength={100} onChange={event => setDrafts(current => ({ ...current, [location.id]: { ...draft, name: event.target.value } }))} />
                <Input label="Region" value={draft.region} maxLength={100} onChange={event => setDrafts(current => ({ ...current, [location.id]: { ...draft, region: event.target.value } }))} />
                <Input label="Concurrency" type="number" min={1} max={128} step={1} value={draft.concurrency} onChange={event => setDrafts(current => ({ ...current, [location.id]: { ...draft, concurrency: Number(event.target.value) } }))} />
                <Button type="submit" variant="secondary" disabled={working || !draft.name.trim()}><Save aria-hidden="true" className="h-4 w-4" />Save location</Button>
              </form>

              {location.recentErrors.length > 0 && <RecentErrors errors={location.recentErrors} />}
            </article>
          );
        })}
      </div>
    </div>
  );
}

function RecentErrors({ errors }: { errors: MonitoringProbeLocation['recentErrors'] }) {
  return (
    <div className="mt-3 border-t border-gray-100 pt-3 dark:border-robin-gray-800">
      <p className="mb-2 text-sm font-medium text-gray-700 dark:text-gray-300">Recent errors <span className="font-normal text-gray-500 dark:text-gray-400">· last 24 hours</span></p>
      <ul className="divide-y divide-gray-100 dark:divide-robin-gray-800">
        {errors.map(item => (
          <li key={`${item.checkName}-${item.errorCode ?? ''}`} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-1.5 text-sm">
            <span aria-hidden="true" className={`h-2 w-2 shrink-0 rounded-full ${item.recovered ? 'bg-gray-300 dark:bg-gray-600' : 'bg-red-500'}`} />
            <span className={`min-w-0 flex-1 truncate font-medium ${item.recovered ? 'text-gray-600 dark:text-gray-400' : 'text-gray-900 dark:text-gray-100'}`} title={item.checkName}>{item.checkName}</span>
            <span className="text-gray-600 dark:text-gray-400">{describeErrorCode(item.errorCode)}{item.count > 1 && <span className="text-gray-500"> ×{item.count}</span>}</span>
            <span className="text-xs text-gray-500 dark:text-gray-400" title={formatTime(item.lastObservedAt)}>last {formatClock(item.lastObservedAt)}</span>
            <span className={`text-xs font-medium ${item.recovered ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-300'}`}>{item.recovered ? 'Recovered' : 'Failing'}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

const ERROR_LABELS: Record<string, string> = {
  connect_refused: 'Connection refused',
  probe_timeout: 'Timed out',
  dns_failed: 'DNS lookup failed',
  tls_certificate_error: 'TLS certificate error',
  target_not_permitted: 'Target not permitted',
  http_status: 'Unexpected HTTP status',
  probe_failed: 'Probe failed',
};

function describeErrorCode(code: string | null): string {
  if (!code) return 'Warning';
  if (ERROR_LABELS[code]) return ERROR_LABELS[code];
  const assertion = /^assertion_failed:(\d+)$/.exec(code);
  if (assertion) return `Assertion ${assertion[1]} failed`;
  const words = code.replace(/[_:]+/g, ' ').trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function formatClock(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'unknown' : date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function Info({ label, value, icon }: { label: string; value: string; icon?: ReactNode }) {
  return <div className="min-w-0"><div className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">{icon}{label}</div><div className="truncate font-medium text-gray-800 dark:text-gray-200">{value}</div></div>;
}

function formatTime(value: string | null): string {
  if (!value) return 'Never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'Unknown' : date.toLocaleString();
}
