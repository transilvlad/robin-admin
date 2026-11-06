import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { AlertTriangle, Bookmark, ChevronDown, Play, Search, Settings, Trash2 } from 'lucide-react';
import { fleetServicesApi, logsApi } from '../api/client';
import { useConfirm } from '../context/ConfirmContext';
import { TimeRangePicker } from '../components/telemetry/TimeRangePicker';
import { Button } from '../components/ui/Button';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { formatBytes } from '../utils/format';
import type { FleetService, LogSearchResult, LogsSavedSearch, LogsStoreStatus } from '../types';
import { hasTimeRange, parseTimeRange, REFRESH_OPTIONS, resolveRange, writeTimeRange, type RangePreset, type TimeRange } from '../utils/telemetry';

const LIMIT_OPTIONS = [100, 200, 500, 1000];
const DEFAULT_LIMIT = 200;
const DEFAULT_LOGS_RANGE: TimeRange = { kind: 'relative', preset: '1h' };

function formatTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'medium' });
}

export function LogsSearchPage() {
  const [params, setParams] = useSearchParams();
  const range = hasTimeRange(params) ? parseTimeRange(params) : DEFAULT_LOGS_RANGE;
  const serviceId = params.get('service') ?? '';
  const sourceName = params.get('source') ?? '';
  const query = params.get('q') ?? '';
  const limitParam = Number(params.get('limit'));
  const limit = LIMIT_OPTIONS.includes(limitParam) ? limitParam : DEFAULT_LIMIT;
  const refreshParam = Number(params.get('refresh'));
  const refreshSeconds = REFRESH_OPTIONS.some((option) => option.value === refreshParam) ? refreshParam : 0;

  const [draft, setDraft] = useState(query);
  const [sourceDraft, setSourceDraft] = useState(sourceName);
  const [services, setServices] = useState<FleetService[]>([]);
  const [servicesError, setServicesError] = useState('');
  const [status, setStatus] = useState<LogsStoreStatus | null>(null);
  const [statusError, setStatusError] = useState('');
  const [savedSearches, setSavedSearches] = useState<LogsSavedSearch[]>([]);
  const [savedSearchesLoaded, setSavedSearchesLoaded] = useState(false);
  const [savedSearchesError, setSavedSearchesError] = useState('');
  const [showSave, setShowSave] = useState(false);
  const [savedName, setSavedName] = useState('');
  const [saveError, setSaveError] = useState('');
  const [savingSearch, setSavingSearch] = useState(false);
  const [showManage, setShowManage] = useState(false);
  const [manageError, setManageError] = useState('');
  const confirm = useConfirm();
  const [result, setResult] = useState<LogSearchResult | null>(null);
  const [error, setError] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const requestRef = useRef(0);

  const update = useCallback((mutate: (next: URLSearchParams) => void) => {
    setParams((current) => {
      const next = new URLSearchParams(current);
      mutate(next);
      return next;
    }, { replace: true });
  }, [setParams]);

  useEffect(() => { setDraft(query); }, [query]);
  useEffect(() => { setSourceDraft(sourceName); }, [sourceName]);

  useEffect(() => {
    let cancelled = false;
    setServicesError('');
    fleetServicesApi.list()
      .then((response) => {
        if (!cancelled) setServices(response.data ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setServices([]);
          setServicesError(err instanceof Error ? err.message : 'Failed to load services');
        }
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    logsApi.listSavedSearches()
      .then((response) => {
        if (!cancelled) setSavedSearches(response.data ?? []);
      })
      .catch((err: unknown) => {
        if (!cancelled) setSavedSearchesError(err instanceof Error ? err.message : 'Failed to load saved searches');
      })
      .finally(() => {
        if (!cancelled) setSavedSearchesLoaded(true);
      });
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setStatusError('');
    logsApi.status()
      .then((response) => {
        if (!cancelled) setStatus(response.data ?? null);
      })
      .catch((err: unknown) => {
        if (!cancelled) setStatusError(err instanceof Error ? err.message : 'Logs store status is unavailable');
      });
    return () => { cancelled = true; };
  }, [refreshKey]);

  const rangeKey = range.kind === 'absolute' ? `${range.from}-${range.to}` : range.preset;
  useEffect(() => {
    const request = ++requestRef.current;
    const { start, end } = resolveRange(range);
    setIsLoading(true);
    setError('');
    logsApi.search({ start, end, serviceIds: serviceId ? [serviceId] : undefined, sourceNames: sourceName ? [sourceName] : undefined, q: query, limit })
      .then((response) => {
        if (request === requestRef.current) setResult(response.data ?? null);
      })
      .catch((err: unknown) => {
        if (request === requestRef.current) {
          setResult(null);
          setError(err instanceof Error ? err.message : 'Logs search failed');
        }
      })
      .finally(() => {
        if (request === requestRef.current) setIsLoading(false);
      });
    return () => { requestRef.current += 1; };
  }, [rangeKey, serviceId, sourceName, query, limit, refreshKey]);

  useEffect(() => {
    if (!refreshSeconds || range.kind === 'absolute') return undefined;
    const timer = setInterval(() => setRefreshKey((key) => key + 1), refreshSeconds * 1000);
    return () => clearInterval(timer);
  }, [refreshSeconds, range.kind]);

  const serviceNames = useMemo(() => new Map(services.map((s) => [s.serviceId, s.name])), [services]);
  const sortedServices = useMemo(
    () => [...services].sort((a, b) => a.serviceType.localeCompare(b.serviceType) || a.name.localeCompare(b.name)),
    [services],
  );

  function submit(event: FormEvent) {
    event.preventDefault();
    update((next) => {
      if (draft.trim()) next.set('q', draft.trim()); else next.delete('q');
      if (sourceDraft.trim()) next.set('source', sourceDraft.trim()); else next.delete('source');
    });
    if (draft.trim() === query && sourceDraft.trim() === sourceName) setRefreshKey((key) => key + 1);
  }

  function applySavedSearch(searchId: string) {
    const saved = savedSearches.find((item) => String(item.id) === searchId);
    if (!saved) return;
    setDraft(saved.filters.query);
    setSourceDraft(saved.filters.sourceName);
    update((next) => {
      if (saved.filters.query) next.set('q', saved.filters.query); else next.delete('q');
      if (saved.filters.sourceName) next.set('source', saved.filters.sourceName); else next.delete('source');
      if (saved.filters.serviceId) next.set('service', saved.filters.serviceId); else next.delete('service');
      writeTimeRange(next, { kind: 'relative', preset: saved.filters.rangePreset as RangePreset }, true);
    });
    setRefreshKey((key) => key + 1);
  }

  async function deleteSavedSearch(saved: LogsSavedSearch) {
    if (!(await confirm(`Delete the shared saved search "${saved.name}"? This affects all administrators.`))) return;
    setManageError('');
    try {
      await logsApi.deleteSavedSearch(saved.id);
      setSavedSearches((current) => current.filter((item) => item.id !== saved.id));
    } catch (err) {
      setManageError(err instanceof Error ? err.message : 'Failed to delete saved search');
    }
  }

  async function saveCurrentSearch() {
    if (savingSearch || range.kind !== 'relative') return;
    setSavingSearch(true);
    setSaveError('');
    try {
      const response = await logsApi.createSavedSearch({
        name: savedName.trim(),
        description: null,
        filters: {
          query: draft.trim(),
          serviceId,
          sourceName: sourceDraft.trim(),
          rangePreset: range.preset,
        },
      });
      const created = response.data;
      if (created) setSavedSearches((current) => [...current, created].sort((a, b) => a.name.localeCompare(b.name)));
      setSavedName('');
      setShowSave(false);
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : 'Failed to save search');
    } finally {
      setSavingSearch(false);
    }
  }

  const storeProblems = [
    statusError ? `Logs store status could not be loaded: ${statusError}` : '',
    status && !status.enabled ? 'Logs are disabled. Enable Logs under Administration → Logs.' : '',
    status?.enabled && !status.reachable
      ? `Logs store is unreachable${status.error ? `: ${status.error}` : ''}. Search is paused; new lines are queued while capacity remains.`
      : '',
    status?.write.droppedLines24h
      ? `${status.write.droppedLines24h.toLocaleString()} Fleet log lines were not kept in the last 24 hours because the ingestion queue was full.`
      : '',
    status?.write.uncertainBatches || status?.write.uncertainDeliveries24h
      ? 'Some store writes had uncertain outcomes. Retried lines may appear more than once in search results and alert counts.'
      : '',
    status?.write.queuedLines && status.reachable
      ? `${status.write.queuedLines.toLocaleString()} ${status.write.queuedLines === 1 ? 'line is' : 'lines are'} waiting to be stored. Search results may be incomplete.${status.write.lastError ? ` ${status.write.lastError}` : ''}`
      : '',
  ].filter(Boolean);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.logs}
        title="Logs"
        description="Search stored logs from Fleet agents and external push integrations."
        actions={(
          <div className="flex flex-wrap items-center gap-2">
            <TimeRangePicker
              range={range}
              onRangeChange={(next) => update((p) => writeTimeRange(p, next, true))}
              refreshSeconds={refreshSeconds}
              onRefreshSecondsChange={(seconds) => update((p) => { if (seconds) p.set('refresh', String(seconds)); else p.delete('refresh'); })}
              onRefresh={() => setRefreshKey((key) => key + 1)}
            />
            <Link className="btn btn-secondary" to="/administration/logs" title="Logs settings" aria-label="Logs settings"><Settings className="h-4 w-4" aria-hidden="true" /></Link>
          </div>
        )}
      />

      <form className="card overflow-hidden p-0" onSubmit={submit} role="search" aria-label="Search logs">
        <div className="grid items-end gap-3 p-4 sm:grid-cols-2 lg:grid-cols-[minmax(11rem,1fr)_minmax(10rem,1fr)_minmax(16rem,2.5fr)_7rem_auto]">
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="form-label mb-0">Service</span>
            <select
              className="input"
              value={serviceId}
              name="service"
              onChange={(event) => update((next) => { if (event.target.value) next.set('service', event.target.value); else next.delete('service'); })}
            >
              <option value="">All services</option>
              {serviceId && !serviceNames.has(serviceId) && <option value={serviceId}>{serviceId}</option>}
              {sortedServices.map((service) => (
                <option key={service.serviceId} value={service.serviceId}>{service.name} ({service.serviceType})</option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="form-label mb-0">Source name</span>
            <input
              className="input"
              value={sourceDraft}
              name="source"
              onChange={(event) => setSourceDraft(event.target.value)}
              placeholder="Any source"
              autoComplete="off"
              maxLength={120}
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm sm:col-span-2 lg:col-span-1">
            <span className="form-label mb-0">Filter</span>
            <input
              className="input font-mono"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder='error, "connection refused", NOT debug…'
              maxLength={1000}
              name="query"
              autoComplete="off"
              spellCheck={false}
              aria-label="Log filter"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="form-label mb-0">Limit</span>
            <select
              className="input"
              value={limit}
              name="limit"
              onChange={(event) => update((next) => next.set('limit', event.target.value))}
            >
              {LIMIT_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <Button type="submit" disabled={isLoading} aria-label={isLoading ? 'Searching logs' : undefined}>
            <Search aria-hidden="true" className="h-4 w-4" />
            Search
          </Button>
        </div>
        <div className="flex flex-wrap items-center justify-between gap-3 border-t border-gray-200 bg-gray-50 px-4 py-2.5 dark:border-robin-gray-700 dark:bg-robin-gray-800/50">
          <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2 text-sm">
            <Bookmark className="h-4 w-4 text-gray-400" aria-hidden="true" />
            {savedSearches.length > 0 ? (
              <select className="input max-w-xs py-1.5 text-sm" aria-label="Apply a saved search" defaultValue="" onChange={(event) => { applySavedSearch(event.target.value); event.target.value = ''; }}>
                <option value="">Apply a saved search…</option>
                {savedSearches.map((saved) => <option key={saved.id} value={saved.id}>{saved.name}</option>)}
              </select>
            ) : <span className="text-gray-500 dark:text-gray-400">{savedSearchesError ? `Saved searches unavailable: ${savedSearchesError}` : savedSearchesLoaded ? 'No saved searches yet' : 'Loading saved searches…'}</span>}
            {savedSearchesError && savedSearches.length > 0 && <span role="alert" className="text-red-600 dark:text-red-400">{savedSearchesError}</span>}
            {savedSearches.length > 0 && (
              <button
                type="button"
                className="inline-flex items-center gap-1 text-robin-orange hover:underline"
                aria-expanded={showManage}
                aria-controls="logs-saved-searches-panel"
                onClick={() => { setShowManage((open) => !open); setManageError(''); }}
              >
                Manage ({savedSearches.length})
                <ChevronDown className={`h-3.5 w-3.5 transition-transform ${showManage ? 'rotate-180' : ''}`} aria-hidden="true" />
              </button>
            )}
          </div>
          {!showSave ? (
            <button type="button" className="btn btn-secondary py-1.5 text-sm" onClick={() => { setShowSave(true); setSaveError(''); }} disabled={range.kind === 'absolute'} title={range.kind === 'absolute' ? 'Choose a relative time range before saving' : undefined}>
              <Bookmark className="h-4 w-4" aria-hidden="true" />Save as shared search
            </button>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <label className="sr-only" htmlFor="logs-saved-search-name">Saved search name</label>
              <input
                id="logs-saved-search-name"
                name="savedSearchName"
                className="input w-56 py-1.5 text-sm"
                value={savedName}
                onChange={(event) => setSavedName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') { event.preventDefault(); if (savedName.trim() && !savingSearch) void saveCurrentSearch(); }
                  if (event.key === 'Escape') setShowSave(false);
                }}
                placeholder="Name this search…"
                maxLength={120}
                autoComplete="off"
              />
              <Button type="button" disabled={savingSearch || !savedName.trim()} onClick={() => void saveCurrentSearch()}>{savingSearch ? 'Saving…' : 'Save'}</Button>
              <button type="button" className="btn btn-secondary" onClick={() => setShowSave(false)}>Cancel</button>
            </div>
          )}
        </div>
        {saveError && <p role="alert" className="border-t border-gray-200 px-4 py-2 text-sm text-red-600 dark:border-robin-gray-700 dark:text-red-400">{saveError}</p>}
        {showManage && savedSearches.length > 0 && (
          <div id="logs-saved-searches-panel" className="border-t border-gray-200 dark:border-robin-gray-700">
            <p className="px-4 pt-3 text-xs text-gray-500 dark:text-gray-400">Shared with all administrators. Time ranges are saved as relative windows.</p>
            {manageError && <p role="alert" className="px-4 pt-2 text-sm text-red-600 dark:text-red-400">{manageError}</p>}
            <ul className="divide-y divide-gray-200 dark:divide-robin-gray-700" aria-label="Saved searches">
              {savedSearches.map((saved) => (
                <li key={saved.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0 flex-1 break-words">
                    <p className="text-sm font-medium">{saved.name}</p>
                    {saved.description && <p className="text-xs text-gray-600 dark:text-gray-300">{saved.description}</p>}
                    <p className="truncate font-mono text-xs text-gray-500 dark:text-gray-400">
                      {saved.filters.query || 'all logs'}
                      {saved.filters.serviceId && ` · service ${serviceNames.get(saved.filters.serviceId) ?? saved.filters.serviceId}`}
                      {saved.filters.sourceName && ` · source ${saved.filters.sourceName}`}
                      {` · last ${saved.filters.rangePreset}`}
                      {saved.createdBy && ` · by ${saved.createdBy}`}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    <button type="button" className="btn btn-secondary py-1.5 text-sm" onClick={() => applySavedSearch(String(saved.id))} aria-label={`Run ${saved.name}`}>
                      <Play className="h-4 w-4" aria-hidden="true" />Run
                    </button>
                    <button type="button" className="btn btn-secondary py-1.5 text-sm" onClick={() => void deleteSavedSearch(saved)} aria-label={`Delete ${saved.name}`} title="Delete saved search">
                      <Trash2 className="h-4 w-4" aria-hidden="true" />
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        )}
      </form>

      {servicesError && (
        <p className="text-sm text-red-600 dark:text-red-400" role="status">
          Could not load the service list: {servicesError}. You can still search all services.
        </p>
      )}

      {isLoading && (
        <div className="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400" role="status" aria-live="polite">
          <Spinner label="Searching logs" size="sm" />
          <span>Searching logs…</span>
        </div>
      )}

      {storeProblems.map((problem) => (
        <div key={problem} className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{problem}</span>
        </div>
      ))}

      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {result && !error && (
        <div className="card p-0" aria-busy={isLoading}>
          <div
            className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-200 px-4 py-3 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400"
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <span>
              {result.rows.length === 0 ? 'No matching lines.' : `${result.rows.length} line${result.rows.length === 1 ? '' : 's'}, newest first`}
              {result.truncated && ` — showing the newest ${result.limit}; narrow the time range or filter to see older lines.`}
            </span>
            {status?.reachable && status.storageBytes !== null && <span>Store size {formatBytes(status.storageBytes)}</span>}
          </div>
          {result.rows.length > 0 && (
            <div className="max-h-[calc(100vh-22rem)] min-h-64 overflow-auto bg-gray-950 font-mono text-xs leading-relaxed text-gray-100">
              <table className="w-full border-collapse" aria-label="Log search results">
                <thead className="sr-only">
                  <tr>
                    <th scope="col">Timestamp</th>
                    <th scope="col">Service</th>
                    <th scope="col">Source</th>
                    <th scope="col">Log message</th>
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, index) => (
                    <tr
                      key={`${row.time}-${index}`}
                      className="align-top hover:bg-white/5"
                      style={{ contentVisibility: 'auto', containIntrinsicSize: 'auto 24px' }}
                    >
                      <td className="whitespace-nowrap px-3 py-0.5 text-gray-400">{formatTime(row.time)}</td>
                      <td className="whitespace-nowrap px-3 py-0.5 text-sky-300" title={`${row.serviceType} · ${row.source}`}>
                        {serviceNames.get(row.serviceId) || row.serviceId || row.sourceName || '—'}
                      </td>
                      <td className="whitespace-nowrap px-3 py-0.5 text-gray-400" title={`${row.sourceType || 'log'} · ${row.source}`}>
                        {row.sourceName || row.source}
                        {row.severity && <span className="ml-2 text-amber-300">{row.severity}</span>}
                      </td>
                      <td className="w-full whitespace-pre-wrap break-all px-3 py-0.5">{row.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      <p className="text-xs text-gray-500 dark:text-gray-400">
        Fleet agents store new shipped lines after Logs is enabled. External sources can push
        JSON, NDJSON or plain-text logs to the authenticated HTTP endpoint; Sentry can send signed
        webhooks. Syslog sources should forward through a collector that supports HTTP or OTLP.
      </p>
    </div>
  );
}
