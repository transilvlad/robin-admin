import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, CheckCircle2, Clock, ExternalLink, FileText, Layers, Plus, RefreshCw, Settings, Upload, Users, Wrench } from 'lucide-react';
import { ApiError, emailApi, monitoringApi, statusPageApi } from '../api/client';
import { useConfirm } from '../context/ConfirmContext';
import { Button } from '../components/ui/Button';
import { Input } from '../components/ui/Input';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import type { MonitoringCheck, MonitoringSummary } from '../types/monitoring';
import type { StatusPageSubscriber } from '../types/email';
import type {
  StatusPageAdminSummary,
  StatusPageComponent,
  StatusPageComponentStatus,
  StatusPageMaintenance,
  StatusPageReport,
  StatusPageReportImpact,
  StatusPageUpdateStatus,
  StatusPageSection,
} from '../types/status-page';

type StatusAdminTab = 'components' | 'sections' | 'reports' | 'maintenance' | 'subscribers';
type ReportUpdateDraft = { status: StatusPageUpdateStatus; message: string };

const STATUS_PAGE_TAB_STORAGE_KEY = 'robin-admin.status-page.tab';

const TABS: readonly MetricTab<StatusAdminTab>[] = [
  { id: 'components', label: 'Components', icon: Layers },
  { id: 'sections', label: 'Sections', icon: Activity },
  { id: 'reports', label: 'Incidents', icon: FileText },
  { id: 'maintenance', label: 'Maintenance', icon: Wrench },
  { id: 'subscribers', label: 'Subscribers', icon: Users },
];

const REPORT_UPDATE_STATUSES: ReadonlyArray<{ value: StatusPageUpdateStatus; label: string }> = [
  { value: 'investigating', label: 'Investigating' },
  { value: 'identified', label: 'Identified' },
  { value: 'monitoring', label: 'Monitoring' },
  { value: 'resolved', label: 'Resolved' },
];

function initialTab(): StatusAdminTab {
  const saved = window.localStorage.getItem(STATUS_PAGE_TAB_STORAGE_KEY);
  return TABS.some((tab) => tab.id === saved) ? saved as StatusAdminTab : 'components';
}

interface ComponentForm {
  id: number | null;
  sectionId: number;
  publicName: string;
  description: string;
  position: number;
  enabled: boolean;
  showHistory: boolean;
  checkIds: number[];
}

interface SectionForm {
  id: number | null;
  name: string;
  position: number;
  enabled: boolean;
}

interface ReportForm {
  title: string;
  impact: StatusPageReportImpact;
  componentIds: number[];
  message: string;
}

interface MaintenanceForm {
  id: number | null;
  title: string;
  message: string;
  status: StatusPageMaintenance['status'];
  startsAt: string;
  endsAt: string;
  componentIds: number[];
}

