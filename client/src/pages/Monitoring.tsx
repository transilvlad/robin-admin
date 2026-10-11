import { Fragment, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, CheckCircle2, ChevronLeft, ChevronRight, CircleHelp, History, ListChecks, MapPin, Pause, PauseCircle, Play, Plus, RefreshCw, Search, Server, Settings, ShieldAlert, Trash2, Zap } from 'lucide-react';
import { ApiError, monitoringApi } from '../api/client';
import { useConfirm } from '../context/ConfirmContext';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { Modal } from '../components/ui/Modal';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { CheckEditor, checkPayload, editCheckForm, emptyCheckForm, type CheckForm } from '../components/monitoring/CheckEditor';
import { CheckHistoryModal } from '../components/monitoring/CheckHistoryModal';
import { MonitoringConfigTransfer } from '../components/monitoring/MonitoringConfigTransfer';
import { MonitoringLocations } from '../components/monitoring/MonitoringLocations';
import type { MonitoringCheck, MonitoringCheckType, MonitoringStatus, MonitoringSummary, MonitoringTarget, MonitoringTargetType } from '../types/monitoring';

interface TargetForm { id: number | null; name: string; targetType: MonitoringTargetType; environment: string; description: string; enabled: boolean; }

type MonitoringTab = 'checks' | 'targets' | 'issues' | 'recent' | 'locations';
type PageSize = 25 | 50 | 100;
const PAGE_SIZE_OPTIONS: PageSize[] = [25, 50, 100];
const STORAGE_KEYS = { tab: 'monitoring-tab' };
const emptyTargetForm: TargetForm = { id: null, name: '', targetType: 'host', environment: 'production', description: '', enabled: true };
function isMonitoringTab(value: unknown): value is MonitoringTab { return value === 'checks' || value === 'targets' || value === 'issues' || value === 'recent' || value === 'locations'; }
function loadMonitoringTab(): MonitoringTab { try { const raw = localStorage.getItem(STORAGE_KEYS.tab); const parsed = raw ? JSON.parse(raw) : null; return isMonitoringTab(parsed) ? parsed : 'checks'; } catch { return 'checks'; } }
function saveMonitoringTab(tab: MonitoringTab): void { try { localStorage.setItem(STORAGE_KEYS.tab, JSON.stringify(tab)); } catch {} }

