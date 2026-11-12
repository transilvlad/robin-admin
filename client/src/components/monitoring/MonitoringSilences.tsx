import { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarClock, CircleX, Plus, RefreshCw } from 'lucide-react';
import { ApiError, monitoringApi } from '../../api/client';
import { Button } from '../ui/Button';
import type { MonitoringCheck, MonitoringSilence, MonitoringTarget } from '../../types/monitoring';

type ScopeType = MonitoringSilence['scopeType'];

interface SilenceForm {
  name: string;
  scopeType: ScopeType;
  scopeId: string;
  reason: string;
  startsAt: string;
  endsAt: string;
}

function localDateTime(value: Date): string {
  const pad = (part: number) => String(part).padStart(2, '0');
  return `${value.getFullYear()}-${pad(value.getMonth() + 1)}-${pad(value.getDate())}T${pad(value.getHours())}:${pad(value.getMinutes())}`;
}

function initialForm(targets: MonitoringTarget[]): SilenceForm {
  const startsAt = new Date();
  const endsAt = new Date(startsAt.getTime() + 60 * 60_000);
  return {
    name: '',
    scopeType: 'target',
    scopeId: String(targets[0]?.id ?? ''),
    reason: '',
    startsAt: localDateTime(startsAt),
    endsAt: localDateTime(endsAt),
  };
}

function status(silence: MonitoringSilence, now: number): string {
  if (silence.processedAt || new Date(silence.endsAt).getTime() <= now) return 'Ended';
  return new Date(silence.startsAt).getTime() > now ? 'Scheduled' : 'Active';
}

function formatWindow(silence: MonitoringSilence): string {
  return `${new Date(silence.startsAt).toLocaleString()} – ${new Date(silence.endsAt).toLocaleString()}`;
}