export function StatusPageAdmin() {
  const [summary, setSummary] = useState<StatusPageAdminSummary | null>(null);
  const [monitoring, setMonitoring] = useState<MonitoringSummary | null>(null);
  const [subscribers, setSubscribers] = useState<StatusPageSubscriber[]>([]);
  const [activeTab, setActiveTabState] = useState<StatusAdminTab>(initialTab);
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [componentForm, setComponentForm] = useState<ComponentForm | null>(null);
  const [sectionForm, setSectionForm] = useState<SectionForm | null>(null);
  const [reportForm, setReportForm] = useState<ReportForm | null>(null);
  const [maintenanceForm, setMaintenanceForm] = useState<MaintenanceForm | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const confirm = useConfirm();

  const load = useCallback(async (showSpinner = false) => {
    if (showSpinner) setLoading(true);
    try {
      const [statusResponse, monitoringResponse, emailResponse] = await Promise.all([
        statusPageApi.adminSummary(),
        monitoringApi.summary(),
        emailApi.statusSubscribers(),
      ]);
      setSummary(statusResponse.data ?? null);
      setMonitoring(monitoringResponse.data ?? null);
      setSubscribers(emailResponse.data ?? []);
      setError('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load status page');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(true); }, [load]);

  const setActiveTab = (tab: StatusAdminTab) => {
    setActiveTabState(tab);
    window.localStorage.setItem(STATUS_PAGE_TAB_STORAGE_KEY, tab);
  };

  const checks = monitoring?.checks ?? [];
  const sections = summary?.sections ?? [];
  const components = summary?.components ?? [];
  const reports = summary?.reports ?? [];
  const maintenances = summary?.maintenances ?? [];
  const counts = useMemo(() => ({
    total: components.length,
    operational: components.filter((component) => component.status === 'operational').length,
    degraded: components.filter((component) => component.status === 'degraded').length,
    outage: components.filter((component) => component.status === 'outage').length,
    unknown: components.filter((component) => component.status === 'unknown').length,
  }), [components]);

  const run = async (successMessage: string, action: () => Promise<void>) => {
    setWorking(true); setError(''); setMessage('');
    try {
      await action();
      setMessage(successMessage);
      await load(false);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Action failed');
    } finally {
      setWorking(false);
    }
  };

  const firstSectionId = sections[0]?.id ?? 0;
  const newComponent = () => setComponentForm({ id: null, sectionId: firstSectionId, publicName: '', description: '', position: components.length, enabled: true, showHistory: true, checkIds: [] });
  const editComponent = (component: StatusPageComponent) => setComponentForm({ id: component.id, sectionId: component.sectionId, publicName: component.publicName, description: component.description ?? '', position: component.position, enabled: component.enabled, showHistory: component.showHistory, checkIds: component.checks.map((check) => check.checkId) });
  const saveComponent = () => { if (!componentForm) return; void run('Component saved', async () => { await statusPageApi.saveComponent({ ...componentForm, description: componentForm.description || null }); setComponentForm(null); }); };
  const newSection = () => setSectionForm({ id: null, name: '', position: sections.length, enabled: true });
  const editSection = (section: StatusPageSection) => setSectionForm({ id: section.id, name: section.name, position: section.position, enabled: section.enabled });
  const saveSection = () => { if (!sectionForm) return; void run('Section saved', async () => { await statusPageApi.saveSection(sectionForm); setSectionForm(null); }); };
  const newReport = () => setReportForm({ title: '', impact: 'degraded', componentIds: [], message: '' });
  const saveReport = () => { if (!reportForm) return; void run('Incident created', async () => { await statusPageApi.createReport(reportForm); setReportForm(null); }); };
  const deleteReport = async (report: StatusPageReport) => {
    if (!(await confirm(`Delete the incident "${report.title}" and its updates from the status page?`))) return;
    void run('Incident deleted', async () => { await statusPageApi.deleteReport(report.id); });
  };
  const importReports = () => {
    if (importText === null) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(importText);
    } catch {
      setError('The import is not valid JSON');
      return;
    }
    const items = Array.isArray(parsed) ? parsed : (parsed as { reports?: unknown[] } | null)?.reports;
    if (!Array.isArray(items)) {
      setError('The import must be an array of incidents, or an object with a reports array');
      return;
    }
    setWorking(true); setError(''); setMessage('');
    statusPageApi.importReports(items)
      .then(async (response) => {
        const result = response.data;
        const unknown = result?.unknownComponents.length ? ` Unknown components: ${result.unknownComponents.join(', ')}.` : '';
        setMessage(`Imported ${result?.imported ?? 0}, skipped ${result?.skipped ?? 0} already imported.${unknown}`);
        setImportText(null);
        await load(false);
      })
      .catch((err) => setError(err instanceof ApiError ? err.message : 'Import failed'))
      .finally(() => setWorking(false));
  };
  const newMaintenance = () => {
    const starts = new Date(Date.now() + 60 * 60 * 1000);
    const ends = new Date(starts.getTime() + 60 * 60 * 1000);
    setMaintenanceForm({ id: null, title: '', message: '', status: 'scheduled', startsAt: toInputDate(starts), endsAt: toInputDate(ends), componentIds: [] });
  };
  const editMaintenance = (maintenance: StatusPageMaintenance) => setMaintenanceForm({ id: maintenance.id, title: maintenance.title, message: maintenance.message, status: maintenance.status, startsAt: toInputDate(new Date(maintenance.startsAt)), endsAt: toInputDate(new Date(maintenance.endsAt)), componentIds: maintenance.components.map((component) => component.id) });
  const saveMaintenance = () => { if (!maintenanceForm) return; void run('Maintenance saved', async () => { await statusPageApi.saveMaintenance({ ...maintenanceForm, startsAt: new Date(maintenanceForm.startsAt).toISOString(), endsAt: new Date(maintenanceForm.endsAt).toISOString() }); setMaintenanceForm(null); }); };

  if (loading) return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;
  if (!summary) return <Notice tone="error">{error || 'Status page unavailable'}</Notice>;

  return (
    <div className="space-y-6">
      <PageHeader icon={appIcons.statusPage} title="Status page" description="Public component status, incidents, and maintenance powered by Monitoring." actions={(
        <div className="flex flex-wrap gap-2">
          <Link className="btn btn-secondary" to="/administration/monitoring?tab=statusPage" title="Status page settings" aria-label="Status page settings"><Settings className="h-4 w-4" aria-hidden="true" /></Link>
          <Button variant="secondary" onClick={() => void load(false)}><RefreshCw aria-hidden="true" className="h-4 w-4" />Refresh</Button>
          <Button variant="secondary" onClick={() => window.open(`${import.meta.env.BASE_URL}status`, '_blank')}><ExternalLink aria-hidden="true" className="h-4 w-4" />Public page</Button>
          {activeTab === 'components' && <Button onClick={newComponent} disabled={!sections.length}><Plus aria-hidden="true" className="h-4 w-4" />Component</Button>}
          {activeTab === 'sections' && <Button onClick={newSection}><Plus aria-hidden="true" className="h-4 w-4" />Section</Button>}
          {activeTab === 'reports' && <Button variant="secondary" onClick={() => setImportText('')}><Upload aria-hidden="true" className="h-4 w-4" />Import</Button>}
          {activeTab === 'reports' && <Button onClick={newReport}><Plus aria-hidden="true" className="h-4 w-4" />Incident</Button>}
          {activeTab === 'maintenance' && <Button onClick={newMaintenance}><Plus aria-hidden="true" className="h-4 w-4" />Maintenance</Button>}
        </div>
      )} />

      <div aria-live="polite" className="space-y-2">{error && <Notice tone="error">{error}</Notice>}{message && <Notice tone="success">{message}</Notice>}</div>

      <section className="flex flex-wrap gap-4">
        <Stat icon={<Layers className="h-4 w-4" />} label="Components" value={counts.total} />
        <Stat icon={<CheckCircle2 className="h-4 w-4" />} label="Operational" value={counts.operational} tone="success" />
        <Stat icon={<AlertTriangle className="h-4 w-4" />} label="Degraded" value={counts.degraded} tone="warning" />
        <Stat icon={<AlertTriangle className="h-4 w-4" />} label="Outage" value={counts.outage} tone="error" />
        <Stat icon={<Clock className="h-4 w-4" />} label="Unknown" value={counts.unknown} />
      </section>

      <MetricTabs tabs={TABS} activeTab={activeTab} onChange={setActiveTab} />

      {activeTab === 'components' && <ComponentsView components={components} editComponent={editComponent} working={working} deleteComponent={(id) => void run('Component deleted', async () => { await statusPageApi.deleteComponent(id); })} />}
      {activeTab === 'sections' && <SectionsView sections={sections} editSection={editSection} working={working} deleteSection={(id) => void run('Section deleted', async () => { await statusPageApi.deleteSection(id); })} />}
      {activeTab === 'reports' && <ReportsView reports={reports} working={working} historyEnabled={summary.settings.incidentHistoryEnabled} deleteReport={(report) => void deleteReport(report)} addUpdate={(id, status, text) => void run('Incident updated', async () => { await statusPageApi.addReportUpdate(id, { status, message: text }); })} />}
      {activeTab === 'maintenance' && <MaintenanceView maintenances={maintenances} editMaintenance={editMaintenance} working={working} deleteMaintenance={(id) => void run('Maintenance deleted', async () => { await statusPageApi.deleteMaintenance(id); })} />}
      {activeTab === 'subscribers' && <SubscribersView subscribers={subscribers} components={components} working={working} deleteSubscriber={(id) => void run('Subscriber deleted', async () => { await emailApi.deleteStatusSubscriber(id); })} />}

      <Modal isOpen={componentForm !== null} title={componentForm?.id ? 'Edit component' : 'Add component'} onClose={() => setComponentForm(null)} size="lg">
        {componentForm && <ComponentEditor form={componentForm} setForm={setComponentForm} sections={sections} checks={checks} onSave={saveComponent} working={working} />}
      </Modal>
      <Modal isOpen={sectionForm !== null} title={sectionForm?.id ? 'Edit section' : 'Add section'} onClose={() => setSectionForm(null)}>
        {sectionForm && <SectionEditor form={sectionForm} setForm={setSectionForm} onSave={saveSection} working={working} />}
      </Modal>
      <Modal isOpen={reportForm !== null} title="Create incident" onClose={() => setReportForm(null)} size="lg">
        {reportForm && <ReportEditor form={reportForm} setForm={setReportForm} components={components} onSave={saveReport} working={working} />}
      </Modal>
      <Modal isOpen={importText !== null} title="Import incidents" onClose={() => setImportText(null)} size="lg">
        {importText !== null && (
          <div className="space-y-4">
            <p className="text-sm text-gray-600 dark:text-gray-300">
              Past incidents as JSON, for example from a previous status page: an array of
              {' '}<code>{'{ title, impact, openedAt, resolvedAt, components: [names], updates: [{ status, message, createdAt }] }'}</code>.
              Components are matched by public name. Incidents already imported are skipped, and subscribers are not notified.
            </p>
            <textarea className="input min-h-64 w-full font-mono text-xs" value={importText} onChange={(event) => setImportText(event.target.value)} aria-label="Incidents JSON" />
            <div className="flex justify-end"><Button onClick={importReports} disabled={working || !importText.trim()}>Import</Button></div>
          </div>
        )}
      </Modal>
      <Modal isOpen={maintenanceForm !== null} title={maintenanceForm?.id ? 'Edit maintenance' : 'Schedule maintenance'} onClose={() => setMaintenanceForm(null)} size="lg">
        {maintenanceForm && <MaintenanceEditor form={maintenanceForm} setForm={setMaintenanceForm} components={components} onSave={saveMaintenance} working={working} />}
      </Modal>
    </div>
  );
}