export function MonitoringPage() {
  const [summary, setSummary] = useState<MonitoringSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const confirm = useConfirm();
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [targetForm, setTargetForm] = useState<TargetForm | null>(null);
  const [checkForm, setCheckForm] = useState<CheckForm | null>(null);
  const [pauseTarget, setPauseTarget] = useState<MonitoringCheck | null>(null);
  const [historyCheck, setHistoryCheck] = useState<MonitoringCheck | null>(null);
  const [pauseReason, setPauseReason] = useState('');
  const [lastRefreshedAt, setLastRefreshedAt] = useState<Date | null>(null);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [activeTab, setActiveTab] = useState<MonitoringTab>(() => loadMonitoringTab());
  const [checkPage, setCheckPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(25);
  const [targetFilter, setTargetFilter] = useState('all');
  const [environmentFilter, setEnvironmentFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState<MonitoringStatus | 'all'>('all');
  const [typeFilter, setTypeFilter] = useState<MonitoringCheckType | 'all'>('all');
  const [pausedFilter, setPausedFilter] = useState<'all' | 'active' | 'paused'>('all');
  const [targetSearch, setTargetSearch] = useState('');
  const [targetEnvironmentFilter, setTargetEnvironmentFilter] = useState('all');
  const [targetTypeFilter, setTargetTypeFilter] = useState<MonitoringTargetType | 'all'>('all');
  const [targetEnabledFilter, setTargetEnabledFilter] = useState<'all' | 'enabled' | 'disabled'>('all');
  const [recentCheckFilter, setRecentCheckFilter] = useState('all');
  const [recentStatusFilter, setRecentStatusFilter] = useState<MonitoringStatus | 'all'>('all');
  const [recentTypeFilter, setRecentTypeFilter] = useState<MonitoringCheckType | 'all'>('all');
  const [issueStatusFilter, setIssueStatusFilter] = useState<'all' | 'open' | 'closed'>('all');
  const [issueSeverityFilter, setIssueSeverityFilter] = useState<'all' | 'warning' | 'critical'>('all');
  const [issueTargetFilter, setIssueTargetFilter] = useState('all');
  const [issueCheckFilter, setIssueCheckFilter] = useState('all');
  const [expandedIssueTargets, setExpandedIssueTargets] = useState<Record<string, boolean>>({});
  const [expandedIssues, setExpandedIssues] = useState<Record<number, boolean>>({});

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true); else setRefreshing(true);
    try { const response = await monitoringApi.summary(); setSummary(response.data ?? null); setLastRefreshedAt(new Date()); setError(''); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Failed to load monitoring'); }
    finally { setLoading(false); setRefreshing(false); }
  }, []);
  useEffect(() => { void load(true); }, [load]);
  useEffect(() => { if (!autoRefresh) return undefined; const timer = window.setInterval(() => void load(false), 10_000); return () => window.clearInterval(timer); }, [autoRefresh, load]);
  useEffect(() => { saveMonitoringTab(activeTab); }, [activeTab]);

  const targets = summary?.targets ?? [];
  const checks = summary?.checks ?? [];
  const openIssues = summary?.openIssues ?? [];
  const issues = summary?.recentIssues ?? [];
  const defaultTargetId = targets[0]?.id ?? 0;
  const counts = useMemo(() => ({ total: checks.length, up: checks.filter((c) => c.currentStatus === 'up').length, warning: checks.filter((c) => c.currentStatus === 'warning').length, down: checks.filter((c) => c.currentStatus === 'down').length, unknown: checks.filter((c) => c.currentStatus === 'unknown').length, paused: checks.filter((c) => c.pausedAt).length }), [checks]);
  const environments = useMemo(() => Array.from(new Set(targets.map((t) => t.environment))).sort(), [targets]);
  const filteredChecks = useMemo(() => {
    const targetsById = new Map(targets.map((target) => [target.id, target]));
    return checks.filter((check) => {
      const target = targetsById.get(check.targetId);
      if (targetFilter !== 'all' && check.targetId !== Number(targetFilter)) return false;
      if (environmentFilter !== 'all' && target?.environment !== environmentFilter) return false;
      if (statusFilter !== 'all' && check.currentStatus !== statusFilter) return false;
      if (typeFilter !== 'all' && check.checkType !== typeFilter) return false;
      if (pausedFilter === 'paused' && !check.pausedAt) return false;
      if (pausedFilter === 'active' && check.pausedAt) return false;
      return true;
    });
  }, [checks, environmentFilter, pausedFilter, statusFilter, targetFilter, targets, typeFilter]);
  const checksById = useMemo(() => new Map(checks.map((check) => [check.id, check])), [checks]);
  const filteredIssues = useMemo(() => issues.filter((issue) => {
    const check = checksById.get(issue.checkId);
    if (issueStatusFilter !== 'all' && issue.status !== issueStatusFilter) return false;
    if (issueSeverityFilter !== 'all' && issue.severity !== issueSeverityFilter) return false;
    if (issueTargetFilter !== 'all' && check?.targetId !== Number(issueTargetFilter)) return false;
    if (issueCheckFilter !== 'all' && issue.checkId !== Number(issueCheckFilter)) return false;
    return true;
  }), [checksById, issueCheckFilter, issueSeverityFilter, issueStatusFilter, issueTargetFilter, issues]);
  const filteredObservations = useMemo(() => (summary?.recentObservations ?? []).filter((observation) => {
    const check = checksById.get(observation.checkId);
    if (recentCheckFilter !== 'all' && observation.checkId !== Number(recentCheckFilter)) return false;
    if (recentStatusFilter !== 'all' && observation.status !== recentStatusFilter) return false;
    if (recentTypeFilter !== 'all' && check?.checkType !== recentTypeFilter) return false;
    return true;
  }), [checksById, recentCheckFilter, recentStatusFilter, recentTypeFilter, summary?.recentObservations]);
  const filteredTargets = useMemo(() => {
    const normalized = targetSearch.trim().toLowerCase();
    return targets.filter((target) => {
      if (normalized && !target.name.toLowerCase().includes(normalized)) return false;
      if (targetEnvironmentFilter !== 'all' && target.environment !== targetEnvironmentFilter) return false;
      if (targetTypeFilter !== 'all' && target.targetType !== targetTypeFilter) return false;
      if (targetEnabledFilter === 'enabled' && !target.enabled) return false;
      if (targetEnabledFilter === 'disabled' && target.enabled) return false;
      return true;
    });
  }, [targetEnabledFilter, targetEnvironmentFilter, targetSearch, targetTypeFilter, targets]);
  useEffect(() => { setCheckPage(1); }, [environmentFilter, pageSize, pausedFilter, statusFilter, targetFilter, typeFilter]);
  const totalCheckPages = Math.max(1, Math.ceil(filteredChecks.length / pageSize));
  const boundedCheckPage = Math.min(checkPage, totalCheckPages);
  const checkStart = (boundedCheckPage - 1) * pageSize;
  const paginatedChecks = filteredChecks.slice(checkStart, checkStart + pageSize);
  const tabs = useMemo<readonly MetricTab<MonitoringTab>[]>(() => [
    { id: 'checks', label: `Checks (${filteredChecks.length})`, icon: ListChecks },
    { id: 'targets', label: `Targets (${filteredTargets.length})`, icon: Server },
    { id: 'issues', label: `Issues (${filteredIssues.length})`, icon: ShieldAlert },
    { id: 'recent', label: `Recent (${filteredObservations.length})`, icon: History },
    { id: 'locations', label: 'Locations', icon: MapPin },
  ], [filteredChecks.length, filteredIssues.length, filteredObservations.length, filteredTargets.length]);  const run = async (successMessage: string, action: () => Promise<void>) => {
    setWorking(true); setError(''); setMessage('');
    try { await action(); setMessage(successMessage); await load(false); }
    catch (err) { setError(err instanceof ApiError ? err.message : 'Action failed'); }
    finally { setWorking(false); }
  };
  const saveTarget = () => { if (!targetForm) return; void run('Target saved', async () => { const payload = { name: targetForm.name, targetType: targetForm.targetType, environment: targetForm.environment, description: targetForm.description || null, enabled: targetForm.enabled }; if (targetForm.id) await monitoringApi.updateTarget(targetForm.id, payload); else await monitoringApi.createTarget(payload); setTargetForm(null); }); };
  const saveCheck = async () => {
    if (!checkForm) return;
    setWorking(true);
    try {
      const payload = checkPayload(checkForm);
      if (checkForm.id) await monitoringApi.updateCheck(checkForm.id, payload);
      else await monitoringApi.createCheck(payload);
      setCheckForm(null); setMessage('Check saved'); await load(false);
    } finally { setWorking(false); }
  };
  const editTarget = (target: MonitoringTarget) => setTargetForm({ id: target.id, name: target.name, targetType: target.targetType, environment: target.environment, description: target.description ?? '', enabled: target.enabled });
  const editCheck = (check: MonitoringCheck) => setCheckForm(editCheckForm(check));
  const savePause = () => { if (!pauseTarget) return; const target = pauseTarget; setPauseTarget(null); void run('Check paused', async () => { await monitoringApi.pauseCheck(target.id, pauseReason); setPauseReason(''); }); };
  const toggleIssueTarget = (targetName: string) => setExpandedIssueTargets((current) => ({ ...current, [targetName]: !(current[targetName] ?? true) }));
  const toggleIssue = (id: number) => setExpandedIssues((current) => ({ ...current, [id]: !current[id] }));
  const closeStaleIssue = (id: number) => void run('Stale issue closed', async () => { await monitoringApi.closeStaleIssue(id); });
  const deleteIssue = async (issue: MonitoringSummary['recentIssues'][number]) => {
    if (!(await confirm(`Delete the closed issue "${issue.summary}"? It disappears from the issue history and the status page.`))) return;
    void run('Issue deleted', async () => { await monitoringApi.deleteIssue(issue.id); });
  };

  if (loading) return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;

  return (
    <div className="space-y-6">
      <PageHeader icon={appIcons.monitoring} title="Monitoring" description={`External checks with independent issue history${lastRefreshedAt ? ` · refreshed ${formatTime(lastRefreshedAt)}` : ''}`} actions={(
        <div className="flex flex-wrap items-center gap-2">
          <MonitoringConfigTransfer onImported={() => void load(false)} />
          <Link className="btn btn-secondary" to="/administration/monitoring" aria-label="Monitoring settings" title="Monitoring settings"><Settings className="h-4 w-4" /></Link>
          <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={autoRefresh} onChange={(event) => setAutoRefresh(event.target.checked)} className="h-4 w-4 rounded-sm accent-robin-orange" />Auto-refresh</label>
          <Button variant="secondary" onClick={() => void load(false)}><RefreshCw aria-hidden="true" className={`h-4 w-4 ${refreshing ? 'animate-spin' : ''}`} />Refresh</Button>
          <Button variant="secondary" onClick={() => setTargetForm(emptyTargetForm)}><Plus aria-hidden="true" className="h-4 w-4" />Target</Button>
          <Button onClick={() => setCheckForm(emptyCheckForm(defaultTargetId))} disabled={!targets.length}><Plus aria-hidden="true" className="h-4 w-4" />Check</Button>
        </div>
      )} />

      <div aria-live="polite" className="space-y-2">{error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}</div>
      {summary?.monitoringEnabled && !summary.alertsEnabled && <div role="status" className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-200">
        Monitoring is active, but alert delivery is disabled. <Link className="underline" to="/administration/alerts">Enable alerts</Link> to notify on issues.
      </div>}

      <section className="flex flex-wrap gap-4">
        <Stat icon={<ListChecks className="h-4 w-4" />} label="Checks" value={counts.total} />
        <Stat icon={<CheckCircle2 className="h-4 w-4" />} label="Up" value={counts.up} tone="success" />
        <Stat icon={<AlertTriangle className="h-4 w-4" />} label="Warning" value={counts.warning} tone="warning" />
        <Stat icon={<ShieldAlert className="h-4 w-4" />} label="Down" value={counts.down} tone="error" />
        <Stat icon={<CircleHelp className="h-4 w-4" />} label="Unknown" value={counts.unknown} />
        <Stat icon={<PauseCircle className="h-4 w-4" />} label="Paused" value={counts.paused} />
      </section>

      {openIssues.length > 0 && <OpenIssuesPanel issues={openIssues} />}
      <MetricTabs tabs={tabs} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'locations' && <MonitoringLocations />}
      {activeTab === 'checks' && <ChecksFilter targets={targets} environments={environments} targetFilter={targetFilter} setTargetFilter={setTargetFilter} environmentFilter={environmentFilter} setEnvironmentFilter={setEnvironmentFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} typeFilter={typeFilter} setTypeFilter={setTypeFilter} pausedFilter={pausedFilter} setPausedFilter={setPausedFilter} filtered={filteredChecks.length} total={checks.length} />}
      {activeTab === 'targets' && <TargetsFilter environments={environments} targetSearch={targetSearch} setTargetSearch={setTargetSearch} targetEnvironmentFilter={targetEnvironmentFilter} setTargetEnvironmentFilter={setTargetEnvironmentFilter} targetTypeFilter={targetTypeFilter} setTargetTypeFilter={setTargetTypeFilter} targetEnabledFilter={targetEnabledFilter} setTargetEnabledFilter={setTargetEnabledFilter} filtered={filteredTargets.length} total={targets.length} />}
      {activeTab === 'issues' && <IssuesFilter targets={targets} checks={checks} issueStatusFilter={issueStatusFilter} setIssueStatusFilter={setIssueStatusFilter} issueSeverityFilter={issueSeverityFilter} setIssueSeverityFilter={setIssueSeverityFilter} issueTargetFilter={issueTargetFilter} setIssueTargetFilter={setIssueTargetFilter} issueCheckFilter={issueCheckFilter} setIssueCheckFilter={setIssueCheckFilter} filtered={filteredIssues.length} total={issues.length} />}
      {activeTab === 'recent' && <RecentFilter checks={checks} recentCheckFilter={recentCheckFilter} setRecentCheckFilter={setRecentCheckFilter} recentStatusFilter={recentStatusFilter} setRecentStatusFilter={setRecentStatusFilter} recentTypeFilter={recentTypeFilter} setRecentTypeFilter={setRecentTypeFilter} filtered={filteredObservations.length} />}

      {activeTab !== 'locations' && <section className="card overflow-hidden">
        {activeTab === 'checks' && <ChecksTable checks={checks} filteredChecks={filteredChecks} paginatedChecks={paginatedChecks} checkStart={checkStart} pageSize={pageSize} setPageSize={setPageSize} boundedCheckPage={boundedCheckPage} totalCheckPages={totalCheckPages} setCheckPage={setCheckPage} working={working} run={run} editCheck={editCheck} setPauseTarget={setPauseTarget} setHistoryCheck={setHistoryCheck} />}
        {activeTab === 'targets' && <TargetsList targets={filteredTargets} editTarget={editTarget} />}
        {activeTab === 'issues' && <IssuesTable issues={filteredIssues} checksById={checksById} expandedTargets={expandedIssueTargets} expandedIssues={expandedIssues} toggleTarget={toggleIssueTarget} toggleIssue={toggleIssue} working={working} run={run} setPauseTarget={setPauseTarget} closeStaleIssue={closeStaleIssue} deleteIssue={(issue) => void deleteIssue(issue)} />}
        {activeTab === 'recent' && <RecentTable observations={filteredObservations} checksById={checksById} />}
      </section>}

      {targetForm && <Modal isOpen title={targetForm.id ? 'Edit target' : 'Add target'} onClose={() => setTargetForm(null)}><TargetEditor form={targetForm} setForm={setTargetForm} onSave={saveTarget} working={working} onDelete={targetForm.id ? () => void run('Target deleted', async () => { await monitoringApi.deleteTarget(targetForm.id!); setTargetForm(null); }) : undefined} /></Modal>}
      {checkForm && <Modal isOpen title={checkForm.id ? 'Edit check' : 'Add check'} size="xl" onClose={() => setCheckForm(null)}><CheckEditor form={checkForm} targets={targets} setForm={setCheckForm} onSave={saveCheck} working={working} /></Modal>}
      {historyCheck && <CheckHistoryModal check={historyCheck} onClose={() => setHistoryCheck(null)} />}
      {pauseTarget && <Modal isOpen title={`Pause ${pauseTarget.name}`} onClose={() => setPauseTarget(null)}><div className="space-y-4"><Input label="Reason" value={pauseReason} onChange={(event) => setPauseReason(event.target.value)} /><div className="flex justify-end gap-2"><Button variant="secondary" onClick={() => setPauseTarget(null)}>Cancel</Button><Button onClick={savePause}>Pause check</Button></div></div></Modal>}
    </div>
  );
}

