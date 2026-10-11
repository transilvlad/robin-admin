import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Clock } from 'lucide-react';
import { ApiError, statusPageApi } from '../../api/client';
import { Spinner } from '../ui/Spinner';
import type {
  PublicIncidentArchive,
  PublicMaintenanceSchedule,
  PublicStatusPage,
  PublicStatusPageMaintenance,
  PublicStatusPageReport,
  StatusPageComponentStatus,
} from '../../types/status-page';
import {
  MAINTENANCE_LABEL,
  STATUS_COPY,
  UPDATE_LABEL,
  dayKey,
  formatDateTime,
  formatDay,
  formatDuration,
  formatMonth,
  formatShortMonth,
  historyColor,
  reportStatus,
  shiftMonth,
  statusClass,
  timeZoneLabel,
  type StatusPalette,
} from './statusPageTheme';

export interface StatusPageContextValue {
  page: PublicStatusPage;
  isDark: boolean;
  palette: StatusPalette;
  timeZone: string;
  /** Where the status page is mounted: "/status" in the app, "" on its own domain. */
  basePath: string;
}

export const StatusPageContext = createContext<StatusPageContextValue | null>(null);

function useStatusPage(): StatusPageContextValue {
  const value = useContext(StatusPageContext);
  if (!value) throw new Error('Status page views need a StatusPageContext');
  return value;
}

export function statusPath(basePath: string, path = ''): string {
  return `${basePath}${path}` || '/';
}

const HEADLINE: Record<StatusPageComponentStatus, string> = {
  operational: 'All systems operational',
  degraded: 'Some systems are degraded',
  outage: 'Some systems are down',
  maintenance: 'Maintenance in progress',
  unknown: 'Status is partially unknown',
};

export function StatusOverview({ notice }: { notice: string }) {
  const { page, isDark, palette, timeZone, basePath } = useStatusPage();
  const aggregate = STATUS_COPY[page.aggregateStatus];
  const AggregateIcon = aggregate.icon;
  return (
    <>
      <section className="space-y-4">
        <div className={`flex flex-wrap items-center gap-3 rounded-lg border border-solid px-4 py-4 ${statusClass(page.aggregateStatus, isDark)}`}>
          <AggregateIcon aria-hidden="true" className="h-5 w-5" />
          <h1 className="text-xl font-semibold">{HEADLINE[page.aggregateStatus]}</h1>
        </div>
        {page.settings.announcement && <div className={`rounded-lg border px-4 py-3 text-sm ${palette.announcement}`}>{page.settings.announcement}</div>}
        {notice && <div className={`rounded-lg border px-4 py-3 text-sm ${palette.announcement}`}>{notice}</div>}
      </section>

      {page.activeReports.length > 0 && <IncidentBlock title="Active incidents" reports={page.activeReports} expanded />}
      {page.maintenances.length > 0 && (
        <MaintenanceBlock
          maintenances={page.maintenances}
          action={page.settings.maintenancePageEnabled ? <Link className={`text-sm font-medium underline-offset-2 hover:underline`} to={statusPath(basePath, '/maintenance')}>All maintenance</Link> : null}
        />
      )}

      {page.sections.map((section) => (
        <section key={section.id} className={`overflow-hidden rounded-lg border ${palette.card}`}>
          <div className={`border-b px-4 py-3 ${palette.cardHeader}`}>
            <h2 className="font-semibold">{section.name}</h2>
          </div>
          <div className={palette.divider}>
            {section.components.map((component) => (
              <article key={component.id} className="px-4 py-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-medium">{component.publicName}</div>
                    {component.description && <div className={`mt-1 text-sm ${palette.muted}`}>{component.description}</div>}
                    {component.statusReason && <div className={`mt-1 text-sm ${palette.muted}`}>{component.statusReason}</div>}
                  </div>
                  <StatusPill status={component.status} />
                </div>
                {component.showHistory && component.history.length > 0 && <HistoryStrip history={component.history} uptimePercent={component.uptimePercent} />}
              </article>
            ))}
          </div>
        </section>
      ))}

      {page.recentReports.length > 0 && (
        <IncidentBlock
          title="Recent incidents"
          reports={page.recentReports}
          action={page.settings.incidentHistoryEnabled ? <Link className="text-sm font-medium underline-offset-2 hover:underline" to={statusPath(basePath, '/incidents')}>All incidents</Link> : null}
        />
      )}
      <p className={`text-xs ${palette.muted}`}>Updated {formatDateTime(page.generatedAt, timeZone)} · Times shown in {timeZoneLabel(timeZone)}</p>
    </>
  );
}