function ComponentsView({ components, editComponent, deleteComponent, working }: { components: StatusPageComponent[]; editComponent: (component: StatusPageComponent) => void; deleteComponent: (id: number) => void; working: boolean }) {
  return <section className="card overflow-hidden"><div className="max-h-[720px] overflow-auto"><table className="min-w-full text-left text-sm"><thead className="sticky top-0 bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300"><tr>{['Status', 'Component', 'Section', 'Checks', 'History', 'Actions'].map((heading) => <th key={heading} className="px-4 py-3 font-medium">{heading}</th>)}</tr></thead><tbody className="divide-y divide-gray-200 dark:divide-gray-700">{components.map((component) => <tr key={component.id}><td className="px-4 py-3"><StatusBadge status={component.status} /></td><td className="min-w-64 px-4 py-3"><div className="font-medium">{component.publicName}</div>{component.description && <div className="mt-1 text-xs text-gray-500">{component.description}</div>}{component.statusReason && <div className="mt-1 text-xs text-gray-500">{component.statusReason}</div>}</td><td className="px-4 py-3">{component.sectionName}</td><td className="px-4 py-3">{component.checks.length ? component.checks.map((check) => check.checkName).join(', ') : <span className="text-gray-500">No checks linked</span>}</td><td className="px-4 py-3">{component.showHistory ? (component.uptimePercent !== null ? `${component.uptimePercent}% uptime` : 'shown') : 'hidden'}</td><td className="px-4 py-3"><div className="flex flex-wrap gap-2"><Button size="sm" variant="secondary" onClick={() => editComponent(component)}>Edit</Button><Button size="sm" variant="danger" disabled={working} onClick={() => deleteComponent(component.id)}>Delete</Button></div></td></tr>)}</tbody></table></div></section>;
}