function OpenIssuesPanel({ issues }: { issues: MonitoringSummary['openIssues'] }) {
  return <section className="rounded-xl border border-amber-200 bg-white p-4 shadow-xs dark:border-amber-900/50 dark:bg-robin-gray-900/70"><div className="flex items-start gap-3"><span className="rounded-lg bg-amber-50 p-2 text-amber-600 dark:bg-amber-900/20 dark:text-amber-300"><AlertTriangle aria-hidden="true" className="h-5 w-5" /></span><div className="min-w-0"><h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">Open monitoring issues</h2><p className="mt-1 text-sm text-gray-600 dark:text-gray-300">{issues.length} active issue{issues.length === 1 ? '' : 's'} need attention.</p></div></div><div className="mt-4 flex max-h-44 flex-wrap gap-3 overflow-auto">{issues.map((issue) => { const critical = issue.severity === 'critical'; return <article key={issue.id} className={`min-w-[260px] max-w-sm flex-1 rounded-lg border px-3 py-2 ${critical ? 'border-red-200 bg-red-50/70 dark:border-red-900/50 dark:bg-red-900/10' : 'border-amber-200 bg-amber-50/70 dark:border-amber-900/40 dark:bg-amber-900/10'}`}><div className="flex items-start gap-2"><AlertTriangle aria-hidden="true" className={`mt-0.5 h-4 w-4 shrink-0 ${critical ? 'text-red-600 dark:text-red-300' : 'text-amber-600 dark:text-amber-300'}`} /><div className="min-w-0"><div className={`truncate text-sm font-medium ${critical ? 'text-red-800 dark:text-red-200' : 'text-amber-800 dark:text-amber-200'}`}>{issue.summary}</div><div className="mt-0.5 truncate text-xs text-gray-600 dark:text-gray-300">{issue.targetName} · {formatDate(issue.openedAt)}</div></div></div></article>; })}</div></section>;
}