export function MonitoringSilences({ targets, checks, onChanged }: {
  targets: MonitoringTarget[];
  checks: MonitoringCheck[];
  onChanged: () => void;
}) {
  const [silences, setSilences] = useState<MonitoringSilence[]>([]);
  const [form, setForm] = useState<SilenceForm>(() => initialForm(targets));
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');

  const choices = form.scopeType === 'target' ? targets : checks;
  const checksByTarget = useMemo(() => new Map(checks.map(check => [check.id, check.targetName])), [checks]);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await monitoringApi.silences();
      setSilences(response.data ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load maintenance silences');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => {
    if (!form.scopeId && choices.length) setForm(current => ({ ...current, scopeId: String(choices[0].id) }));
  }, [choices, form.scopeId]);

  const create = async () => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      const scopeId = Number(form.scopeId);
      await monitoringApi.createSilence({
        name: form.name.trim(),
        scopeType: form.scopeType,
        ...(form.scopeType === 'target' ? { targetId: scopeId } : { checkId: scopeId }),
        reason: form.reason.trim() || null,
        startsAt: new Date(form.startsAt).toISOString(),
        endsAt: new Date(form.endsAt).toISOString(),
      });
      setForm(initialForm(targets));
      setMessage('Maintenance silence scheduled');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : err instanceof Error ? err.message : 'Failed to schedule maintenance');
    } finally {
      setWorking(false);
    }
  };

  const end = async (silence: MonitoringSilence) => {
    setWorking(true);
    setError('');
    setMessage('');
    try {
      await monitoringApi.endSilence(silence.id);
      setMessage('Silence ended; active issues can notify again');
      await load();
      onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to end maintenance silence');
    } finally {
      setWorking(false);
    }
  };

  const now = Date.now();
  return <div className="space-y-4">
    <section className="card space-y-4 p-4">
      <div className="flex items-start gap-3">
        <CalendarClock aria-hidden="true" className="mt-1 h-5 w-5 shrink-0 text-robin-orange" />
        <div>
          <h2 className="font-semibold">Scheduled maintenance silences</h2>
          <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
            Monitoring continues to record health and issues. Opening notifications are held during a silence; any issue still open when it ends is notified. Recovery notifications for previously notified issues are still sent.
          </p>
        </div>
      </div>
      <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-5">
        <label className="space-y-1"><span className="block text-sm font-medium">Name</span><input className="input w-full" maxLength={160} value={form.name} onChange={event => setForm(current => ({ ...current, name: event.target.value }))} /></label>
        <label className="space-y-1"><span className="block text-sm font-medium">Scope</span><select className="input w-full" value={form.scopeType} onChange={event => {
          const scopeType = event.target.value as ScopeType;
          const nextChoices = scopeType === 'target' ? targets : checks;
          setForm(current => ({ ...current, scopeType, scopeId: String(nextChoices[0]?.id ?? '') }));
        }}><option value="target">All checks on target</option><option value="check">Single check</option></select></label>
        <label className="space-y-1"><span className="block text-sm font-medium">{form.scopeType === 'target' ? 'Target' : 'Check'}</span><select className="input w-full" value={form.scopeId} onChange={event => setForm(current => ({ ...current, scopeId: event.target.value }))}>{choices.map(choice => <option key={choice.id} value={choice.id}>{choice.name}</option>)}</select></label>
        <label className="space-y-1"><span className="block text-sm font-medium">Starts</span><input className="input w-full" type="datetime-local" value={form.startsAt} onChange={event => setForm(current => ({ ...current, startsAt: event.target.value }))} /></label>
        <label className="space-y-1"><span className="block text-sm font-medium">Ends</span><input className="input w-full" type="datetime-local" value={form.endsAt} onChange={event => setForm(current => ({ ...current, endsAt: event.target.value }))} /></label>
      </div>
      <div className="flex flex-col gap-3 sm:flex-row">
        <label className="flex-1 space-y-1"><span className="block text-sm font-medium">Reason (optional)</span><input className="input w-full" maxLength={500} value={form.reason} onChange={event => setForm(current => ({ ...current, reason: event.target.value }))} /></label>
        <div className="flex items-end"><Button onClick={() => void create()} disabled={working || !form.name.trim() || !form.scopeId || !form.startsAt || !form.endsAt}><Plus aria-hidden="true" className="h-4 w-4" />Schedule silence</Button></div>
      </div>
      <div aria-live="polite">{error && <p role="alert" className="text-sm text-red-600 dark:text-red-300">{error}</p>}{message && <p role="status" className="text-sm text-green-700 dark:text-green-300">{message}</p>}</div>
    </section>

    <section className="card overflow-hidden">
      <div className="flex items-center justify-between border-b border-gray-200 p-4 dark:border-gray-700">
        <div><h2 className="font-semibold">Maintenance windows</h2><p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Maximum duration is 30 days.</p></div>
        <Button size="sm" variant="secondary" onClick={() => void load()} disabled={loading}><RefreshCw aria-hidden="true" className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} />Refresh</Button>
      </div>
      {loading ? <p className="p-5 text-sm text-gray-500">Loading silences…</p> : <div className="overflow-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300"><tr>{['Name', 'Scope', 'Window', 'Reason', 'State', ''].map(label => <th key={label} scope="col" className="px-4 py-3 font-medium">{label}</th>)}</tr></thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">{silences.map(silence => {
            const scope = silence.scopeType === 'target'
              ? `Target: ${silence.targetName ?? `#${silence.targetId}`}`
              : `${silence.targetName ?? checksByTarget.get(silence.checkId ?? -1) ?? 'Target'} / ${silence.checkName ?? `Check #${silence.checkId}`}`;
            const state = status(silence, now);
            return <tr key={silence.id}>
              <td className="px-4 py-3 font-medium">{silence.name}</td>
              <td className="px-4 py-3">{scope}</td>
              <td className="whitespace-nowrap px-4 py-3">{formatWindow(silence)}</td>
              <td className="px-4 py-3">{silence.reason || '—'}</td>
              <td className="px-4 py-3">{state}</td>
              <td className="px-4 py-3">{state !== 'Ended' && <Button size="sm" variant="secondary" onClick={() => void end(silence)} disabled={working}><CircleX aria-hidden="true" className="h-4 w-4" />End now</Button>}</td>
            </tr>;
          })}{!silences.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No maintenance silences scheduled.</td></tr>}</tbody>
        </table>
      </div>}
    </section>
  </div>;
}