function SectionsView({ sections, editSection, deleteSection, working }: { sections: StatusPageSection[]; editSection: (section: StatusPageSection) => void; deleteSection: (id: number) => void; working: boolean }) {
  return <section className="card overflow-hidden"><table className="min-w-full text-left text-sm"><thead className="bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300"><tr>{['Position', 'Section', 'State', 'Actions'].map((heading) => <th key={heading} className="px-4 py-3 font-medium">{heading}</th>)}</tr></thead><tbody className="divide-y divide-gray-200 dark:divide-gray-700">{sections.map((section) => <tr key={section.id}><td className="px-4 py-3">{section.position}</td><td className="px-4 py-3 font-medium">{section.name}</td><td className="px-4 py-3">{section.enabled ? 'enabled' : 'disabled'}</td><td className="px-4 py-3"><div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => editSection(section)}>Edit</Button><Button size="sm" variant="danger" disabled={working} onClick={() => deleteSection(section.id)}>Delete</Button></div></td></tr>)}</tbody></table></section>;
}

function ReportsView({ reports, addUpdate, deleteReport, historyEnabled, working }: { reports: StatusPageReport[]; addUpdate: (id: number, status: StatusPageUpdateStatus, message: string) => void; deleteReport: (report: StatusPageReport) => void; historyEnabled: boolean; working: boolean }) {
  const [drafts, setDrafts] = useState<Record<number, ReportUpdateDraft>>({});
  const draftFor = (id: number): ReportUpdateDraft => drafts[id] ?? { status: 'monitoring', message: '' };
  const setDraft = (id: number, draft: ReportUpdateDraft) => setDrafts((current) => ({ ...current, [id]: draft }));

  return (
    <section className="card divide-y divide-gray-200 dark:divide-gray-700">
      {reports.length === 0 && <p className="p-6 text-center text-sm text-gray-500">No incidents yet.</p>}
      {reports.map((report) => {
        const draft = draftFor(report.id);
        return (
          <article key={report.id} className="p-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <div className="font-medium">{report.title}</div>
                <div className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                  {report.source} · {report.impact} · opened {formatDate(report.openedAt)}
                  {report.resolvedAt ? ` · resolved ${formatDate(report.resolvedAt)}` : ''}
                </div>
                <div className="mt-1 text-xs text-gray-500">{report.components.map((component) => component.publicName).join(', ') || 'No components'}</div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                <span className={`rounded-full px-2.5 py-1 text-xs font-medium ${report.status === 'open' ? 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200' : 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200'}`}>{report.status}</span>
                {historyEnabled && <a className="btn btn-secondary px-2 py-1.5" href={`${import.meta.env.BASE_URL}status/incidents/${report.id}`} target="_blank" rel="noreferrer" title="Public incident page" aria-label="Public incident page"><ExternalLink aria-hidden="true" className="h-4 w-4" /></a>}
                <Button size="sm" variant="danger" disabled={working} onClick={() => deleteReport(report)}>Delete</Button>
              </div>
            </div>
            {report.updates.length > 0 && (
              <div className="mt-3 space-y-2 text-sm text-gray-600 dark:text-gray-300">
                {report.updates.map((update) => (
                  <div key={update.id}>
                    <span className="font-medium">{formatDate(update.createdAt)}</span>{' '}
                    <span className="text-xs text-gray-500">{REPORT_UPDATE_STATUSES.find((option) => option.value === update.status)?.label ?? update.status}</span>{' '}
                    {update.message}
                  </div>
                ))}
              </div>
            )}
            <div className="mt-3 grid gap-2 md:grid-cols-[180px_1fr_auto_auto]">
              <L label="Status">
                <select className="input" value={draft.status} onChange={(event) => setDraft(report.id, { ...draft, status: event.target.value as StatusPageUpdateStatus })}>
                  {REPORT_UPDATE_STATUSES.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              </L>
              <Input label="Update" value={draft.message} onChange={(event) => setDraft(report.id, { ...draft, message: event.target.value })} />
              <div className="flex items-end">
                <Button size="sm" variant="secondary" disabled={working || !draft.message.trim()} onClick={() => addUpdate(report.id, draft.status, draft.message)}>Add update</Button>
              </div>
              {report.status === 'open' && (
                <div className="flex items-end">
                  <Button size="sm" disabled={working} onClick={() => addUpdate(report.id, 'resolved', draft.message.trim() || 'Resolved.')}>Resolve</Button>
                </div>
              )}
            </div>
          </article>
        );
      })}
    </section>
  );
}

function MaintenanceView({ maintenances, editMaintenance, deleteMaintenance, working }: { maintenances: StatusPageMaintenance[]; editMaintenance: (maintenance: StatusPageMaintenance) => void; deleteMaintenance: (id: number) => void; working: boolean }) {
  return <section className="card divide-y divide-gray-200 dark:divide-gray-700">{maintenances.map((maintenance) => <article key={maintenance.id} className="p-4"><div className="flex flex-wrap items-start justify-between gap-3"><div><div className="font-medium">{maintenance.title}</div><div className="mt-1 text-sm text-gray-600 dark:text-gray-300">{formatDate(maintenance.startsAt)} - {formatDate(maintenance.endsAt)} · {maintenance.status}</div><div className="mt-1 text-sm">{maintenance.message}</div><div className="mt-1 text-xs text-gray-500">{maintenance.components.map((component) => component.publicName).join(', ') || 'No components'}</div></div><div className="flex gap-2"><Button size="sm" variant="secondary" onClick={() => editMaintenance(maintenance)}>Edit</Button><Button size="sm" variant="danger" disabled={working} onClick={() => deleteMaintenance(maintenance.id)}>Delete</Button></div></div></article>)}</section>;
}

function SubscribersView({ subscribers, components, deleteSubscriber, working }: { subscribers: StatusPageSubscriber[]; components: StatusPageComponent[]; deleteSubscriber: (id: number) => void; working: boolean }) {
  const componentNames = new Map(components.map((component) => [component.id, component.publicName]));
  const scope = (subscriber: StatusPageSubscriber) => (
    subscriber.allComponents
      ? 'All components'
      : subscriber.componentIds.map((id) => componentNames.get(id) ?? `Component ${id}`).join(', ') || 'No components'
  );

  return (
    <section className="card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-gray-50 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
            <tr>{['Email', 'Status', 'Scope', 'Last notified', 'Created', 'Actions'].map((heading) => <th key={heading} className="px-4 py-3 font-medium">{heading}</th>)}</tr>
          </thead>
          <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
            {subscribers.map((subscriber) => (
              <tr key={subscriber.id}>
                <td className="px-4 py-3 font-medium">{subscriber.email}</td>
                <td className="px-4 py-3">{subscriber.status}</td>
                <td className="max-w-md wrap-break-word px-4 py-3">{scope(subscriber)}</td>
                <td className="px-4 py-3">{subscriber.lastNotifiedAt ? formatDate(subscriber.lastNotifiedAt) : '-'}</td>
                <td className="px-4 py-3">{formatDate(subscriber.createdAt)}</td>
                <td className="px-4 py-3"><Button size="sm" variant="danger" disabled={working} onClick={() => deleteSubscriber(subscriber.id)}>Delete</Button></td>
              </tr>
            ))}
            {!subscribers.length && (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-gray-500">No public subscribers yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </section>
  );
}


function ComponentEditor({ form, setForm, sections, checks, onSave, working }: { form: ComponentForm; setForm: (form: ComponentForm) => void; sections: StatusPageSection[]; checks: MonitoringCheck[]; onSave: () => void; working: boolean }) {
  return <div className="space-y-4"><div className="grid gap-4 sm:grid-cols-2"><L label="Section"><select className="input" value={form.sectionId} onChange={(event) => setForm({ ...form, sectionId: Number(event.target.value) })}>{sections.map((section) => <option key={section.id} value={section.id}>{section.name}</option>)}</select></L><Input label="Position" type="number" min={0} value={form.position} onChange={(event) => setForm({ ...form, position: Number(event.target.value) })} /></div><Input label="Public name" value={form.publicName} onChange={(event) => setForm({ ...form, publicName: event.target.value })} /><Input label="Description" value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /><L label="Linked Monitoring checks"><select multiple className="input min-h-36" value={form.checkIds.map(String)} onChange={(event) => setForm({ ...form, checkIds: Array.from(event.currentTarget.selectedOptions, (option) => Number(option.value)) })}>{checks.map((check) => <option key={check.id} value={check.id}>{check.targetName} / {check.name}</option>)}</select></L><div className="flex flex-wrap items-center justify-between gap-3"><div className="flex gap-4"><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} className="h-4 w-4 accent-robin-orange" />Enabled</label><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.showHistory} onChange={(event) => setForm({ ...form, showHistory: event.target.checked })} className="h-4 w-4 accent-robin-orange" />History</label></div><Button onClick={onSave} disabled={working || !form.publicName || !form.sectionId}>Save component</Button></div></div>;
}

function SectionEditor({ form, setForm, onSave, working }: { form: SectionForm; setForm: (form: SectionForm) => void; onSave: () => void; working: boolean }) {
  return <div className="space-y-4"><Input label="Name" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /><Input label="Position" type="number" min={0} value={form.position} onChange={(event) => setForm({ ...form, position: Number(event.target.value) })} /><label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={form.enabled} onChange={(event) => setForm({ ...form, enabled: event.target.checked })} className="h-4 w-4 accent-robin-orange" />Enabled</label><div className="flex justify-end"><Button onClick={onSave} disabled={working || !form.name}>Save section</Button></div></div>;
}

function ReportEditor({ form, setForm, components, onSave, working }: { form: ReportForm; setForm: (form: ReportForm) => void; components: StatusPageComponent[]; onSave: () => void; working: boolean }) {
  return <div className="space-y-4"><Input label="Title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /><L label="Impact"><select className="input" value={form.impact} onChange={(event) => setForm({ ...form, impact: event.target.value as StatusPageReportImpact })}><option value="degraded">Degraded</option><option value="outage">Outage</option><option value="maintenance">Maintenance</option></select></L><ComponentMultiSelect components={components} value={form.componentIds} onChange={(componentIds) => setForm({ ...form, componentIds })} /><Input label="Initial update" value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} /><div className="flex justify-end"><Button onClick={onSave} disabled={working || !form.title || !form.message || form.componentIds.length === 0}>Create incident</Button></div></div>;
}

function MaintenanceEditor({ form, setForm, components, onSave, working }: { form: MaintenanceForm; setForm: (form: MaintenanceForm) => void; components: StatusPageComponent[]; onSave: () => void; working: boolean }) {
  return <div className="space-y-4"><Input label="Title" value={form.title} onChange={(event) => setForm({ ...form, title: event.target.value })} /><Input label="Message" value={form.message} onChange={(event) => setForm({ ...form, message: event.target.value })} /><div className="grid gap-4 sm:grid-cols-3"><L label="Status"><select className="input" value={form.status} onChange={(event) => setForm({ ...form, status: event.target.value as MaintenanceForm['status'] })}><option value="scheduled">Scheduled</option><option value="active">Active</option><option value="completed">Completed</option><option value="cancelled">Cancelled</option></select></L><Input label="Starts" type="datetime-local" value={form.startsAt} onChange={(event) => setForm({ ...form, startsAt: event.target.value })} /><Input label="Ends" type="datetime-local" value={form.endsAt} onChange={(event) => setForm({ ...form, endsAt: event.target.value })} /></div><ComponentMultiSelect components={components} value={form.componentIds} onChange={(componentIds) => setForm({ ...form, componentIds })} /><div className="flex justify-end"><Button onClick={onSave} disabled={working || !form.title || !form.message || form.componentIds.length === 0}>Save maintenance</Button></div></div>;
}

function ComponentMultiSelect({ components, value, onChange }: { components: StatusPageComponent[]; value: number[]; onChange: (value: number[]) => void }) {
  return <L label="Components"><select multiple className="input min-h-36" value={value.map(String)} onChange={(event) => onChange(Array.from(event.currentTarget.selectedOptions, (option) => Number(option.value)))}>{components.map((component) => <option key={component.id} value={component.id}>{component.sectionName} / {component.publicName}</option>)}</select></L>;
}

function L({ label, children }: { label: string; children: ReactNode }) { return <label className="space-y-1"><span className="block text-sm font-medium text-gray-700 dark:text-gray-300">{label}</span>{children}</label>; }
function Notice({ tone, children }: { tone: 'error' | 'success'; children: string }) { return <div className={`rounded-lg border p-3 text-sm ${tone === 'error' ? 'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-900/20 dark:text-red-300' : 'border-green-200 bg-green-50 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-300'}`}>{children}</div>; }
function StatusBadge({ status }: { status: StatusPageComponentStatus }) { const classes = { operational: 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-200', degraded: 'bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-200', outage: 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-200', maintenance: 'bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-200', unknown: 'bg-gray-100 text-gray-700 dark:bg-gray-800 dark:text-gray-200' }[status]; return <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${classes}`}>{status}</span>; }
function Stat({ icon, label, value, tone = 'neutral' }: { icon: ReactNode; label: string; value: number; tone?: 'neutral' | 'success' | 'warning' | 'error' }) { const chip = { neutral: 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300', success: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-300', warning: 'bg-amber-50 text-amber-600 dark:bg-amber-900/20 dark:text-amber-300', error: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-300' }[tone]; return <div className="flex min-w-[150px] flex-1 items-center gap-3 rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-robin-gray-700 dark:bg-robin-gray-900/60"><div className={`shrink-0 rounded-lg p-2 ${chip}`}>{icon}</div><div><div className="text-xl font-semibold">{value}</div><div className="text-sm text-gray-600 dark:text-gray-300">{label}</div></div></div>; }
function formatDate(value: string): string { return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)); }
function toInputDate(value: Date): string { const offset = value.getTimezoneOffset() * 60_000; return new Date(value.getTime() - offset).toISOString().slice(0, 16); }