function ChecksFilter({ targets, environments, targetFilter, setTargetFilter, environmentFilter, setEnvironmentFilter, statusFilter, setStatusFilter, typeFilter, setTypeFilter, pausedFilter, setPausedFilter, filtered, total }: { targets: MonitoringTarget[]; environments: string[]; targetFilter: string; setTargetFilter: (v: string) => void; environmentFilter: string; setEnvironmentFilter: (v: string) => void; statusFilter: MonitoringStatus | 'all'; setStatusFilter: (v: MonitoringStatus | 'all') => void; typeFilter: MonitoringCheckType | 'all'; setTypeFilter: (v: MonitoringCheckType | 'all') => void; pausedFilter: 'all' | 'active' | 'paused'; setPausedFilter: (v: 'all' | 'active' | 'paused') => void; filtered: number; total: number }) {
  return <section className="card p-4"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-5"><L label="Target"><select className="input" value={targetFilter} onChange={(e) => setTargetFilter(e.target.value)}><option value="all">All targets</option>{targets.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></L><L label="Environment"><select className="input" value={environmentFilter} onChange={(e) => setEnvironmentFilter(e.target.value)}><option value="all">All environments</option>{environments.map((e) => <option key={e} value={e}>{e}</option>)}</select></L><L label="Status"><select className="input" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as MonitoringStatus | 'all')}><option value="all">All statuses</option><option value="down">Down</option><option value="warning">Warning</option><option value="unknown">Unknown</option><option value="up">Up</option></select></L><L label="Type"><select className="input" value={typeFilter} onChange={(e) => setTypeFilter(e.target.value as MonitoringCheckType | 'all')}><option value="all">All types</option><option value="http">HTTP / HTTPS</option><option value="tcp">TCP</option><option value="dns">DNS</option><option value="smtp">SMTP</option><option value="imap">IMAP</option></select></L><L label="Pause"><select className="input" value={pausedFilter} onChange={(e) => setPausedFilter(e.target.value as 'all' | 'active' | 'paused')}><option value="all">All checks</option><option value="active">Active</option><option value="paused">Paused</option></select></L></div><div className="mt-3 text-sm text-gray-600 dark:text-gray-300">Showing {filtered} of {total} checks.</div></section>;
}
function TargetsFilter({ environments, targetSearch, setTargetSearch, targetEnvironmentFilter, setTargetEnvironmentFilter, targetTypeFilter, setTargetTypeFilter, targetEnabledFilter, setTargetEnabledFilter, filtered, total }: { environments: string[]; targetSearch: string; setTargetSearch: (v: string) => void; targetEnvironmentFilter: string; setTargetEnvironmentFilter: (v: string) => void; targetTypeFilter: MonitoringTargetType | 'all'; setTargetTypeFilter: (v: MonitoringTargetType | 'all') => void; targetEnabledFilter: 'all' | 'enabled' | 'disabled'; setTargetEnabledFilter: (v: 'all' | 'enabled' | 'disabled') => void; filtered: number; total: number }) {
  return <section className="card p-4"><div className="flex flex-col gap-4 lg:flex-row"><div className="relative flex-1"><Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" /><input className="input w-full pl-10" placeholder="Search targets" value={targetSearch} onChange={(e) => setTargetSearch(e.target.value)} /></div><select className="input w-full lg:w-48" value={targetEnvironmentFilter} onChange={(e) => setTargetEnvironmentFilter(e.target.value)}><option value="all">All environments</option>{environments.map((env) => <option key={env} value={env}>{env}</option>)}</select><select className="input w-full lg:w-40" value={targetTypeFilter} onChange={(e) => setTargetTypeFilter(e.target.value as MonitoringTargetType | 'all')}><option value="all">All types</option><option value="host">Host</option><option value="endpoint">Endpoint</option></select><select className="input w-full lg:w-40" value={targetEnabledFilter} onChange={(e) => setTargetEnabledFilter(e.target.value as 'all' | 'enabled' | 'disabled')}><option value="all">All states</option><option value="enabled">Enabled</option><option value="disabled">Disabled</option></select></div><div className="mt-3 text-sm text-gray-600 dark:text-gray-300">Showing {filtered} of {total} targets.</div></section>;
}
function RecentFilter({ checks, recentCheckFilter, setRecentCheckFilter, recentStatusFilter, setRecentStatusFilter, recentTypeFilter, setRecentTypeFilter, filtered }: { checks: MonitoringCheck[]; recentCheckFilter: string; setRecentCheckFilter: (v: string) => void; recentStatusFilter: MonitoringStatus | 'all'; setRecentStatusFilter: (v: MonitoringStatus | 'all') => void; recentTypeFilter: MonitoringCheckType | 'all'; setRecentTypeFilter: (v: MonitoringCheckType | 'all') => void; filtered: number }) {
  return <section className="card p-4"><div className="grid gap-4 sm:grid-cols-3"><L label="Check"><select className="input" value={recentCheckFilter} onChange={(e) => setRecentCheckFilter(e.target.value)}><option value="all">All checks</option>{checks.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select></L><L label="Status"><select className="input" value={recentStatusFilter} onChange={(e) => setRecentStatusFilter(e.target.value as MonitoringStatus | 'all')}><option value="all">All statuses</option><option value="down">Down</option><option value="warning">Warning</option><option value="unknown">Unknown</option><option value="up">Up</option></select></L><L label="Type"><select className="input" value={recentTypeFilter} onChange={(e) => setRecentTypeFilter(e.target.value as MonitoringCheckType | 'all')}><option value="all">All types</option><option value="http">HTTP / HTTPS</option><option value="tcp">TCP</option><option value="dns">DNS</option><option value="smtp">SMTP</option><option value="imap">IMAP</option></select></L></div><div className="mt-3 text-sm text-gray-600 dark:text-gray-300">Showing {filtered} recent observations.</div></section>;
}
function IssuesFilter({ targets, checks, issueStatusFilter, setIssueStatusFilter, issueSeverityFilter, setIssueSeverityFilter, issueTargetFilter, setIssueTargetFilter, issueCheckFilter, setIssueCheckFilter, filtered, total }: { targets: MonitoringTarget[]; checks: MonitoringCheck[]; issueStatusFilter: 'all' | 'open' | 'closed'; setIssueStatusFilter: (v: 'all' | 'open' | 'closed') => void; issueSeverityFilter: 'all' | 'warning' | 'critical'; setIssueSeverityFilter: (v: 'all' | 'warning' | 'critical') => void; issueTargetFilter: string; setIssueTargetFilter: (v: string) => void; issueCheckFilter: string; setIssueCheckFilter: (v: string) => void; filtered: number; total: number }) {
  return <section className="card p-4"><div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4"><L label="Status"><select className="input" value={issueStatusFilter} onChange={(e) => setIssueStatusFilter(e.target.value as 'all' | 'open' | 'closed')}><option value="all">All issues</option><option value="open">Open</option><option value="closed">Closed</option></select></L><L label="Severity"><select className="input" value={issueSeverityFilter} onChange={(e) => setIssueSeverityFilter(e.target.value as 'all' | 'warning' | 'critical')}><option value="all">All severities</option><option value="critical">Critical</option><option value="warning">Warning</option></select></L><L label="Target"><select className="input" value={issueTargetFilter} onChange={(e) => setIssueTargetFilter(e.target.value)}><option value="all">All targets</option>{targets.map((target) => <option key={target.id} value={target.id}>{target.name}</option>)}</select></L><L label="Check"><select className="input" value={issueCheckFilter} onChange={(e) => setIssueCheckFilter(e.target.value)}><option value="all">All checks</option>{checks.map((check) => <option key={check.id} value={check.id}>{check.name}</option>)}</select></L></div><div className="mt-3 text-sm text-gray-600 dark:text-gray-300">Showing {filtered} of {total} issue episodes.</div></section>;
}
function L({ label, children }: { label: string; children: ReactNode }) { return <label className="space-y-1"><span className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>{children}</label>; }

function TargetsList({ targets, editTarget }: { targets: MonitoringTarget[]; editTarget: (target: MonitoringTarget) => void }) {
  return <div className="max-h-[640px] overflow-auto p-5"><div className="grid gap-3 lg:grid-cols-2 xl:grid-cols-3">{targets.map((target) => <article key={target.id} className={`rounded-xl border border-gray-200 bg-white p-4 dark:border-robin-gray-700 dark:bg-robin-gray-900/60 ${target.enabled ? '' : 'opacity-70'}`}><div className="flex items-start justify-between gap-3"><div className="min-w-0"><div className="flex min-w-0 items-center gap-2"><span className="truncate font-medium">{target.name}</span><StateBadge enabled={target.enabled} /></div><div className="mt-1 text-sm text-gray-600 dark:text-gray-300">{target.environment} · {target.targetType}</div></div><Button size="sm" variant="secondary" onClick={() => editTarget(target)}>Edit</Button></div></article>)}</div>{!targets.length && <p className="text-sm text-gray-500">No targets match the current filters.</p>}</div>;
}

function ChecksTable({ checks, filteredChecks, paginatedChecks, checkStart, pageSize, setPageSize, boundedCheckPage, totalCheckPages, setCheckPage, working, run, editCheck, setPauseTarget, setHistoryCheck }: { checks: MonitoringCheck[]; filteredChecks: MonitoringCheck[]; paginatedChecks: MonitoringCheck[]; checkStart: number; pageSize: PageSize; setPageSize: (value: PageSize) => void; boundedCheckPage: number; totalCheckPages: number; setCheckPage: (value: number) => void; working: boolean; run: (successMessage: string, action: () => Promise<void>) => Promise<void>; editCheck: (check: MonitoringCheck) => void; setPauseTarget: (check: MonitoringCheck) => void; setHistoryCheck: (check: MonitoringCheck) => void }) {
  return <div><div className="flex flex-wrap items-center justify-between gap-3 border-b border-gray-200 p-4 dark:border-gray-700"><div><h2 className="flex items-center gap-2 text-base font-semibold"><ListChecks aria-hidden="true" className="h-4 w-4 text-robin-orange" />Checks</h2><p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Showing {filteredChecks.length ? checkStart + 1 : 0}-{Math.min(checkStart + pageSize, filteredChecks.length)} of {filteredChecks.length} filtered checks.</p></div><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 text-sm">Rows<select className="input w-24" value={pageSize} onChange={(e) => setPageSize(Number(e.target.value) as PageSize)}>{PAGE_SIZE_OPTIONS.map((v) => <option key={v} value={v}>{v}</option>)}</select></label><Button size="sm" variant="secondary" onClick={() => setCheckPage(Math.max(1, boundedCheckPage - 1))} disabled={boundedCheckPage <= 1} aria-label="Previous checks page"><ChevronLeft aria-hidden="true" className="h-4 w-4" /></Button><span className="text-sm text-gray-600 dark:text-gray-300">Page {boundedCheckPage} of {totalCheckPages}</span><Button size="sm" variant="secondary" onClick={() => setCheckPage(Math.min(totalCheckPages, boundedCheckPage + 1))} disabled={boundedCheckPage >= totalCheckPages} aria-label="Next checks page"><ChevronRight aria-hidden="true" className="h-4 w-4" /></Button></div></div><div className="max-h-[640px] overflow-auto"><table className="min-w-full text-left text-sm"><thead className="sticky top-0 z-10 bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300"><tr>{['State', 'Check', 'Target', 'Endpoint', 'Last run', 'Actions'].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody className="divide-y divide-gray-200 dark:divide-gray-700">{paginatedChecks.map((check) => <tr key={check.id}><td className="px-4 py-3">{check.targetEnabled ? <StatusBadge status={check.currentStatus} /> : <StateBadge enabled={false} label="Target disabled" />}</td><td className="min-w-48 px-4 py-3"><div className="font-medium">{check.name}</div><div className="text-xs text-gray-500">{checkTypeLabel(check.checkType)}{check.pausedAt ? ' · paused' : ''}</div></td><td className="px-4 py-3">{check.targetName}</td><td className="max-w-80 wrap-break-word px-4 py-3">{check.checkType === 'push' ? (check.lastPingAt ? `Last ping ${formatDate(check.lastPingAt)}${check.lastPingStatus === 'fail' ? ' (failure)' : ''}` : 'No ping yet') : `${check.endpoint}${check.port ? `:${check.port}` : ''}`}{check.lastError && check.targetEnabled && !check.pausedAt && <div className="mt-1 text-xs text-red-600 dark:text-red-300">{check.lastError}</div>}</td><td className="whitespace-nowrap px-4 py-3">{check.lastRunAt ? formatDate(check.lastRunAt) : 'Not run'}{check.lastResponseTimeMs !== null && <div className="text-xs text-gray-500">{check.lastResponseTimeMs} ms</div>}</td><td className="px-4 py-3"><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => void run('Check executed', async () => { await monitoringApi.runCheck(check.id); })} disabled={working}><Zap aria-hidden="true" className="h-4 w-4" />Run</Button><Button size="sm" variant="secondary" onClick={() => setHistoryCheck(check)} aria-label={`History of ${check.name}`} title="History"><History aria-hidden="true" className="h-4 w-4" /></Button><Button size="sm" variant="secondary" onClick={() => editCheck(check)}>Edit</Button>{check.pausedAt ? <Button size="sm" variant="secondary" onClick={() => void run('Check resumed', async () => { await monitoringApi.resumeCheck(check.id); })}><Play aria-hidden="true" className="h-4 w-4" /></Button> : <Button size="sm" variant="secondary" onClick={() => setPauseTarget(check)}><Pause aria-hidden="true" className="h-4 w-4" /></Button>}<Button size="sm" variant="danger" onClick={() => void run('Check deleted', async () => { await monitoringApi.deleteCheck(check.id); })} aria-label={`Delete ${check.name}`}><Trash2 aria-hidden="true" className="h-4 w-4" /></Button></div></td></tr>)}{!filteredChecks.length && <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">{checks.length ? 'No checks match the current filters.' : 'Add a target and a check to start monitoring.'}</td></tr>}</tbody></table></div></div>;
}

