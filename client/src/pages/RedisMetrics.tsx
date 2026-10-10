import { useCallback, useEffect, useMemo, useState } from 'react';
import { Activity, BarChart3, Clock, Database, FileText, RefreshCw, Server, Users, Zap } from 'lucide-react';
import { ApiError, redisApi } from '../api/client';
import { LineChart, downsampleData, formatChartLabels } from '../components/charts';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { Button } from '../components/ui/Button';
import { MetricCard } from '../components/ui/MetricCard';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import { useServices } from '../context/ServiceContext';
import { useConfirm } from '../context/ConfirmContext';
import { formatBytes, formatMetricNumber, formatMetricPercent } from '../utils/format';
import type { RedisClientEntry, RedisMetricsSnapshot, RedisMetricsStats, RedisSlowlogEntry } from '../types';
import { useCapableTabs } from '../hooks/useCapableTabs';
import { useServiceCapabilities } from '../context/FeaturesContext';

type TabType = 'overview' | 'slowlog' | 'clients' | 'raw';
type WindowType = '1h' | '6h' | '24h' | '7d';

const TABS: readonly MetricTab<TabType>[] = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'slowlog', label: 'Slowlog', icon: Clock },
  { id: 'clients', label: 'Clients', icon: Users },
  { id: 'raw', label: 'Raw', icon: FileText },
];

// Tabs the selected service's setup must support.
const TAB_NEEDS: Partial<Record<TabType, string>> = { slowlog: 'admin', clients: 'admin', raw: 'raw' };

const WINDOW_HOURS: Record<WindowType, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
};

