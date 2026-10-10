/**
 * Robin MTA Metrics page.
 * 
 * Displays comprehensive metrics from Robin MTA using Chart.js for
 * time-series charts and current service health.
 */

import { useState, useEffect, useCallback, useMemo } from 'react';
import {
  Activity,
  AlertTriangle,
  Ban,
  BarChart3,
  ChevronDown,
  ChevronRight,
  Cpu,
  FileText,
  HardDrive,
  Mail,
  Package,
  RefreshCw,
  Shield,
  TrendingUp,
  Wrench,
  type LucideIcon,
} from 'lucide-react';
import { metricsApi } from '../api/client';
import { useServices } from '../context/ServiceContext';
import { Button } from '../components/ui/Button';
import { MetricValue } from '../components/ui/MetricCard';
import { MetricTabs, type MetricTab } from '../components/ui/MetricTabs';
import { PageHeader } from '../components/ui/PageHeader';
import { PageServiceSelector } from '../components/fleet/PageServiceSelector';
import { appIcons } from '../constants/appIcons';
import { LineChart, formatChartLabels, downsampleData } from '../components/charts';
import type { DataSeries } from '../components/charts';
import type { MetricsSnapshot } from '../types';
import { formatBytes, formatMetricNumber, formatMetricPercent } from '../utils/format';
import { useCapableTabs } from '../hooks/useCapableTabs';

type TabType = 'overview' | 'detailed' | 'raw';
type WindowType = '1h' | '6h' | '24h' | '7d' | '30d';

const WINDOW_HOURS: Record<WindowType, number> = {
  '1h': 1,
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
  '30d': 24 * 30,
};

const TABS: readonly MetricTab<TabType>[] = [
  { id: 'overview', label: 'Overview', icon: BarChart3 },
  { id: 'detailed', label: 'Detailed', icon: TrendingUp },
  { id: 'raw', label: 'Raw', icon: FileText },
];

// Tabs the selected service's setup must support.
const TAB_NEEDS: Partial<Record<TabType, string>> = { raw: 'raw' };

// LocalStorage keys
const STORAGE_KEYS = {
  window: 'metrics-window',
  tab: 'metrics-tab',
  sections: 'metrics-sections',
};

function loadState<T>(key: string, defaultValue: T): T {
  try {
    const stored = localStorage.getItem(key);
    return stored ? JSON.parse(stored) : defaultValue;
  } catch {
    return defaultValue;
  }
}

function saveState<T>(key: string, value: T): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {}
}

function formatCompact(n: number): string {
  if (n >= 1000000) return `${formatMetricNumber(n / 1000000)}M`;
  if (n >= 1000) return `${formatMetricNumber(n / 1000)}K`;
  return formatMetricNumber(n);
}

// Individual metric chart component for detailed view using Chart.js
interface MetricChartProps {
  title: string;
  data: MetricsSnapshot[];
  dataKey: keyof MetricsSnapshot;
  color?: string;
  formatter?: (v: number) => string;
}

function MetricChart({ title, data, dataKey, color = '#f97316', formatter }: MetricChartProps) {
  const values = useMemo(() => data.map(d => Number(d[dataKey]) || 0), [data, dataKey]);
  const current = values.length > 0 ? values[values.length - 1] : 0;
  const formatValue = formatter || formatMetricNumber;
  
  const labels = useMemo(() => data.map(() => ''), [data]);
  const series = useMemo(() => [{
    label: title,
    data: values,
    color,
    fill: true,
  }], [title, values, color]);
  
  return (
    <div className="card p-3 min-h-[160px]">
      <div className="text-xs font-medium text-gray-600 dark:text-gray-400 mb-1 truncate" title={title}>
        {title}
      </div>
      
      {/* Current value */}
      <div className="text-lg font-semibold mb-2" style={{ color }}>
        {formatValue(current)}
      </div>
      
      {/* Chart */}
      <div className="h-20">
        {data.length > 0 ? (
          <LineChart 
            labels={labels} 
            series={series} 
            height={80} 
            showLegend={false}
            tooltipFormatter={formatter}
          />
        ) : (
          <div className="w-full h-full flex items-center justify-center text-xs text-gray-400">
            No data
          </div>
        )}
      </div>
    </div>
  );
}

// Health Tile component
interface HealthTileProps {
  icon: React.ReactNode;
  title: string;
  value: string | number;
  subtitle?: string;
  tone?: 'neutral' | 'success' | 'danger';
  percentage?: number;
}