export function StatusPill({ status, label }: { status: StatusPageComponentStatus; label?: string }) {
  const { isDark } = useStatusPage();
  const copy = STATUS_COPY[status];
  const Icon = copy.icon;
  return <span className={`inline-flex shrink-0 items-center gap-1 rounded-full px-2.5 py-1 text-xs font-medium ring-1 ${statusClass(status, isDark)}`}><Icon aria-hidden="true" className="h-3.5 w-3.5" />{label ?? copy.label}</span>;
}

function ReportPill({ report }: { report: PublicStatusPageReport }) {
  return <StatusPill status={reportStatus(report)} label={report.status === 'resolved' ? 'Resolved' : undefined} />;
}

function HistoryStrip({ history, uptimePercent }: { history: PublicStatusPage['sections'][number]['components'][number]['history']; uptimePercent: number | null }) {
  const { palette } = useStatusPage();
  return (
    <div className="mt-3">
      <div className="flex gap-1" aria-label="Status history">{history.map((day) => <span key={day.day} title={`${day.day}: ${STATUS_COPY[day.status].label}`} className={`h-6 flex-1 rounded-xs ${historyColor(day.status)}`} />)}</div>
      <div className={`mt-1 flex justify-between text-xs ${palette.muted}`}>
        <span>{history[0].day}</span>
        {uptimePercent !== null && <span>{uptimePercent}% uptime</span>}
        <span>Today</span>
      </div>
    </div>
  );
}

