import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Activity,
  BarChart3,
  CheckCircle2,
  Cylinder,
  FileText,
  Gauge,
  HardDrive,
  Lock,
  RefreshCw,
  Server,
  Table2,
  TrendingUp,
} from 'lucide-react';
import { ApiError, postgresApi } from '../api/client';
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
import { useAuth } from '../context/AuthContext';
import { formatBytes, formatMetricNumber, formatMetricPercent, formatMetricRatio } from '../utils/format';
import type {
  PostgresActivityRow,
  PostgresLockRow,
  PostgresMetricsSnapshot,
  PostgresMetricsStats,
  PostgresStatStatementRow,
  PostgresTableSizeRow,
} from '../types';
import { useCapableTabs } from '../hooks/useCapableTabs';
import { useServiceCapabilities } from '../context/FeaturesContext';

type TabType = 'overview' | 'activity' | 'locks' | 'tables' | 'statements' | 'raw';
type WindowType = '1h' | '6h' | '24h' | '7d';

const WINDOW_HOURS: Record<WindowType, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
};

const TABS: readonly MetricTab<TabType>[] = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'locks', label: 'Locks', icon: Lock },
  { id: 'tables', label: 'Tables', icon: Table2 },
  { id: 'statements', label: 'Statements', icon: TrendingUp },
  { id: 'raw', label: 'Raw', icon: FileText },
];

// Tabs the selected service's setup must support.
const TAB_NEEDS: Partial<Record<TabType, string>> = { activity: 'admin', locks: 'admin', tables: 'admin', statements: 'admin', raw: 'raw' };

