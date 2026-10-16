import { useEffect, useRef, useState } from 'react';
import { Link, Navigate, Route, Routes, useLocation, useSearchParams } from 'react-router-dom';
import { Activity, Bell, Copy } from 'lucide-react';
import { ApiError, emailApi, statusPageApi, statusPageFeedUrl } from '../api/client';
import { Spinner } from '../components/ui/Spinner';
import {
  IncidentDetail,
  IncidentHistory,
  MaintenanceSchedule,
  StatusOverview,
  StatusPageContext,
  statusPath,
} from '../components/status-page/StatusPageViews';
import { pagePalette, type StatusPalette } from '../components/status-page/statusPageTheme';
import type { PublicStatusPage } from '../types/status-page';

/**
 * The public status page. In the app it lives under /status; on its own domain
 * (outside the app's base path) it is the whole site, so basePath is "".
 */
export function StatusPagePublic({ basePath = '/status' }: { basePath?: string }) {
  const [page, setPage] = useState<PublicStatusPage | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [prefersDark, setPrefersDark] = useState(false);
  const [params] = useSearchParams();
  const [notice, setNotice] = useState('');

  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)');
    const update = () => setPrefersDark(query.matches);
    update();
    query.addEventListener('change', update);
    return () => query.removeEventListener('change', update);
  }, []);

  useEffect(() => {
    const confirm = params.get('confirm');
    const unsubscribe = params.get('unsubscribe');
    if (!confirm && !unsubscribe) return;
    const action = confirm
      ? emailApi.confirmStatusSubscription(confirm)
      : emailApi.unsubscribeStatusSubscription(unsubscribe!);
    action
      .then(() => setNotice(confirm ? 'Subscription confirmed.' : 'Subscription removed.'))
      .catch(() => setNotice('The subscription link is invalid or expired.'));
  }, [params]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await statusPageApi.publicPage();
        if (!cancelled) setPage(response.data ?? null);
      } catch (err) {
        if (!cancelled) setError(err instanceof ApiError ? err.message : 'Failed to load status page');
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void load();
    const timer = window.setInterval(load, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, []);

  // The tab shows the company, not the app: this page is the whole site on its own domain.
  const companyName = page?.settings.companyName;
  const logoUrl = page?.settings.logoUrl;
  useEffect(() => {
    if (companyName) document.title = `${companyName} status`;
    if (logoUrl) {
      const icon = document.querySelector<HTMLLinkElement>('link[rel~="icon"]') ?? document.head.appendChild(document.createElement('link'));
      icon.rel = 'icon';
      icon.href = logoUrl;
    }
  }, [companyName, logoUrl]);

  if (loading) return <div className="flex min-h-screen items-center justify-center bg-gray-50"><Spinner className="text-robin-orange" /></div>;
  if (error || !page) return <div className="flex min-h-screen items-center justify-center bg-gray-50 px-6 text-center text-sm text-red-700">{error || 'Status page unavailable'}</div>;

  const isDark = page.settings.theme === 'dark' || (page.settings.theme === 'system' && prefersDark);
  const palette = pagePalette(isDark);
  const timeZone = page.settings.timezone || 'UTC';
  const home = statusPath(basePath);

  return (
    <StatusPageContext.Provider value={{ page, isDark, palette, timeZone, basePath }}>
      <main className={`min-h-screen ${palette.page}`}>
        <header className={`border-b ${palette.header}`}>
          <div className="mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-4 px-5 py-4">
            <a href={page.settings.companyUrl ?? home} className="flex items-center gap-3">
              {page.settings.logoUrl ? <img src={page.settings.logoUrl} alt="" className="h-9 w-9 rounded-lg object-contain" /> : <span className="rounded-lg bg-robin-orange/10 p-2 text-robin-orange"><Activity className="h-5 w-5" /></span>}
              <span className="text-lg font-semibold">{page.settings.companyName}</span>
            </a>
            <nav aria-label="Status page" className="flex flex-wrap items-center gap-1 text-sm">
              <NavTab to={home} label="Status" end palette={palette} />
              {page.settings.maintenancePageEnabled && <NavTab to={statusPath(basePath, '/maintenance')} label="Maintenance" palette={palette} />}
              {page.settings.incidentHistoryEnabled && <NavTab to={statusPath(basePath, '/incidents')} label="Previous incidents" palette={palette} />}
              <GetUpdates page={page} palette={palette} onNotice={setNotice} />
            </nav>
          </div>
        </header>

        <div className="mx-auto max-w-4xl space-y-6 px-5 py-8">
          <Routes>
            <Route index element={<StatusOverview notice={notice} />} />
            {page.settings.maintenancePageEnabled && <Route path="maintenance" element={<MaintenanceSchedule />} />}
            {page.settings.incidentHistoryEnabled && <Route path="incidents" element={<IncidentHistory />} />}
            {page.settings.incidentHistoryEnabled && <Route path="incidents/:id" element={<IncidentDetail />} />}
            <Route path="*" element={<Navigate to={home} replace />} />
          </Routes>
        </div>
      </main>
    </StatusPageContext.Provider>
  );
}

