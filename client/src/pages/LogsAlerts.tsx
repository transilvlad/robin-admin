import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, BellRing, Eye, Info, Pencil, RefreshCw, Settings, Trash2 } from 'lucide-react';
import { ApiError, logsApi } from '../api/client';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useConfirm } from '../context/ConfirmContext';
import type { LogsAlertComparator, LogsAlertRule, LogsAlertRuleInput, LogsStoreStatus } from '../types';

const EMPTY_FORM: LogsAlertRuleInput = {
  name: '',
  description: null,
  query: '',
  windowSeconds: 300,
  comparator: '>=',
  threshold: 1,
  forSeconds: 300,
  enabled: true,
};

function condition(input: Pick<LogsAlertRuleInput, 'comparator' | 'threshold' | 'windowSeconds'>): string {
  return `${input.comparator} ${input.threshold} matching logs in ${input.windowSeconds / 60} min`;
}

function statusLabel(rule: LogsAlertRule): string {
  if (!rule.enabled) return 'Disabled';
  return rule.status === 'firing' ? 'Firing' : rule.status === 'pending' ? 'Pending' : 'OK';
}

export function LogsAlertsPage() {
  const [rules, setRules] = useState<LogsAlertRule[] | null>(null);
  const [form, setForm] = useState<LogsAlertRuleInput>(EMPTY_FORM);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [preview, setPreview] = useState<{ value: number; matches: boolean } | null>(null);
  const confirm = useConfirm();
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [storeStatus, setStoreStatus] = useState<LogsStoreStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const busy = saving || previewing;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await logsApi.listAlertRules();
      setRules(response.data ?? []);
      setLoadError('');
    } catch (err) {
      setLoadError(err instanceof ApiError ? err.message : 'Failed to load Logs alerts');
    } finally {
      setLoading(false);
    }
  }, []);

  const loadStoreStatus = useCallback(async () => {
    try {
      const response = await logsApi.status();
      setStoreStatus(response.data ?? null);
      setStatusError('');
    } catch (err) {
      setStoreStatus(null);
      setStatusError(err instanceof ApiError ? err.message : 'Failed to load Logs health');
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { void loadStoreStatus(); }, [loadStoreStatus]);
  useEffect(() => {
    const timer = window.setInterval(() => { void load(); void loadStoreStatus(); }, 60_000);
    return () => window.clearInterval(timer);
  }, [load, loadStoreStatus]);

  function update<K extends keyof LogsAlertRuleInput>(key: K, value: LogsAlertRuleInput[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setPreview(null);
  }

  function edit(rule: LogsAlertRule) {
    setEditingId(rule.id);
    setForm({
      name: rule.name,
      description: rule.description,
      query: rule.query,
      windowSeconds: rule.windowSeconds,
      comparator: rule.comparator,
      threshold: rule.threshold,
      forSeconds: rule.forSeconds,
      enabled: rule.enabled,
    });
    setPreview(null);
  }

  async function testRule() {
    setPreviewing(true);
    try {
      const response = await logsApi.previewAlertRule(form);
      setPreview(response.data ?? null);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to preview Logs alert');
    } finally {
      setPreviewing(false);
    }
  }

  async function saveRule(event: FormEvent) {
    event.preventDefault();
    setSaving(true);
    try {
      if (editingId === null) await logsApi.createAlertRule(form);
      else await logsApi.updateAlertRule(editingId, form);
      setForm(EMPTY_FORM);
      setEditingId(null);
      setPreview(null);
      setError('');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to save Logs alert');
    } finally {
      setSaving(false);
    }
  }

  async function removeRule(rule: LogsAlertRule) {
    if (!(await confirm(`Delete the log alert "${rule.name}"? If it is firing, a recovery is queued for subscribed destinations that allow recovery notifications.`))) return;
    setSaving(true);
    try {
      await logsApi.deleteAlertRule(rule.id);
      if (editingId === rule.id) {
        setEditingId(null);
        setForm(EMPTY_FORM);
      }
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete Logs alert');
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader icon={appIcons.alerts} title="Log alerts" description="Evaluate a count query every minute, wait for the condition to persist, then notify subscribed alert destinations." actions={<div className="flex gap-2">
        <Link className="btn btn-secondary" to="/administration/alerts"><BellRing className="h-4 w-4" aria-hidden="true" />Alert destinations</Link>
        <Link className="btn btn-secondary" to="/administration/logs" title="Logs settings" aria-label="Logs settings"><Settings className="h-4 w-4" aria-hidden="true" /></Link>
      </div>} />
      <p className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50 p-3 text-sm text-blue-800 dark:border-blue-900/40 dark:bg-blue-900/10 dark:text-blue-200">
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <span>Rules use the same filter syntax as Search (pipes are not allowed). Configure the “Logs alert rule” subscription on an enabled destination under Alert destinations. Recovery messages follow that destination’s recovery setting.</span>
      </p>
      {statusError && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">Logs delivery health is unavailable: {statusError}</p>}
      {storeStatus && (storeStatus.write.queuedLines > 0 || storeStatus.write.droppedLines24h > 0 || storeStatus.write.rejectedLines24h > 0 || storeStatus.write.discardedLines24h > 0) && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Queued, rejected, dropped, or discarded lines can make alert counts incomplete. Check <Link className="underline" to="/logs/health">Logs health</Link> before relying on these results.</span>
        </p>
      )}
      {storeStatus && (storeStatus.write.uncertainBatches > 0 || storeStatus.write.uncertainDeliveries24h > 0) && (
        <p role="status" className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
          <span>Some store writes had uncertain outcomes. Retried lines may be counted more than once. See <Link className="underline" to="/logs/health">Logs health</Link>.</span>
        </p>
      )}
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {loadError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{loadError}</p>}

      <form className="card" onSubmit={(event) => void saveRule(event)} aria-labelledby="logs-alert-form-title">
        <div className="card-header flex flex-wrap items-start justify-between gap-4">
          <div><h2 id="logs-alert-form-title" className="card-title">{editingId === null ? 'Create a log alert' : 'Edit log alert'}</h2><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Maximum 20 rules. Evaluation uses the last 60 seconds to 24 hours of logs.</p></div>
          {editingId !== null && <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => { setEditingId(null); setForm(EMPTY_FORM); setPreview(null); }}>Cancel edit</button>}
        </div>
        <div className="card-body space-y-5">
        <fieldset disabled={busy} className="grid gap-x-6 gap-y-4 md:grid-cols-2">
          <label className="flex flex-col gap-1.5 text-sm"><span className="form-label mb-0">Name</span><input className="input" name="name" required maxLength={120} autoComplete="off" value={form.name} onChange={(event) => update('name', event.target.value)} placeholder="e.g. Delivery errors…" /></label>
          <label className="flex flex-col gap-1.5 text-sm"><span className="form-label mb-0">Description <span className="font-normal text-gray-400">(optional)</span></span><input className="input" name="description" maxLength={500} autoComplete="off" value={form.description ?? ''} onChange={(event) => update('description', event.target.value || null)} /></label>
          <label className="flex flex-col gap-1.5 text-sm md:col-span-2"><span className="form-label mb-0">Log filter</span><input className="input font-mono" name="query" maxLength={1000} value={form.query} onChange={(event) => update('query', event.target.value)} placeholder='error, "connection refused", source:file…' autoComplete="off" spellCheck={false} /><span className="form-hint mt-0">Leave empty to count all logs. For a quiet-source alert, filter on the source name and alert when count is at or below 0.</span></label>
          <label className="flex flex-col gap-1.5 text-sm"><span className="form-label mb-0">Window</span><select className="input" value={form.windowSeconds} onChange={(event) => update('windowSeconds', Number(event.target.value))}><option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={900}>15 minutes</option><option value={3600}>1 hour</option><option value={21600}>6 hours</option><option value={86400}>24 hours</option></select></label>
          <div className="flex flex-col gap-1.5 text-sm"><span className="form-label mb-0" id="logs-alert-threshold">Threshold</span><div className="flex gap-2"><select className="input w-24" aria-label="Comparator" value={form.comparator} onChange={(event) => update('comparator', event.target.value as LogsAlertComparator)}>{['>', '>=', '<', '<=', '==', '!='].map((value) => <option key={value} value={value}>{value}</option>)}</select><input className="input flex-1 tabular-nums" aria-label="Threshold count" type="number" inputMode="numeric" min="0" max="1000000000" step="1" value={form.threshold} onChange={(event) => update('threshold', Number(event.target.value))} /></div></div>
          <label className="flex flex-col gap-1.5 text-sm"><span className="form-label mb-0">Condition must hold for</span><select className="input" value={form.forSeconds} onChange={(event) => update('forSeconds', Number(event.target.value))}><option value={60}>1 minute</option><option value={300}>5 minutes</option><option value={600}>10 minutes</option><option value={1800}>30 minutes</option></select></label>
          <label className="flex items-center gap-2 self-end pb-2.5 text-sm"><input type="checkbox" className="h-4 w-4 rounded border-gray-300 text-robin-orange focus:ring-robin-orange" checked={form.enabled} onChange={(event) => update('enabled', event.target.checked)} />Enabled</label>
        </fieldset>
        {preview && <p role="status" aria-live="polite" className={`rounded-lg p-3 text-sm ${preview.matches ? 'bg-amber-50 text-amber-800 dark:bg-amber-900/10 dark:text-amber-200' : 'bg-green-50 text-green-800 dark:bg-green-900/10 dark:text-green-200'}`}>
          Current count: <strong className="tabular-nums">{preview.value.toLocaleString()}</strong> · {condition(form)} · {preview.matches ? 'condition matches now; the hold period still applies' : 'condition does not match now'}
        </p>}
        </div>
        <div className="flex flex-wrap justify-end gap-2 border-t border-gray-200 px-6 py-4 dark:border-robin-gray-700">
          <button type="button" className="btn btn-secondary" onClick={() => void testRule()} disabled={busy}><Eye className="h-4 w-4" aria-hidden="true" />{previewing ? 'Previewing…' : 'Preview'}</button>
          <button type="submit" className="btn btn-primary" disabled={busy}>{saving ? 'Saving…' : editingId === null ? 'Create rule' : 'Save changes'}</button>
        </div>
      </form>

      <section className="card overflow-hidden p-0" aria-label="Log alert rules">
        <div className="flex items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700">
          <div><h2 className="flex items-center gap-2 text-base font-semibold"><BellRing className="h-4 w-4 text-robin-orange" aria-hidden="true" />Rules</h2><p className="mt-1 text-sm text-gray-500 dark:text-gray-400">The evaluator runs once per minute; query failures are shown rather than treated as recovery.</p></div>
          <button type="button" className="btn btn-secondary" onClick={() => void load()} disabled={loading} title="Refresh log alert rules" aria-label="Refresh log alert rules"><RefreshCw className={`h-4 w-4 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" /></button>
        </div>
        {!rules ? (!loadError && <div className="flex justify-center p-8"><Spinner label="Loading log alert rules" /></div>) : rules.length === 0 ? (
          <p className="p-6 text-sm text-gray-500 dark:text-gray-400">No log alert rules. Create one above to monitor a recurring filter.</p>
        ) : <div className="divide-y divide-gray-200 dark:divide-gray-700">
          {rules.map((rule) => (
            <article key={rule.id} className="space-y-2 p-4">
              <div className="flex flex-wrap items-start justify-between gap-3">
                <div className="min-w-0 flex-1 break-words">
                  <div className="flex flex-wrap items-center gap-2"><h3 className="font-medium">{rule.name}</h3><span className={`rounded-full px-2.5 py-1 text-xs font-medium ${rule.status === 'firing' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200' : rule.status === 'pending' ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-300'}`}>{statusLabel(rule)}</span></div>
                  {rule.description && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{rule.description}</p>}
                  <p className="mt-1 font-mono text-xs text-gray-500 dark:text-gray-400">{rule.query || 'all logs'} · {condition(rule)} · for {rule.forSeconds / 60} min</p>
                  <p className="mt-1 text-xs text-gray-500 dark:text-gray-400">Last count: {rule.lastValue?.toLocaleString() ?? 'Not evaluated'} · Last evaluation: {rule.lastEvaluatedAt ? new Date(rule.lastEvaluatedAt).toLocaleString() : 'Never'}</p>
                  {rule.lastError && <p role="status" className="mt-1 flex items-start gap-1 text-xs text-amber-700 dark:text-amber-300"><AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />{rule.lastError}</p>}
                </div>
                <div className="flex gap-2">
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => edit(rule)} aria-label={`Edit ${rule.name}`}><Pencil className="h-4 w-4" aria-hidden="true" />Edit</button>
                  <button type="button" className="btn btn-secondary" disabled={busy} onClick={() => void removeRule(rule)} aria-label={`Delete ${rule.name}`}><Trash2 className="h-4 w-4" aria-hidden="true" /></button>
                </div>
              </div>
            </article>
          ))}
        </div>}
      </section>
    </div>
  );
}
