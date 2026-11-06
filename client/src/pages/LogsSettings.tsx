import { useCallback, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { Activity, CheckCircle2, Database, KeyRound, Plug, RefreshCw, Save, SlidersHorizontal, XCircle } from 'lucide-react';
import { ApiError, configApi, logsApi } from '../api/client';
import type { AdminConfig, LogsConfiguration, LogsStoreStatus } from '../types';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { MetricTabs } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useFeatures } from '../context/FeaturesContext';
import { formatBytes } from '../utils/format';

type NumericKey = 'logsSourceQuietAfterSeconds' | 'logsSourceLimit' | 'logsRequestTimeoutMs' | 'logsIngestBodyLimitBytes';
type Field = { key: NumericKey; label: string; hint: string; min: number; max: number };

const POLICY_FIELDS: Field[] = [
  { key: 'logsSourceQuietAfterSeconds', label: 'Quiet after (seconds)', hint: 'Sources with no lines for this long are marked quiet.', min: 60, max: 86400 },
  { key: 'logsSourceLimit', label: 'Maximum listed sources', hint: 'Upper bound for the Sources inventory.', min: 10, max: 1000 },
  { key: 'logsRequestTimeoutMs', label: 'Store request timeout (milliseconds)', hint: 'Applies to search, statistics and inventory queries.', min: 1000, max: 60000 },
];
const INGEST_FIELDS: Field[] = [
  { key: 'logsIngestBodyLimitBytes', label: 'Maximum ingest request (bytes)', hint: 'Larger HTTP and Sentry payloads are rejected with 413.', min: 65536, max: 33554432 },
];
const TABS = ['connection', 'ingestion', 'policy', 'storage'] as const;
type Tab = typeof TABS[number];

function Detail({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">{label}</dt>
      <dd className="mt-1 break-words text-sm text-gray-900 dark:text-gray-100">{children}</dd>
    </div>
  );
}

function StateBadge({ ok, okLabel, badLabel }: { ok: boolean; okLabel: string; badLabel: string }) {
  const Icon = ok ? CheckCircle2 : XCircle;
  return (
    <span className={`inline-flex items-center gap-1.5 ${ok ? 'text-green-700 dark:text-green-400' : 'text-amber-700 dark:text-amber-300'}`}>
      <Icon className="h-4 w-4" aria-hidden="true" />{ok ? okLabel : badLabel}
    </span>
  );
}

