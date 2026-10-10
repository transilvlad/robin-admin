import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, FileText, RefreshCw, Server, ShieldAlert, TrendingUp } from 'lucide-react';
import { metricsApi } from '../api/client';
import { LineChart, downsampleData, formatChartLabels } from '../components/charts';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';
import { formatMetricNumber, formatMetricPercent } from '../utils/format';
import { counterDeltas } from '../utils/metricTrends';
import type { RspamdMetricsSnapshot, RspamdMetricsStats } from '../types';
import { useCapableTabs } from '../hooks/useCapableTabs';

type TabType = 'overview' | 'raw';
type WindowType = '1h' | '6h' | '24h' | '7d';

const TABS: readonly MetricTab<TabType>[] = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'raw', label: 'Raw', icon: FileText },
];

// Tabs the selected service's setup must support.
const TAB_NEEDS: Partial<Record<TabType, string>> = { raw: 'raw' };

const WINDOW_HOURS: Record<WindowType, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
};

const STORAGE_KEYS = {
  tab: 'rspamd-metrics-tab',
  window: 'rspamd-metrics-window',
};

function loadState<T>(key: string, fallback: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) as T : fallback;
  } catch {
    return fallback;
  }
}

function saveState<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Ignore storage failures.
  }
}

export function RspamdMetricsPage() {
  const { selectedRspamdService } = useServices();
  const [tab, setTab] = useState<TabType>(() => loadState(STORAGE_KEYS.tab, 'overview'));
  const tabs = useCapableTabs(TABS, TAB_NEEDS, selectedRspamdService?.serviceId, tab, setTab);
  const [window, setWindow] = useState<WindowType>(() => loadState(STORAGE_KEYS.window, '24h'));
  const [stats, setStats] = useState<RspamdMetricsStats | null>(null);
  const [history, setHistory] = useState<RspamdMetricsSnapshot[]>([]);
  const [rawText, setRawText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');

  const serviceId = selectedRspamdService?.serviceId;

  useEffect(() => { saveState(STORAGE_KEYS.tab, tab); }, [tab]);
  useEffect(() => { saveState(STORAGE_KEYS.window, window); }, [window]);

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
      const scope = { serviceType: 'rspamd' as const, serviceId };
      if (tab === 'raw') {
        const text = await metricsApi.getRaw(scope);
        setRawText(text);
      } else {
        const [statsResponse, historyResponse] = await Promise.all([
          metricsApi.getStats<RspamdMetricsStats>(scope),
          metricsApi.getHistory<RspamdMetricsSnapshot[]>(WINDOW_HOURS[window], scope),
        ]);
        setStats(statsResponse.data ?? null);
        setHistory(historyResponse.data ?? []);
      }
    } catch {
      setError('Failed to load Rspamd metrics');
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
    const scanned = counterDeltas(history, (point) => point.scannedMessages);
    const spam = counterDeltas(history, (point) => point.spamMessages);
    const ham = counterDeltas(history, (point) => point.hamMessages);
    return downsampleData(
      samples.map((point, index) => ({
        ...point,
        scannedMessages: scanned[index] ?? 0,
        spamMessages: spam[index] ?? 0,
        hamMessages: ham[index] ?? 0,
      })),
      200,
    );
  }, [history]);
  const chartLabels = useMemo(
    () => formatChartLabels(chartData.map((point) => point.timestamp), window),
    [chartData, window],
  );
  const chartSeries = useMemo(() => [
    { label: 'Scanned', data: chartData.map((point) => point.scannedMessages), color: '#3b82f6', fill: true },
    { label: 'Spam', data: chartData.map((point) => point.spamMessages), color: '#ef4444', fill: false },
    { label: 'Ham', data: chartData.map((point) => point.hamMessages), color: '#22c55e', fill: false },
  ], [chartData]);

  if (!serviceId) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.rspamdMetrics}
          title="Rspamd metrics"
          description="Select an enabled Rspamd service from Fleet before opening the metrics workspace."
          actions={<PageServiceSelector serviceType="rspamd" capability="metrics" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Rspamd service is currently selected.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.rspamdMetrics}
        title="Rspamd metrics"
        description={<>Scan volume, action mix, and controller health for <strong>{selectedRspamdService?.name ?? serviceId}</strong>.</>}
        actions={(
          <>
            <PageServiceSelector serviceType="rspamd" capability="metrics" />
            <div className="flex rounded-lg border border-gray-200 p-1 dark:border-robin-gray-700">
              {(['1h', '6h', '24h', '7d'] as WindowType[]).map((value) => (
                <button
                  key={value}
                  onClick={() => setWindow(value)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium transition-colors ${
                    window === value
                      ? 'bg-robin-orange text-white'
                      : 'text-gray-600 hover:bg-gray-100 dark:text-gray-300 dark:hover:bg-robin-gray-800'
                  }`}
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

      {error && (
        <div className="rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
          {error}
        </div>
      )}

      {tab === 'raw' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Raw metrics output</h2>
          <pre className="mt-4 overflow-x-auto rounded-sm bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{rawText || '# No metrics returned'}</pre>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <MetricCard icon={<Server className="h-5 w-5" />} label="Controller reachable" value={stats?.live?.controllerReachable ? 'Yes' : 'No'} />
            <MetricCard icon={<Server className="h-5 w-5" />} label="Normal worker" value={stats?.live?.normalWorkerPingOk ? 'Healthy' : 'Unavailable'} />
            <MetricCard icon={<ShieldAlert className="h-5 w-5" />} label="Spam (24h)" value={(stats?.totals24h.spam ?? 0).toLocaleString()} />
            <MetricCard icon={<TrendingUp className="h-5 w-5" />} label="Ham (24h)" value={(stats?.totals24h.ham ?? 0).toLocaleString()} />
            <MetricCard icon={<TrendingUp className="h-5 w-5" />} label="Scanned (24h)" value={(stats?.totals24h.scanned ?? 0).toLocaleString()} />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Actions (24h)" value={(stats?.totals24h.totalActions ?? 0).toLocaleString()} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
            <div className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Scanning trend</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    History combines scan volume with spam and ham outcomes for the selected service.
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
                  No Rspamd history is available for this window.
                </div>
              )}
            </div>

            <div className="card p-4">
              <h2 className="text-lg font-semibold">Action mix (24h)</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Controller actions accumulated from the historical counters.
              </p>
              <div className="mt-4 space-y-2">
                {Object.entries(stats?.totals24h.actions ?? {}).map(([key, value]) => (
                  <div key={key} className="flex items-center justify-between rounded-lg bg-gray-50 px-3 py-2 text-sm dark:bg-robin-gray-800">
                    <span>{formatActionLabel(key)}</span>
                    <span className="font-medium">{value.toLocaleString()}</span>
                  </div>
                ))}
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <StatPanel
              title="Live runtime"
              items={[
                ['Controller auth', stats?.live?.controllerAuthenticated ? 'Authorized' : 'Unavailable'],
                ['Normal worker', stats?.live?.normalWorkerPingOk ? 'Reachable' : 'Unavailable'],
                ['Connections', stats?.live?.connections ?? 0],
                ['Resident memory', `${formatMetricNumber(stats?.live?.memoryResidentMB)} MB`],
                ['Allocated memory', `${formatMetricNumber(stats?.live?.memoryAllocatedMB)} MB`],
                ['Uptime', formatDuration(stats?.live?.uptimeSeconds ?? 0)],
                ['Samples tracked', stats?.historyCount ?? 0],
              ]}
            />
            <StatPanel
              title="Message totals"
              items={[
                ['Total scanned', stats?.live?.scannedMessages ?? 0],
                ['Total spam', stats?.live?.spamMessages ?? 0],
                ['Total ham', stats?.live?.hamMessages ?? 0],
                ['Learned spam', stats?.live?.learnedSpam ?? 0],
                ['Learned ham', stats?.live?.learnedHam ?? 0],
                ['Spam share (24h)', formatPercent((stats?.totals24h.spam ?? 0), (stats?.totals24h.scanned ?? 0))],
              ]}
            />
            <StatPanel
              title="Decision totals (24h)"
              items={[
                ['Add header', stats?.totals24h.actions.addHeader ?? 0],
                ['Reject', stats?.totals24h.actions.reject ?? 0],
                ['Soft reject', stats?.totals24h.actions.softReject ?? 0],
                ['Greylist', stats?.totals24h.actions.greylist ?? 0],
                ['No action', stats?.totals24h.actions.noAction ?? 0],
                ['Rewrite subject', stats?.totals24h.actions.rewriteSubject ?? 0],
                ['Discard', stats?.totals24h.actions.discard ?? 0],
                ['Quarantine', stats?.totals24h.actions.quarantine ?? 0],
              ]}
            />
          </div>
        </>
      )}
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

function formatActionLabel(key: string) {
  return key
    .replace(/([A-Z])/g, ' $1')
    .replace(/^./, (value) => value.toUpperCase());
}

function formatDuration(seconds: number) {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  return `${hours}h ${minutes}m`;
}

function formatPercent(value: number, total: number) {
  if (total <= 0) {
    return '0%';
  }
  return formatMetricPercent((value / total) * 100);
}
