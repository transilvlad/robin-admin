import { useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { KeyRound, Save, Settings } from 'lucide-react';
import { ApiError, configApi, telemetryApi } from '../api/client';
import type { AdminConfig } from '../types';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { MetricTabs } from '../components/ui/MetricTabs';
import { TelemetryConnectionSettings, TelemetryStorageSettingsView } from '../components/administration/TelemetryStoreSettings';
import { StatusPageSettingsView } from '../components/monitoring/StatusPageSettingsView';
import { MonitoringHeartbeats } from '../components/monitoring/MonitoringHeartbeats';

type Field = { key: keyof AdminConfig; label: string; min: number; max: number };
const TELEMETRY_FIELDS: Field[] = [
  { key: 'telemetrySourceWindowDays', label: 'Discovery window (days)', min: 1, max: 90 },
  { key: 'telemetrySilentAfterSeconds', label: 'Silent after (seconds)', min: 60, max: 86400 },
  { key: 'telemetrySourceRefreshSeconds', label: 'Source refresh (seconds)', min: 15, max: 3600 },
  { key: 'telemetrySourceLimit', label: 'Maximum displayed sources', min: 100, max: 5000 },
  { key: 'telemetryIngestBodyLimitBytes', label: 'Maximum ingest request (bytes)', min: 65536, max: 67108864 },
  { key: 'telemetryRequestTimeoutMs', label: 'Store request timeout (milliseconds)', min: 1000, max: 30000 },
  { key: 'telemetryQueryMaxPoints', label: 'Maximum query points per series', min: 100, max: 1500 },
  { key: 'telemetryQueryMaxSeries', label: 'Maximum query series', min: 1, max: 100 },
  { key: 'telemetryQueryMaxRangeDays', label: 'Maximum query range (days)', min: 1, max: 400 },
];
const MONITORING_FIELDS: Field[] = [
  { key: 'monitoringConcurrency', label: 'Concurrent probes', min: 4, max: 128 },
  { key: 'monitoringManualConcurrency', label: 'Concurrent manual probes', min: 1, max: 127 },
  { key: 'monitoringManualQueueSize', label: 'Waiting manual probes', min: 1, max: 1000 },
  { key: 'monitoringQueueWaitMs', label: 'Maximum queue wait (milliseconds)', min: 1000, max: 120000 },
  { key: 'monitoringObservationRetentionDays', label: 'Raw observations (days)', min: 1, max: 3650 },
  { key: 'monitoringHistoryRetentionDays', label: 'Daily history (days)', min: 1, max: 3650 },
];
const DISCOVERY_FIELDS = [
  { key: 'telemetrySourceLabel', label: 'Source identity label', maxLength: 128 },
  { key: 'telemetryGroupLabel', label: 'Grouping label (optional)', maxLength: 128 },
  { key: 'telemetrySourceSelector', label: 'Series selector', maxLength: 1024 },
] as const;

export function ObservabilitySettingsPage({ section }: { section: 'telemetry' | 'monitoring' }) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [config, setConfig] = useState<AdminConfig | null>(null);
  const [configurationError, setConfigurationError] = useState('');
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [saving, setSaving] = useState(false);
  const [labels, setLabels] = useState<string[]>([]);
  const [labelsError, setLabelsError] = useState('');
  const [tab, setTab] = useState(section === 'telemetry' ? 'connection' : 'policy');
  const fields = section === 'telemetry' ? TELEMETRY_FIELDS : MONITORING_FIELDS;
  useEffect(() => {
    let cancelled = false;
    setConfig(null); setError(''); setSuccess('');
    configApi.get()
      .then(response => {
        if (cancelled) return;
        if (!response.data) throw new Error('Configuration missing');
        setConfig(response.data);
        setConfigurationError(response.configurationError ?? '');
      })
      .catch(err => { if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load settings'); });
    return () => { cancelled = true; };
  }, [section]);
  useEffect(() => {
    const requested = searchParams.get('tab');
    setTab(section === 'telemetry' ? requested === 'policy' || requested === 'storage' || requested === 'discovery' ? requested : 'connection' : requested === 'statusPage' || requested === 'heartbeats' ? requested : 'policy');
  }, [section, searchParams]);
  const discoveryDays = config?.telemetrySourceWindowDays;
  useEffect(() => {
    if (section !== 'telemetry' || tab !== 'discovery' || !discoveryDays) return;
    let cancelled = false;
    setLabels([]); setLabelsError('');
    const end = Math.floor(Date.now() / 1000);
    telemetryApi.labelNames({ start: end - discoveryDays * 86400, end })
      .then(response => { if (!cancelled) setLabels(response.data ?? []); })
      .catch(err => { if (!cancelled) setLabelsError(err instanceof ApiError ? err.message : 'Label suggestions unavailable'); });
    return () => { cancelled = true; };
  }, [section, tab, discoveryDays]);
  const save = async () => {
    if (!config) return;
    setSaving(true); setError(''); setSuccess('');
    try {
      const updates = Object.fromEntries((tab === 'discovery' ? DISCOVERY_FIELDS : fields).map(field => [field.key, config[field.key]]));
      const response = await configApi.update(updates);
      if (!response.data) throw new Error('Configuration missing');
      setConfig(response.data); setConfigurationError(response.configurationError ?? ''); setSuccess('Settings saved');
    } catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to save settings'); }
    finally { setSaving(false); }
  };
  return (
    <div className="space-y-6">
      <PageHeader icon={Settings} title={section === 'telemetry' ? 'Telemetry' : 'Monitoring'} actions={section === 'telemetry' ? <Link className="btn btn-secondary" to="/administration/access?tab=apiKeys&preset=telemetry"><KeyRound className="h-4 w-4" />API keys</Link> : undefined} />
      {error && <p role="alert" className="text-sm text-red-600 dark:text-red-400">{error}</p>}
      {configurationError && <p role="alert" className="rounded border border-amber-300 p-3 text-sm text-amber-900 dark:border-amber-700 dark:text-amber-200">A saved observability setting is invalid. The last valid settings remain active. {configurationError} Correct the saved values below.</p>}
      {success && <p role="status" className="text-sm text-green-700 dark:text-green-400">{success}</p>}
      {!config ? (!error && <Spinner label="Loading settings" />) : <>
        <MetricTabs tabs={section === 'telemetry' ? [{ id: 'connection', label: 'Connection', icon: Settings }, { id: 'discovery', label: 'Discovery', icon: Settings }, { id: 'policy', label: 'Policy', icon: Settings }, { id: 'storage', label: 'Storage', icon: Settings }] : [{ id: 'policy', label: 'Policy', icon: Settings }, { id: 'heartbeats', label: 'Heartbeats', icon: Settings }, { id: 'statusPage', label: 'Status page', icon: Settings }]} activeTab={tab} onChange={value => setSearchParams({ tab: value })} />
        {tab === 'discovery' && <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-6">
          <fieldset disabled={saving} className="grid gap-4 border-t border-gray-200 pt-5 dark:border-robin-gray-700 sm:grid-cols-2">
            {DISCOVERY_FIELDS.map(field => <Input key={field.key} label={field.label} list={field.key === 'telemetrySourceSelector' ? undefined : 'telemetry-discovery-labels'} maxLength={field.maxLength} required={field.key !== 'telemetryGroupLabel'} value={config[field.key] ?? ''} onChange={event => { setSuccess(''); setConfig({ ...config, [field.key]: event.target.value }); }} />)}
            <datalist id="telemetry-discovery-labels">{labels.map(label => <option key={label} value={label} />)}</datalist>
          </fieldset>
          {labelsError && <p role="status" className="text-sm text-gray-500">{labelsError} <Link className="text-robin-blue hover:underline" to="/administration/telemetry?tab=connection">Store settings</Link></p>}
          <Button type="submit" disabled={saving}><Save className="h-4 w-4" />{saving ? 'Saving...' : 'Save'}</Button>
        </form>}
        {tab === 'policy' && <form onSubmit={event => { event.preventDefault(); void save(); }} className="space-y-6">
          <fieldset disabled={saving} className="grid gap-4 border-t border-gray-200 pt-5 dark:border-robin-gray-700 sm:grid-cols-2 lg:grid-cols-3">
            {fields.map(field => <Input key={field.key} label={field.label} type="number" min={field.min} max={field.max} step={1} required value={Number.isNaN(config[field.key]) ? '' : Number(config[field.key])} onChange={event => { setSuccess(''); setConfig({ ...config, [field.key]: event.target.value === '' ? NaN : Number(event.target.value) }); }} />)}
          </fieldset>
          <Button type="submit" disabled={saving}><Save className="h-4 w-4" />{saving ? 'Saving...' : 'Save'}</Button>
        </form>}
        {tab === 'connection' && <TelemetryConnectionSettings />}
        {tab === 'storage' && <TelemetryStorageSettingsView />}
        {tab === 'statusPage' && <StatusPageSettingsView />}
        {tab === 'heartbeats' && <MonitoringHeartbeats />}
      </>}
    </div>
  );
}
