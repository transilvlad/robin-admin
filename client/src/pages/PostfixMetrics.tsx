import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Clock, FileText, Inbox, Layers, RefreshCw, Server } from 'lucide-react';
import { postfixApi } from '../api/client';
import { LineChart, downsampleData, formatChartLabels } from '../components/charts';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';
import { counterDeltas } from '../utils/metricTrends';
import type { PostfixMetricsSnapshot, PostfixMetricsStats } from '../types';
import { useServiceCapabilities } from '../context/FeaturesContext';
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

function formatAgeSecs(seconds: number | null | undefined): string {
  const value = seconds ?? 0;
  if (value <= 0) {
    return '0s';
  }
  if (value < 60) {
    return `${Math.round(value)}s`;
  }
  if (value < 3600) {
    return `${Math.round(value / 60)}m`;
  }
  if (value < 86400) {
    return `${Math.round(value / 3600)}h`;
  }
  return `${Math.round(value / 86400)}d`;
}

export function PostfixMetricsPage() {
  const { selectedPostfixService } = useServices();
  const [tab, setTab] = useState<TabType>('overview');
  const tabs = useCapableTabs(TABS, TAB_NEEDS, selectedPostfixService?.serviceId, tab, setTab);
  const [window, setWindow] = useState<WindowType>('24h');
  const [stats, setStats] = useState<PostfixMetricsStats | null>(null);
  const [history, setHistory] = useState<PostfixMetricsSnapshot[]>([]);
  const [rawText, setRawText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');

  const serviceId = selectedPostfixService?.serviceId;
  // Message counters come from an agent streaming the log; deferral ages from
  // the agent's `postqueue -j` (a postfix_exporter reports depth only).
  const { can } = useServiceCapabilities(serviceId);
  const messageCounters = can('messageCounters');
  const deferredAge = can('deferredAge');

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
        setRawText(await postfixApi.getMetricsRaw(serviceId));
      } else {
        const [statsResponse, historyResponse] = await Promise.all([
          postfixApi.getMetricsStats(serviceId),
          postfixApi.getMetricsHistory(serviceId, WINDOW_HOURS[window]),
        ]);
        setStats(statsResponse.data ?? null);
        setHistory(historyResponse.data ?? []);
      }
    } catch {
      setError('Failed to load Postfix metrics');
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
    { label: 'Queue total', data: chartData.map((point) => point.queueTotal), color: '#3b82f6', fill: true },
    { label: 'Deferred', data: chartData.map((point) => point.queueDeferred), color: '#f97316', fill: false },
  ], [chartData]);
  // Counters are cumulative; chart the per-sample increase.
  const flowData = useMemo(() => {
    const delivered = counterDeltas(history, (point) => point.messagesDelivered);
    const deferred = counterDeltas(history, (point) => point.messagesDeferred);
    const bounced = counterDeltas(history, (point) => point.messagesBounced);
    const rejected = counterDeltas(history, (point) => point.messagesRejected);
    return downsampleData(
      history.slice(1).map((point, index) => ({
        timestamp: point.timestamp,
        delivered: delivered[index] ?? 0,
        deferred: deferred[index] ?? 0,
        bounced: bounced[index] ?? 0,
        rejected: rejected[index] ?? 0,
      })),
      200,
    );
  }, [history]);
  const flowLabels = useMemo(() => formatChartLabels(flowData.map((point) => point.timestamp), window), [flowData, window]);
  const flowSeries = useMemo(() => [
    { label: 'Delivered', data: flowData.map((point) => point.delivered), color: '#22c55e', fill: true },
    { label: 'Deferred', data: flowData.map((point) => point.deferred), color: '#f97316', fill: false },
    { label: 'Bounced', data: flowData.map((point) => point.bounced), color: '#a855f7', fill: false },
    { label: 'Rejected', data: flowData.map((point) => point.rejected), color: '#ef4444', fill: false },
  ], [flowData]);

  if (!serviceId) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.postfixMetrics}
          title="Postfix metrics"
          description="Select an enabled Postfix service from Fleet before opening the metrics workspace."
          actions={<PageServiceSelector serviceType="postfix" capability="metrics" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Postfix service is currently selected.
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
        icon={appIcons.postfixMetrics}
        title="Postfix metrics"
        description={<>Live queue depth, deferral pressure, and delivery activity for <strong>{selectedPostfixService?.name ?? serviceId}</strong>.</>}
        actions={(
          <>
            <PageServiceSelector serviceType="postfix" capability="metrics" />
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
          <h2 className="text-lg font-semibold">Raw queue output</h2>
          <pre className="mt-4 overflow-x-auto rounded-sm bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{rawText || '# No stats returned'}</pre>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <MetricCard icon={<Server className="h-5 w-5" />} label="Daemon" value={stats?.live?.reachable ? 'Healthy' : 'Unavailable'} />
            <MetricCard icon={<Layers className="h-5 w-5" />} label="Queue total" value={String(stats?.live?.queueTotal ?? 0)} />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Active" value={String(stats?.live?.queueActive ?? 0)} />
            <MetricCard icon={<Inbox className="h-5 w-5" />} label="Deferred" value={String(stats?.live?.queueDeferred ?? 0)} />
            <MetricCard icon={<Inbox className="h-5 w-5" />} label="Hold" value={String(stats?.live?.queueHold ?? 0)} />
            {deferredAge && <MetricCard icon={<Clock className="h-5 w-5" />} label="Oldest deferred" value={formatAgeSecs(stats?.live?.oldestDeferredAgeSecs)} />}
          </div>

          {messageCounters && (
            <div className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Message flow</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Delivery outcomes per recipient and rejected connections, read from the Postfix log.
                  </p>
                </div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{window} window</span>
              </div>
              <div className="mt-4 grid grid-cols-2 gap-3 md:grid-cols-4">
                <StatRow label="Delivered (24h)" value={String(stats?.totals24h.delivered ?? 0)} />
                <StatRow label="Deferred (24h)" value={String(stats?.totals24h.deferred ?? 0)} />
                <StatRow label="Bounced (24h)" value={String(stats?.totals24h.bounced ?? 0)} />
                <StatRow label="Rejected (24h)" value={String(stats?.totals24h.rejected ?? 0)} />
              </div>
              {flowData.length > 0 && (
                <div className="mt-4">
                  <LineChart labels={flowLabels} series={flowSeries} height={220} />
                </div>
              )}
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
            <div className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Runtime trend</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Queue total and deferred depth over time for the selected Postfix service.
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
                  No Postfix history is available for this window.
                </div>
              )}
            </div>

            <div className="card p-4">
              <h2 className="text-lg font-semibold">Live runtime</h2>
              <div className="mt-4 space-y-2">
                <StatRow label="Reachability" value={stats?.live?.reachable ? 'Healthy' : 'Unavailable'} />
                <StatRow label="Queue total" value={String(stats?.live?.queueTotal ?? 0)} />
                <StatRow label="Active" value={String(stats?.live?.queueActive ?? 0)} />
                <StatRow label="Deferred" value={String(stats?.live?.queueDeferred ?? 0)} />
                <StatRow label="Hold" value={String(stats?.live?.queueHold ?? 0)} />
                <StatRow label="Incoming" value={String(stats?.live?.queueIncoming ?? 0)} />
                {deferredAge && <StatRow label="Oldest deferred age" value={formatAgeSecs(stats?.live?.oldestDeferredAgeSecs)} />}
              </div>
            </div>
          </div>

          <div className="grid gap-4 xl:grid-cols-3">
            <StatPanel
              title="Queue depth"
              items={[
                ['Daemon reachability', stats?.live?.reachable ? 'Healthy' : 'Unavailable'],
                ['Queue total (live)', stats?.live?.queueTotal ?? 0],
                ['Active (live)', stats?.live?.queueActive ?? 0],
                ['Deferred (live)', stats?.live?.queueDeferred ?? 0],
                ['Hold (live)', stats?.live?.queueHold ?? 0],
                ['Incoming (live)', stats?.live?.queueIncoming ?? 0],
              ]}
            />
            <StatPanel
              title="24h peaks"
              items={[
                ['Peak queue (24h)', stats?.totals24h.peakQueue ?? 0],
                ['Peak deferred (24h)', stats?.totals24h.peakDeferred ?? 0],
                ...(deferredAge ? [['Max deferred age (24h)', formatAgeSecs(stats?.totals24h.maxDeferredAgeSecs)]] as Array<[string, string]> : []),
                ['Unreachable samples (24h)', stats?.totals24h.unreachableSamples ?? 0],
                ['Samples tracked', stats?.historyCount ?? 0],
              ]}
            />
            <StatPanel
              title="Deferral"
              items={[
                ...(deferredAge ? [['Oldest deferred age (live)', formatAgeSecs(stats?.live?.oldestDeferredAgeSecs)]] as Array<[string, string]> : []),
                ['Deferred (live)', stats?.live?.queueDeferred ?? 0],
                ['Peak deferred (24h)', stats?.totals24h.peakDeferred ?? 0],
                ...(deferredAge ? [['Max deferred age (24h)', formatAgeSecs(stats?.totals24h.maxDeferredAgeSecs)]] as Array<[string, string]> : []),
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