function RecentTable({ observations, checksById }: { observations: MonitoringSummary['recentObservations']; checksById: Map<number, MonitoringCheck> }) {
  return <div className="max-h-[640px] overflow-auto"><table className="min-w-full text-left text-sm"><thead className="sticky top-0 z-10 bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300"><tr>{['Observed', 'Check', 'State', 'Response', 'Details'].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody className="divide-y divide-gray-200 dark:divide-gray-700">{observations.map((observation) => { const check = checksById.get(observation.checkId); return <tr key={observation.id}><td className="whitespace-nowrap px-4 py-3">{formatDate(observation.observedAt)}</td><td className="px-4 py-3">{check?.name ?? `Check ${observation.checkId}`}</td><td className="px-4 py-3"><StatusBadge status={observation.status} /></td><td className="px-4 py-3">{observation.responseTimeMs !== null ? `${observation.responseTimeMs} ms` : '-'}</td><td className="max-w-xl wrap-break-word px-4 py-3 text-xs text-gray-600 dark:text-gray-300">{observation.error ?? formatDetails(observation.details)}</td></tr>; })}{!observations.length && <tr><td colSpan={5} className="px-4 py-8 text-center text-gray-500">No observations match the current filters.</td></tr>}</tbody></table></div>;
}
// Protocols read as written in the check editor: HTTP, SMTP, IMAP, ... and Push.
function checkTypeLabel(type: MonitoringCheckType): string {
  return type === 'push' ? 'Push' : type.toUpperCase();
}

function IssuesTable({ issues, checksById, expandedTargets, expandedIssues, toggleTarget, toggleIssue, working, run, setPauseTarget, closeStaleIssue, deleteIssue }: { issues: MonitoringSummary['recentIssues']; checksById: Map<number, MonitoringCheck>; expandedTargets: Record<string, boolean>; expandedIssues: Record<number, boolean>; toggleTarget: (targetName: string) => void; toggleIssue: (id: number) => void; working: boolean; run: (successMessage: string, action: () => Promise<void>) => Promise<void>; setPauseTarget: (check: MonitoringCheck) => void; closeStaleIssue: (id: number) => void; deleteIssue: (issue: MonitoringSummary['recentIssues'][number]) => void }) {
  const grouped = issues.reduce<Array<{ targetName: string; issues: MonitoringSummary['recentIssues'] }>>((groups, issue) => {
    const group = groups.find((item) => item.targetName === issue.targetName);
    if (group) group.issues.push(issue);
    else groups.push({ targetName: issue.targetName, issues: [issue] });
    return groups;
  }, []);
  return <div><div className="border-b border-gray-200 p-4 dark:border-gray-700"><h2 className="flex items-center gap-2 text-base font-semibold"><ShieldAlert aria-hidden="true" className="h-4 w-4 text-robin-orange" />Issue episodes</h2><p className="mt-1 text-sm text-gray-600 dark:text-gray-300">Issues are grouped by Monitoring target. One open issue is kept per check until recovery closes the episode.</p></div><div className="max-h-[680px] overflow-auto">{grouped.map((group) => { const expanded = expandedTargets[group.targetName] ?? true; const openCount = group.issues.filter((issue) => issue.status === 'open').length; return <section key={group.targetName} className="border-b border-gray-200 last:border-b-0 dark:border-gray-700"><button type="button" className="flex w-full items-center justify-between gap-3 bg-gray-50 px-4 py-3 text-left hover:bg-gray-100 dark:bg-robin-gray-800 dark:hover:bg-robin-gray-700" onClick={() => toggleTarget(group.targetName)}><span className="font-medium">{group.targetName}</span><span className="text-sm text-gray-600 dark:text-gray-300">{openCount} open · {group.issues.length} total · {expanded ? 'hide' : 'show'}</span></button>{expanded && <table className="min-w-full text-left text-sm"><thead className="bg-white text-gray-600 dark:bg-robin-gray-900 dark:text-gray-300"><tr>{['', 'Status', 'Severity', 'Issue', 'Opened', 'Closed', 'Duration', 'Actions'].map((h) => <th key={h} scope="col" className="px-4 py-3 font-medium">{h}</th>)}</tr></thead><tbody className="divide-y divide-gray-200 dark:divide-gray-700">{group.issues.map((issue) => { const check = checksById.get(issue.checkId); const issueExpanded = expandedIssues[issue.id] ?? false; const canCloseStale = issue.status === 'open' && (!check || !check.enabled || Boolean(check.pausedAt) || (check.currentStatus !== 'warning' && check.currentStatus !== 'down')); return <Fragment key={issue.id}><tr><td className="px-4 py-3"><Button size="sm" variant="secondary" onClick={() => toggleIssue(issue.id)}>{issueExpanded ? 'Hide' : 'Details'}</Button></td><td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${issue.status === 'open' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200' : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200'}`}>{issue.status}</span></td><td className="px-4 py-3"><span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${issue.severity === 'critical' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200' : 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200'}`}>{issue.severity}</span></td><td className="min-w-72 px-4 py-3"><div className="font-medium">{issue.summary}</div><div className="mt-1 text-xs text-gray-500">{check ? checkTypeLabel(check.checkType) : 'Check'}{check?.endpoint ? ` · ${check.endpoint}${check.port ? `:${check.port}` : ''}` : ''}</div></td><td className="whitespace-nowrap px-4 py-3">{formatDate(issue.openedAt)}</td><td className="whitespace-nowrap px-4 py-3">{issue.closedAt ? formatDate(issue.closedAt) : '-'}</td><td className="whitespace-nowrap px-4 py-3">{formatDuration(issue.openedAt, issue.closedAt)}</td><td className="px-4 py-3"><div className="flex flex-wrap gap-2">{check && <Button size="sm" variant="secondary" onClick={() => void run('Check executed', async () => { await monitoringApi.runCheck(check.id); })} disabled={working}>Run</Button>}{check && !check.pausedAt && <Button size="sm" variant="secondary" onClick={() => setPauseTarget(check)} disabled={working}>Pause</Button>}{canCloseStale && <Button size="sm" variant="secondary" onClick={() => closeStaleIssue(issue.id)} disabled={working}>Close stale</Button>}{issue.status === 'closed' && <Button size="sm" variant="danger" onClick={() => deleteIssue(issue)} disabled={working}>Delete</Button>}</div></td></tr>{issueExpanded && <tr><td colSpan={8} className="bg-gray-50 px-4 py-4 dark:bg-robin-gray-900/60"><IssueDetails issue={issue} check={check} /></td></tr>}</Fragment>; })}</tbody></table>}</section>; })}{!issues.length && <div className="px-4 py-8 text-center text-sm text-gray-500">No issue episodes match the current filters.</div>}</div></div>;
}

