import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, FileText, Inbox, MonitorSmartphone, PieChart, RefreshCw, Server, Users } from 'lucide-react';
import { cyrusApi } from '../api/client';
import { LineChart, downsampleData, formatChartLabels } from '../components/charts';
import { CyrusQuotaPanel, CyrusSessionsPanel } from '../components/fleet/CyrusPanels';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';
import { counterDeltas } from '../utils/metricTrends';
import { useServiceCapabilities } from '../context/FeaturesContext';
import { useCapableTabs } from '../hooks/useCapableTabs';
import type { CyrusMetricsSnapshot, CyrusMetricsStats } from '../types';

type TabType = 'overview' | 'sessions' | 'quota' | 'raw';
type WindowType = '1h' | '6h' | '24h' | '7d';

const TABS: readonly MetricTab<TabType>[] = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'sessions', label: 'Sessions', icon: MonitorSmartphone },
  { id: 'quota', label: 'Quota', icon: PieChart },
  { id: 'raw', label: 'Raw', icon: FileText },
];

const TAB_NEEDS: Partial<Record<TabType, string>> = { sessions: 'sessions', quota: 'quota', raw: 'raw' };

const WINDOW_HOURS: Record<WindowType, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
};

export function CyrusMetricsPage() {
  const { selectedCyrusService } = useServices();
  const [tab, setTab] = useState<TabType>('overview');
  const [window, setWindow] = useState<WindowType>('24h');
  const [stats, setStats] = useState<CyrusMetricsStats | null>(null);
  const [history, setHistory] = useState<CyrusMetricsSnapshot[]>([]);
  const [rawText, setRawText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');

  const serviceId = selectedCyrusService?.serviceId;
  const { can } = useServiceCapabilities(serviceId);
  const tabs = useCapableTabs(TABS, TAB_NEEDS, serviceId, tab, setTab);
  const sessionCounts = can('sessions');

  const load = useCallback(async (showRefreshing = false) => {
    if (!serviceId) {
      setStats(null);
      setHistory([]);
      setRawText('');
      setIsLoading(false);
      return;
    }

    if (showRefreshing) {
      setIsRefreshing(true);
    }

    try {
      setError('');
      if (tab === 'sessions' || tab === 'quota') {
        return;
      } else if (tab === 'raw') {
        setRawText(await cyrusApi.getMetricsRaw(serviceId));
      } else {
        const [statsResponse, historyResponse] = await Promise.all([
          cyrusApi.getMetricsStats(serviceId),
          cyrusApi.getMetricsHistory(serviceId, WINDOW_HOURS[window]),
        ]);
        setStats(statsResponse.data ?? null);
        setHistory(historyResponse.data ?? []);
      }
    } catch {
      setError('Failed to load Cyrus metrics');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [serviceId, tab, window]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (tab !== 'overview') {
      return undefined;
    }
    const interval = setInterval(() => {
      void load(true);
    }, 60000);
    return () => clearInterval(interval);
  }, [load, tab]);

  const chartData = useMemo(() => {
    const samples = history.slice(1);
    const imapCommands = counterDeltas(history, (point) => point.imapCommands);
    const logins = counterDeltas(history, (point) => point.loginCount);
    return downsampleData(
      samples.map((point, index) => ({
        ...point,
        imapCommands: imapCommands[index] ?? 0,
        loginCount: logins[index] ?? 0,
      })),
      200,
    );
  }, [history]);
  const chartLabels = useMemo(() => formatChartLabels(chartData.map((point) => point.timestamp), window), [chartData, window]);
  const chartSeries = useMemo(() => [
    ...(sessionCounts ? [{ label: 'Sessions', data: chartData.map((point) => point.sessionCount), color: '#3b82f6', fill: true }] : []),
    { label: 'IMAP commands', data: chartData.map((point) => point.imapCommands), color: '#f97316', fill: false },
    { label: 'Logins', data: chartData.map((point) => point.loginCount), color: '#22c55e', fill: false },
  ], [chartData, sessionCounts]);

  if (!serviceId) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.cyrusMetrics}
          title="Cyrus metrics"
          description="Select an enabled Cyrus service from Fleet before opening the metrics workspace."
          actions={<PageServiceSelector serviceType="cyrus" capability="metrics" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Cyrus service is currently selected.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex justify-center py-8"><Spinner className="text-robin-orange" /></div>;
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.cyrusMetrics}
        title="Cyrus metrics"
        description={<>Live authentication, session, and IMAP activity for <strong>{selectedCyrusService?.name ?? serviceId}</strong>.</>}
        actions={(
          <>
            <PageServiceSelector serviceType="cyrus" capability="metrics" />
            <div className="flex rounded-lg border border-gray-200 p-1 dark:border-robin-gray-700">
              {(['1h', '6h', '24h', '7d'] as WindowType[]).map((value) => (
                <button
                  key={value}
                  onClick={() => setWindow(value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${window === value ? 'bg-robin-orange text-white' : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-robin-gray-800'}`}
                >
                  {value}
                </button>
              ))}
            </div>
            <Button variant="secondary" onClick={() => void load(true)}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </>
        )}
      />

      <MetricTabs tabs={tabs} activeTab={tab} onChange={setTab} />

      {error && <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{error}</div>}

      {tab === 'sessions' ? (
        <CyrusSessionsPanel serviceId={serviceId} />
      ) : tab === 'quota' ? (
        <CyrusQuotaPanel serviceId={serviceId} canLookup={can('user')} />
      ) : tab === 'raw' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Raw stats output</h2>
          <pre className="mt-4 overflow-x-auto rounded-sm bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{rawText || '# No stats returned'}</pre>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <MetricCard icon={<Server className="h-5 w-5" />} label="Daemon" value={stats?.live?.reachable ? 'Healthy' : 'Unavailable'} />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Active connections" value={String(stats?.live?.activeConnections ?? 0)} />
            <MetricCard icon={<Users className="h-5 w-5" />} label="Users" value={String(stats?.live?.userCount ?? 0)} />
            <MetricCard icon={<Inbox className="h-5 w-5" />} label="IMAP logins OK (24h)" value={String(stats?.totals24h.logins ?? 0)} />
            <MetricCard icon={<Inbox className="h-5 w-5" />} label="IMAP commands (24h)" value={String(stats?.totals24h.imapCommands ?? 0)} />
            <MetricCard icon={<Inbox className="h-5 w-5" />} label="LMTP deliveries (24h)" value={String(stats?.totals24h.mailDeliveries ?? 0)} />
            {sessionCounts && <MetricCard icon={<Activity className="h-5 w-5" />} label="Peak sessions (24h)" value={String(stats?.totals24h.peakSessions ?? 0)} />}
            <MetricCard icon={<Inbox className="h-5 w-5" />} label="IMAP logins failed (24h)" value={String(stats?.totals24h.authFailure ?? 0)} />
            <MetricCard icon={<Inbox className="h-5 w-5" />} label="Mailboxes" value={String(stats?.live?.mailboxCount ?? 0)} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
            <div className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Runtime trend</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Sessions, IMAP commands, and logins over time for the selected Cyrus service.
                  </p>
                </div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{window} window</span>
              </div>
              {chartData.length > 0 ? (
                <div className="mt-4">
                  <LineChart labels={chartLabels} series={chartSeries} height={260} />
                </div>
              ) : (
                <div className="mt-4 rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                  No Cyrus history is available for this window.
                </div>
              )}
            </div>

            <div className="card p-4">
              <h2 className="text-lg font-semibold">Live runtime</h2>
              <div className="mt-4 space-y-2">
                <StatRow label="Reachability" value={stats?.live?.reachable ? 'Healthy' : 'Unavailable'} />
                {sessionCounts && <StatRow label="Active sessions" value={String(stats?.live?.sessionCount ?? 0)} />}
                {sessionCounts && <StatRow label="Users" value={String(stats?.live?.userCount ?? 0)} />}
                <StatRow label="Logins" value={String(stats?.live?.loginCount ?? 0)} />
                <StatRow label="IMAP commands" value={String(stats?.live?.imapCommands ?? 0)} />
                <StatRow label="Mail deliveries" value={String(stats?.live?.mailDeliveries ?? 0)} />
                <StatRow label="Auth success / failure" value={`${stats?.live?.authSuccess ?? 0} / ${stats?.live?.authFailure ?? 0}`} />
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <StatPanel
              title="Authentication"
              items={[
                ['Daemon reachability', stats?.live?.reachable ? 'Healthy' : 'Unavailable'],
                ['Auth success (live)', stats?.live?.authSuccess ?? 0],
                ['Auth failure (live)', stats?.live?.authFailure ?? 0],
                ['Auth success (24h)', stats?.totals24h.authSuccess ?? 0],
                ['Auth failure (24h)', stats?.totals24h.authFailure ?? 0],
                ['Samples tracked', stats?.historyCount ?? 0],
              ]}
            />
            <StatPanel
              title={sessionCounts ? 'Sessions and logins' : 'Logins'}
              items={[
                ...(sessionCounts ? [['Active sessions', stats?.live?.sessionCount ?? 0], ['Users', stats?.live?.userCount ?? 0]] as Array<[string, number]> : []),
                ['Logins (live)', stats?.live?.loginCount ?? 0],
                ['Logins (24h)', stats?.totals24h.logins ?? 0],
                ...(sessionCounts ? [['Peak sessions (24h)', stats?.totals24h.peakSessions ?? 0]] as Array<[string, number]> : []),
                ['Unreachable samples (24h)', stats?.totals24h.unreachableSamples ?? 0],
              ]}
            />
            <StatPanel
              title="Mail activity"
              items={[
                ['IMAP commands (live)', stats?.live?.imapCommands ?? 0],
                ['IMAP commands (24h)', stats?.totals24h.imapCommands ?? 0],
                ['Mail deliveries (live)', stats?.live?.mailDeliveries ?? 0],
                ['Mail deliveries (24h)', stats?.totals24h.mailDeliveries ?? 0],
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}

function StatRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-robin-gray-800">
      <span>{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

function StatPanel({ title, items }: { title: string; items: Array<[string, string | number]> }) {
  return (
    <div className="card p-4">
      <h2 className="text-lg font-semibold">{title}</h2>
      <div className="mt-4 space-y-2">
        {items.map(([label, value]) => (
          <div key={label} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-robin-gray-800">
            <span>{label}</span>
            <span className="font-medium">{value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