function HealthTile({ icon, title, value, subtitle, tone = 'neutral', percentage }: HealthTileProps) {
  const toneClasses = {
    neutral: 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300',
    success: 'bg-green-50 text-green-600 dark:bg-green-900/20 dark:text-green-400',
    danger: 'bg-red-50 text-red-600 dark:bg-red-900/20 dark:text-red-400',
  };
  
  return (
    <div className="card p-4">
      <div className="flex items-start justify-between mb-2">
        <div className={`rounded-lg p-2 ${toneClasses[tone]}`}>{icon}</div>
        {percentage !== undefined && (
          <span className={`text-sm font-medium ${percentage > 80 ? 'text-red-500' : percentage > 60 ? 'text-yellow-500' : 'text-green-500'}`}>
            {formatMetricPercent(percentage)}
          </span>
        )}
      </div>
      <MetricValue className="font-bold text-gray-900 dark:text-white">{value}</MetricValue>
      <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">{title}</div>
      {subtitle && <div className="text-xs text-gray-400 dark:text-gray-500">{subtitle}</div>}
    </div>
  );
}

// Panel component for charts
interface PanelProps {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
}

function Panel({ title, subtitle, children }: PanelProps) {
  return (
    <div className="card p-4">
      <div className="flex justify-between items-center mb-3">
        <div className="font-medium text-gray-700 dark:text-gray-300">{title}</div>
        {subtitle && <span className="text-xs text-gray-400">{subtitle}</span>}
      </div>
      {children}
    </div>
  );
}

// Collapsible section for detailed charts
interface CollapsibleSectionProps {
  id: string;
  title: string;
  icon: LucideIcon;
  isOpen: boolean;
  onToggle: (id: string) => void;
  children: React.ReactNode;
}

function CollapsibleSection({ id, title, icon: Icon, isOpen, onToggle, children }: CollapsibleSectionProps) {
  return (
    <div className="card overflow-hidden">
      <button
        onClick={() => onToggle(id)}
        className="w-full flex items-center justify-between p-4 hover:bg-gray-50 dark:hover:bg-gray-800 transition-colors"
      >
        <span className="flex items-center gap-2 font-medium text-gray-700 dark:text-gray-300">
          <Icon aria-hidden="true" className="h-4 w-4" />
          {title}
        </span>
        {isOpen ? <ChevronDown className="w-5 h-5 text-gray-400" /> : <ChevronRight className="w-5 h-5 text-gray-400" />}
      </button>
      {isOpen && <div className="p-4 pt-0 border-t border-gray-100 dark:border-gray-800">{children}</div>}
    </div>
  );
}

// Stats row component
interface StatsRowProps {
  stats: { label: string; value: string | number; color?: string }[];
}

function StatsRow({ stats }: StatsRowProps) {
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
      {stats.map((s, i) => (
        <div key={i} className="bg-gray-50 dark:bg-gray-800 rounded-lg p-3 text-center">
          <div className={`text-lg font-bold ${s.color || 'text-gray-900 dark:text-white'}`}>{s.value}</div>
          <div className="text-xs text-gray-500">{s.label}</div>
        </div>
      ))}
    </div>
  );
}

// Section IDs for persistence
const SECTION_IDS = ['email', 'rejections', 'dos', 'threads', 'cpu', 'memory', 'buffers', 'gc', 'other', 'rates'];
const DEFAULT_SECTIONS: Record<string, boolean> = {
  email: true, rejections: true, dos: false, threads: false,
  cpu: false, memory: false, buffers: false, gc: false, other: false, rates: false,
};

