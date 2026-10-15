/**
 * Telemetry alert rules: a query against the telemetry store, a condition and
 * a duration. Each result series (for example each host) fires and recovers on
 * its own; webhooks subscribed to "Telemetry rule" receive the notifications.
 */
import { useCallback, useEffect, useState } from 'react';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { alertsApi, ApiError } from '../../api/client';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Modal } from '../ui/Modal';
import { Spinner } from '../ui/Spinner';
import {
  TELEMETRY_ALERT_COMPARATORS,
  type TelemetryAlertComparator,
  type TelemetryAlertPreview,
  type TelemetryAlertRule,
  type TelemetryAlertRuleInput,
} from '../../types/telemetry-alerts';

interface RuleForm {
  id: number | null;
  name: string;
  description: string;
  query: string;
  comparator: TelemetryAlertComparator;
  threshold: string;
  forMinutes: string;
  severity: TelemetryAlertRuleInput['severity'];
  enabled: boolean;
}

const EMPTY_FORM: RuleForm = {
  id: null,
  name: '',
  description: '',
  query: '',
  comparator: '<',
  threshold: '1',
  forMinutes: '5',
  severity: 'critical',
  enabled: true,
};

export function formatLabels(labels: Record<string, string>): string {
  const entries = Object.entries(labels).filter(([name]) => name !== '__name__');
  return entries.length ? entries.sort(([a], [b]) => a.localeCompare(b)).map(([name, value]) => `${name}=${value}`).join(', ') : 'all series';
}

function formatValue(value: number | null): string {
  return value === null ? 'n/a' : String(Number(value.toFixed(4)));
}

function formatCondition(rule: Pick<TelemetryAlertRule, 'comparator' | 'threshold' | 'forSeconds'>): string {
  const duration = rule.forSeconds === 0
    ? 'immediately'
    : rule.forSeconds % 60 === 0 ? `for ${rule.forSeconds / 60} min` : `for ${rule.forSeconds} s`;
  return `${rule.comparator} ${rule.threshold} ${duration}`;
}

function formatTime(value: string | null): string {
  return value ? new Date(value).toLocaleString() : 'never';
}

/** Parses the form, or returns the first problem to show. */
function toInput(form: RuleForm): TelemetryAlertRuleInput | string {
  if (!form.name.trim()) return 'Name is required.';
  if (!form.query.trim()) return 'Query is required.';
  const threshold = Number(form.threshold);
  if (form.threshold.trim() === '' || !Number.isFinite(threshold)) return 'Threshold must be a number.';
  const forMinutes = Number(form.forMinutes);
  if (!Number.isFinite(forMinutes) || forMinutes < 0 || forMinutes > 1440) return 'Duration must be 0 to 1440 minutes.';
  return {
    name: form.name.trim(),
    description: form.description.trim() || null,
    query: form.query.trim(),
    comparator: form.comparator,
    threshold,
    forSeconds: Math.round(forMinutes * 60),
    severity: form.severity,
    enabled: form.enabled,
  };
}