function Card({ title, action, children }: { title: ReactNode; action?: ReactNode; children: ReactNode }) {
  const { palette } = useStatusPage();
  return (
    <section className={`overflow-hidden rounded-lg border ${palette.card}`}>
      <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 ${palette.cardHeader}`}>
        <h2 className="font-semibold">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}

function IncidentBlock({ title, reports, expanded = false, action }: { title: string; reports: PublicStatusPageReport[]; expanded?: boolean; action?: ReactNode }) {
  const { palette } = useStatusPage();
  return <Card title={title} action={action}><div className={palette.divider}>{reports.map((report) => <IncidentSummary key={report.id} report={report} expanded={expanded} />)}</div></Card>;
}

/** An incident's title, affected services and newest update, linking to its page when incident pages are on. */
function IncidentSummary({ report, expanded = false }: { report: PublicStatusPageReport; expanded?: boolean }) {
  const { page, palette, timeZone, basePath } = useStatusPage();
  const linked = page.settings.incidentHistoryEnabled;
  const newestFirst = [...report.updates].reverse();
  const shown = expanded || !linked ? newestFirst : newestFirst.slice(0, 1);
  const earlier = report.updates.length - shown.length;
  const href = statusPath(basePath, `/incidents/${report.id}`);
  return (
    <article className="px-4 py-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          {linked ? <Link to={href} className={`font-medium underline-offset-2 hover:underline ${palette.link}`}>{report.title}</Link> : <div className="font-medium">{report.title}</div>}
          <div className={`mt-1 text-sm ${palette.muted}`}>{report.components.map((component) => component.publicName).join(', ') || 'No services listed'} · {formatDateTime(report.openedAt, timeZone)}</div>
        </div>
        <ReportPill report={report} />
      </div>
      {shown.length > 0 && (
        <div className={`mt-3 space-y-2 rounded-md border px-3 py-2 text-sm ${palette.inset}`}>
          {shown.map((update) => (
            <div key={update.id}>
              <span className="font-medium">{UPDATE_LABEL[update.status]}</span>
              <span className={`ml-2 text-xs ${palette.muted}`}>{formatDateTime(update.createdAt, timeZone)}</span>
              <div className={palette.subtleText}>{update.message}</div>
            </div>
          ))}
        </div>
      )}
      {earlier > 0 && linked && <Link to={href} className={`mt-2 inline-block text-xs underline-offset-2 hover:underline ${palette.muted}`}>{earlier} earlier update{earlier === 1 ? '' : 's'}</Link>}
    </article>
  );
}

function MaintenanceBlock({ maintenances, action }: { maintenances: PublicStatusPageMaintenance[]; action?: ReactNode }) {
  const { isDark, timeZone } = useStatusPage();
  const classes = isDark ? 'border-blue-500/30 bg-blue-500/10 text-blue-200' : 'border-blue-200 bg-blue-50 text-blue-900';
  return (
    <section className={`rounded-lg border ${classes}`}>
      <div className={`flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3 ${isDark ? 'border-blue-500/30' : 'border-blue-200'}`}>
        <h2 className="flex items-center gap-2 font-semibold"><Clock aria-hidden="true" className="h-4 w-4" />Maintenance</h2>
        {action}
      </div>
      <div className={`divide-y ${isDark ? 'divide-blue-500/20' : 'divide-blue-100'}`}>
        {maintenances.map((maintenance) => (
          <article key={maintenance.id} className="px-4 py-3">
            <div className="font-medium">{maintenance.title}</div>
            <div className="mt-1 text-sm">{maintenance.message}</div>
            <div className="mt-1 text-xs">{formatDateTime(maintenance.startsAt, timeZone)} - {formatDateTime(maintenance.endsAt, timeZone)}</div>
          </article>
        ))}
      </div>
    </section>
  );
}

function useLoad<T>(load: () => Promise<{ data?: T }>, deps: unknown[]): { data: T | null; error: string; loading: boolean } {
  const [state, setState] = useState<{ data: T | null; error: string; loading: boolean }>({ data: null, error: '', loading: true });
  useEffect(() => {
    let cancelled = false;
    setState((current) => ({ ...current, loading: true }));
    load()
      .then((response) => { if (!cancelled) setState({ data: response.data ?? null, error: '', loading: false }); })
      .catch((err) => { if (!cancelled) setState({ data: null, error: err instanceof ApiError ? err.message : 'Failed to load', loading: false }); });
    return () => { cancelled = true; };
  }, deps);
  return state;
}

function PageHeading({ title, range, onOlder, onNewer, hasOlder, hasNewer }: { title: string; range?: string; onOlder?: () => void; onNewer?: () => void; hasOlder?: boolean; hasNewer?: boolean }) {
  const { palette } = useStatusPage();
  return (
    <div className="text-center">
      <h1 className="text-2xl font-semibold">{title}</h1>
      {range && (
        <div className={`mt-2 flex items-center justify-center gap-3 text-sm ${palette.muted}`}>
          <button type="button" aria-label="Earlier months" disabled={!hasOlder} onClick={onOlder} className={`rounded-md border p-1 ${palette.button}`}><ChevronLeft aria-hidden="true" className="h-4 w-4" /></button>
          <span>{range}</span>
          <button type="button" aria-label="Later months" disabled={!hasNewer} onClick={onNewer} className={`rounded-md border p-1 ${palette.button}`}><ChevronRight aria-hidden="true" className="h-4 w-4" /></button>
        </div>
      )}
    </div>
  );
}

function Loading({ error, loading }: { error: string; loading: boolean }) {
  const { palette } = useStatusPage();
  if (loading) return <div className="flex justify-center py-10"><Spinner className="text-robin-orange" /></div>;
  return <p className={`py-10 text-center text-sm ${palette.muted}`}>{error || 'Not available'}</p>;
}

export function IncidentHistory() {
  const { palette, timeZone } = useStatusPage();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? undefined;
  const { data, error, loading } = useLoad<PublicIncidentArchive>(() => statusPageApi.incidentArchive(month), [month]);
  return (
    <>
      <PageHeading
        title="Previous incidents"
        range={data ? `${formatShortMonth(data.from)} to ${formatShortMonth(data.to)}` : undefined}
        hasOlder={data?.hasOlder}
        hasNewer={data?.hasNewer}
        onOlder={() => data && setParams({ month: shiftMonth(data.from, -1) })}
        onNewer={() => data && setParams({ month: shiftMonth(data.to, 3) })}
      />
      {!data ? <Loading error={error} loading={loading} /> : data.months.map((entry) => {
        const days = new Map<string, PublicStatusPageReport[]>();
        for (const report of entry.reports) {
          const key = dayKey(report.openedAt, timeZone);
          days.set(key, [...(days.get(key) ?? []), report]);
        }
        return (
          <Card key={entry.month} title={formatMonth(entry.month)}>
            {entry.reports.length === 0 ? <p className={`px-4 py-6 text-center text-sm ${palette.muted}`}>No incidents reported</p> : (
              <div className={palette.divider}>
                {[...days.values()].map((reports) => (
                  <div key={reports[0].id}>
                    <div className={`flex justify-between px-4 pt-3 text-xs font-medium ${palette.muted}`}>
                      <span>{formatDay(reports[0].openedAt, timeZone)}</span>
                      <span>{reports.length} incident{reports.length === 1 ? '' : 's'}</span>
                    </div>
                    {reports.map((report) => <IncidentSummary key={report.id} report={report} />)}
                  </div>
                ))}
              </div>
            )}
          </Card>
        );
      })}
    </>
  );
}

export function IncidentDetail() {
  const { palette, timeZone, basePath } = useStatusPage();
  const { id } = useParams();
  const { data: report, error, loading } = useLoad<PublicStatusPageReport>(() => statusPageApi.incident(Number(id)), [id]);
  const timeline = useMemo(() => (report ? [...report.updates].reverse() : []), [report]);
  return (
    <>
      <Link to={statusPath(basePath, '/incidents')} className={`inline-flex items-center gap-1 text-sm ${palette.muted} hover:underline`}><ArrowLeft aria-hidden="true" className="h-4 w-4" />All incidents</Link>
      {!report ? <Loading error={error} loading={loading} /> : (
        <>
          <section className={`rounded-lg border p-5 ${palette.card}`}>
            <ReportPill report={report} />
            <h1 className="mt-3 text-xl font-semibold">{report.title}</h1>
            <p className={`mt-1 text-sm ${palette.muted}`}>
              Started {formatDateTime(report.openedAt, timeZone)} · {report.resolvedAt ? `lasted ${formatDuration(report.openedAt, report.resolvedAt)}` : `ongoing for ${formatDuration(report.openedAt, null)}`}
            </p>
            {report.components.length > 0 && (
              <div className="mt-4">
                <h2 className={`text-sm font-medium ${palette.muted}`}>Affected services</h2>
                <ul className="mt-2 flex flex-wrap gap-2">{report.components.map((component) => <li key={component.id} className={`rounded-md border px-2 py-1 text-sm ${palette.inset}`}>{component.publicName}</li>)}</ul>
              </div>
            )}
          </section>
          <Card title="Updates">
            <ol className={palette.divider}>
              {timeline.map((update) => (
                <li key={update.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-baseline gap-2">
                    <span className="font-medium">{UPDATE_LABEL[update.status]}</span>
                    <span className={`text-xs ${palette.muted}`}>{formatDateTime(update.createdAt, timeZone)}</span>
                  </div>
                  <p className={`mt-1 text-sm ${palette.subtleText}`}>{update.message}</p>
                </li>
              ))}
              {timeline.length === 0 && <li className={`px-4 py-6 text-center text-sm ${palette.muted}`}>No updates posted.</li>}
            </ol>
          </Card>
        </>
      )}
    </>
  );
}

export function MaintenanceSchedule() {
  const { palette, timeZone } = useStatusPage();
  const [params, setParams] = useSearchParams();
  const month = params.get('month') ?? undefined;
  const { data, error, loading } = useLoad<PublicMaintenanceSchedule>(() => statusPageApi.maintenanceSchedule(month), [month]);
  return (
    <>
      <PageHeading
        title="Maintenance"
        range={data ? `${formatShortMonth(data.from)} to ${formatShortMonth(data.to)}` : undefined}
        hasOlder={data?.hasOlder}
        hasNewer={data?.hasNewer}
        onOlder={() => data && setParams({ month: shiftMonth(data.from, -3) })}
        onNewer={() => data && setParams({ month: shiftMonth(data.to, 1) })}
      />
      {!data ? <Loading error={error} loading={loading} /> : data.months.map((entry) => (
        <Card key={entry.month} title={formatMonth(entry.month)}>
          {entry.maintenances.length === 0 ? <p className={`px-4 py-6 text-center text-sm ${palette.muted}`}>No maintenance scheduled</p> : (
            <div className={palette.divider}>
              {entry.maintenances.map((maintenance) => (
                <article key={maintenance.id} className="px-4 py-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="font-medium">{maintenance.title}</div>
                      <div className={`mt-1 text-sm ${palette.muted}`}>{formatDateTime(maintenance.startsAt, timeZone)} - {formatDateTime(maintenance.endsAt, timeZone)}</div>
                    </div>
                    <StatusPill status={maintenance.status === 'completed' ? 'operational' : 'maintenance'} label={MAINTENANCE_LABEL[maintenance.status]} />
                  </div>
                  <p className={`mt-2 text-sm ${palette.subtleText}`}>{maintenance.message}</p>
                  {maintenance.components.length > 0 && <p className={`mt-1 text-xs ${palette.muted}`}>Affects {maintenance.components.map((component) => component.publicName).join(', ')}</p>}
                </article>
              ))}
            </div>
          )}
        </Card>
      ))}
    </>
  );
}
