import { useCallback, useEffect, useState } from 'react';
import { Activity, Camera, RefreshCw, Save, Trash2 } from 'lucide-react';
import { ApiError, telemetryApi, telemetrySettingsApi } from '../../api/client';
import type { TelemetryConnection, TelemetryConnectionUpdate, TelemetrySnapshot } from '../../types/telemetry-settings';
import type { TelemetryStoreHealth } from '../../types/telemetry';
import { formatTelemetryValue } from '../../utils/telemetry';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Spinner } from '../ui/Spinner';

function message(error: unknown) { return error instanceof ApiError ? error.message : 'Operation failed'; }

export function TelemetryConnectionSettings() {
  const [connection, setConnection] = useState<TelemetryConnection | null>(null);
  const [secret, setSecret] = useState('');
  const [clearSecret, setClearSecret] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  useEffect(() => {
    let cancelled = false;
    telemetrySettingsApi.connection().then(response => { if (!cancelled && response.data) setConnection(response.data); })
      .catch(error => { if (!cancelled) setError(message(error)); });
    return () => { cancelled = true; };
  }, []);
  async function submit(test: boolean) {
    if (!connection) return;
    const { secretConfigured: _configured, ...fields } = connection;
    const update: TelemetryConnectionUpdate = { ...fields, ...(secret ? { secret } : {}), clearSecret };
    setBusy(true); setError(''); setSuccess('');
    try {
      if (test) { const result = await telemetrySettingsApi.test(update); setSuccess(result.data?.reachable ? 'Connection healthy' : 'Store disabled'); }
      else {
        const result = await telemetrySettingsApi.save(update);
        if (!result.data) throw new Error('Missing connection');
        setConnection(result.data); setSecret(''); setClearSecret(false); setSuccess('Connection saved');
      }
    } catch (error) { setError(message(error)); }
    finally { setBusy(false); }
  }
  if (!connection) return error ? <p role="alert" className="text-sm text-red-600">{error}</p> : <Spinner label="Loading connection" />;
  function change<K extends keyof TelemetryConnection>(key: K, value: TelemetryConnection[K]) {
    setConnection(current => current ? { ...current, [key]: value } : null); setSuccess('');
  }
  return <form onSubmit={event => { event.preventDefault(); void submit(false); }} className="space-y-5">
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {success && <p role="status" className="text-sm text-green-700 dark:text-green-400">{success}</p>}
    <fieldset disabled={busy} className="space-y-4 border-t border-gray-200 pt-5 dark:border-robin-gray-700">
      <label className="block text-sm font-medium">Store mode<select className="input mt-1 w-full sm:max-w-sm" value={connection.mode} onChange={event => change('mode', event.target.value as TelemetryConnection['mode'])}><option value="bundled">Bundled VictoriaMetrics</option><option value="external">External store</option><option value="disabled">Disabled</option></select></label>
      {connection.mode === 'bundled' && <p className="text-sm text-gray-500 dark:text-gray-400">The VictoriaMetrics store that ships with this deployment, at the address the deployment sets (<code>TELEMETRY_STORE_URL</code>). Nothing else to configure.</p>}
      {connection.mode === 'external' && <>
        <Input label="Store URL" type="url" required value={connection.url} onChange={event => change('url', event.target.value)} />
        <label className="block text-sm font-medium">Authentication<select className="input mt-1 w-full sm:max-w-sm" value={connection.auth} onChange={event => change('auth', event.target.value as TelemetryConnection['auth'])}><option value="none">None</option><option value="basic">Basic</option><option value="bearer">Bearer token</option></select></label>
        {connection.auth !== 'none' && <div className="grid gap-4 sm:grid-cols-2">
          {connection.auth === 'basic' && <Input label="Username" required value={connection.username} onChange={event => change('username', event.target.value)} />}
          <Input label={connection.auth === 'basic' ? 'Password' : 'Bearer token'} type="password" autoComplete="new-password" value={secret} placeholder={connection.secretConfigured ? 'Credential stored' : ''} onChange={event => { setSecret(event.target.value); setClearSecret(false); setSuccess(''); }} />
        </div>}
        {connection.secretConfigured && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={clearSecret} onChange={event => { setClearSecret(event.target.checked); if (event.target.checked) setSecret(''); }} />Clear stored credential</label>}
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={connection.allowPrivate} onChange={event => change('allowPrivate', event.target.checked)} />Allow private-network destination</label>
      </>}
      <div className="flex flex-wrap gap-2"><Button type="button" variant="secondary" onClick={() => void submit(true)}><Activity className="h-4 w-4" />Test connection</Button><Button type="submit"><Save className="h-4 w-4" />Save</Button></div>
    </fieldset>
  </form>;
}

