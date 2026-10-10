import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import {
  Activity,
  BarChart3,
  Clock,
  DatabaseZap,
  FileText,
  Gauge,
  HardDrive,
  Lock,
  RefreshCw,
  Server,
  Table2,
  TrendingUp,
  Users,
} from 'lucide-react';
import { ApiError, mariadbApi } from '../api/client';
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
  MariadbMetricsSnapshot,
  MariadbMetricsStats,
  MariadbProcessRow,
  MariadbSchemaRow,
  MariadbStatementsResult,
  MariadbTableRow,
  MariadbTransactionRow,
} from '../types';
import { useCapableTabs } from '../hooks/useCapableTabs';
import { useServiceCapabilities } from '../context/FeaturesContext';

type TabType = 'overview' | 'processes' | 'transactions' | 'schemas' | 'statements' | 'raw';
type WindowType = '1h' | '6h' | '24h' | '7d';

const WINDOW_HOURS: Record<WindowType, number> = { '1h': 1, '6h': 6, '24h': 24, '7d': 24 * 7 };

const TABS: readonly MetricTab<TabType>[] = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'processes', label: 'Processes', icon: Activity },
  { id: 'transactions', label: 'Transactions', icon: Lock },
  { id: 'schemas', label: 'Schemas', icon: Table2 },
  { id: 'statements', label: 'Statements', icon: TrendingUp },
  { id: 'raw', label: 'Raw', icon: FileText },
];

// Tabs the selected service's setup must support.
const TAB_NEEDS: Partial<Record<TabType, string>> = { processes: 'admin', transactions: 'admin', schemas: 'admin', statements: 'admin', raw: 'raw' };

function duration(secs: number | null | undefined): string {
  const value = secs ?? 0;
  if (value < 60) return `${formatMetricNumber(value)}s`;
  if (value < 3600) return `${formatMetricNumber(value / 60)}m`;
  if (value < 86400) return `${formatMetricNumber(value / 3600)}h`;
  return `${formatMetricNumber(value / 86400)}d`;
}