export function MetricsPage() {
  const { selectedRobinService } = useServices();
  const [tab, setTab] = useState<TabType>(() => loadState(STORAGE_KEYS.tab, 'overview'));
  const tabs = useCapableTabs(TABS, TAB_NEEDS, selectedRobinService?.serviceId, tab, setTab);
  const [window, setWindow] = useState<WindowType>(() => loadState(STORAGE_KEYS.window, '24h'));
  const [openSections, setOpenSections] = useState<Record<string, boolean>>(() => loadState(STORAGE_KEYS.sections, DEFAULT_SECTIONS));
  const [history, setHistory] = useState<MetricsSnapshot[]>([]);
  const [rawText, setRawText] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);

  useEffect(() => { saveState(STORAGE_KEYS.tab, tab); }, [tab]);
  useEffect(() => { saveState(STORAGE_KEYS.window, window); }, [window]);
  useEffect(() => { saveState(STORAGE_KEYS.sections, openSections); }, [openSections]);

  const toggleSection = useCallback((id: string) => {
    setOpenSections(prev => ({ ...prev, [id]: !prev[id] }));
  }, []);

  const expandAll = useCallback(() => {
    setOpenSections(SECTION_IDS.reduce((acc, id) => ({ ...acc, [id]: true }), {}));
  }, []);

  const collapseAll = useCallback(() => {
    setOpenSections(SECTION_IDS.reduce((acc, id) => ({ ...acc, [id]: false }), {}));
  }, []);

  // Downsample data for charts (max 200 points for smooth rendering)
  const chartData = useMemo(() => downsampleData(history, 200), [history]);
  const labels = useMemo(() => formatChartLabels(chartData.map(d => d.timestamp), window), [chartData, window]);
  const latestData = useMemo(() => history.length > 0 ? history[history.length - 1] : null, [history]);
  const firstData = useMemo(() => history.length > 0 ? history[0] : null, [history]);

  // Calculate deltas for the selected window
  const windowDeltas = useMemo(() => {
    if (!latestData || !firstData) return null;
    return {
      delivered: Math.max(0, latestData.emailReceiptSuccess - firstData.emailReceiptSuccess),
      rejected: Math.max(0, 
        (latestData.rblRejections + latestData.virusRejections + latestData.spamRejections) -
        (firstData.rblRejections + firstData.virusRejections + firstData.spamRejections)
      ),
      dosBlocked: Math.max(0,
        (latestData.dosRatelimitRejections + latestData.dosConnlimitRejections + latestData.dosTarpitCount) -
        (firstData.dosRatelimitRejections + firstData.dosConnlimitRejections + firstData.dosTarpitCount)
      ),
    };
  }, [latestData, firstData]);

  const memoryPct = useMemo(() => {
    if (!latestData || !latestData.jvmMemoryMax) return 0;
    return (latestData.jvmMemoryUsed / latestData.jvmMemoryMax) * 100;
  }, [latestData]);

  const fetchData = useCallback(async () => {
    try {
      setError('');
      if (tab === 'raw') {
        const text = await metricsApi.getRaw(selectedRobinService?.serviceId);
        setRawText(text);
      } else {
        const historyRes = await metricsApi.getHistory(WINDOW_HOURS[window], selectedRobinService?.serviceId);
        setHistory(historyRes.data ?? []);
      }
    } catch {
      setError('Failed to fetch metrics');
    } finally {
      setIsLoading(false);
    }
  }, [tab, window, selectedRobinService?.serviceId]);

  useEffect(() => { fetchData(); }, [fetchData]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(fetchData, 60000);
    return () => clearInterval(interval);
  }, [autoRefresh, fetchData]);

  // Build chart series
  const throughputSeries: DataSeries[] = useMemo(() => {
    if (chartData.length < 2) return [];
    const delivered: number[] = [];
    const rejected: number[] = [];
    for (let i = 1; i < chartData.length; i++) {
      const curr = chartData[i];
      const prev = chartData[i - 1];
      delivered.push(Math.max(0, curr.emailReceiptSuccess - prev.emailReceiptSuccess));
      rejected.push(Math.max(0, 
        (curr.rblRejections + curr.virusRejections + curr.spamRejections) -
        (prev.rblRejections + prev.virusRejections + prev.spamRejections)
      ));
    }
    return [
      { label: 'Delivered', data: delivered, color: '#22c55e', fill: true },
      { label: 'Rejected', data: rejected, color: '#ef4444', fill: false },
    ];
  }, [chartData]);

  const memorySeries: DataSeries[] = useMemo(() => [{
    label: 'Memory (MB)',
    data: chartData.map(d => Math.round(d.jvmMemoryUsed / 1048576)),
    color: '#8b5cf6',
    fill: true,
  }], [chartData]);

  const threadsSeries: DataSeries[] = useMemo(() => [
    { label: 'Live', data: chartData.map(d => d.jvmThreadsLive), color: '#06b6d4', fill: true },
    { label: 'Daemon', data: chartData.map(d => d.jvmThreadsDaemon), color: '#14b8a6', fill: false },
  ], [chartData]);

  const cpuSeries: DataSeries[] = useMemo(() => [
    { label: 'System %', data: chartData.map(d => (d.cpuUsage || 0) * 100), color: '#f59e0b', fill: true },
    { label: 'Process %', data: chartData.map(d => (d.processCpuUsage || 0) * 100), color: '#3b82f6', fill: false },
  ], [chartData]);

  const ratesSeries: DataSeries[] = useMemo(() => [
    { label: 'Delivered/min', data: chartData.map(d => d.rateEmailSuccess || 0), color: '#22c55e', fill: true },
    { label: 'Rejected/min', data: chartData.map(d => d.rateRejections || 0), color: '#ef4444', fill: false },
  ], [chartData]);

  // Cumulative totals series
  const cumulativeSeries: DataSeries[] = useMemo(() => [
    { label: 'Delivered', data: chartData.map(d => d.emailReceiptSuccess), color: '#22c55e', fill: false },
    {
      label: 'Rejected',
      data: chartData.map(d => d.rblRejections + d.virusRejections + d.spamRejections),
      color: '#ef4444',
      fill: false,
    },
  ], [chartData]);

  const throughputLabels = useMemo(() => labels.slice(1), [labels]);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.metrics}
        title="Robin metrics"
        description="Memory, threads, throughput, and delivery activity for the selected Robin service."
        actions={
          <>
            <PageServiceSelector  capability="metrics" />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={autoRefresh} onChange={(e) => setAutoRefresh(e.target.checked)} className="h-4 w-4 rounded-sm accent-robin-orange" />
              Auto-refresh
            </label>
            <Button variant="secondary" onClick={fetchData} disabled={isLoading}>
              <RefreshCw className={`w-4 h-4 mr-2 ${isLoading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </>
        }
      />

      {/* Tabs */}
      <MetricTabs tabs={tabs} activeTab={tab} onChange={setTab} />

      {/* Time window selector */}
      {tab !== 'raw' && (
        <div className="flex gap-2 mb-6">
          <span className="text-sm text-gray-500 self-center mr-2">Window:</span>
          {(['1h', '6h', '24h', '7d', '30d'] as WindowType[]).map((w) => (
            <button key={w} onClick={() => setWindow(w)}
              className={`px-3 py-1.5 text-sm rounded border transition-colors ${
                window === w ? 'bg-robin-orange text-white border-robin-orange' : 'border-gray-300 dark:border-robin-gray-600 hover:bg-gray-100 dark:hover:bg-robin-gray-700'
              }`}>
              {w}
            </button>
          ))}
        </div>
      )}

      {error && (
        <div className="mb-4 p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-sm text-red-600 dark:text-red-400">
          {error}
        </div>
      )}

      {history.length === 0 && tab !== 'raw' && !isLoading && (
        <div className="mb-4 p-4 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-sm">
          <div className="flex items-center gap-2 text-yellow-700 dark:text-yellow-400">
            <AlertTriangle className="w-5 h-5" />
            <span className="font-medium">No metrics data available</span>
          </div>
          <p className="text-sm text-yellow-600 dark:text-yellow-500 mt-1">
            Make sure Robin MTA is running and the metrics poller is collecting data.
          </p>
        </div>
      )}

      {/* Overview Tab */}
      {tab === 'overview' && history.length > 0 && latestData && (
        <div className="space-y-6">
          {/* Health Tiles */}
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <HealthTile icon={<HardDrive className="w-5 h-5" />} title="Memory usage" value={formatBytes(latestData.jvmMemoryUsed)} subtitle={`of ${formatBytes(latestData.jvmMemoryMax || 0)}`} percentage={memoryPct} />
            <HealthTile icon={<Cpu className="w-5 h-5" />} title="Live threads" value={latestData.jvmThreadsLive} subtitle={`Peak: ${latestData.jvmThreadsPeak || 0}`} />
            <HealthTile icon={<TrendingUp className="w-5 h-5" />} title={`Delivered (${window})`} value={formatCompact(windowDeltas?.delivered || 0)} tone="success" />
            <HealthTile icon={<Shield className="w-5 h-5" />} title={`Rejected (${window})`} value={formatCompact(windowDeltas?.rejected || 0)} tone="danger" />
            <HealthTile
              icon={<Mail className="w-5 h-5" />}
              title="Delivered / min"
              value={formatMetricNumber(latestData.rateEmailSuccess || 0)}
              subtitle="Current delivery rate"
            />
            <HealthTile icon={<Activity className="w-5 h-5" />} title={`DoS Blocked (${window})`} value={formatCompact(windowDeltas?.dosBlocked || 0)} tone="danger" />
          </div>

          {/* Main Charts */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel title="Email throughput" subtitle="per sample interval">
              <LineChart labels={throughputLabels} series={throughputSeries} height={220} />
            </Panel>
            <Panel title="Memory Usage (MB)">
              <LineChart labels={labels} series={memorySeries} height={220} yAxisFormatter={(v) => `${v} MB`} />
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel title="JVM Threads">
              <LineChart labels={labels} series={threadsSeries} height={200} />
            </Panel>
            <Panel title="CPU Usage (%)">
              <LineChart labels={labels} series={cpuSeries} height={200} yAxisFormatter={formatMetricPercent} />
            </Panel>
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            <Panel title="Outcome rates (per minute)">
              <LineChart labels={labels} series={ratesSeries} height={200} yAxisFormatter={(v) => `${formatMetricNumber(v)}/min`} />
            </Panel>
            <Panel title="Cumulative outcomes" subtitle="since Robin start">
              <LineChart labels={labels} series={cumulativeSeries} height={200} />
            </Panel>
          </div>

          {/* Current Stats */}
          <div className="card p-4">
            <h3 className="font-medium text-gray-700 dark:text-gray-300 mb-4">System overview</h3>
            <StatsRow stats={[
              { label: 'CPU Cores', value: latestData.systemCpuCount || 0, color: 'text-blue-500' },
              { label: 'System CPU', value: formatMetricPercent((latestData.cpuUsage || 0) * 100), color: 'text-green-500' },
              { label: 'Load avg', value: formatMetricNumber(latestData.systemLoadAverage || 0), color: 'text-orange-500' },
              { label: 'GC Pauses', value: latestData.jvmGcPauseCount || 0, color: 'text-purple-500' },
              { label: 'GC Time', value: `${formatMetricNumber(latestData.jvmGcPauseSeconds || 0)}s`, color: 'text-cyan-500' },
              { label: 'Daemon threads', value: latestData.jvmThreadsDaemon || 0, color: 'text-pink-500' },
            ]} />
          </div>
        </div>
      )}

      {/* Detailed Charts Tab */}
      {tab === 'detailed' && history.length > 0 && (
        <div className="space-y-3">
          <div className="flex justify-end gap-2 mb-2">
            <button onClick={expandAll} className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white">
              Expand all
            </button>
            <span className="text-gray-300">|</span>
            <button onClick={collapseAll} className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white">
              Collapse all
            </button>
          </div>

          <CollapsibleSection id="email" title="Email counters" icon={Mail} isOpen={openSections['email']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="Receipt starts" data={chartData} dataKey="emailReceiptStart" color="#64748b" />
              <MetricChart title="Delivered messages" data={chartData} dataKey="emailReceiptSuccess" color="#22c55e" />
              <MetricChart title="Receipt limits" data={chartData} dataKey="emailReceiptLimit" color="#eab308" />
              <MetricChart title="Receipt exceptions" data={chartData} dataKey="emailReceiptException" color="#ef4444" />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="rejections" title="Email rejections" icon={Ban} isOpen={openSections['rejections']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="RBL Rejection" data={chartData} dataKey="rblRejections" color="#ef4444" />
              <MetricChart title="Virus rejection" data={chartData} dataKey="virusRejections" color="#f97316" />
              <MetricChart title="Spam rejection" data={chartData} dataKey="spamRejections" color="#a855f7" />
              <MetricChart title="Rate limit rejection" data={chartData} dataKey="dosRatelimitRejections" color="#ec4899" />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="dos" title="DoS Protection" icon={Shield} isOpen={openSections['dos']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="Connection limit rejection" data={chartData} dataKey="dosConnlimitRejections" color="#f43f5e" />
              <MetricChart title="Tarpit count" data={chartData} dataKey="dosTarpitCount" color="#d946ef" />
              <MetricChart title="Slow transfer rejection" data={chartData} dataKey="dosSlowtransferRejections" color="#8b5cf6" />
              <MetricChart title="Command flood rejection" data={chartData} dataKey="dosCommandfloodRejections" color="#6366f1" />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="threads" title="JVM Threads" icon={Cpu} isOpen={openSections['threads']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="Daemon threads" data={chartData} dataKey="jvmThreadsDaemon" color="#14b8a6" />
              <MetricChart title="Live threads" data={chartData} dataKey="jvmThreadsLive" color="#06b6d4" />
              <MetricChart title="Peak threads" data={chartData} dataKey="jvmThreadsPeak" color="#0ea5e9" />
              <MetricChart title="Started threads" data={chartData} dataKey="jvmThreadsStarted" color="#3b82f6" />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="cpu" title="CPU Usage" icon={Cpu} isOpen={openSections['cpu']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="Process CPU usage" data={chartData} dataKey="processCpuUsage" color="#f59e0b" formatter={(v) => formatMetricPercent(v * 100)} />
              <MetricChart title="System CPU count" data={chartData} dataKey="systemCpuCount" color="#84cc16" />
              <MetricChart title="System CPU usage" data={chartData} dataKey="cpuUsage" color="#22c55e" formatter={(v) => formatMetricPercent(v * 100)} />
              <MetricChart title="System load average" data={chartData} dataKey="systemLoadAverage" color="#10b981" />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="memory" title="JVM Memory" icon={HardDrive} isOpen={openSections['memory']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="Memory committed" data={chartData} dataKey="jvmMemoryCommitted" color="#8b5cf6" formatter={formatBytes} />
              <MetricChart title="Memory max" data={chartData} dataKey="jvmMemoryMax" color="#a855f7" formatter={formatBytes} />
              <MetricChart title="Memory used" data={chartData} dataKey="jvmMemoryUsed" color="#d946ef" formatter={formatBytes} />
              <MetricChart title="Buffer count" data={chartData} dataKey="jvmBufferCount" color="#ec4899" />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="buffers" title="JVM Buffers" icon={Package} isOpen={openSections['buffers']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="Buffer memory used" data={chartData} dataKey="jvmBufferMemoryUsed" color="#f472b6" formatter={formatBytes} />
              <MetricChart title="Buffer total capacity" data={chartData} dataKey="jvmBufferTotalCapacity" color="#fb7185" formatter={formatBytes} />
              <MetricChart title="GC Live Data Size" data={chartData} dataKey="jvmGcLiveDataSize" color="#f87171" formatter={formatBytes} />
              <MetricChart title="GC Max Data Size" data={chartData} dataKey="jvmGcMaxDataSize" color="#ef4444" formatter={formatBytes} />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="gc" title="Garbage collection" icon={RefreshCw} isOpen={openSections['gc']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="GC Memory Allocated" data={chartData} dataKey="jvmGcMemoryAllocated" color="#fb923c" formatter={formatBytes} />
              <MetricChart title="GC Memory Promoted" data={chartData} dataKey="jvmGcMemoryPromoted" color="#f97316" formatter={formatBytes} />
              <MetricChart title="GC Pause Seconds" data={chartData} dataKey="jvmGcPauseSeconds" color="#ea580c" formatter={(v) => `${formatMetricNumber(v)}s`} />
              <MetricChart title="GC Pause Count" data={chartData} dataKey="jvmGcPauseCount" color="#dc2626" />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="other" title="Other counters" icon={Wrench} isOpen={openSections['other']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="Whitelist bypass" data={chartData} dataKey="whitelistBypasses" color="#22d3ee" />
              <MetricChart title="Adaptive rate limit applied" data={chartData} dataKey="adaptiveRatelimitApplied" color="#2dd4bf" />
              <MetricChart title="GeoIP Block Rejection" data={chartData} dataKey="geoipBlockRejections" color="#4ade80" />
              <MetricChart title="GeoIP Limit Applied" data={chartData} dataKey="geoipLimitApplied" color="#a3e635" />
            </div>
          </CollapsibleSection>

          <CollapsibleSection id="rates" title="Rates (per minute)" icon={TrendingUp} isOpen={openSections['rates']} onToggle={toggleSection}>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              <MetricChart title="Receipt Starts / min" data={chartData} dataKey="rateEmailStart" color="#64748b" formatter={(v) => `${formatMetricNumber(v)}/min`} />
              <MetricChart title="Delivered / min" data={chartData} dataKey="rateEmailSuccess" color="#22c55e" formatter={(v) => `${formatMetricNumber(v)}/min`} />
              <MetricChart title="Rejected / min" data={chartData} dataKey="rateRejections" color="#ef4444" formatter={(v) => `${formatMetricNumber(v)}/min`} />
              <MetricChart title="Distributed store errors" data={chartData} dataKey="distributedStoreErrors" color="#f59e0b" />
            </div>
          </CollapsibleSection>
        </div>
      )}

      {/* Raw Tab */}
      {tab === 'raw' && (
        <div className="card p-4">
          <h3 className="font-medium mb-4">Raw Prometheus metrics</h3>
          <pre className="bg-gray-100 dark:bg-robin-gray-800 p-4 rounded-sm overflow-auto max-h-[600px] text-xs font-mono">
            {rawText || 'Loading...'}
          </pre>
        </div>
      )}
    </div>
  );
}