export function TelemetryStorageSettingsView() {
  const [mode, setMode] = useState<TelemetryConnection['mode'] | null>(null);
  const [health, setHealth] = useState<TelemetryStoreHealth | null>(null);
  const [snapshots, setSnapshots] = useState<TelemetrySnapshot[]>([]);
  const [pendingDelete, setPendingDelete] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const load = useCallback(async () => {
    setError('');
    const connection = (await telemetrySettingsApi.connection()).data;
    if (!connection) throw new Error('Missing connection');
    setMode(connection.mode);
    if (connection.mode === 'disabled') return;
    const [store, list] = await Promise.all([
      telemetryApi.store(),
      connection.mode === 'bundled' ? telemetrySettingsApi.snapshots() : Promise.resolve({ data: [] }),
    ]);
    setHealth(store.data ?? null);
    setSnapshots(list.data ?? []);
  }, []);
  useEffect(() => { void load().catch(error => setError(message(error))); }, [load]);
  async function run(action: () => Promise<string>) {
    setBusy(true); setError(''); setSuccess('');
    try { const done = await action(); await load(); setSuccess(done); }
    catch (error) { setError(message(error)); }
    finally { setBusy(false); setPendingDelete(''); }
  }
  const bytes = (value: number | null | undefined) => value === null || value === undefined ? 'Unknown' : formatTelemetryValue(value, 'bytes');
  const stats: Array<[string, string]> = [
    ['Version', health?.version ?? 'Unknown'], ['Retention', health?.retention ?? 'Unknown'], ['Memory limit', bytes(health?.memoryLimitBytes)],
    ['Data on disk', bytes(health?.dataSizeBytes)], ['Free disk', bytes(health?.freeDiskBytes)],
  ];
  return <div className="space-y-5">
    {error && <p role="alert" className="text-sm text-red-600">{error}</p>}
    {success && <p role="status" className="text-sm text-green-700 dark:text-green-400">{success}</p>}
    {mode === null ? (!error && <Spinner label="Loading storage" />) : mode === 'disabled' ? <p className="text-sm text-gray-600 dark:text-gray-400">The telemetry store is disabled. Choose a store under connection.</p> : <>
      <section className="space-y-3 border-t border-gray-200 pt-5 dark:border-robin-gray-700">
        <div className="flex items-center justify-between gap-3"><h2 className="text-base font-semibold">Store</h2><Button variant="secondary" disabled={busy} onClick={() => void load().catch(error => setError(message(error)))}><RefreshCw className="h-4 w-4" />Refresh</Button></div>
        <dl className="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">{stats.map(([label, value]) => <div key={label} className="min-w-0"><dt className="text-xs text-gray-500">{label}</dt><dd className="mt-0.5 wrap-break-word font-medium tabular-nums">{value}</dd></div>)}</dl>
        <p className="text-sm text-gray-500 dark:text-gray-400">{mode === 'bundled'
          ? <>Retention and memory are deployment settings: <code>TELEMETRY_RETENTION_DAYS</code> and <code>TELEMETRY_STORE_MEMORY</code> in the deployment&apos;s <code>.env</code>. Change them there and recreate the store container.</>
          : 'Retention, memory and backups of an external store are managed where it runs.'}</p>
      </section>
      {mode === 'bundled' && <section className="space-y-3 border-t border-gray-200 pt-5 dark:border-robin-gray-700">
        <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-base font-semibold">Snapshots</h2><Button disabled={busy} onClick={() => void run(async () => { const result = await telemetrySettingsApi.createSnapshot(); return `Snapshot ${result.data?.name ?? ''} created`; })}><Camera className="h-4 w-4" />Create snapshot</Button></div>
        <p className="text-sm text-gray-500 dark:text-gray-400">An online, consistent copy of the store, kept under <code>snapshots/</code> in the store&apos;s data volume. Copy a snapshot off the host to keep it as a backup; restore with the store stopped, as described in the Telemetry documentation.</p>
        {snapshots.length ? <ul className="divide-y divide-gray-200 dark:divide-robin-gray-700">{snapshots.map(snapshot => <li key={snapshot.name} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
          <span><span className="font-medium">{new Date(snapshot.createdAt).toLocaleString()}</span> <code className="text-xs text-gray-500">{snapshot.name}</code></span>
          {pendingDelete === snapshot.name
            ? <span className="flex gap-2"><Button variant="secondary" disabled={busy} onClick={() => setPendingDelete('')}>Cancel</Button><Button variant="danger" disabled={busy} onClick={() => void run(async () => { await telemetrySettingsApi.deleteSnapshot(snapshot.name); return 'Snapshot deleted'; })}><Trash2 className="h-4 w-4" />Confirm delete</Button></span>
            : <Button variant="secondary" disabled={busy} aria-label={`Delete snapshot ${snapshot.name}`} onClick={() => setPendingDelete(snapshot.name)}><Trash2 className="h-4 w-4" />Delete</Button>}
        </li>)}</ul> : <p className="text-sm text-gray-500">No snapshots</p>}
      </section>}
    </>}
  </div>;
}