export function MariadbMetricsPage() {
  const confirm = useConfirm();
  const { selectedMariadbService } = useServices();
  const serviceId = selectedMariadbService?.serviceId;
  const [tab, setTab] = useState<TabType>('overview');
  const { user } = useAuth();
  const isAdmin = user?.role === 'admin';
  const permittedTabs = useMemo(() => TABS.filter((entry) => isAdmin || TAB_NEEDS[entry.id] !== 'admin'), [isAdmin]);
  const tabs = useCapableTabs(permittedTabs, TAB_NEEDS, serviceId, tab, setTab);
  // Operations run against the server directly, over robin-admin's admin connection.
  const canAdmin = useServiceCapabilities(serviceId).can('admin') && isAdmin;
  const [window, setWindow] = useState<WindowType>('24h');
  const [stats, setStats] = useState<MariadbMetricsStats | null>(null);
  const [history, setHistory] = useState<MariadbMetricsSnapshot[]>([]);
  const [rawText, setRawText] = useState('');
  const [processes, setProcesses] = useState<MariadbProcessRow[]>([]);
  const [transactions, setTransactions] = useState<MariadbTransactionRow[]>([]);
  const [schemas, setSchemas] = useState<MariadbSchemaRow[]>([]);
  const [schemaFilter, setSchemaFilter] = useState('');
  const [tables, setTables] = useState<MariadbTableRow[]>([]);
  const [statements, setStatements] = useState<MariadbStatementsResult>({ available: true, rows: [] });
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  // One operation at a time; only the button whose op is running spins.
  const [runningOp, setRunningOp] = useState<string | null>(null);

  // An operation's outcome belongs to the tab it ran on.
  useEffect(() => setSuccess(''), [tab, serviceId]);

  const load = useCallback(async (showRefreshing = false) => {
    if (!serviceId) {
      setIsLoading(false);
      return;
    }
    if (showRefreshing) setIsRefreshing(true);
    try {
      setError('');
      if (tab === 'raw') {
        setRawText(await mariadbApi.getMetricsRaw(serviceId));
      } else if (tab === 'processes') {
        setProcesses((await mariadbApi.getProcesses(serviceId)).data ?? []);
      } else if (tab === 'transactions') {
        setTransactions((await mariadbApi.getTransactions(serviceId)).data ?? []);
      } else if (tab === 'schemas') {
        const [schemaResponse, tableResponse] = await Promise.all([
          mariadbApi.getSchemas(serviceId),
          mariadbApi.getTables(serviceId, schemaFilter || undefined),
        ]);
        setSchemas(schemaResponse.data ?? []);
        setTables(tableResponse.data ?? []);
      } else if (tab === 'statements') {
        setStatements((await mariadbApi.getStatements(serviceId)).data ?? { available: false, rows: [] });
      } else {
        const [statsResponse, historyResponse] = await Promise.all([
          mariadbApi.getMetricsStats(serviceId),
          mariadbApi.getMetricsHistory(serviceId, WINDOW_HOURS[window]),
        ]);
        setStats(statsResponse.data ?? null);
        setHistory(historyResponse.data ?? []);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Failed to load MariaDB metrics');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, [schemaFilter, serviceId, tab, window]);

  useEffect(() => {
    void load();
  }, [load]);

  // Overview and the lock view are worth watching live.
  useEffect(() => {
    if (tab !== 'overview' && tab !== 'transactions') return undefined;
    const interval = setInterval(() => void load(true), tab === 'overview' ? 60000 : 10000);
    return () => clearInterval(interval);
  }, [load, tab]);

  const chartData = useMemo(() => downsampleData(history, 200).filter((point) => point.reachable), [history]);
  const chartLabels = useMemo(() => formatChartLabels(chartData.map((point) => point.timestamp), window), [chartData, window]);
  const chartSeries = useMemo(() => {
    // Questions and commits are cumulative counters: chart per-interval deltas.
    const deltas = (pick: (point: MariadbMetricsSnapshot) => number) =>
      chartData.map((point, i) => (i === 0 ? 0 : Math.max(0, pick(point) - pick(chartData[i - 1]))));
    return [
      { label: 'Connections', data: chartData.map((point) => point.threadsConnected), color: '#3b82f6', fill: true },
      { label: 'Queries/interval', data: deltas((point) => point.questions), color: '#22c55e', fill: false },
      { label: 'Slow queries/interval', data: deltas((point) => point.slowQueries), color: '#ef4444', fill: false },
    ];
  }, [chartData]);

  const runOp = async (key: string, prompt: string, run: () => Promise<string>) => {
    if (!serviceId || !(await confirm(prompt))) return;
    setRunningOp(key);
    setError('');
    setSuccess('');
    try {
      setSuccess(await run());
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'The operation failed');
    } finally {
      setRunningOp(null);
    }
  };

  const kill = (id: number, scope: 'query' | 'connection') => runOp(
    `kill-${scope}:${id}`,
    scope === 'query'
      ? `Kill the running query of connection ${id}? The connection stays open.`
      : `Kill connection ${id}? Its open transaction is rolled back and the client is disconnected.`,
    async () => {
      if (!serviceId) return '';
      await mariadbApi.kill(serviceId, id, scope);
      return scope === 'query' ? `Query on connection ${id} killed` : `Connection ${id} killed`;
    },
  );

  const analyze = (table: string) => runOp(`analyze:${table}`, `Run ANALYZE TABLE on ${table}? It refreshes index statistics and reads the table.`, async () => (
    serviceId ? (await mariadbApi.analyze(serviceId, table)).data?.response ?? 'ANALYZE TABLE done' : ''
  ));

  const resetStats = () => runOp('reset', 'Reset the status counters (FLUSH STATUS)? Cumulative counters restart from zero.', async () => (
    serviceId ? (await mariadbApi.resetStats(serviceId)).data?.response ?? 'Status counters reset' : ''
  ));

  const opButton = (key: string, label: string, onClick: () => void, variant: 'secondary' | 'danger' = 'secondary') => (
    <Button size="sm" variant={variant} onClick={onClick} isLoading={runningOp === key} disabled={!!runningOp && runningOp !== key}>{label}</Button>
  );

  const header = (description: ReactNode) => (
    <PageHeader
      icon={appIcons.mariadbMetrics}
      title="MariaDB Metrics"
      description={description}
      actions={(
        <>
          <PageServiceSelector serviceType="mariadb" capability="metrics" />
          {serviceId && (
            <>
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
        </>
      )}
    />
  );

  if (!serviceId) {
    return (
      <div className="space-y-6">
        {header('Select an enabled MariaDB service from Fleet before opening the metrics workspace.')}
        <div className="rounded-lg border border-dashed border-gray-300 px-6 py-10 text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
          No enabled MariaDB service is currently selected.
        </div>
      </div>
    );
  }

  if (isLoading) {
    return <div className="flex justify-center py-8"><Spinner className="text-robin-orange" /></div>;
  }

  const live = stats?.live;
  const totals = stats?.totals24h;

  return (
    <div className="space-y-6">
      {header(<>Connections, queries, InnoDB and transaction health for <strong>{selectedMariadbService?.name ?? serviceId}</strong>.</>)}

      <MetricTabs tabs={tabs} activeTab={tab} onChange={setTab} />

      {error && <div className="rounded border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">{error}</div>}
      {success && <div className="rounded border border-green-200 bg-green-50 p-3 text-green-700 dark:border-green-800 dark:bg-green-900/20 dark:text-green-400">{success}</div>}

      {tab === 'raw' ? (
        <div className="card p-4">
          <h2 className="text-lg font-semibold">Raw statistics batch</h2>
          <pre className="mt-4 max-h-[70vh] overflow-auto rounded bg-gray-50 p-4 text-xs dark:bg-robin-gray-900">{rawText || '# No statistics returned'}</pre>
        </div>
      ) : tab === 'processes' ? (
        <Section title="Processes" description="Connections from the process list, longest-running first. Kill query stops the statement; kill connection ends the session.">
          <DataTable
            columns={['Id', 'User', 'Host', 'Database', 'Command', 'Time', 'State', 'Query', '']}
            empty="No other connections"
            rows={processes.map((row) => [
              row.id, row.user ?? '—', row.host ?? '—', row.db ?? '—', row.command ?? '—', duration(row.timeSecs), row.state ?? '—',
              <span className="block max-w-md truncate font-mono text-xs" title={row.info ?? ''}>{row.info ?? '—'}</span>,
              <div className="flex justify-end gap-2">
                {row.command === 'Query' && opButton(`kill-query:${row.id}`, 'Kill query', () => void kill(row.id, 'query'))}
                {opButton(`kill-connection:${row.id}`, 'Kill connection', () => void kill(row.id, 'connection'), 'danger')}
              </div>,
            ])}
          />
        </Section>
      ) : tab === 'transactions' ? (
        <Section title="Open transactions" description="InnoDB transactions, oldest first, with the connections holding the locks a waiting transaction needs. A long idle transaction holding locks is usually a stuck client; killing its connection rolls it back.">
          <DataTable
            columns={['Connection', 'State', 'Age', 'User', 'Database', 'Rows locked', 'Blocked by', 'Query', '']}
            empty="No open transactions"
            rows={transactions.map((row) => [
              row.threadId,
              <span className={row.state === 'LOCK WAIT' ? 'font-medium text-amber-600 dark:text-amber-400' : ''}>{row.state}</span>,
              duration(row.ageSecs), row.user ?? '—', row.db ?? '—', formatMetricNumber(row.rowsLocked),
              row.blockedByThreadIds.length > 0 ? row.blockedByThreadIds.join(', ') : '—',
              <span className="block max-w-sm truncate font-mono text-xs" title={row.query ?? ''}>{row.query ?? (row.command === 'Sleep' ? 'idle in transaction' : '—')}</span>,
              <div className="flex justify-end">{opButton(`kill-connection:${row.threadId}`, 'Kill connection', () => void kill(row.threadId, 'connection'), 'danger')}</div>,
            ])}
          />
        </Section>
      ) : tab === 'schemas' ? (
        <>
          <Section title="Schemas" description="Every database by size. Pick one to list its tables.">
            <DataTable
              columns={['Schema', 'Tables', 'Size', 'Free (reclaimable)']}
              empty="No schemas reported"
              rows={schemas.map((row) => [
                <button className="font-mono text-xs text-robin-orange hover:underline" onClick={() => setSchemaFilter(row.schema)}>{row.schema}</button>,
                formatMetricNumber(row.tables), formatBytes(row.totalBytes), formatBytes(row.freeBytes),
              ])}
            />
          </Section>
          <Section
            title={schemaFilter ? `Largest tables in ${schemaFilter}` : 'Largest tables'}
            description="By data plus index size. ANALYZE TABLE refreshes index statistics without rebuilding."
            actions={schemaFilter ? <Button size="sm" variant="secondary" onClick={() => setSchemaFilter('')}>All schemas</Button> : undefined}
          >
            <DataTable
              columns={['Schema', 'Table', 'Engine', 'Rows (estimate)', 'Size', 'Free', '']}
              empty="No tables reported"
              rows={tables.map((row) => {
                const name = `${row.schema}.${row.table}`;
                return [
                  row.schema, <span className="font-mono text-xs">{row.table}</span>, row.engine ?? '—', formatMetricNumber(row.rows),
                  formatBytes(row.totalBytes), formatBytes(row.freeBytes),
                  <div className="flex justify-end">{canAdmin && opButton(`analyze:${name}`, 'Analyze', () => void analyze(name))}</div>,
                ];
              })}
            />
          </Section>
        </>
      ) : tab === 'statements' ? (
        <Section title="Top statements" description="Statement digests from performance_schema, by total time.">
          {!statements.available && (
            <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-800 dark:border-amber-800 dark:bg-amber-900/20 dark:text-amber-300">
              performance_schema is off on this server (it needs performance_schema=ON and a restart).
            </div>
          )}
          <DataTable
            columns={['Schema', 'Statement', 'Calls', 'Total time', 'Mean time', 'Rows examined']}
            empty="No statement digests"
            rows={statements.rows.map((row) => [
              row.schema ?? '—',
              <span className="block max-w-lg truncate font-mono text-xs" title={row.digest}>{row.digest}</span>,
              formatMetricNumber(row.calls), `${formatMetricNumber(row.totalMs)} ms`, `${formatMetricNumber(row.meanMs)} ms`, formatMetricNumber(row.rowsExamined),
            ])}
          />
        </Section>
      ) : (
        <>
          <div className="flex flex-wrap gap-4">
            <MetricCard icon={<Server className="h-5 w-5" />} label="Server" value={live?.reachable ? 'Healthy' : 'Unavailable'} tone={live?.reachable ? 'success' : 'danger'} />
            <MetricCard icon={<Users className="h-5 w-5" />} label="Connections" value={`${formatMetricNumber(live?.threadsConnected)} / ${formatMetricNumber(live?.maxConnections)}`} tone={(live?.connectionSaturationPct ?? 0) >= 80 ? 'danger' : 'neutral'} />
            <MetricCard icon={<Gauge className="h-5 w-5" />} label="Buffer pool hit ratio" value={formatMetricRatio(live?.bufferPoolHitRatio)} />
            <MetricCard icon={<Clock className="h-5 w-5" />} label="Oldest transaction" value={duration(live?.oldestTrxAgeSecs)} tone={(live?.oldestTrxAgeSecs ?? 0) >= 300 ? 'danger' : 'neutral'} />
            <MetricCard icon={<Lock className="h-5 w-5" />} label="Lock waits" value={formatMetricNumber(live?.trxLockWaits)} tone={(live?.trxLockWaits ?? 0) > 0 ? 'danger' : 'neutral'} />
            <MetricCard icon={<HardDrive className="h-5 w-5" />} label="Data size" value={live?.databaseSizeBytes == null ? '—' : formatBytes(live.databaseSizeBytes)} />
            <MetricCard icon={<DatabaseZap className="h-5 w-5" />} label="Queries (24h)" value={formatMetricNumber(totals?.questions)} />
          </div>

          <div className="grid gap-4 xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]">
            <div className="card p-4">
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold">Runtime trend</h2>
                  <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">Connections, queries and slow queries per poll interval.</p>
                </div>
                <span className="text-xs font-medium text-gray-500 dark:text-gray-400">{window} window</span>
              </div>
              {chartData.length > 0 ? (
                <div className="mt-4"><LineChart labels={chartLabels} series={chartSeries} height={260} /></div>
              ) : (
                <div className="mt-4 rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
                  No MariaDB history is available for this window.
                </div>
              )}
            </div>

            <StatPanel
              title="Live runtime"
              items={[
                ['Version', live?.version || '—'],
                ['Running threads', formatMetricNumber(live?.threadsRunning)],
                ['Connection saturation', formatMetricPercent(live?.connectionSaturationPct)],
                ['Open transactions', formatMetricNumber(live?.trxActive)],
                ['Schemas', formatMetricNumber(live?.schemaCount)],
                ['Replication', live?.isReplica ? (live.secondsBehindSource === null ? 'Stopped' : `${duration(live.secondsBehindSource)} behind`) : 'Not a replica'],
              ]}
            />
          </div>

          {canAdmin && (
            <div className="card p-6">
              <h2 className="text-lg font-semibold">Operations</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">These run directly against this server. Each asks for confirmation.</p>
              <div className="mt-4 flex flex-wrap gap-3">
                {opButton('reset', 'Reset status counters', () => void resetStats(), 'danger')}
              </div>
            </div>
          )}

          <div className="grid gap-4 xl:grid-cols-3">
            <StatPanel
              title="Queries (24h)"
              items={[
                ['Queries', formatMetricNumber(totals?.questions)],
                ['Commits', formatMetricNumber(totals?.comCommit)],
                ['Rollbacks', formatMetricNumber(totals?.comRollback)],
                ['Inserts / updates / deletes', `${formatMetricNumber(totals?.comInsert)} / ${formatMetricNumber(totals?.comUpdate)} / ${formatMetricNumber(totals?.comDelete)}`],
                ['Slow queries', formatMetricNumber(totals?.slowQueries)],
                ['On-disk temp tables', formatMetricNumber(totals?.createdTmpDiskTables)],
              ]}
            />
            <StatPanel
              title="Locking (24h)"
              items={[
                ['Deadlocks', formatMetricNumber(totals?.deadlocks)],
                ['Row lock waits', formatMetricNumber(totals?.rowLockWaits)],
                ['Peak transaction age', duration(totals?.peakOldestTrxAgeSecs)],
              ]}
            />
            <StatPanel
              title="Connections (24h)"
              items={[
                ['Peak connections', formatMetricNumber(totals?.peakThreadsConnected)],
                ['Peak saturation', formatMetricPercent(totals?.peakConnectionSaturationPct)],
                ['Failed connection attempts', formatMetricNumber(totals?.abortedConnects)],
                ['Unreachable samples', formatMetricNumber(totals?.unreachableSamples)],
                ['Samples tracked', formatMetricNumber(stats?.historyCount)],
              ]}
            />
          </div>
        </>
      )}
    </div>
  );
}

function Section({ title, description, actions, children }: { title: string; description: string; actions?: ReactNode; children: ReactNode }) {
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{description}</p>
        </div>
        {actions}
      </div>
      <div className="mt-4">{children}</div>
    </div>
  );
}

function DataTable({ columns, rows, empty }: { columns: string[]; rows: ReactNode[][]; empty: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] text-sm">
        <thead className="bg-gray-50 dark:bg-gray-800">
          <tr>
            {columns.map((column, index) => (
              <th key={index} className="px-3 py-2 text-left text-xs font-medium text-gray-500 dark:text-gray-400">{column}</th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-gray-200 dark:divide-gray-700">
          {rows.map((cells, rowIndex) => (
            <tr key={rowIndex}>
              {cells.map((cell, index) => <td key={index} className="px-3 py-2">{cell}</td>)}
            </tr>
          ))}
          {rows.length === 0 && (
            <tr><td colSpan={columns.length} className="px-3 py-6 text-center text-sm text-gray-500 dark:text-gray-400">{empty}</td></tr>
          )}
        </tbody>
      </table>
    </div>
  );
}

function StatPanel({ title, items }: { title: string; items: Array<[string, string]> }) {
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
