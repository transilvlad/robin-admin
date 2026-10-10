import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Database, FileText, HardDrive, RefreshCw, Server } from 'lucide-react';
import { clamavApi } from '../api/client';
import { LineChart, downsampleData, formatChartLabels } from '../components/charts';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';
import { formatMetricNumber } from '../utils/format';
import type { ClamavMetricsSnapshot, ClamavMetricsStats } from '../types';
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

export function ClamavMetricsPage() {
  const { selectedClamavService } = useServices();
  const [tab, setTab] = useState<TabType>('overview');
  const tabs = useCapableTabs(TABS, TAB_NEEDS, selectedClamavService?.serviceId, tab, setTab);
  const [window, setWindow] = useState<WindowType>('24h');
  const [stats, setStats] = useState<ClamavMetricsStats | null>(null);
  const [history, setHistory] = useState<ClamavMetricsSnapshot[]>([]);
  const [rawText, setRawText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');

  const serviceId = selectedClamavService?.serviceId;

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
      if (tab === 'raw') {
        setRawText(await clamavApi.getMetricsRaw(serviceId));
      } else {
        const [statsResponse, historyResponse] = await Promise.all([
          clamavApi.getMetricsStats(serviceId),
          clamavApi.getMetricsHistory(serviceId, WINDOW_HOURS[window]),
        ]);
        setStats(statsResponse.data ?? null);
        setHistory(historyResponse.data ?? []);
      }
    } catch {
      setError('Failed to load ClamAV metrics');
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

  const chartData = useMemo(() => downsampleData(history, 200), [history]);
  const chartLabels = useMemo(() => formatChartLabels(chartData.map((point) => point.timestamp), window), [chartData, window]);
  const chartSeries = useMemo(() => [
    { label: 'Queue', data: chartData.map((point) => point.queueItems), color: '#3b82f6', fill: true },
    { label: 'Used memory (MB)', data: chartData.map((point) => point.memoryUsedMB), color: '#f97316', fill: false },
    { label: 'Live threads', data: chartData.map((point) => point.threadsLive), color: '#22c55e', fill: false },
  ], [chartData]);

  if (!serviceId) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.clamavMetrics}
          title="ClamAV Metrics"
          description="Select an enabled ClamAV service from Fleet before opening the metrics workspace."
          actions={<PageServiceSelector serviceType="clamav" capability="metrics" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled ClamAV service is currently selected.
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
        icon={appIcons.clamavMetrics}
        title="ClamAV Metrics"
        description={<>Live daemon health, queue pressure, and historical ClamD runtime data for <strong>{selectedClamavService?.name ?? serviceId}</strong>.</>}
        actions={(
          <>
            <PageServiceSelector serviceType="clamav" capability="metrics" />
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

      {tab === 'raw' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Raw STATS output</h2>
          <pre className="mt-4 overflow-x-auto rounded-sm bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{rawText || '# No stats returned'}</pre>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <MetricCard icon={<Server className="h-5 w-5" />} label="Daemon" value={stats?.live?.pingOk ? 'Healthy' : 'Unavailable'} />
            <MetricCard icon={<Database className="h-5 w-5" />} label="Signature DB" value={stats?.live?.databaseVersion ? `#${stats.live.databaseVersion}` : '—'} />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Current queue" value={String(stats?.live?.queueItems ?? 0)} />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Peak queue (24h)" value={String(stats?.totals24h.peakQueue ?? 0)} />
            <MetricCard icon={<Server className="h-5 w-5" />} label="Live threads" value={String(stats?.live?.threadsLive ?? 0)} />
            <MetricCard icon={<HardDrive className="h-5 w-5" />} label="Used memory" value={`${formatMetricNumber(stats?.live?.memoryUsedMB)} MB`} />
            <MetricCard icon={<HardDrive className="h-5 w-5" />} label="Peak memory (24h)" value={`${formatMetricNumber(stats?.totals24h.peakMemoryMB)} MB`} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
            <div className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Runtime trend</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Queue depth, memory, and live threads over time for the selected ClamAV service.
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
                  No ClamAV history is available for this window.
                </div>
              )}
            </div>

            <div className="card p-4">
              <h2 className="text-lg font-semibold">Live runtime</h2>
              <div className="mt-4 space-y-2">
                <StatRow label="Engine version" value={stats?.live?.engineVersion ?? '—'} />
                <StatRow label="State" value={stats?.live?.statusText ?? '—'} />
                <StatRow label="Pools" value={String(stats?.live?.pools ?? 0)} />
                <StatRow label="Queue items" value={String(stats?.live?.queueItems ?? 0)} />
                <StatRow label="Threads live / idle / max" value={`${stats?.live?.threadsLive ?? 0} / ${stats?.live?.threadsIdle ?? 0} / ${stats?.live?.threadsMax ?? 0}`} />
                <StatRow label="Used memory" value={`${formatMetricNumber(stats?.live?.memoryUsedMB)} MB`} />
                <StatRow label="Heap / mmap" value={`${formatMetricNumber(stats?.live?.memoryHeapMB)} MB / ${formatMetricNumber(stats?.live?.memoryMmapMB)} MB`} />
                <StatRow label="Unhealthy samples (24h)" value={String(stats?.totals24h.unhealthySamples ?? 0)} />
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <StatPanel
              title="Signature health"
              items={[
                ['Daemon reachability', stats?.live?.pingOk ? 'Healthy' : 'Unavailable'],
                ['Engine version', stats?.live?.engineVersion ?? '—'],
                ['Database version', stats?.live?.databaseVersion ? `#${stats.live.databaseVersion}` : '—'],
                ['Database updated', formatTimestamp(stats?.live?.databaseUpdatedAt)],
                ['Daemon state', stats?.live?.statusText ?? '—'],
                ['Samples tracked', stats?.historyCount ?? 0],
              ]}
            />
            <StatPanel
              title="Queue and threads"
              items={[
                ['Pools', stats?.live?.pools ?? 0],
                ['Current queue', stats?.live?.queueItems ?? 0],
                ['Queue delta (24h)', stats?.totals24h.queueDelta ?? 0],
                ['Peak queue (24h)', stats?.totals24h.peakQueue ?? 0],
                ['Threads live / idle', `${stats?.live?.threadsLive ?? 0} / ${stats?.live?.threadsIdle ?? 0}`],
                ['Threads max', stats?.live?.threadsMax ?? 0],
              ]}
            />
            <StatPanel
              title="Memory breakdown"
              items={[
                ['Used', `${formatMetricNumber(stats?.live?.memoryUsedMB)} MB`],
                ['Heap', `${formatMetricNumber(stats?.live?.memoryHeapMB)} MB`],
                ['mmap', `${formatMetricNumber(stats?.live?.memoryMmapMB)} MB`],
                ['Free', `${formatMetricNumber(stats?.live?.memoryFreeMB)} MB`],
                ['Releasable', `${formatMetricNumber(stats?.live?.memoryReleasableMB)} MB`],
                ['Pools used / total', `${formatMetricNumber(stats?.live?.memoryPoolsUsedMB)} MB / ${formatMetricNumber(stats?.live?.memoryPoolsTotalMB)} MB`],
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

function formatTimestamp(value: string | null | undefined) {
  if (!value) {
    return '—';
  }
  return new Date(value).toLocaleString();
}