function IssueDetails({ issue, check }: { issue: MonitoringSummary['recentIssues'][number]; check?: MonitoringCheck }) {
  const detail = issueDetailText(issue.details);
  const rawObservation = issue.details.latestObservationId ?? issue.details.observationId;
  const latestObservation = typeof rawObservation === 'number' || typeof rawObservation === 'string' ? String(rawObservation) : '';
  return <div className="space-y-4"><div className="grid gap-3 md:grid-cols-3"><div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-robin-gray-700 dark:bg-robin-gray-900"><div className="text-xs font-medium text-gray-500">Check state</div><div className="mt-1 flex items-center gap-2">{check ? <StatusBadge status={check.currentStatus} /> : <span className="text-sm text-gray-500">Missing check</span>}{check?.pausedAt && <span className="text-xs text-gray-500">paused</span>}</div></div><div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-robin-gray-700 dark:bg-robin-gray-900"><div className="text-xs font-medium text-gray-500">Endpoint</div><div className="mt-1 wrap-break-word text-sm">{check ? `${check.endpoint}${check.port ? `:${check.port}` : ''}` : '-'}</div></div><div className="rounded-lg border border-gray-200 bg-white p-3 dark:border-robin-gray-700 dark:bg-robin-gray-900"><div className="text-xs font-medium text-gray-500">Latest result</div><div className="mt-1 wrap-break-word text-sm">{detail}</div>{latestObservation && <div className="mt-1 text-xs text-gray-500">Observation {String(latestObservation)}</div>}</div></div><div className="rounded-lg border border-gray-200 bg-white dark:border-robin-gray-700 dark:bg-robin-gray-900"><div className="border-b border-gray-200 px-3 py-2 text-sm font-medium dark:border-robin-gray-700">Alert deliveries</div>{issue.deliveries.length ? <div className="overflow-auto"><table className="min-w-full text-left text-xs"><thead className="bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300"><tr>{['Event', 'Webhook', 'Status', 'Attempts', 'Response', 'Created', 'Completed', 'Error'].map((heading) => <th key={heading} scope="col" className="px-3 py-2 font-medium">{heading}</th>)}</tr></thead><tbody className="divide-y divide-gray-200 dark:divide-robin-gray-700">{issue.deliveries.map((delivery) => <tr key={delivery.id}><td className="px-3 py-2">{delivery.eventKind}</td><td className="px-3 py-2">{delivery.webhookName}</td><td className="px-3 py-2"><DeliveryStatusBadge status={delivery.status} /></td><td className="px-3 py-2">{delivery.attempts}</td><td className="px-3 py-2">{delivery.responseStatus ?? '-'}</td><td className="whitespace-nowrap px-3 py-2">{formatDate(delivery.createdAt)}</td><td className="whitespace-nowrap px-3 py-2">{delivery.completedAt ? formatDate(delivery.completedAt) : '-'}</td><td className="max-w-sm wrap-break-word px-3 py-2 text-red-600 dark:text-red-300">{delivery.error ?? '-'}</td></tr>)}</tbody></table></div> : <div className="px-3 py-4 text-sm text-gray-500">No alert deliveries are linked to this issue.</div>}</div></div>;
}