export function RedisMetricsPage() {
  const confirm = useConfirm();
  const { selectedRedisService } = useServices();
  const [tab, setTab] = useState<TabType>('overview');
  const tabs = useCapableTabs(TABS, TAB_NEEDS, selectedRedisService?.serviceId, tab, setTab);
  // Operations run against the service directly, with robin-admin's admin connection.
  const canAdmin = useServiceCapabilities(selectedRedisService?.serviceId).can('admin');
  const [window, setWindow] = useState<WindowType>('24h');
  const [stats, setStats] = useState<RedisMetricsStats | null>(null);
  const [history, setHistory] = useState<RedisMetricsSnapshot[]>([]);
  const [rawText, setRawText] = useState('');
  const [slowlog, setSlowlog] = useState<RedisSlowlogEntry[]>([]);
  const [clients, setClients] = useState<RedisClientEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Keyed by `${op}:${target}` so only the button whose op is running shows the
  // spinner; other op buttons are disabled (one op at a time) but not spinning.
  const [runningOp, setRunningOp] = useState<string | null>(null);

  const serviceId = selectedRedisService?.serviceId;

  const load = useCallback(async (showRefreshing = false) => {
    if (!serviceId) {
      setStats(null);
      setHistory([]);
      setRawText('');
      setSlowlog([]);
      setClients([]);
      setIsLoading(false);
      return;
    }

    if (showRefreshing) {
      setIsRefreshing(true);
    }

    try {
      setError('');
      if (tab === 'raw') {
        setRawText(await redisApi.getMetricsRaw(serviceId));
      } else if (tab === 'slowlog') {
        const response = await redisApi.getSlowlog(serviceId);
        setSlowlog(response.data ?? []);
      } else if (tab === 'clients') {
        const response = await redisApi.getClients(serviceId);
        setClients(response.data ?? []);
      } else {
        const [statsResponse, historyResponse] = await Promise.all([
          redisApi.getMetricsStats(serviceId),
          redisApi.getMetricsHistory(serviceId, WINDOW_HOURS[window]),
        ]);
        setStats(statsResponse.data ?? null);
        setHistory(historyResponse.data ?? []);
      }
    } catch {
      setError('Failed to load Redis metrics');
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
    { label: 'Ops/sec', data: chartData.map((point) => point.instantaneousOpsPerSec), color: '#3b82f6', fill: true },
    { label: 'Connected clients', data: chartData.map((point) => point.connectedClients), color: '#22c55e', fill: false },
    { label: 'Memory used (MB)', data: chartData.map((point) => Math.round(point.memoryUsedBytes / 1048576)), color: '#f97316', fill: false },
  ], [chartData]);

  const handleResetSlowlog = async () => {
    if (!serviceId || !(await confirm('Reset the Redis slowlog? This clears all recorded slow-query entries.'))) {
      return;
    }
    setRunningOp('slowlog-reset');
    setError('');
    setSuccess('');
    try {
      await redisApi.resetSlowlog(serviceId);
      setSuccess('Slowlog reset');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset slowlog');
    } finally {
      setRunningOp(null);
    }
  };

  const handleKillClient = async (clientId: number) => {
    if (!serviceId || !(await confirm(`Kill Redis client ${clientId}? This immediately disconnects it.`))) {
      return;
    }
    setRunningOp(`kill:${clientId}`);
    setError('');
    setSuccess('');
    try {
      await redisApi.killClient(serviceId, clientId);
      setSuccess(`Client ${clientId} killed`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to kill client');
    } finally {
      setRunningOp(null);
    }
  };

  const handleBgsave = async () => {
    if (!serviceId || !(await confirm('Trigger BGSAVE? This starts a background RDB snapshot.'))) {
      return;
    }
    setRunningOp('bgsave');
    setError('');
    setSuccess('');
    try {
      const response = await redisApi.bgsave(serviceId);
      setSuccess(response.data?.response ?? 'BGSAVE started');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start BGSAVE');
    } finally {
      setRunningOp(null);
    }
  };

  const handleBgrewriteaof = async () => {
    if (!serviceId || !(await confirm('Trigger BGREWRITEAOF? This starts a background AOF rewrite.'))) {
      return;
    }
    setRunningOp('bgrewriteaof');
    setError('');
    setSuccess('');
    try {
      const response = await redisApi.bgrewriteaof(serviceId);
      setSuccess(response.data?.response ?? 'BGREWRITEAOF started');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to start BGREWRITEAOF');
    } finally {
      setRunningOp(null);
    }
  };

  const handleResetStats = async () => {
    if (!serviceId || !(await confirm('Reset Redis stats (CONFIG RESETSTAT)? This clears cumulative counters.'))) {
      return;
    }
    setRunningOp('resetstat');
    setError('');
    setSuccess('');
    try {
      await redisApi.resetStats(serviceId);
      setSuccess('Stats reset');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to reset stats');
    } finally {
      setRunningOp(null);
    }
  };

  if (!serviceId) {
    return (
      <div className="space-y-6">
        <PageHeader
          icon={appIcons.redisMetrics}
          title="Redis metrics"
          description="Select an enabled Redis service from Fleet before opening the metrics workspace."
          actions={<PageServiceSelector serviceType="redis" capability="metrics" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Redis service is currently selected.
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
        icon={appIcons.redisMetrics}
        title="Redis metrics"
        description={<>Live client, memory, and throughput activity for <strong>{selectedRedisService?.name ?? serviceId}</strong>.</>}
        actions={(
          <>
            <PageServiceSelector serviceType="redis" capability="metrics" />
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
      {success && <div className="rounded-sm border border-green-200 bg-green-50 p-3 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400">{success}</div>}

      {tab === 'raw' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Raw INFO output</h2>
          <pre className="mt-4 overflow-x-auto rounded-sm bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{rawText || '# No stats returned'}</pre>
        </div>
      ) : tab === 'slowlog' ? (
        <div className="card p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Slowlog</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Commands that exceeded the slowlog-log-slower-than threshold.</p>
            </div>
            <Button variant="danger" onClick={() => void handleResetSlowlog()} isLoading={runningOp === 'slowlog-reset'} disabled={!!runningOp && runningOp !== 'slowlog-reset'}>
              Reset slowlog
            </Button>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[600px] text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">ID</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Client</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Duration</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Command</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {slowlog.map((entry) => (
                  <tr key={entry.id}>
                    <td className="px-3 py-2">{entry.id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.clientName || entry.clientAddress}</td>
                    <td className="px-3 py-2">{formatMetricNumber(entry.durationMicros / 1000)} ms</td>
                    <td className="px-3 py-2 font-mono text-xs">{entry.command.join(' ')}</td>
                  </tr>
                ))}
                {slowlog.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No slowlog entries</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === 'clients' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Connected clients</h2>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">ID</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Address</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Name</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">User</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Age</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Command</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {clients.map((client) => (
                  <tr key={client.id}>
                    <td className="px-3 py-2">{client.id}</td>
                    <td className="px-3 py-2 font-mono text-xs">{client.addr}</td>
                    <td className="px-3 py-2">{client.name || '—'}</td>
                    <td className="px-3 py-2">{client.user || '—'}</td>
                    <td className="px-3 py-2">{client.ageSecs}s</td>
                    <td className="px-3 py-2 font-mono text-xs">{client.cmd}</td>
                    <td className="px-3 py-2 text-right">
                      <Button size="sm" variant="danger" onClick={() => void handleKillClient(client.id)} isLoading={runningOp === `kill:${client.id}`} disabled={!!runningOp && runningOp !== `kill:${client.id}`}>
                        Kill
                      </Button>
                    </td>
                  </tr>
                ))}
                {clients.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No connected clients</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <MetricCard icon={<Server className="h-5 w-5" />} label="Daemon" value={stats?.live?.reachable ? 'Healthy' : 'Unavailable'} />
            <MetricCard icon={<Users className="h-5 w-5" />} label="Connected clients" value={String(stats?.live?.connectedClients ?? 0)} />
            <MetricCard icon={<Database className="h-5 w-5" />} label="Memory used" value={formatBytes(stats?.live?.memoryUsedBytes)} />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Ops/sec" value={formatMetricNumber(stats?.live?.instantaneousOpsPerSec)} />
            <MetricCard icon={<Zap className="h-5 w-5" />} label="Hit ratio" value={formatMetricPercent(stats?.live?.hitRatio)} />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Ops processed (24h)" value={String(stats?.totals24h.opsProcessed ?? 0)} />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Evicted keys (24h)" value={String(stats?.totals24h.evictedKeys ?? 0)} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
            <div className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Runtime trend</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Ops/sec, connected clients, and memory use over time for the selected Redis service.
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
                  No Redis history is available for this window.
                </div>
              )}
            </div>

            <div className="card p-4">
              <h2 className="text-lg font-semibold">Live runtime</h2>
              <div className="mt-4 space-y-2">
                <StatRow label="Reachability" value={stats?.live?.reachable ? 'Healthy' : 'Unavailable'} />
                <StatRow label="Role" value={stats?.live?.role ?? '—'} />
                <StatRow label="Connected clients" value={String(stats?.live?.connectedClients ?? 0)} />
                <StatRow label="Blocked clients" value={String(stats?.live?.blockedClients ?? 0)} />
                <StatRow label="Memory used" value={formatBytes(stats?.live?.memoryUsedBytes)} />
                <StatRow label="Memory peak" value={formatBytes(stats?.live?.memoryPeakBytes)} />
                <StatRow label="Keys / expires" value={`${stats?.live?.dbKeys ?? 0} / ${stats?.live?.dbExpires ?? 0}`} />
                <StatRow label="Connected replicas" value={String(stats?.live?.connectedSlaves ?? 0)} />
              </div>
            </div>
          </div>

          {canAdmin && (
            <div className="card p-6">
              <h2 className="text-lg font-semibold">Operations</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                These trigger the Redis commands directly against this service. Each requires confirmation.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => void handleBgsave()} isLoading={runningOp === 'bgsave'} disabled={!!runningOp && runningOp !== 'bgsave'}>
                  BGSAVE
                </Button>
                <Button variant="secondary" onClick={() => void handleBgrewriteaof()} isLoading={runningOp === 'bgrewriteaof'} disabled={!!runningOp && runningOp !== 'bgrewriteaof'}>
                  BGREWRITEAOF
                </Button>
                <Button variant="danger" onClick={() => void handleResetStats()} isLoading={runningOp === 'resetstat'} disabled={!!runningOp && runningOp !== 'resetstat'}>
                  CONFIG RESETSTAT
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-3">
            <StatPanel
              title="Memory"
              items={[
                ['Memory used', formatBytes(stats?.live?.memoryUsedBytes)],
                ['Memory peak', formatBytes(stats?.live?.memoryPeakBytes)],
                ['Evicted keys (live)', stats?.live?.evictedKeys ?? 0],
                ['Evicted keys (24h)', stats?.totals24h.evictedKeys ?? 0],
                ['Peak memory used (24h)', formatBytes(stats?.totals24h.peakMemoryUsedBytes)],
              ]}
            />
            <StatPanel
              title="Clients"
              items={[
                ['Connected clients (live)', stats?.live?.connectedClients ?? 0],
                ['Blocked clients', stats?.live?.blockedClients ?? 0],
                ['Peak connected clients (24h)', stats?.totals24h.peakConnectedClients ?? 0],
                ['Unreachable samples (24h)', stats?.totals24h.unreachableSamples ?? 0],
              ]}
            />
            <StatPanel
              title="Keyspace"
              items={[
                ['Keys', stats?.live?.dbKeys ?? 0],
                ['Expires', stats?.live?.dbExpires ?? 0],
                ['Hit ratio', formatMetricPercent(stats?.live?.hitRatio)],
                ['Ops processed (24h)', stats?.totals24h.opsProcessed ?? 0],
                ['Expired keys (24h)', stats?.totals24h.expiredKeys ?? 0],
                ['Samples tracked', stats?.historyCount ?? 0],
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