export function PostgresMetricsPage() {
  const confirm = useConfirm();
  const { selectedPostgresService } = useServices();
  const [tab, setTab] = useState<TabType>('overview');
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const permittedTabs = useMemo(() => TABS.filter((entry) => isAdmin || TAB_NEEDS[entry.id] !== 'admin'), [isAdmin]);
  const tabs = useCapableTabs(permittedTabs, TAB_NEEDS, selectedPostgresService?.serviceId, tab, setTab);
  // Operations run against the service directly, with robin-admin's admin connection.
  const canAdmin = useServiceCapabilities(selectedPostgresService?.serviceId).can('admin') && isAdmin;
  const [window, setWindow] = useState<WindowType>('24h');
  const [stats, setStats] = useState<PostgresMetricsStats | null>(null);
  const [history, setHistory] = useState<PostgresMetricsSnapshot[]>([]);
  const [rawText, setRawText] = useState('');
  const [activity, setActivity] = useState<PostgresActivityRow[]>([]);
  const [locks, setLocks] = useState<PostgresLockRow[]>([]);
  const [tables, setTables] = useState<PostgresTableSizeRow[]>([]);
  const [statements, setStatements] = useState<PostgresStatStatementRow[]>([]);
  const [statementsAvailable, setStatementsAvailable] = useState(true);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // Keyed by `${op}:${target}` so only the button whose op is running shows the
  // spinner; other op buttons are disabled (one op at a time) but not spinning.
  const [runningOp, setRunningOp] = useState<string | null>(null);

  const serviceId = selectedPostgresService?.serviceId;

  const load = useCallback(async (showRefreshing = false) => {
    if (!serviceId) {
      setStats(null);
      setHistory([]);
      setRawText('');
      setActivity([]);
      setLocks([]);
      setTables([]);
      setStatements([]);
      setIsLoading(false);
      return;
    }

    if (showRefreshing) {
      setIsRefreshing(true);
    }

    try {
      setError('');
      if (tab === 'raw') {
        setRawText(await postgresApi.getMetricsRaw(serviceId));
      } else if (tab === 'activity') {
        const response = await postgresApi.getActivity(serviceId);
        setActivity(response.data ?? []);
      } else if (tab === 'locks') {
        const response = await postgresApi.getLocks(serviceId);
        setLocks(response.data ?? []);
      } else if (tab === 'tables') {
        const response = await postgresApi.getTableSizes(serviceId);
        setTables(response.data ?? []);
      } else if (tab === 'statements') {
        const response = await postgresApi.getStatStatements(serviceId);
        setStatements(response.data?.rows ?? []);
        setStatementsAvailable(response.data?.available ?? true);
      } else {
        const [statsResponse, historyResponse] = await Promise.all([
          postgresApi.getMetricsStats(serviceId),
          postgresApi.getMetricsHistory(serviceId, WINDOW_HOURS[window]),
        ]);
        setStats(statsResponse.data ?? null);
        setHistory(historyResponse.data ?? []);
      }
    } catch {
      setError('Failed to load Postgres metrics');
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
  const chartSeries = useMemo(() => {
    // xactCommit/xactRollback are cumulative counters; chart per-interval deltas
    // (as the fleet view does) so they read as a rate alongside the connections
    // gauge instead of an ever-rising line that flattens everything else.
    const deltas = (pick: (point: (typeof chartData)[number]) => number) =>
      chartData.map((point, i) => (i === 0 ? 0 : Math.max(0, pick(point) - pick(chartData[i - 1]))));
    return [
      { label: 'Active connections', data: chartData.map((point) => point.connectionsActive), color: '#3b82f6', fill: true },
      { label: 'Commits/interval', data: deltas((point) => point.xactCommit), color: '#22c55e', fill: false },
      { label: 'Rollbacks/interval', data: deltas((point) => point.xactRollback), color: '#ef4444', fill: false },
    ];
  }, [chartData]);

  const handleCancel = async (pid: number) => {
    if (!serviceId || !(await confirm(`Cancel backend PID ${pid}? This sends pg_cancel_backend and may interrupt an in-flight query.`))) {
      return;
    }
    setRunningOp(`cancel:${pid}`);
    setError('');
    setSuccess('');
    try {
      const response = await postgresApi.cancelBackend(serviceId, pid);
      setSuccess(response.data?.cancelled ? `Cancel signal sent to PID ${pid}` : `PID ${pid} was not cancelled (it may have already completed)`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to cancel backend');
    } finally {
      setRunningOp(null);
    }
  };

  const handleTerminate = async (pid: number) => {
    if (!serviceId || !(await confirm(`Terminate backend PID ${pid}? This sends pg_terminate_backend and immediately drops the connection.`))) {
      return;
    }
    setRunningOp(`terminate:${pid}`);
    setError('');
    setSuccess('');
    try {
      const response = await postgresApi.terminateBackend(serviceId, pid);
      setSuccess(response.data?.terminated ? `PID ${pid} terminated` : `PID ${pid} was not terminated (it may have already completed)`);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to terminate backend');
    } finally {
      setRunningOp(null);
    }
  };

  const handleVacuum = async (table?: string, analyze?: boolean) => {
    const label = table ? `table ${table}` : 'the whole database';
    if (!serviceId || !(await confirm(`Run VACUUM${analyze ? ' ANALYZE' : ''} on ${label}? This may take time and hold locks briefly.`))) {
      return;
    }
    setRunningOp(`vacuum:${table ?? 'db'}`);
    setError('');
    setSuccess('');
    try {
      const response = await postgresApi.vacuum(serviceId, table, analyze);
      setSuccess(response.data?.response ?? 'VACUUM requested');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to run VACUUM');
    } finally {
      setRunningOp(null);
    }
  };

  const handleAnalyze = async (table?: string) => {
    const label = table ? `table ${table}` : 'the whole database';
    if (!serviceId || !(await confirm(`Run ANALYZE on ${label}? This refreshes planner statistics.`))) {
      return;
    }
    setRunningOp(`analyze:${table ?? 'db'}`);
    setError('');
    setSuccess('');
    try {
      const response = await postgresApi.analyze(serviceId, table);
      setSuccess(response.data?.response ?? 'ANALYZE requested');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to run ANALYZE');
    } finally {
      setRunningOp(null);
    }
  };

  const handleResetStats = async () => {
    if (!serviceId || !(await confirm('Reset Postgres statistics (pg_stat_reset)? This clears cumulative counters.'))) {
      return;
    }
    setRunningOp('reset');
    setError('');
    setSuccess('');
    try {
      await postgresApi.resetStats(serviceId);
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
          icon={appIcons.postgresMetrics}
          title="Postgres metrics"
          description="Select an enabled Postgres service from Fleet before opening the metrics workspace."
          actions={<PageServiceSelector serviceType="postgres" capability="metrics" />}
        />
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled Postgres service is currently selected.
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
        icon={appIcons.postgresMetrics}
        title="Postgres metrics"
        description={<>Live connection, transaction, and query activity for <strong>{selectedPostgresService?.name ?? serviceId}</strong>.</>}
        actions={(
          <>
            <PageServiceSelector serviceType="postgres" capability="metrics" />
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
          <h2 className="text-lg font-semibold">Raw stats output</h2>
          <pre className="mt-4 overflow-x-auto rounded-sm bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{rawText || '# No stats returned'}</pre>
        </div>
      ) : tab === 'activity' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Active queries</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Backends from pg_stat_activity. Cancel interrupts the query; terminate drops the connection.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">PID</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">User</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">State</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Age</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Query</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {activity.map((row) => (
                  <tr key={row.pid}>
                    <td className="px-3 py-2">{row.pid}</td>
                    <td className="px-3 py-2">{row.usename ?? '—'}</td>
                    <td className="px-3 py-2">{row.state ?? '—'}</td>
                    <td className="px-3 py-2">{row.ageSecs}s</td>
                    <td className="px-3 py-2 max-w-md truncate font-mono text-xs" title={row.query ?? ''}>{row.query ?? '—'}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => void handleCancel(row.pid)} isLoading={runningOp === `cancel:${row.pid}`} disabled={!!runningOp && runningOp !== `cancel:${row.pid}`}>
                          Cancel
                        </Button>
                        <Button size="sm" variant="danger" onClick={() => void handleTerminate(row.pid)} isLoading={runningOp === `terminate:${row.pid}`} disabled={!!runningOp && runningOp !== `terminate:${row.pid}`}>
                          Terminate
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {activity.length === 0 && (
                  <tr>
                    <td colSpan={6} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No active backends</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === 'locks' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Locks</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Current lock grants and waiters, including blocking PIDs.</p>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">PID</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Relation</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Mode</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Granted</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Blocked by</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {locks.map((row, index) => (
                  <tr key={`${row.pid}-${index}`}>
                    <td className="px-3 py-2">{row.pid}</td>
                    <td className="px-3 py-2">{row.relation ?? '—'}</td>
                    <td className="px-3 py-2">{row.mode ?? '—'}</td>
                    <td className="px-3 py-2">{row.granted ? 'Yes' : 'No'}</td>
                    <td className="px-3 py-2">{row.blockedByPids.length > 0 ? row.blockedByPids.join(', ') : '—'}</td>
                  </tr>
                ))}
                {locks.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No locks reported</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === 'tables' ? (
        <div className="card p-4">
          <div className="flex items-center justify-between gap-4">
            <div>
              <h2 className="text-lg font-semibold">Table sizes</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Largest tables by total on-disk size (table + indexes).</p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => void handleAnalyze()} isLoading={runningOp === 'analyze:db'} disabled={!!runningOp && runningOp !== 'analyze:db'}>
                ANALYZE database
              </Button>
              <Button variant="secondary" onClick={() => void handleVacuum(undefined, true)} isLoading={runningOp === 'vacuum:db'} disabled={!!runningOp && runningOp !== 'vacuum:db'}>
                VACUUM ANALYZE database
              </Button>
            </div>
          </div>
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[700px] text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Schema</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Table</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Total size</th>
                  <th className="px-3 py-2 text-right text-xs font-medium text-gray-500 dark:text-gray-400">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {tables.map((row) => (
                  <tr key={`${row.schema}.${row.table}`}>
                    <td className="px-3 py-2">{row.schema}</td>
                    <td className="px-3 py-2 font-mono text-xs">{row.table}</td>
                    <td className="px-3 py-2">{formatBytes(row.totalBytes)}</td>
                    <td className="px-3 py-2 text-right">
                      <div className="flex justify-end gap-2">
                        <Button size="sm" variant="secondary" onClick={() => void handleAnalyze(`${row.schema}.${row.table}`)} isLoading={runningOp === `analyze:${row.schema}.${row.table}`} disabled={!!runningOp && runningOp !== `analyze:${row.schema}.${row.table}`}>
                          Analyze
                        </Button>
                        <Button size="sm" variant="secondary" onClick={() => void handleVacuum(`${row.schema}.${row.table}`, true)} isLoading={runningOp === `vacuum:${row.schema}.${row.table}`} disabled={!!runningOp && runningOp !== `vacuum:${row.schema}.${row.table}`}>
                          Vacuum
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
                {tables.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">No tables reported</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : tab === 'statements' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Top statements</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
            Requires the pg_stat_statements extension. If it is not installed on this server, this table will be empty.
          </p>
          {!statementsAvailable && (
            <div className="mt-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              The pg_stat_statements extension is not installed on this server.
            </div>
          )}
          <div className="mt-4 overflow-x-auto">
            <table className="w-full min-w-[900px] text-sm">
              <thead className="bg-gray-50 dark:bg-gray-800">
                <tr>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Query</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Calls</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Total time</th>
                  <th className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">Mean time</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
                {statements.map((row, index) => (
                  <tr key={index}>
                    <td className="px-3 py-2 max-w-lg truncate font-mono text-xs" title={row.query}>{row.query}</td>
                    <td className="px-3 py-2">{row.calls}</td>
                    <td className="px-3 py-2">{formatMetricNumber(row.totalExecMs)} ms</td>
                    <td className="px-3 py-2">{formatMetricNumber(row.meanExecMs)} ms</td>
                  </tr>
                ))}
                {statements.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">
                      No statement statistics available (pg_stat_statements may not be installed)
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <MetricCard
              icon={<Server className="h-5 w-5" />}
              label="Daemon"
              value={stats?.live?.reachable ? 'Healthy' : 'Unavailable'}
              tone={stats?.live?.reachable ? 'success' : 'danger'}
            />
            <MetricCard icon={<Activity className="h-5 w-5" />} label="Active connections" value={String(stats?.live?.connectionsActive ?? 0)} />
            <MetricCard icon={<Cylinder className="h-5 w-5" />} label="Total connections" value={`${stats?.live?.connectionsTotal ?? 0} / ${stats?.live?.maxConnections ?? 0}`} />
            <MetricCard icon={<HardDrive className="h-5 w-5" />} label="Database size" value={formatBytes(stats?.live?.databaseSizeBytes)} />
            <MetricCard icon={<Gauge className="h-5 w-5" />} label="Cache hit ratio" value={formatMetricRatio(stats?.live?.cacheHitRatio)} />
            <MetricCard icon={<CheckCircle2 className="h-5 w-5" />} label="Commits (24h)" value={String(stats?.totals24h.xactCommit ?? 0)} />
            <MetricCard
              icon={<Lock className="h-5 w-5" />}
              label="Deadlocks (24h)"
              value={String(stats?.totals24h.deadlocks ?? 0)}
              tone={(stats?.totals24h.deadlocks ?? 0) > 0 ? 'danger' : 'neutral'}
            />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
            <div className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Runtime trend</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                    Active connections, commits, and rollbacks over time for the selected Postgres service.
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
                  No Postgres history is available for this window.
                </div>
              )}
            </div>

            <div className="card p-4">
              <h2 className="text-lg font-semibold">Live runtime</h2>
              <div className="mt-4 space-y-2">
                <StatRow label="Reachability" value={stats?.live?.reachable ? 'Healthy' : 'Unavailable'} />
                <StatRow label="Connections (active/idle)" value={`${stats?.live?.connectionsActive ?? 0} / ${stats?.live?.connectionsIdle ?? 0}`} />
                <StatRow label="Connection saturation" value={formatMetricPercent(stats?.live?.connectionSaturationPct)} />
                <StatRow label="Cache hit ratio" value={formatMetricRatio(stats?.live?.cacheHitRatio)} />
                <StatRow label="Commit ratio" value={formatMetricRatio(stats?.live?.commitRatio)} />
                <StatRow label="Dead tuples" value={String(stats?.live?.deadTuplesTotal ?? 0)} />
                <StatRow label="Blocked queries" value={String(stats?.live?.blockedQueries ?? 0)} />
                <StatRow label="Database size" value={formatBytes(stats?.live?.databaseSizeBytes)} />
              </div>
            </div>
          </div>

          {canAdmin && (
            <div className="card p-6">
              <h2 className="text-lg font-semibold">Operations</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                These trigger administrative actions directly against this service. Each requires confirmation.
              </p>
              <div className="mt-4 flex flex-wrap gap-3">
                <Button variant="secondary" onClick={() => void handleAnalyze()} isLoading={runningOp === 'analyze:db'} disabled={!!runningOp && runningOp !== 'analyze:db'}>
                  ANALYZE database
                </Button>
                <Button variant="secondary" onClick={() => void handleVacuum(undefined, true)} isLoading={runningOp === 'vacuum:db'} disabled={!!runningOp && runningOp !== 'vacuum:db'}>
                  VACUUM ANALYZE database
                </Button>
                <Button variant="danger" onClick={() => void handleResetStats()} isLoading={runningOp === 'reset'} disabled={!!runningOp && runningOp !== 'reset'}>
                  Reset statistics
                </Button>
              </div>
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-3">
            <StatPanel
              title="Connections"
              items={[
                ['Total connections', stats?.live?.connectionsTotal ?? 0],
                ['Max connections', stats?.live?.maxConnections ?? 0],
                ['Connection saturation', formatMetricPercent(stats?.live?.connectionSaturationPct)],
                ['Peak connections (24h)', stats?.totals24h.peakConnectionsTotal ?? 0],
                ['Peak saturation (24h)', formatMetricPercent(stats?.totals24h.peakConnectionSaturationPct)],
                ['Unreachable samples (24h)', stats?.totals24h.unreachableSamples ?? 0],
              ]}
            />
            <StatPanel
              title="Transactions"
              items={[
                ['Commits (24h)', stats?.totals24h.xactCommit ?? 0],
                ['Rollbacks (24h)', stats?.totals24h.xactRollback ?? 0],
                ['Deadlocks (24h)', stats?.totals24h.deadlocks ?? 0],
                ['Commit ratio', formatMetricRatio(stats?.live?.commitRatio)],
                ['Dead tuples', stats?.live?.deadTuplesTotal ?? 0],
              ]}
            />
            <StatPanel
              title="Temp usage"
              items={[
                ['Temp files (24h)', stats?.totals24h.tempFiles ?? 0],
                ['Temp bytes (24h)', formatBytes(stats?.totals24h.tempBytes)],
                ['Blocked queries', stats?.live?.blockedQueries ?? 0],
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