function TargetEditor({ form, setForm, onSave, working, onDelete }: { form: TargetForm; setForm: (form: TargetForm) => void; onSave: () => void; working: boolean; onDelete?: () => void }) { return <div className="space-y-4"><Input label="Name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /><div className="grid gap-4 sm:grid-cols-2"><L label="Type"><select className="input" value={form.targetType} onChange={(e) => setForm({ ...form, targetType: e.target.value as MonitoringTargetType })}><option value="host">Host</option><option value="endpoint">Endpoint</option></select></L><Input label="Environment" value={form.environment} onChange={(e) => setForm({ ...form, environment: e.target.value })} /></div><Input label="Description" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" className="h-4 w-4 accent-robin-orange" checked={form.enabled} onChange={(e) => setForm({ ...form, enabled: e.target.checked })} />Enabled</label><div className="flex justify-between gap-2">{onDelete ? <Button variant="danger" onClick={onDelete}>Delete target</Button> : <span />}<Button onClick={onSave} disabled={working || !form.name}>Save target</Button></div></div>; }

function Stat({ icon, label, value, tone = 'neutral' }: { icon: ReactNode; label: string; value: number; tone?: 'neutral' | 'success' | 'warning' | 'error' }) { const chip = { neutral: 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300', success: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-300', warning: 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-300', error: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-300' }[tone]; const valueClass = { neutral: 'text-gray-900 dark:text-gray-100', success: 'text-green-700 dark:text-green-300', warning: 'text-amber-700 dark:text-amber-300', error: 'text-red-700 dark:text-red-300' }[tone]; return <div className="flex min-w-[150px] flex-1 items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-robin-gray-700 dark:bg-robin-gray-900/60"><div className={`shrink-0 rounded-lg p-2 ${chip}`}>{icon}</div><div><div className={`text-xl font-semibold ${valueClass}`}>{value}</div><div className="text-sm text-gray-600 dark:text-gray-300">{label}</div></div></div>; }
function StateBadge({ enabled, label }: { enabled: boolean; label?: string }) { return <span className={`inline-flex shrink-0 rounded-full px-2.5 py-1 text-xs font-medium ${enabled ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200' : 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200'}`}>{label ?? (enabled ? 'Enabled' : 'Disabled')}</span>; }