export function TelemetryAlertRules() {
  const [rules, setRules] = useState<TelemetryAlertRule[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<RuleForm | null>(null);
  const [formError, setFormError] = useState('');
  const [preview, setPreview] = useState<TelemetryAlertPreview | null>(null);
  const [working, setWorking] = useState(false);
  const [deleting, setDeleting] = useState<TelemetryAlertRule | null>(null);

  const load = useCallback(async () => {
    try {
      const response = await alertsApi.listTelemetryRules();
      setRules(response.data ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load telemetry rules');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(), 30_000);
    return () => window.clearInterval(timer);
  }, [load]);

  const openForm = (rule: TelemetryAlertRule | null) => {
    setFormError('');
    setPreview(null);
    setForm(rule ? {
      id: rule.id,
      name: rule.name,
      description: rule.description ?? '',
      query: rule.query,
      comparator: rule.comparator,
      threshold: String(rule.threshold),
      forMinutes: String(rule.forSeconds / 60),
      severity: rule.severity,
      enabled: rule.enabled,
    } : EMPTY_FORM);
  };

  const runPreview = async () => {
    if (!form) return;
    const input = toInput(form);
    if (typeof input === 'string') {
      setFormError(input);
      return;
    }
    setWorking(true);
    setFormError('');
    try {
      const response = await alertsApi.previewTelemetryRule({ query: input.query, comparator: input.comparator, threshold: input.threshold });
      setPreview(response.data ?? null);
    } catch (err) {
      setPreview(null);
      setFormError(err instanceof ApiError ? err.message : 'Preview failed');
    } finally {
      setWorking(false);
    }
  };

  const save = async () => {
    if (!form) return;
    const input = toInput(form);
    if (typeof input === 'string') {
      setFormError(input);
      return;
    }
    setWorking(true);
    setFormError('');
    try {
      if (form.id === null) await alertsApi.createTelemetryRule(input);
      else await alertsApi.updateTelemetryRule(form.id, input);
      setForm(null);
      await load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Failed to save rule');
    } finally {
      setWorking(false);
    }
  };

  const remove = async () => {
    if (!deleting) return;
    setWorking(true);
    try {
      await alertsApi.deleteTelemetryRule(deleting.id);
      setDeleting(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to delete rule');
    } finally {
      setWorking(false);
    }
  };

  if (loading) return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;

  return (
    <section className="card p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-base font-semibold">Telemetry rules</h2>
          <p className="mt-1 max-w-3xl text-sm text-gray-600 dark:text-gray-300">
            Each rule runs a query against the telemetry store every evaluation interval. A series (for example a host)
            fires when the condition holds for the whole duration and recovers when it stops. Webhooks subscribed to
            “Telemetry rule” receive the notifications.
          </p>
        </div>
        <Button onClick={() => openForm(null)}>
          <Plus aria-hidden="true" className="h-4 w-4" />
          Add rule
        </Button>
      </div>
      {error && <p role="alert" className="mt-3 text-sm text-red-600 dark:text-red-400">{error}</p>}

      {rules.length === 0 ? (
        <p className="mt-4 rounded-lg border border-dashed border-gray-300 p-5 text-sm text-gray-600 dark:border-gray-700 dark:text-gray-300">
          No telemetry rules yet. For example: query <code>min by (host) (smtp_egress_ok)</code>, condition <code>&lt; 1</code> for 5 minutes.
        </p>
      ) : (
        <div className="mt-4 grid gap-3">
          {rules.map((rule) => {
            const firing = rule.states.filter((state) => state.status === 'firing');
            const pending = rule.states.filter((state) => state.status === 'pending');
            return (
              <article key={rule.id} className="rounded-lg border border-gray-200 p-4 dark:border-gray-700">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h3 className="flex flex-wrap items-center gap-2 font-medium">
                      {rule.name}
                      <RuleStatus enabled={rule.enabled} firing={firing.length} pending={pending.length} error={rule.lastError} />
                    </h3>
                    {rule.description && <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{rule.description}</p>}
                    <p className="mt-1 break-all font-mono text-xs text-gray-600 dark:text-gray-300">{rule.query}</p>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                      {formatCondition(rule)} · {rule.severity} · last evaluated {formatTime(rule.lastEvaluatedAt)}
                    </p>
                    {rule.lastError && <p className="mt-1 text-sm text-red-600 dark:text-red-400">{rule.lastError}</p>}
                  </div>
                  <div className="flex gap-2">
                    <Button size="sm" variant="secondary" onClick={() => openForm(rule)} aria-label={`Edit ${rule.name}`}>
                      <Pencil aria-hidden="true" className="h-4 w-4" />
                      Edit
                    </Button>
                    <Button size="sm" variant="danger" onClick={() => setDeleting(rule)} aria-label={`Delete ${rule.name}`}>
                      <Trash2 aria-hidden="true" className="h-4 w-4" />
                    </Button>
                  </div>
                </div>
                {rule.states.length > 0 && (
                  <ul className="mt-3 space-y-1 border-t border-gray-100 pt-3 text-sm dark:border-gray-700">
                    {rule.states.map((state) => (
                      <li key={state.seriesKey} className="flex flex-wrap items-center justify-between gap-2">
                        <span className="flex items-center gap-2">
                          <span className={`h-2 w-2 rounded-full ${state.status === 'firing' ? 'bg-red-500' : 'bg-amber-400'}`} aria-hidden="true" />
                          {formatLabels(state.labels)}
                        </span>
                        <span className="tabular-nums text-gray-600 dark:text-gray-300">
                          {formatValue(state.lastValue)} · {state.status === 'firing' ? `firing since ${formatTime(state.firingSince)}` : `pending since ${formatTime(state.pendingSince)}`}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </article>
            );
          })}
        </div>
      )}

      <Modal isOpen={form !== null} onClose={() => setForm(null)} title={form?.id ? 'Edit telemetry rule' : 'Add telemetry rule'} size="lg">
        {form && (
          <form className="space-y-4" onSubmit={(event) => { event.preventDefault(); void save(); }}>
            <Input label="Name" maxLength={120} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} placeholder="SMTP egress down" />
            <Input label="Description (optional)" maxLength={500} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} />
            <label className="block space-y-1">
              <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">Query</span>
              <textarea
                className="input min-h-20 font-mono text-sm"
                maxLength={4000}
                value={form.query}
                onChange={(event) => setForm({ ...form, query: event.target.value })}
                placeholder="min by (host) (smtp_egress_ok)"
              />
              <span className="form-hint">An instant query. Group by the labels each alert should be about, for example by (host).</span>
            </label>
            <div className="grid gap-4 sm:grid-cols-4">
              <label className="block space-y-1">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">Fires when value is</span>
                <select className="input" value={form.comparator} onChange={(event) => setForm({ ...form, comparator: event.target.value as TelemetryAlertComparator })}>
                  {TELEMETRY_ALERT_COMPARATORS.map((comparator) => <option key={comparator} value={comparator}>{comparator}</option>)}
                </select>
              </label>
              <Input label="Threshold" inputMode="decimal" value={form.threshold} onChange={(event) => setForm({ ...form, threshold: event.target.value })} />
              <Input label="For (minutes)" inputMode="decimal" value={form.forMinutes} onChange={(event) => setForm({ ...form, forMinutes: event.target.value })} />
              <label className="block space-y-1">
                <span className="block text-sm font-medium text-gray-700 dark:text-gray-300">Severity</span>
                <select className="input" value={form.severity} onChange={(event) => setForm({ ...form, severity: event.target.value as RuleForm['severity'] })}>
                  <option value="critical">Critical</option>
                  <option value="warning">Warning</option>
                </select>
              </label>
            </div>
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" className="accent-robin-orange" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} />
              Enabled
            </label>
            {formError && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{formError}</p>}
            {preview && (
              <div className="rounded-lg border border-gray-200 p-3 text-sm dark:border-gray-700">
                <p className="font-medium">
                  {preview.series.filter((series) => series.matches).length} of {preview.series.length} series match now
                  {preview.truncated ? ' (more series than can be evaluated)' : ''}
                </p>
                <ul className="mt-2 max-h-48 space-y-1 overflow-y-auto">
                  {preview.series.map((series) => (
                    <li key={formatLabels(series.labels)} className="flex justify-between gap-3">
                      <span className="flex items-center gap-2">
                        <span className={`h-2 w-2 rounded-full ${series.matches ? 'bg-red-500' : 'bg-green-500'}`} aria-hidden="true" />
                        {formatLabels(series.labels)}
                      </span>
                      <span className="tabular-nums">{formatValue(series.value)}</span>
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <div className="flex flex-wrap justify-end gap-2">
              <Button type="button" variant="secondary" onClick={() => void runPreview()} disabled={working}>Preview</Button>
              <Button type="button" variant="secondary" onClick={() => setForm(null)}>Cancel</Button>
              <Button type="submit" disabled={working}>Save rule</Button>
            </div>
          </form>
        )}
      </Modal>

      <Modal isOpen={deleting !== null} onClose={() => setDeleting(null)} title="Delete telemetry rule" size="sm">
        <p className="text-sm">Delete “{deleting?.name}”? Series that are firing get a recovery notification.</p>
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setDeleting(null)}>Cancel</Button>
          <Button variant="danger" onClick={() => void remove()} disabled={working}>Delete</Button>
        </div>
      </Modal>
    </section>
  );
}

function RuleStatus({ enabled, firing, pending, error }: { enabled: boolean; firing: number; pending: number; error: string | null }) {
  const [label, tone] = !enabled
    ? ['Disabled', 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300']
    : error
      ? ['Error', 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300']
      : firing > 0
        ? [`Firing (${firing})`, 'bg-red-50 text-red-700 dark:bg-red-950/30 dark:text-red-300']
        : pending > 0
          ? [`Pending (${pending})`, 'bg-amber-50 text-amber-800 dark:bg-amber-950/30 dark:text-amber-200']
          : ['OK', 'bg-green-50 text-green-700 dark:bg-green-950/30 dark:text-green-300'];
  return <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${tone}`}>{label}</span>;
}