function NavTab({ to, label, end = false, palette }: { to: string; label: string; end?: boolean; palette: StatusPalette }) {
  const { pathname } = useLocation();
  const normalized = pathname.replace(/\/+$/, '') || '/';
  const target = to.replace(/\/+$/, '') || '/';
  const active = end ? normalized === target : normalized === target || normalized.startsWith(`${target}/`);
  return <Link to={to} aria-current={active ? 'page' : undefined} className={`rounded-md px-3 py-1.5 font-medium ${active ? palette.tabActive : palette.tabIdle}`}>{label}</Link>;
}

type UpdateChannel = 'email' | 'rss' | 'json';

/** Ways to follow the page: email when subscriptions are on, and the RSS and JSON feeds when feeds are on. */
function GetUpdates({ page, palette, onNotice }: { page: PublicStatusPage; palette: StatusPalette; onNotice: (message: string) => void }) {
  const channels: UpdateChannel[] = [
    ...(page.settings.subscribable ? ['email' as const] : []),
    ...(page.settings.feedsEnabled ? ['rss' as const, 'json' as const] : []),
  ];
  const [open, setOpen] = useState(false);
  const [channel, setChannel] = useState<UpdateChannel>(channels[0] ?? 'email');
  const panel = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent | KeyboardEvent) => {
      if (event instanceof KeyboardEvent ? event.key === 'Escape' : !panel.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  if (channels.length === 0) return null;
  const label: Record<UpdateChannel, string> = { email: 'Email', rss: 'RSS', json: 'JSON' };
  return (
    <div ref={panel} className="relative">
      <button type="button" aria-expanded={open} onClick={() => setOpen((value) => !value)} className={`ml-1 inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 font-medium ${palette.button}`}>
        <Bell aria-hidden="true" className="h-4 w-4" />Get updates
      </button>
      {open && (
        <div className={`absolute right-0 z-20 mt-2 w-[min(22rem,calc(100vw-2.5rem))] rounded-lg border p-4 shadow-lg ${palette.card}`}>
          <div role="tablist" className="flex gap-1">
            {channels.map((entry) => (
              <button key={entry} type="button" role="tab" aria-selected={channel === entry} onClick={() => setChannel(entry)} className={`rounded-md px-2.5 py-1 text-xs font-medium ${channel === entry ? palette.tabActive : palette.tabIdle}`}>{label[entry]}</button>
            ))}
          </div>
          <div className="mt-3">
            {channel === 'email' ? <EmailSubscription page={page} palette={palette} onDone={(message) => { onNotice(message); setOpen(false); }} /> : <FeedLink kind={channel} palette={palette} />}
          </div>
        </div>
      )}
    </div>
  );
}

function EmailSubscription({ page, palette, onDone }: { page: PublicStatusPage; palette: StatusPalette; onDone: (message: string) => void }) {
  const [email, setEmail] = useState('');
  const [all, setAll] = useState(true);
  const [selected, setSelected] = useState<number[]>([]);
  const [error, setError] = useState('');
  const components = page.sections.flatMap((section) => section.components);
  return (
    <form className="space-y-3 text-sm" onSubmit={(event) => {
      event.preventDefault();
      setError('');
      emailApi.subscribeToStatusPage({ email, allComponents: all, componentIds: selected })
        .then(() => onDone('Check your email to confirm the subscription.'))
        .catch((err) => setError(err instanceof ApiError ? err.message : 'Subscription failed.'));
    }}>
      <p className={palette.muted}>Get an email whenever an incident is created, updated or resolved.</p>
      <input className="input w-full" type="email" required placeholder="you@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
      <label className="flex items-center gap-2"><input type="checkbox" className="h-4 w-4 accent-robin-orange" checked={!all} onChange={(event) => setAll(!event.target.checked)} />Only specific services</label>
      {!all && (
        <div className="max-h-40 space-y-1 overflow-auto">
          {components.map((component) => (
            <label key={component.id} className="flex items-center gap-2">
              <input type="checkbox" className="h-4 w-4 accent-robin-orange" checked={selected.includes(component.id)} onChange={() => setSelected((current) => current.includes(component.id) ? current.filter((id) => id !== component.id) : [...current, component.id])} />
              {component.publicName}
            </label>
          ))}
        </div>
      )}
      {error && <p role="alert" className="text-red-600">{error}</p>}
      <button className="btn btn-primary w-full" type="submit">Subscribe</button>
    </form>
  );
}

function FeedLink({ kind, palette }: { kind: 'rss' | 'json'; palette: StatusPalette }) {
  const url = statusPageFeedUrl(kind);
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-3 text-sm">
      <p className={palette.muted}>{kind === 'rss' ? 'Follow incidents in any RSS reader.' : 'Read incidents as a JSON Feed from your own tools.'}</p>
      <div className="flex gap-2">
        <input readOnly className="input min-w-0 flex-1 text-xs" value={url} onFocus={(event) => event.currentTarget.select()} aria-label={`${kind.toUpperCase()} feed URL`} />
        <button type="button" className={`inline-flex items-center gap-1 rounded-md border px-2 ${palette.button}`} onClick={() => {
          void navigator.clipboard?.writeText(url).then(() => setCopied(true));
        }}><Copy aria-hidden="true" className="h-4 w-4" />{copied ? 'Copied' : 'Copy'}</button>
      </div>
      <a className="text-xs underline-offset-2 hover:underline" href={url} target="_blank" rel="noreferrer">Open the feed</a>
    </div>
  );
}