function StatusBadge({ status }: { status: MonitoringStatus }) { const classes = { up: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200', warning: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200', down: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200', unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200' }[status]; return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${classes}`}>{status}</span>; }
function DeliveryStatusBadge({ status }: { status: MonitoringSummary['recentIssues'][number]['deliveries'][number]['status'] }) { const classes = { pending: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200', processing: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200', accepted: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200', failed: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200', cancelled: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200', expired: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200' }[status]; return <span className={`inline-flex rounded-full px-2.5 py-1 font-medium ${classes}`}>{status}</span>; }
function Notice({ tone, children }: { tone: 'error' | 'success'; children: string }) { return <div className={`rounded-lg border p-3 text-sm ${tone === 'error' ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300' : 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300'}`}>{children}</div>; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function formatTime(value: Date): string { return new Intl.DateTimeFormat(undefined, { timeStyle: 'medium' }).format(value); }
function formatDuration(start: string, end: string | null): string { const started = new Date(start).getTime(); const ended = end ? new Date(end).getTime() : Date.now(); const seconds = Math.max(0, Math.round((ended - started) / 1000)); if (seconds < 60) return `${seconds}s`; const minutes = Math.floor(seconds / 60); if (minutes < 60) return `${minutes}m`; const hours = Math.floor(minutes / 60); if (hours < 48) return `${hours}h ${minutes % 60}m`; const days = Math.floor(hours / 24); return `${days}d ${hours % 24}h`; }
function issueDetailText(details: Record<string, unknown>): string { const error = typeof details.error === 'string' ? details.error : null; const latestError = typeof details.latestError === 'string' ? details.latestError : null; const recovery = typeof details.recovery === 'string' ? details.recovery : null; const manuallyClosed = details.manuallyClosedAsStale === true ? 'Closed as stale' : null; return error ?? latestError ?? recovery ?? manuallyClosed ?? formatDetails(details); }
function formatDetails(details: Record<string, unknown>): string { const certDays = typeof details.certDaysRemaining === 'number' ? `${details.certDaysRemaining} cert days` : null; const statusCode = typeof details.statusCode === 'number' ? `HTTP ${details.statusCode}` : null; const banner = typeof details.banner === 'string' ? details.banner : null; const records = typeof details.recordCount === 'number' ? `${details.recordType} · ${details.recordCount} records` : null; const assertions = Array.isArray(details.assertions) ? details.assertions.filter((item) => item?.passed === false).map((item) => `Assertion ${item.index} failed`).join(', ') : null; return [statusCode, certDays, banner, records, assertions].filter(Boolean).join(' · ') || '-'; }
