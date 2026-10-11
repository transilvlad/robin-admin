import { type FormEvent, useEffect, useState } from 'react';
import { HeartPulse, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { ApiError, monitoringApi } from '../../api/client';
import type { MonitoringHeartbeat, MonitoringHeartbeatFormat } from '../../types/monitoring';
import type { MonitoringHeartbeatHealth } from '../../types/monitoring';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

const emptyForm = {
  name: '', format: 'generic' as MonitoringHeartbeatFormat, pingUrl: '', failureUrl: '',
  intervalSeconds: 60, minimumFreshLocations: 0, enabled: true, clearFailureUrl: false,
};

export function MonitoringHeartbeats() {
  const [targets, setTargets] = useState<MonitoringHeartbeat[]>([]);
  const [health, setHealth] = useState<MonitoringHeartbeatHealth | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [editing, setEditing] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const load = async () => {
    try {
      const [response, healthResponse] = await Promise.all([monitoringApi.listHeartbeats(), monitoringApi.heartbeatHealth()]);
      setTargets(response.data ?? []);
      setHealth(healthResponse.data ?? null);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Failed to load heartbeat targets');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => { void load(); }, []);

  const save = async (event: FormEvent) => {
    event.preventDefault();
    setWorking(true); setError(''); setMessage('');
    const sentry = form.format === 'sentry_crons';
    const payload = {
      name: form.name,
      format: form.format,
      intervalSeconds: Number(form.intervalSeconds),
      minimumFreshLocations: Number(form.minimumFreshLocations),
      enabled: form.enabled,
      ...(form.pingUrl ? { pingUrl: form.pingUrl } : {}),
      ...(sentry ? {} : form.clearFailureUrl ? { failureUrl: null } : form.failureUrl ? { failureUrl: form.failureUrl } : {}),
    };
    try {
      if (editing === null) {
        await monitoringApi.createHeartbeat({ ...payload, pingUrl: form.pingUrl });
        setMessage('Heartbeat added');
      } else {
        await monitoringApi.updateHeartbeat(editing, payload);
        setMessage('Heartbeat saved');
      }
      setForm(emptyForm); setEditing(null); await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Failed to save heartbeat');
    } finally {
      setWorking(false);
    }
  };

  const edit = (target: MonitoringHeartbeat) => {
    setEditing(target.id);
    setForm({
      ...emptyForm,
      name: target.name,
      format: target.format,
      intervalSeconds: target.intervalSeconds,
      minimumFreshLocations: target.minimumFreshLocations,
      enabled: target.enabled,
    });
    setError(''); setMessage('');
  };

  const remove = async (target: MonitoringHeartbeat) => {
    setWorking(true); setError(''); setMessage('');
    try {
      await monitoringApi.deleteHeartbeat(target.id);
      if (editing === target.id) { setEditing(null); setForm(emptyForm); }
      setMessage('Heartbeat removed'); await load();
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Failed to remove heartbeat');
    } finally { setWorking(false); }
  };

  const test = async (target: MonitoringHeartbeat) => {
    setWorking(true); setError(''); setMessage('');
    try {
      const result = await monitoringApi.testHeartbeat(target.id);
      setMessage(result.data?.accepted ? `Test ping accepted by ${target.name}` : `Test ping was not accepted by ${target.name}`);
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Failed to send test ping');
    } finally { setWorking(false); }
  };

  return <section className="card space-y-5 p-5">
    <div className="flex items-start gap-3">
      <HeartPulse className="mt-1 h-5 w-5 text-robin-blue" aria-hidden="true" />
      <div>
        <h2 className="text-lg font-semibold">External heartbeats</h2>
        <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Send an HTTPS heartbeat only while Monitoring, its scheduler, the database, alert delivery, and any configured fresh-location minimum are healthy. URL tokens are encrypted and never returned.</p>
      </div>
    </div>
    {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
    {message && <p role="status" className="text-sm text-green-700 dark:text-green-400">{message}</p>}
    {health && <p className={`rounded border p-3 text-sm ${health.healthy ? 'border-green-300 text-green-800 dark:border-green-800 dark:text-green-200' : 'border-amber-300 text-amber-900 dark:border-amber-700 dark:text-amber-200'}`} role="status">
      Current health: <strong>{health.healthy ? 'Healthy' : `Unhealthy${health.reason ? ` (${health.reason})` : ''}`}</strong>
    </p>}
    {loading ? <p className="text-sm text-gray-500">Loading heartbeat targets…</p> : targets.length === 0
      ? <p className="text-sm text-gray-500">No heartbeat targets configured.</p>
      : <ul className="divide-y divide-gray-200 dark:divide-robin-gray-700">
        {targets.map(target => <li key={target.id} className="flex flex-wrap items-center justify-between gap-3 py-3">
          <div>
            <p className="font-medium">{target.name} <span className={target.enabled ? 'text-green-700 dark:text-green-400' : 'text-gray-500'}>{target.enabled ? 'Enabled' : 'Disabled'}</span></p>
            <p className="text-xs text-gray-500">{target.format === 'sentry_crons' ? 'Sentry Crons' : 'Generic'} · every {target.intervalSeconds}s · {target.minimumFreshLocations || 'No'} fresh locations required · ping URL {target.pingUrlConfigured ? 'configured' : 'missing'}{target.format === 'sentry_crons' ? '' : ` · failure URL ${target.failureUrlConfigured ? 'configured' : 'not configured'}`}</p>
            <p className="text-xs text-gray-500">Last attempt: {target.lastAttemptAt ? new Date(target.lastAttemptAt).toLocaleString() : 'Never'}{target.lastResult ? ` · ${target.lastResult}` : ''}{target.lastReason ? ` · ${target.lastReason}` : ''}</p>
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" disabled={working} onClick={() => void test(target)}><Send className="h-4 w-4" />Send test ping</Button>
            <Button type="button" variant="secondary" disabled={working} aria-label={`Edit ${target.name}`} onClick={() => edit(target)}><Pencil className="h-4 w-4" /></Button>
            <Button type="button" variant="secondary" disabled={working} aria-label={`Delete ${target.name}`} onClick={() => void remove(target)}><Trash2 className="h-4 w-4" /></Button>
          </div>
        </li>)}
      </ul>}
    <form onSubmit={save} className="space-y-4 border-t border-gray-200 pt-5 dark:border-robin-gray-700">
      <h3 className="font-medium">{editing === null ? 'Add heartbeat target' : 'Edit heartbeat target'}</h3>
      <div className="grid gap-4 sm:grid-cols-2">
        <Input label="Name" required maxLength={100} value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} />
        <label className="block space-y-1 text-sm">
          <span className="block font-medium text-gray-700 dark:text-gray-300">Format</span>
          <select className="input" value={form.format} onChange={event => setForm({ ...form, format: event.target.value as MonitoringHeartbeatFormat })}>
            <option value="generic">Generic (POST status and reason)</option>
            <option value="sentry_crons">Sentry Crons check-in</option>
          </select>
        </label>
        <Input label="Interval (seconds)" type="number" min={15} max={3600} required value={form.intervalSeconds} onChange={event => setForm({ ...form, intervalSeconds: Number(event.target.value) })} />
        <Input label="Minimum fresh probe locations (0 = off)" type="number" min={0} max={128} required value={form.minimumFreshLocations} onChange={event => setForm({ ...form, minimumFreshLocations: Number(event.target.value) })} />
        <Input
          label={`${form.format === 'sentry_crons' ? 'Sentry check-in URL' : 'Ping URL'}${editing === null ? '' : ' (leave blank to keep current)'}`}
          type="url"
          required={editing === null}
          value={form.pingUrl}
          placeholder={form.format === 'sentry_crons' ? 'https://o<org>.ingest.sentry.io/api/<project>/cron/<monitor>/<key>/' : undefined}
          onChange={event => setForm({ ...form, pingUrl: event.target.value })}
        />
        {form.format !== 'sentry_crons' && <Input label="Failure URL (optional; leave blank to keep current)" type="url" value={form.failureUrl} onChange={event => setForm({ ...form, failureUrl: event.target.value, clearFailureUrl: false })} />}
      </div>
      {form.format === 'sentry_crons' && <p className="text-sm text-gray-600 dark:text-gray-300">
        Sends Sentry Cron check-ins: <code>ok</code> while Robin Admin is healthy, <code>error</code> with the same URL when it is not.
        The Sentry monitor is created on the first check-in, so any monitor slug in the URL works.
      </p>}
      {editing !== null && form.format !== 'sentry_crons' && <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.clearFailureUrl} onChange={event => setForm({ ...form, clearFailureUrl: event.target.checked, failureUrl: '' })} />Remove the configured failure URL</label>}
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={event => setForm({ ...form, enabled: event.target.checked })} />Enabled</label>
      <div className="flex gap-2">
        <Button type="submit" disabled={working}><Plus className="h-4 w-4" />{working ? 'Saving…' : editing === null ? 'Add heartbeat' : 'Save heartbeat'}</Button>
        {editing !== null && <Button type="button" variant="secondary" disabled={working} onClick={() => { setEditing(null); setForm(emptyForm); }}>Cancel</Button>}
      </div>
    </form>
  </section>;
}