export function LogsSettingsPage() {
  const { refresh: refreshFeatures } = useFeatures();
  const [searchParams, setSearchParams] = useSearchParams();
  const requested = searchParams.get('tab') as Tab | null;
  const tab: Tab = requested && TABS.includes(requested) ? requested : 'connection';
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [drafts, setDrafts] = useState<Partial<Record<NumericKey, number>>>({});
  const [configuration, setConfiguration] = useState<LogsConfiguration | null>(null);
  const [status, setStatus] = useState<LogsStoreStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const hasDrafts = Object.keys(drafts).length > 0;

  useEffect(() => {
    if (!hasDrafts) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [hasDrafts]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([configApi.get(), logsApi.configuration()])
      .then(([configResponse, logsResponse]) => {
        if (cancelled) return;
        if (!configResponse.data || !logsResponse.data) throw new Error('Configuration missing');
        setConfig(configResponse.data);
        setConfiguration(logsResponse.data);
      })
      .catch((err: unknown) => { if (!cancelled) setError(err instanceof Error ? err.message : 'Failed to load settings'); });
    return () => { cancelled = true; };
  }, []);

  const checkStore = useCallback(async () => {
    setChecking(true);
    setStatusError('');
    try {
      const response = await logsApi.status();
      setStatus(response.data ?? null);
    } catch (err) {
      setStatus(null);
      setStatusError(err instanceof Error ? err.message : 'Logs store status is unavailable');
    } finally {
      setChecking(false);
    }
  }, []);

  useEffect(() => { void checkStore(); }, [checkStore]);

  const save = async (updates: Partial<AdminConfig>, message = 'Settings saved') => {
    setSaving(true); setError(''); setSuccess('');
    try {
      const response = await configApi.update(updates);
      if (!response.data) throw new Error('Configuration missing');
      setConfig(response.data);
      setDrafts((current) => Object.fromEntries(Object.entries(current).filter(([key]) => !(key in updates))));
      if ('logsEnabled' in updates) {
        setConfiguration((current) => current ? { ...current, enabled: Boolean(response.data?.logsEnabled) } : current);
        void checkStore();
        await refreshFeatures();
      }
      setSuccess(message);
    } catch (err) {
      setError(err instanceof ApiError || err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const numericForm = (fields: Field[]) => config && (
    <form
      className="card overflow-hidden p-0"
      onSubmit={(event) => { event.preventDefault(); void save(Object.fromEntries(fields.map((field) => [field.key, drafts[field.key] ?? config[field.key]]))); }}
    >
      <fieldset disabled={saving} className="grid gap-4 p-6 sm:grid-cols-2 lg:grid-cols-3">
        {fields.map((field) => (
          <div key={field.key}>
            <Input
              label={field.label}
              name={field.key}
              autoComplete="off"
              type="number"
              min={field.min}
              max={field.max}
              step={1}
              required
              value={Number.isNaN(drafts[field.key]) ? '' : drafts[field.key] ?? config[field.key]}
              onChange={(event) => {
                setSuccess('');
                const value = event.target.value === '' ? NaN : Number(event.target.value);
                setDrafts((current) => {
                  const next = { ...current, [field.key]: value };
                  if (value === config[field.key]) delete next[field.key];
                  return next;
                });
              }}
            />
            <p className="form-hint">{field.hint} Range {field.min.toLocaleString()}–{field.max.toLocaleString()}.</p>
          </div>
        ))}
      </fieldset>
      <div className="flex justify-end border-t border-gray-200 bg-gray-50 px-6 py-3 dark:border-robin-gray-700 dark:bg-robin-gray-800/50">
        <Button type="submit" disabled={saving}><Save className="h-4 w-4" aria-hidden="true" />{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );

  const enabled = config?.logsEnabled ?? false;

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.logs}
        title="Logs"
        description="Configure the VictoriaLogs store, ingestion endpoints and source inventory."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <Link className="btn btn-secondary" to="/logs/health"><Activity className="h-4 w-4" aria-hidden="true" />Health</Link>
            <Link className="btn btn-secondary" to="/administration/access?tab=apiKeys&preset=logs"><KeyRound className="h-4 w-4" aria-hidden="true" />API keys</Link>
          </div>
        )}
      />
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {success && <p role="status" className="text-sm text-green-700 dark:text-green-400">{success}</p>}
      {hasDrafts && <p role="status" className="text-sm text-amber-700 dark:text-amber-300">You have unsaved settings. Save each changed tab before leaving this page.</p>}
      {!config || !configuration ? (!error && <Spinner label="Loading settings" />) : (
        <>
          <MetricTabs
            tabs={[
              { id: 'connection', label: 'Connection', icon: Plug },
              { id: 'ingestion', label: 'Ingestion', icon: KeyRound },
              { id: 'policy', label: 'Policy', icon: SlidersHorizontal },
              { id: 'storage', label: 'Storage', icon: Database },
            ]}
            activeTab={tab}
            onChange={(value) => { setSuccess(''); setSearchParams({ tab: value }); }}
          />

          {tab === 'connection' && (
            <div className="space-y-6">
              <section className="card">
                <div className="card-header flex items-center justify-between gap-4">
                  <div>
                    <h2 className="card-title">Logs collection</h2>
                    <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">When disabled, new lines are not stored and Logs search is hidden. Stored lines stay until retention removes them.</p>
                  </div>
                  <label className="inline-flex shrink-0 cursor-pointer items-center gap-3">
                    <span className="text-sm font-medium text-gray-700 dark:text-gray-300">{enabled ? 'Enabled' : 'Disabled'}</span>
                    <input
                      type="checkbox"
                      role="switch"
                      className="peer sr-only"
                      checked={enabled}
                      disabled={saving}
                      aria-label="Enable logs"
                      onChange={(event) => void save({ logsEnabled: event.target.checked }, event.target.checked ? 'Logs enabled' : 'Logs disabled')}
                    />
                    <span className="relative h-6 w-11 rounded-full bg-gray-300 transition-colors after:absolute after:left-0.5 after:top-0.5 after:h-5 after:w-5 after:rounded-full after:bg-white after:transition-transform peer-checked:bg-robin-orange peer-checked:after:translate-x-5 peer-focus-visible:ring-2 peer-focus-visible:ring-robin-orange peer-focus-visible:ring-offset-2 peer-disabled:opacity-50 dark:bg-robin-gray-600" aria-hidden="true" />
                  </label>
                </div>
              </section>
              <section className="card">
                <div className="card-header flex items-center justify-between gap-4">
                  <h2 className="card-title">Store connection</h2>
                  <Button type="button" variant="secondary" onClick={() => void checkStore()} disabled={checking}>
                    <RefreshCw className={`h-4 w-4 ${checking ? 'animate-spin' : ''}`} aria-hidden="true" />{checking ? 'Checking…' : 'Test connection'}
                  </Button>
                </div>
                <dl className="card-body grid gap-6 sm:grid-cols-3">
                  <Detail label="Store URL"><code className="font-mono text-xs">{configuration.storeUrl}</code></Detail>
                  <Detail label="Reachability">
                    {checking && !status ? 'Checking…' : statusError
                      ? <span className="text-red-600 dark:text-red-400">{statusError}</span>
                      : status ? <StateBadge ok={status.reachable} okLabel="Reachable" badLabel={status.error ? `Unavailable: ${status.error}` : 'Unavailable'} /> : '—'}
                  </Detail>
                  <Detail label="Ingestion queue">
                    {status ? `${status.write.queuedLines.toLocaleString()} lines queued · ${formatBytes(status.write.queuedBytes)} of ${formatBytes(status.write.capacityBytes)}` : '—'}
                  </Detail>
                </dl>
                <p className="border-t border-gray-200 px-6 py-3 text-xs text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                  The store URL is set by the <code>LOGS_STORE_URL</code> deployment variable.
                </p>
              </section>
            </div>
          )}

          {tab === 'ingestion' && (
            <div className="space-y-6">
              <section className="card">
                <div className="card-header"><h2 className="card-title">Endpoints</h2></div>
                <dl className="card-body grid gap-6 sm:grid-cols-3">
                  <Detail label="HTTP ingest">
                    <code className="font-mono text-xs">POST {configuration.endpoints.ingest}</code>
                    <p className="form-hint">JSON, NDJSON or text. Requires an API key with the <code>logs:write</code> scope.</p>
                  </Detail>
                  <Detail label="Sentry webhook">
                    <code className="font-mono text-xs">POST {configuration.endpoints.sentry}</code>
                    <p className="form-hint">Signed with the Sentry integration client secret.</p>
                  </Detail>
                  <Detail label="Sentry signing secret">
                    <StateBadge ok={configuration.sentryWebhookConfigured} okLabel="Configured" badLabel="Not configured" />
                    <p className="form-hint">Set with the <code>LOGS_SENTRY_CLIENT_SECRET</code> deployment variable.</p>
                  </Detail>
                </dl>
              </section>
              {numericForm(INGEST_FIELDS)}
            </div>
          )}

          {tab === 'policy' && numericForm(POLICY_FIELDS)}

          {tab === 'storage' && (
            <section className="card">
              <div className="card-header flex items-center justify-between gap-4">
                <h2 className="card-title">Retention and capacity</h2>
                <Link className="btn btn-secondary" to="/logs/health"><Activity className="h-4 w-4" aria-hidden="true" />View usage</Link>
              </div>
              <dl className="card-body grid gap-6 sm:grid-cols-3">
                <Detail label="Retention">{configuration.retentionDays} days</Detail>
                <Detail label="Disk cap">{configuration.maxDiskBytes === null ? 'Unavailable' : formatBytes(configuration.maxDiskBytes)}</Detail>
                <Detail label="Current size">{status?.storageBytes === null || status?.storageBytes === undefined ? 'Unavailable' : formatBytes(status.storageBytes)}</Detail>
              </dl>
              <p className="border-t border-gray-200 px-6 py-3 text-xs text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                Retention and the disk cap are VictoriaLogs start-up flags set by the <code>LOGS_RETENTION_DAYS</code> and <code>LOGS_STORE_MAX_DISK</code> deployment variables. Change them and restart the logs store.
              </p>
            </section>
          )}
        </>
      )}
    </div>
  );
}
