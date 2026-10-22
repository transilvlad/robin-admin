import { useState, useEffect, useCallback, type CSSProperties, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  AlertTriangle,
  ArrowRight,
  AtSign,
  CheckCircle2,
  Inbox,
  ListTodo,
  Package,
  RefreshCw,
  Repeat,
  Send,
  Shield,
  ShieldCheck,
  SlidersHorizontal,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { dashboardApi, dashboardReportingApi, monitoringApi, modulesApi, reportingApi, telemetryApi } from '../api/client';
import { DonutChart } from '../components/charts';
import { MetricCard, type MetricTone } from '../components/ui/MetricCard';
import { Modal } from '../components/ui/Modal';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { appIcons } from '../constants/appIcons';
import {
  SERVICE_TYPE_LIST,
  type CapacityPeakData,
  type PressureData,
  type ServiceTypeMeta,
} from '../constants/serviceTypes';
import { useFeatures } from '../context/FeaturesContext';
import { useModules } from '../context/ModulesContext';
import type {
  DashboardStats,
  FleetDashboard,
  FleetDashboardService,
  PostfixFleetTotals,
  RobinFleetDashboardService,
  RobinFleetTotals,
} from '../types';
import type { MonitoringCheck, MonitoringIssue, MonitoringStatus, MonitoringSummary } from '../types/monitoring';
import type { TelemetrySources } from '../types/telemetry';
import { formatSpan } from '../utils/telemetry';
import type { IssueSeverity, ReportingOverview, TaxonomyBreakdown, TrendPoint } from '../types/reporting';

interface DashboardReportingData {
  issuesBySeverity: Record<IssueSeverity, number>;
  latestIssues: Array<{ id?: string | number; title?: string; severity?: IssueSeverity; domain?: string }>;
}

interface SheriffOverview {
  moduleCount: number;
  licenseCount: number;
}

interface DashboardCard {
  id: string;
  label: string;
  available: boolean;
  /** Relative width when the card shares a row with another card. */
  weight: number;
  render: () => ReactNode;
}

interface ShortcutData {
  label: string;
  value: number;
  icon: LucideIcon;
  color: string;
  to: string;
}

interface KpiCardData {
  label: string;
  value: ReactNode;
  icon: ReactNode;
  tone?: MetricTone;
  toneValue?: boolean;
  sub?: ReactNode;
}

const SEVERITY_ORDER: IssueSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const SEVERITY_TONE: Record<IssueSeverity, string> = {
  critical: 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-300',
  high: 'bg-orange-100 text-orange-700 dark:bg-orange-900/20 dark:text-orange-300',
  medium: 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  low: 'bg-sky-100 text-sky-700 dark:bg-sky-900/20 dark:text-sky-300',
  info: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
};

const STATUS_TONE: Record<MonitoringStatus, string> = {
  up: 'bg-green-100 text-green-700 dark:bg-green-900/20 dark:text-green-300',
  warning: 'bg-amber-100 text-amber-700 dark:bg-amber-900/20 dark:text-amber-300',
  down: 'bg-red-100 text-red-700 dark:bg-red-900/20 dark:text-red-300',
  unknown: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
};

/** Headline tiles fill their row whatever the count (one tile per enabled integration, at most four). */
const TILE_GRID_CLASS: Record<number, string> = {
  1: 'grid-cols-1',
  2: 'grid-cols-1 sm:grid-cols-2',
  3: 'grid-cols-1 sm:grid-cols-3',
  4: 'grid-cols-1 sm:grid-cols-2 xl:grid-cols-4',
};

/**
 * Each row holds two slots side by side; a slot is one card, or two short
 * cards stacked so they match a tall neighbour. When a slot is empty, its
 * partner pairs with the next lone slot, and a final lone slot takes the full
 * width, so every row fills whatever integrations are enabled.
 */
const CARD_ROWS: string[][][] = [
  [['mail-flow'], ['monitoring']],
  [['message-outcomes'], ['pressure']],
  [['fleet'], ['capacity-peaks', 'telemetry']],
];

export function pairDashboardCards<T extends { id: string }>(cards: T[]): T[][][] {
  const byId = new Map(cards.map((card) => [card.id, card]));
  const placed = new Set<string>();
  const rows: T[][][] = [];
  const singles: T[][] = [];
  for (const row of CARD_ROWS) {
    const slots = row
      .map((slot) => slot.map((id) => byId.get(id)).filter((card): card is T => card !== undefined))
      .filter((slot) => slot.length > 0);
    slots.flat().forEach((card) => placed.add(card.id));
    if (slots.length === 2) rows.push(slots);
    else if (slots.length === 1) singles.push(slots[0]);
  }
  singles.push(...cards.filter((card) => !placed.has(card.id)).map((card) => [card]));
  while (singles.length >= 2) rows.push(singles.splice(0, 2));
  if (singles.length === 1) rows.push(singles);
  return rows;
}

const MAX_CAPACITY_METERS = 5;

function formatNumber(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  if (n >= 1000000) return `${(n / 1000000).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatExact(n: number | null | undefined): string {
  if (typeof n !== 'number' || !Number.isFinite(n)) return '0';
  return n.toLocaleString();
}

function formatDuration(seconds: number | null | undefined): string {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds <= 0) return '0s';
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h`;
  return `${Math.round(seconds / 86400)}d`;
}

function formatDateTime(value: string | null | undefined): string {
  if (!value) return 'never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function asPercentPeak(peak: CapacityPeakData): number | null {
  const match = /^(\d+(?:\.\d+)?)%$/.exec(peak.value.trim());
  return match ? Number(match[1]) : null;
}

function toPct(value: number, total: number): number {
  return total > 0 ? (value / total) * 100 : 0;
}

export function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [fleet, setFleet] = useState<FleetDashboard | null>(null);
  const [overview, setOverview] = useState<ReportingOverview | null>(null);
  const [reporting, setReporting] = useState<DashboardReportingData | null>(null);
  const [monitoring, setMonitoring] = useState<MonitoringSummary | null>(null);
  const [telemetrySources, setTelemetrySources] = useState<TelemetrySources | null>(null);
  const [sheriffOverview, setSheriffOverview] = useState<SheriffOverview | null>(null);
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [showSetup, setShowSetup] = useState(false);
  const dismissSetup = () => {
    setShowSetup(false);
    dashboardApi.dismissSetupGuide().catch(() => { /* hidden for this view either way */ });
  };
  const [showCustomize, setShowCustomize] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const { features } = useFeatures();
  const { modules } = useModules();
  const sheriffAvailable = modules.some((moduleEntry) => (
    moduleEntry.slug === 'robin-sheriff'
    && moduleEntry.installed
    && moduleEntry.active
    && moduleEntry.runtimeAvailable
  ));

  const fetchStats = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) setIsRefreshing(true);
    try {
      const [statsRes, fleetRes] = await Promise.all([
        dashboardApi.getStats(),
        features.fleet ? dashboardApi.getFleet() : Promise.resolve({ data: null }),
      ]);
      setStats(statsRes.data ?? null);
      setFleet(fleetRes.data ?? null);
      setError('');
    } catch {
      setError('Failed to load dashboard statistics');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }

    dashboardApi.getPreferences().then((r) => {
      setHidden(new Set(r.data?.hidden ?? []));
      setShowSetup(r.data?.setupGuide === true);
    }).catch(() => {});
    if (features.monitoring) {
      monitoringApi.summary().then((r) => setMonitoring(r.data ?? null)).catch(() => setMonitoring(null));
    } else {
      setMonitoring(null);
    }
    if (features.telemetry) {
      telemetryApi.sources().then((r) => setTelemetrySources(r.data ?? null)).catch(() => setTelemetrySources(null));
    } else {
      setTelemetrySources(null);
    }
    if (features.reporting) {
      reportingApi.getOverview().then((r) => setOverview(r.data ?? null)).catch(() => {});
      dashboardReportingApi.get().then((r) => setReporting((r.data as DashboardReportingData) ?? null)).catch(() => {});
    } else {
      setOverview(null);
      setReporting(null);
    }
    if (sheriffAvailable) {
      modulesApi.getBackendOverview('robin-sheriff')
        .then((r) => setSheriffOverview(r.data ?? null))
        .catch(() => setSheriffOverview(null));
    } else {
      setSheriffOverview(null);
    }
  }, [features.fleet, features.monitoring, features.reporting, features.telemetry, sheriffAvailable]);

  useEffect(() => {
    void fetchStats();
  }, [fetchStats]);

  const toggleCard = async (id: string) => {
    const next = new Set(hidden);
    if (next.has(id)) next.delete(id); else next.add(id);
    setHidden(next);
    try { await dashboardApi.savePreferences([...next]); } catch { /* keep local state */ }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-8">
        <Spinner className="text-robin-orange" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-sm border border-red-200 bg-red-50 p-4 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
        {error}
      </div>
    );
  }

  if (!stats) return null;

  const presentTypes = features.fleet && fleet
    ? SERVICE_TYPE_LIST.filter((meta) => (fleet.byType[meta.type]?.length ?? 0) > 0)
    : [];
  const hasFleetServices = features.fleet && presentTypes.length > 0;
  const unhealthyServices = fleet ? fleet.overview.totalServices - fleet.overview.healthyServices : 0;
  const attentionCount = fleet ? fleet.services.filter((service) => serviceNeedsAttention(service)).length : 0;
  const capacityMeters = features.fleet && fleet
    ? presentTypes
        .flatMap((meta) => meta.capacityPeaks(fleet.byType[meta.type]))
        .map((peak) => ({ peak, pct: asPercentPeak(peak) }))
        .filter((entry): entry is { peak: CapacityPeakData; pct: number } => entry.pct !== null)
        .sort((a, b) => b.pct - a.pct)
        .slice(0, MAX_CAPACITY_METERS)
    : [];
  const pressures: PressureData[] = features.fleet && fleet
    ? presentTypes
        .map((meta) => (meta.pressure ? meta.pressure(fleet.overview.byType[meta.type]) : null))
        .filter((p): p is PressureData => p !== null)
    : [];
  const configWarningReasons = stats.configWarnings?.enabledReasons ?? [];
  const showConfigWarning = configWarningReasons.length > 0;

  const robinTotals = fleet?.overview.byType.robin?.totals as RobinFleetTotals | undefined;
  const postfixTotals = fleet?.overview.byType.postfix?.totals as PostfixFleetTotals | undefined;
  const hasRobinFleet = Boolean(features.robin && robinTotals && fleet && fleet.byType.robin.length > 0);
  const hasPostfixFallback = Boolean(!hasRobinFleet && features.postfix && postfixTotals && (fleet?.byType.postfix.length ?? 0) > 0);
  const dmarcBreakdown = overview?.totals.breakdown;
  const dmarcPct = dmarcBreakdown && dmarcBreakdown.totalVolume > 0
    ? (dmarcBreakdown.compliantVolume / dmarcBreakdown.totalVolume) * 100
    : null;
  const issuesTotal = reporting
    ? Object.values(reporting.issuesBySeverity ?? {}).reduce((sum, n) => sum + (n ?? 0), 0)
    : null;
  const monitoringCounts = getMonitoringCounts(monitoring);
  const hasMonitoring = Boolean(features.monitoring && monitoring && monitoring.checks.length > 0);
  const monitoringIssueCount = monitoring?.openIssues.length ?? 0;

  const telemetrySilent = telemetrySources ? telemetrySources.sources.filter((source) => source.silent).length : 0;
  const hasTelemetry = Boolean(features.telemetry && telemetrySources && telemetrySources.sources.length > 0);

  const tiles: KpiCardData[] = [];
  if (hasFleetServices && fleet) {
    tiles.push({
      label: 'Fleet health',
      value: `${formatNumber(fleet.overview.healthyServices)} / ${formatNumber(fleet.overview.totalServices)}`,
      icon: <ShieldCheck className="h-5 w-5" />,
      tone: unhealthyServices > 0 ? 'warning' : 'success',
      sub: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{unhealthyServices === 0 ? 'All services healthy' : `${unhealthyServices} need${unhealthyServices === 1 ? 's' : ''} attention`} · {attentionCount} signal{attentionCount === 1 ? '' : 's'}</span>
          <Link to="/fleet/metrics" className="inline-flex items-center gap-1 text-robin-orange">Metrics <ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
      ),
    });
  }
  const queueTotal = features.queue && stats.queue ? stats.queue.total : null;
  if (hasRobinFleet && robinTotals) {
    tiles.push({
      label: 'Mail flow · 24h',
      value: formatNumber(robinTotals.delivered24h),
      icon: <Send className="h-5 w-5" />,
      tone: queueTotal && queueTotal > 0 ? 'warning' : 'success',
      sub: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>delivered · {formatNumber(robinTotals.rejected24h)} rejected{queueTotal !== null ? ` · ${formatNumber(queueTotal)} queued` : ''}</span>
          {queueTotal !== null && <Link to="/robin/queue" className="inline-flex items-center gap-1 text-robin-orange">Robin queue <ArrowRight className="h-3.5 w-3.5" /></Link>}
        </div>
      ),
    });
  } else if (queueTotal !== null && stats.queue) {
    tiles.push({
      label: 'Robin queue',
      value: formatNumber(queueTotal),
      icon: <ListTodo className="h-5 w-5" />,
      tone: queueTotal > 0 ? 'warning' : 'success',
      toneValue: queueTotal > 0,
      sub: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>{queueStateSummary(stats.queue.byState)}</span>
          <Link to="/robin/queue" className="inline-flex items-center gap-1 text-robin-orange">Robin queue <ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
      ),
    });
  } else if (hasPostfixFallback && postfixTotals) {
    tiles.push({
      label: 'Postfix queue',
      value: formatNumber(postfixTotals.queueTotal),
      icon: <Inbox className="h-5 w-5" />,
      tone: postfixTotals.queueDeferred > 0 ? 'warning' : 'success',
      sub: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>Deferred {formatNumber(postfixTotals.queueDeferred)}</span>
          <Link to="/postfix/metrics" className="inline-flex items-center gap-1 text-robin-orange">Postfix metrics <ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
      ),
    });
  }
  if (hasMonitoring && monitoring) {
    tiles.push({
      label: 'External checks',
      value: `${formatNumber(monitoringCounts.up)} / ${formatNumber(monitoring.checks.length)}`,
      icon: <Activity className="h-5 w-5" />,
      tone: monitoringCounts.down > 0 ? 'danger' : monitoringCounts.warning > 0 ? 'warning' : 'success',
      sub: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>up · {formatNumber(monitoringCounts.down)} down{monitoringCounts.paused > 0 ? ` · ${formatNumber(monitoringCounts.paused)} paused` : ''}{monitoringIssueCount > 0 ? ` · ${monitoringIssueCount} open issue${monitoringIssueCount === 1 ? '' : 's'}` : ''}</span>
          <Link to="/monitoring" className="inline-flex items-center gap-1 text-robin-orange">Monitoring <ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
      ),
    });
  }
  if (dmarcPct !== null) {
    const bySeverity = reporting?.issuesBySeverity ?? ({} as Record<IssueSeverity, number>);
    tiles.push({
      label: 'DMARC compliant',
      value: `${dmarcPct.toFixed(2)}%`,
      icon: <ShieldCheck className="h-5 w-5" />,
      tone: issuesTotal && issuesTotal > 0 ? 'warning' : 'success',
      sub: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          {issuesTotal !== null ? (
            issuesTotal === 0
              ? <span>No open reporting issues</span>
              : <span>{formatNumber(issuesTotal)} open reporting issue{issuesTotal === 1 ? '' : 's'}</span>
          ) : <span>Reported compliance rate</span>}
          <div className="flex flex-wrap items-center gap-1.5">
            {SEVERITY_ORDER.filter((s) => (bySeverity[s] ?? 0) > 0).map((s) => (
              <span key={s} className={`rounded-full px-2 py-0.5 text-xs font-medium ${SEVERITY_TONE[s]}`}>{bySeverity[s]} {s}</span>
            ))}
            {features.reporting && <Link to="/reporting" className="inline-flex items-center gap-1 text-robin-orange">View <ArrowRight className="h-3.5 w-3.5" /></Link>}
          </div>
        </div>
      ),
    });
  }
  if (hasTelemetry && telemetrySources && tiles.length < 4) {
    tiles.push({
      label: 'Telemetry hosts',
      value: formatNumber(telemetrySources.sources.length - telemetrySilent),
      icon: <Activity className="h-5 w-5" />,
      tone: telemetrySilent > 0 ? 'warning' : 'success',
      sub: (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <span>reporting · {formatNumber(telemetrySilent)} silent</span>
          <Link to="/telemetry/sources" className="inline-flex items-center gap-1 text-robin-orange">Sources <ArrowRight className="h-3.5 w-3.5" /></Link>
        </div>
      ),
    });
  }
  const headlineTiles = tiles.slice(0, 4);

  const shortcuts: ShortcutData[] = [
    ...(features.mailboxes && features.users ? [{ label: 'Mail users', value: stats.users, icon: Users, color: 'text-blue-500', to: '/users' }] : []),
    ...(features.mailboxes && features.aliases ? [{ label: 'Aliases', value: stats.aliases, icon: AtSign, color: 'text-green-500', to: '/aliases' }] : []),
    ...(features.mailboxes && features.autoAliases ? [{ label: 'Auto aliases', value: stats.autoAliases, icon: Repeat, color: 'text-purple-500', to: '/auto-aliases' }] : []),
    { label: 'Admins', value: stats.admins, icon: Shield, color: 'text-indigo-500', to: '/administration/access' },
    ...(sheriffOverview ? [
      {
        label: 'Sheriff licences',
        value: sheriffOverview.licenseCount,
        icon: ShieldCheck,
        color: 'text-robin-orange',
        to: '/modules/robin-sheriff/licenses',
      },
      {
        label: 'Sheriff catalogue modules',
        value: sheriffOverview.moduleCount,
        icon: ShieldCheck,
        color: 'text-robin-orange',
        to: '/modules/robin-sheriff/catalogue',
      },
    ] : []),
  ];

  const cards: DashboardCard[] = [
    {
      id: 'mail-flow',
      label: hasRobinFleet ? 'Robin flow & queue pressure' : 'Mail flow',
      available: hasRobinFleet || hasPostfixFallback,
      weight: 2,
      render: () => hasRobinFleet && robinTotals
        ? <RobinFlowCard totals={robinTotals} queue={features.queue ? stats.queue : null} />
        : postfixTotals ? <PostfixQueueCard totals={postfixTotals} /> : null,
    },
    {
      id: 'monitoring',
      label: 'External monitoring',
      available: hasMonitoring,
      weight: 1,
      render: () => monitoring ? <MonitoringCard summary={monitoring} /> : null,
    },
    {
      id: 'telemetry',
      label: 'Telemetry hosts',
      available: hasTelemetry,
      weight: 2,
      render: () => telemetrySources ? <TelemetryHostsCard data={telemetrySources} /> : null,
    },
    {
      id: 'message-outcomes',
      label: 'Message outcomes',
      available: Boolean(features.reporting && overview && dmarcBreakdown),
      weight: 1,
      render: () => dmarcBreakdown ? <DashboardMessageOutcomesCard breakdown={dmarcBreakdown} trend={overview?.trend} /> : null,
    },
    {
      id: 'pressure',
      label: 'Protection pressure',
      available: Boolean(features.fleet && pressures.length > 0),
      weight: 1,
      render: () => <ProtectionPressureCard pressures={pressures} />,
    },
    {
      id: 'fleet',
      label: 'Fleet summary',
      available: Boolean(features.fleet && fleet && presentTypes.length > 0),
      weight: 3,
      render: () => fleet ? <FleetSummaryCard types={presentTypes} fleet={fleet} attentionCount={attentionCount} /> : null,
    },
    {
      id: 'capacity-peaks',
      label: 'Capacity peaks',
      available: Boolean(features.fleet && capacityMeters.length > 0),
      weight: 2,
      render: () => <CapacityMetersCard meters={capacityMeters} />,
    },
  ];
  const snapshotVisible = shortcuts.length > 0 && !hidden.has('snapshot');
  const customizableCards = [...cards, { id: 'snapshot', label: 'Quick links', available: shortcuts.length > 0 }];
  const cardRows = pairDashboardCards(cards.filter((card) => card.available && !hidden.has(card.id)));
  const setupItems = [
    !features.mailboxes ? {
      title: 'Enable mailboxes',
      description: 'Manage mailbox accounts and aliases using the configured database.',
      to: '/administration/integration?tab=capabilities',
      icon: Users,
    } : null,
    !features.fleetEnabled ? {
      title: 'Enable fleet',
      description: 'Register services before showing fleet dashboards, metrics, config, and logs.',
      to: '/administration/integration?tab=capabilities',
      icon: ShieldCheck,
    } : null,
    !features.monitoringEnabled ? {
      title: 'Enable monitoring',
      description: 'Turn on external checks, status-page management, and the Monitoring scheduler.',
      to: '/administration/integration?tab=capabilities',
      icon: Activity,
    } : null,
    !features.reporting ? {
      title: 'Enable reports',
      description: 'Show DMARC, TLSRPT, forensic, and domain-intelligence workspaces.',
      to: '/administration/reporting',
      icon: ListTodo,
    } : null,
    !features.modulesEnabled ? {
      title: 'Enable modules',
      description: 'Prepare Sheriff keys, installer signing, and proxy secrets before installing modules.',
      to: '/administration/integration?tab=modules',
      icon: Package,
    } : null,
  ].filter((item): item is {
    title: string;
    description: string;
    to: string;
    icon: LucideIcon;
  } => item !== null);

  return (
    <div className="space-y-6">
      <PageHeader
        icon={appIcons.dashboard}
        title="Dashboard"
        description={features.robin || features.reporting || hasFleetServices || hasMonitoring
          ? 'Monitor fleet health, mail flow, external checks, and protection pressure from one workspace.'
          : 'Manage Robin Admin access and available services from one workspace.'}
        actions={(
          <div className="flex items-center gap-2">
            <button onClick={() => setShowCustomize(true)} className="btn btn-secondary">
              <SlidersHorizontal className="h-4 w-4" />
              Customize
            </button>
            <button onClick={() => void fetchStats(true)} disabled={isRefreshing} className="btn btn-secondary">
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              {isRefreshing ? 'Refreshing...' : 'Refresh'}
            </button>
          </div>
        )}
      />

      {showConfigWarning && (
        <div className="flex items-start gap-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800 dark:border-amber-900/40 dark:bg-amber-900/10 dark:text-amber-200">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
          <p>
            <strong>Warning: </strong>{' '}
            {configWarningReasons.join(' and ')} {configWarningReasons.length === 1 ? 'is' : 'are'} currently enabled.
          </p>
        </div>
      )}

      {monitoring && monitoring.openIssues.length > 0 && (
        <MonitoringIssueBanner issues={monitoring.openIssues} counts={monitoringCounts} />
      )}

      {showSetup && setupItems.length > 0 && (
        <section className="card p-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-semibold">First-time setup</h2>
              <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">
                Enable optional capabilities as their secrets, endpoints, and owners are ready.
              </p>
            </div>
            <button type="button" onClick={dismissSetup} className="btn btn-secondary">
              Dismiss
            </button>
          </div>
          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            {setupItems.map((item) => {
              const Icon = item.icon;
              return (
                <Link
                  key={item.title}
                  to={item.to}
                  className="rounded-lg border border-gray-200 p-4 transition hover:border-robin-orange/50 hover:bg-robin-orange/5 dark:border-robin-gray-700 dark:hover:border-robin-orange/50 dark:hover:bg-robin-orange/10"
                >
                  <Icon className="h-5 w-5 text-robin-orange" />
                  <h3 className="mt-3 text-sm font-semibold">{item.title}</h3>
                  <p className="mt-1 text-xs leading-5 text-gray-500 dark:text-gray-400">{item.description}</p>
                </Link>
              );
            })}
          </div>
        </section>
      )}

      {headlineTiles.length > 0 && (
        <section className={`grid gap-4 ${TILE_GRID_CLASS[headlineTiles.length]}`}>
          {headlineTiles.map((tile) => <MetricCard key={tile.label} {...tile} />)}
        </section>
      )}

      {cardRows.map((row) => (
        <section
          key={row.map((slot) => slot.map((card) => card.id).join('/')).join('+')}
          className="grid grid-cols-1 gap-6 xl:grid-cols-(--pair-columns)"
          style={{ '--pair-columns': row.map((slot) => `minmax(0, ${Math.max(...slot.map((card) => card.weight))}fr)`).join(' ') } as CSSProperties}
        >
          {row.map((slot) => (
            <div key={slot.map((card) => card.id).join('/')} className="flex min-w-0 flex-col gap-6 [&>*]:flex-1">
              {slot.map((card) => <div key={card.id} className="flex min-w-0 flex-col [&>*]:flex-1">{card.render()}</div>)}
            </div>
          ))}
        </section>
      ))}

      {snapshotVisible && <OperationalSnapshotCard shortcuts={shortcuts} />}

      <Modal isOpen={showCustomize} onClose={() => setShowCustomize(false)} title="Customize dashboard">
        <div className="space-y-2">
          <p className="text-sm text-gray-500 dark:text-gray-400">Choose which sections appear on your dashboard. Saved to your account.</p>
          <div className="mt-3 divide-y divide-gray-100 dark:divide-gray-800">
            {customizableCards.filter((card) => card.available).map((card) => (
              <label key={card.id} className="flex cursor-pointer items-center justify-between py-3">
                <span className="text-sm font-medium">{card.label}</span>
                <input
                  type="checkbox"
                  className="h-4 w-4 accent-robin-orange"
                  checked={!hidden.has(card.id)}
                  onChange={() => void toggleCard(card.id)}
                />
              </label>
            ))}
          </div>
        </div>
      </Modal>
    </div>
  );
}

function MonitoringIssueBanner({
  issues,
  counts,
}: {
  issues: MonitoringIssue[];
  counts: ReturnType<typeof getMonitoringCounts>;
}) {
  return (
    <section className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-900 dark:border-red-900/40 dark:bg-red-900/10 dark:text-red-100">
      <div className="flex flex-col gap-3 md:flex-row md:items-start">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-red-600 dark:text-red-300" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">Monitoring needs attention</h2>
              {counts.down > 0 && <StatusPill status="down">{counts.down} down</StatusPill>}
              {counts.warning > 0 && <StatusPill status="warning">{counts.warning} warning</StatusPill>}
              <span className="text-xs text-red-700 dark:text-red-200">last checked {formatDateTime(getLatestMonitoringRun(issues))}</span>
            </div>
            <div className="mt-3 grid gap-2 lg:grid-cols-2">
              {issues.slice(0, 4).map((issue) => (
                <div key={issue.id} className="min-w-0 rounded-sm border border-red-200 bg-white/70 px-3 py-2 dark:border-red-900/40 dark:bg-red-950/20">
                  <div className="truncate font-medium">{issue.targetName} / {issue.checkName}</div>
                  <div className="truncate text-xs text-red-700 dark:text-red-200">{issue.summary}</div>
                </div>
              ))}
            </div>
          </div>
        </div>
        <Link to="/monitoring" className="inline-flex items-center gap-1 font-medium text-robin-orange hover:underline">
          View issues <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}

function RobinFlowCard({ totals, queue }: { totals: RobinFleetTotals; queue: DashboardStats['queue'] | null }) {
  const totalFlow = totals.delivered24h + totals.rejected24h;
  const deliveredPct = toPct(totals.delivered24h, totalFlow);
  const rejectedPct = toPct(totals.rejected24h, totalFlow);
  const queueTotal = queue?.total ?? 0;
  const queueStates = queue?.byState ?? {};
  return (
    <section className="card flex h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Robin flow & queue pressure</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Delivery, rejection, and relay backlog from Robin.</p>
        </div>
        <Link to="/robin/metrics" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-robin-orange hover:underline">
          Robin metrics <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <strong className="text-3xl font-semibold tabular-nums">{formatNumber(totals.delivered24h)}</strong>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          delivered in 24h · {formatNumber(totals.received24h)} SMTP connections · {formatNumber(totals.rejected24h)} rejected
        </span>
      </div>
      <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-gray-200 dark:bg-robin-gray-700">
        {totals.delivered24h > 0 && <div className="bg-green-500" style={{ width: `${deliveredPct}%` }} title={`Delivered ${formatExact(totals.delivered24h)}`} />}
        {totals.rejected24h > 0 && <div className="bg-red-500" style={{ width: `${rejectedPct}%` }} title={`Rejected ${formatExact(totals.rejected24h)}`} />}
      </div>
      <div className="mt-5 grid gap-3 sm:grid-cols-3">
        <MiniPanel label="Queued now" value={formatNumber(queueTotal)} tone={queueTotal > 0 ? 'warning' : 'success'} />
        <MiniPanel label="Pending" value={formatNumber(findQueueCount(queueStates, ['pending', 'queued', 'ready']))} />
        <MiniPanel label="Failed / deferred" value={formatNumber(findQueueCount(queueStates, ['failed', 'deferred', 'retry']))} tone={findQueueCount(queueStates, ['failed', 'deferred', 'retry']) > 0 ? 'danger' : 'neutral'} />
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <span>Avg CPU {formatNumber(totals.avgCpuPct)}% · Avg memory {formatNumber(totals.avgMemoryPct)}%</span>
        <Link to="/robin/queue" className="inline-flex items-center gap-1 font-medium text-robin-orange hover:underline">
          Robin queue <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
    </section>
  );
}

function PostfixQueueCard({ totals }: { totals: PostfixFleetTotals }) {
  return (
    <section className="card flex h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Postfix queue pressure</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Fallback mail pressure card for Postfix-only deployments.</p>
        </div>
        <Link to="/postfix/metrics" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-robin-orange hover:underline">
          Postfix metrics <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="grid gap-3 sm:grid-cols-4">
        <MiniPanel label="Queue total" value={formatNumber(totals.queueTotal)} />
        <MiniPanel label="Deferred" value={formatNumber(totals.queueDeferred)} tone={totals.queueDeferred > 0 ? 'warning' : 'success'} />
        <MiniPanel label="Active" value={formatNumber(totals.queueActive)} />
        <MiniPanel label="Oldest deferred" value={formatDuration(totals.maxDeferredAgeSecs)} />
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-4 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <span>Peak queue {formatNumber(totals.peakQueue24h)} · peak deferred {formatNumber(totals.peakDeferred24h)} in 24h</span>
      </div>
    </section>
  );
}

function DashboardMessageOutcomesCard({ breakdown, trend }: { breakdown: TaxonomyBreakdown; trend?: TrendPoint[] }) {
  const compliantRate = breakdown.totalVolume > 0 ? (breakdown.compliantVolume / breakdown.totalVolume) * 100 : 0;
  const segments = [
    { label: 'Compliant', value: breakdown.compliantVolume, className: 'bg-green-500' },
    { label: 'Authenticated only', value: breakdown.authenticatedUnalignedVolume, className: 'bg-amber-500' },
    { label: 'Forwarded / relayed', value: breakdown.benignRelayVolume, className: 'bg-sky-500' },
    { label: 'Needs attention', value: breakdown.actionableFailureVolume, className: 'bg-red-500' },
  ];
  const total = breakdown.totalVolume || 1;
  const trendPoints = trend?.filter((point) => Number.isFinite(point.complianceRate)) ?? [];
  const latestTrend = trendPoints.length > 0 ? trendPoints[trendPoints.length - 1] : undefined;
  const averageTrend = trendPoints.length > 0
    ? trendPoints.reduce((sum, point) => sum + point.complianceRate, 0) / trendPoints.length
    : null;
  const lowestTrend = trendPoints.length > 0
    ? trendPoints.reduce((lowest, point) => point.complianceRate < lowest.complianceRate ? point : lowest, trendPoints[0])
    : null;
  const formatComplianceRate = (value: number | null | undefined) => (
    typeof value === 'number' && Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : '0.00%'
  );
  const complianceTone = (value: number | null | undefined): 'success' | 'warning' => (
    typeof value === 'number' && value >= 0.98 ? 'success' : 'warning'
  );
  return (
    <section className="card flex h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Message outcomes</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">DMARC compliance with absolute volume beside the rate.</p>
        </div>
        <Link to="/reporting" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-robin-orange hover:underline">
          Reporting <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1">
        <strong className="text-3xl font-semibold tabular-nums">{compliantRate.toFixed(2)}%</strong>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          {formatExact(breakdown.totalVolume)} total messages · {formatExact(breakdown.actionableFailureVolume)} need attention
        </span>
      </div>
      <div className="mt-4 flex h-2.5 overflow-hidden rounded-full bg-gray-200 dark:bg-robin-gray-700">
        {segments.map((segment) => (
          segment.value > 0
            ? <div key={segment.label} className={segment.className} style={{ width: `${(segment.value / total) * 100}%` }} title={`${segment.label}: ${formatExact(segment.value)}`} />
            : null
        ))}
      </div>
      <div className="mt-4 grid gap-3 border-t border-gray-200 pt-4 text-xs dark:border-robin-gray-700 sm:grid-cols-2 lg:grid-cols-4">
        {segments.map((segment) => (
          <div key={segment.label}>
            <div className="text-gray-500 dark:text-gray-400">{segment.label}</div>
            <div className="mt-0.5 font-medium tabular-nums">{formatExact(segment.value)}</div>
          </div>
        ))}
      </div>
      {trendPoints.length > 0 && (
        <div className="mt-4 border-t border-gray-200 pt-4 dark:border-robin-gray-700">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="text-xs font-medium text-gray-500 dark:text-gray-400">Daily compliance rate</div>
            <div className="flex items-center gap-1.5" aria-label="Recent daily compliance markers">
              {trendPoints.slice(-14).map((point) => (
                <span
                  key={point.date}
                  className={`h-2.5 w-2.5 rounded-full ${point.complianceRate >= 0.98 ? 'bg-green-500' : 'bg-amber-500'}`}
                  title={`${point.date}: ${formatComplianceRate(point.complianceRate)}`}
                />
              ))}
            </div>
          </div>
          <div className="grid gap-2 sm:grid-cols-3">
            <MiniPanel label="Latest day" value={formatComplianceRate(latestTrend?.complianceRate)} tone={complianceTone(latestTrend?.complianceRate)} />
            <MiniPanel label="Lowest day" value={formatComplianceRate(lowestTrend?.complianceRate)} tone={complianceTone(lowestTrend?.complianceRate)} />
            <MiniPanel label={`${trendPoints.length}-day average`} value={formatComplianceRate(averageTrend)} tone={complianceTone(averageTrend)} />
          </div>
        </div>
      )}
    </section>
  );
}

function TelemetryHostsCard({ data }: { data: TelemetrySources }) {
  const { sources } = data;
  const silent = sources.filter((source) => source.silent);
  const limit = 3;
  return (
    <section className="card flex h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Telemetry sources</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Discovered telemetry senders.</p>
        </div>
        <Link to="/telemetry/sources" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-robin-orange hover:underline">
          Sources <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-2">
        <MiniPanel label="Reporting" value={formatNumber(sources.length - silent.length)} tone="success" />
        <MiniPanel label="Silent" value={formatNumber(silent.length)} tone={silent.length > 0 ? 'warning' : 'neutral'} />
      </div>
      <div className="mt-4 divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-800 dark:border-gray-800">
        {silent.length > 0 ? silent.slice(0, limit).map((source) => (
          <Link key={source.name} to={`/telemetry/explore?q=${encodeURIComponent(source.query)}`} className="flex min-w-0 items-center gap-2 py-2.5 hover:text-robin-orange">
            <StatusDot status="warning" />
            <span className="truncate text-sm font-medium">{source.name}</span>
            <span className="ml-auto shrink-0 text-xs text-gray-500 dark:text-gray-400">{source.groups.join(', ')}</span>
          </Link>
        )) : (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500 dark:text-gray-400">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            Every displayed source reported in the last {formatSpan(data.silentAfterSeconds)}
          </div>
        )}
      </div>
      {data.truncated && <p className="mt-3 text-xs text-amber-700 dark:text-amber-300">Source results are limited; counts may be incomplete.</p>}
      {silent.length > limit && (
        <div className="mt-auto border-t border-gray-200 pt-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
          {silent.length - limit} more silent source{silent.length - limit === 1 ? '' : 's'}
        </div>
      )}
    </section>
  );
}

function MonitoringCard({ summary }: { summary: MonitoringSummary }) {
  const counts = getMonitoringCounts(summary);
  const issueLimit = 3;
  return (
    <section className="card flex h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">External monitoring</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Independent checks without duplicating fleet metrics.</p>
        </div>
        <Link to="/monitoring" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-robin-orange hover:underline">
          Checks <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-2 2xl:grid-cols-4">
        <MiniPanel label="Up" value={formatNumber(counts.up)} tone="success" />
        <MiniPanel label="Warning" value={formatNumber(counts.warning)} tone={counts.warning > 0 ? 'warning' : 'neutral'} />
        <MiniPanel label="Down" value={formatNumber(counts.down)} tone={counts.down > 0 ? 'danger' : 'neutral'} />
        <MiniPanel label="Paused" value={formatNumber(counts.paused)} />
      </div>
      <div className="mt-4 divide-y divide-gray-100 border-t border-gray-100 dark:divide-gray-800 dark:border-gray-800">
        {summary.openIssues.length > 0 ? summary.openIssues.slice(0, issueLimit).map((issue) => (
          <div key={issue.id} className="flex min-w-0 items-start gap-2 py-2.5">
            <StatusDot status={issue.severity === 'critical' ? 'down' : 'warning'} />
            <div className="min-w-0">
              <div className="truncate text-sm font-medium">{issue.targetName} / {issue.checkName}</div>
              <div className="truncate text-xs text-gray-500 dark:text-gray-400">{issue.summary}</div>
            </div>
          </div>
        )) : (
          <div className="flex items-center gap-2 py-4 text-sm text-gray-500 dark:text-gray-400">
            <CheckCircle2 className="h-4 w-4 text-green-500" />
            No open monitoring issues
          </div>
        )}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <span>Last run {formatDateTime(getLatestCheckRun(summary.checks))}</span>
        {summary.openIssues.length > issueLimit && (
          <span>{summary.openIssues.length - issueLimit} more issue{summary.openIssues.length - issueLimit === 1 ? '' : 's'}</span>
        )}
      </div>
    </section>
  );
}

function CapacityMetersCard({ meters }: { meters: Array<{ peak: CapacityPeakData; pct: number }> }) {
  return (
    <section className="card flex h-full flex-col p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Capacity peaks</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Highest-utilization capacity metrics across enabled fleet services.</p>
      </div>
      <div className="space-y-4">
        {meters.map(({ peak, pct }) => (
          <div key={peak.label}>
            <div className="mb-1.5 flex items-center justify-between gap-3 text-sm">
              <span>{peak.label}</span>
              <strong className="font-semibold tabular-nums">{peak.value}</strong>
            </div>
            <div className="h-1.5 w-full overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700">
              <div
                className={`h-full rounded-full ${pct >= 80 ? 'bg-amber-500' : 'bg-robin-orange'}`}
                style={{ width: `${Math.min(100, Math.max(0, pct))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
      <Link to="/fleet/metrics" className="mt-auto inline-flex items-center gap-1.5 pt-5 text-xs font-medium text-robin-orange hover:underline">
        Per-service peaks in Metrics <ArrowRight className="h-3.5 w-3.5" />
      </Link>
    </section>
  );
}

function FleetSummaryCard({
  types,
  fleet,
  attentionCount,
}: {
  types: ServiceTypeMeta[];
  fleet: FleetDashboard;
  attentionCount: number;
}) {
  return (
    <section className="card flex h-full flex-col p-5">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">Fleet summary</h2>
          <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Only enabled service types are shown here.</p>
        </div>
        <Link to="/fleet/metrics" className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-robin-orange hover:underline">
          Metrics <ArrowRight className="h-3.5 w-3.5" />
        </Link>
      </div>
      <div className="divide-y divide-gray-100 dark:divide-gray-800">
        {types.map((meta) => {
          const entry = fleet.overview.byType[meta.type];
          const headline = meta.headlineCard(entry);
          const allHealthy = entry.healthyServices === entry.totalServices;
          const Icon = meta.icon;
          return (
            <div key={meta.type} className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-3 py-2.5 first:pt-0 last:pb-0">
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg ${meta.badgeClass}`}>
                <Icon className="h-4 w-4" />
              </span>
              <div className="min-w-0">
                <div className="truncate text-sm font-semibold">{meta.label}</div>
                <div className={`text-xs ${allHealthy ? 'text-green-700 dark:text-green-400' : 'text-red-700 dark:text-red-400'}`}>
                  {headline.status}
                </div>
              </div>
              <div className="min-w-0 text-right">
                <div className="text-sm font-semibold tabular-nums">{headline.primaryValue}</div>
                <div className="text-[11px] text-gray-500 dark:text-gray-400">{headline.primaryLabel}</div>
              </div>
            </div>
          );
        })}
      </div>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 border-t border-gray-200 pt-3 text-xs text-gray-500 dark:border-gray-700 dark:text-gray-400">
        <span>{types.length} type{types.length === 1 ? '' : 's'} · {fleet.overview.totalServices} services · {attentionCount} metric signal{attentionCount === 1 ? '' : 's'} need attention</span>
      </div>
    </section>
  );
}

function ProtectionPressureCard({ pressures }: { pressures: PressureData[] }) {
  // The card shares its row, so layers stack: side by side, legends truncate.
  return (
    <section className="card flex h-full flex-col p-5">
      <div className="mb-4">
        <h2 className="text-lg font-semibold">Protection pressure</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">Only active protection layers represented by fleet metrics are included.</p>
      </div>
      <div className="grid gap-5">
        {pressures.map((pressure) => (
          <div key={pressure.title} className="min-w-0">
            <div className="mb-3 flex items-start justify-between gap-3">
              <h3 className="text-sm font-semibold">{pressure.title}</h3>
              <span className="rounded-full bg-gray-100 px-2.5 py-0.5 text-xs font-medium text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300">
                {pressure.totalLabel}
              </span>
            </div>
            {pressure.values.every((value) => value === 0) ? (
              <p className="flex items-center gap-1.5 text-xs text-gray-500 dark:text-gray-400">
                <CheckCircle2 className="h-3.5 w-3.5 text-green-500" aria-hidden="true" />
                Nothing blocked in the last 24 hours ({pressure.labels.join(', ')}).
              </p>
            ) : (
            <div className="flex items-start gap-4">
              <DonutChart values={pressure.values} colors={pressure.colors} labels={pressure.labels} size={90} strokeWidth={16} showLegend={false} />
              <div className="grid flex-1 grid-cols-1 gap-y-1.5 sm:grid-cols-2 sm:gap-x-4">
                {pressure.labels.map((label, index) => (
                  <div key={label} className="flex items-center justify-between gap-3 text-xs">
                    <span className="flex min-w-0 items-center gap-1.5 text-gray-500 dark:text-gray-400">
                      <span className="h-2 w-2 shrink-0 rounded-full" style={{ backgroundColor: pressure.colors[index] }} />
                      <span className="truncate">{label}</span>
                    </span>
                    <span className="font-medium tabular-nums">{formatNumber(pressure.values[index])}</span>
                  </div>
                ))}
              </div>
            </div>
            )}
          </div>
        ))}
      </div>
    </section>
  );
}

function OperationalSnapshotCard({ shortcuts }: { shortcuts: ShortcutData[] }) {
  return (
    <section className="card space-y-4 p-5">
      <div>
        <h2 className="text-lg font-semibold">Quick links</h2>
        <p className="mt-0.5 text-xs text-gray-500 dark:text-gray-400">The areas operators open most often.</p>
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {shortcuts.map((shortcut) => <ShortcutCard key={shortcut.label} {...shortcut} />)}
      </div>
    </section>
  );
}

function MiniPanel({
  label,
  value,
  tone = 'neutral',
}: {
  label: string;
  value: ReactNode;
  tone?: 'neutral' | 'success' | 'warning' | 'danger';
}) {
  const toneClass = {
    neutral: 'bg-gray-50 text-gray-900 dark:bg-robin-gray-800 dark:text-white',
    success: 'bg-green-50 text-green-800 dark:bg-green-900/20 dark:text-green-300',
    warning: 'bg-amber-50 text-amber-800 dark:bg-amber-900/20 dark:text-amber-300',
    danger: 'bg-red-50 text-red-800 dark:bg-red-900/20 dark:text-red-300',
  }[tone];
  return (
    <div className={`rounded-lg p-3 ${toneClass}`}>
      <div className="text-xl font-semibold tabular-nums">{value}</div>
      <div className="mt-0.5 text-xs opacity-80">{label}</div>
    </div>
  );
}

function StatusPill({ status, children }: { status: MonitoringStatus; children: ReactNode }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STATUS_TONE[status]}`}>
      {children}
    </span>
  );
}

function StatusDot({ status }: { status: MonitoringStatus }) {
  const className = {
    up: 'bg-green-500',
    warning: 'bg-amber-500',
    down: 'bg-red-500',
    unknown: 'bg-gray-400',
  }[status];
  return <span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${className}`} />;
}

function ShortcutCard({ label, value, icon: Icon, color, to }: ShortcutData) {
  return (
    <Link to={to} className="card group flex items-center gap-4 p-5 transition-colors hover:border-robin-orange">
      <Icon className={`h-6 w-6 ${color}`} />
      <div>
        <span className="text-sm text-gray-500 dark:text-gray-400">{label}</span>
        <strong className="block text-2xl font-bold tracking-tight text-gray-900 dark:text-white">{value.toLocaleString()}</strong>
      </div>
      <ArrowRight className="ml-auto h-4 w-4 text-robin-orange transition-transform group-hover:translate-x-0.5" />
    </Link>
  );
}

function getMonitoringCounts(summary: MonitoringSummary | null) {
  const initial: Record<MonitoringStatus | 'paused', number> = {
    up: 0,
    warning: 0,
    down: 0,
    unknown: 0,
    paused: 0,
  };
  if (!summary) return initial;
  return summary.checks.reduce((counts, check) => {
    if (check.pausedAt) counts.paused += 1;
    else counts[check.currentStatus] += 1;
    return counts;
  }, initial);
}

function getLatestCheckRun(checks: MonitoringCheck[]): string | null {
  return checks
    .map((check) => check.lastRunAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
}

function getLatestMonitoringRun(issues: MonitoringIssue[]): string | null {
  return issues
    .map((issue) => issue.updatedAt || issue.openedAt)
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => new Date(right).getTime() - new Date(left).getTime())[0] ?? null;
}

function queueStateSummary(byState: Record<string, number>): string {
  const entries = Object.entries(byState).filter(([, count]) => count > 0);
  if (entries.length === 0) return 'No queued messages';
  return entries
    .sort(([, left], [, right]) => right - left)
    .slice(0, 2)
    .map(([state, count]) => `${state} ${formatNumber(count)}`)
    .join(' · ');
}

function findQueueCount(byState: Record<string, number>, keys: string[]): number {
  const normalized = new Map(Object.entries(byState).map(([key, value]) => [key.toLowerCase(), value]));
  return keys.reduce((sum, key) => sum + (normalized.get(key.toLowerCase()) ?? 0), 0);
}

function isRobinService(service: FleetDashboardService): service is RobinFleetDashboardService {
  return service.serviceType === 'robin';
}

function isRspamdService(service: FleetDashboardService): service is Extract<FleetDashboardService, { serviceType: 'rspamd' }> {
  return service.serviceType === 'rspamd';
}

function isClamavService(service: FleetDashboardService): service is Extract<FleetDashboardService, { serviceType: 'clamav' }> {
  return service.serviceType === 'clamav';
}

function isDovecotService(service: FleetDashboardService): service is Extract<FleetDashboardService, { serviceType: 'dovecot' }> {
  return service.serviceType === 'dovecot';
}

function isPostfixService(service: FleetDashboardService): service is Extract<FleetDashboardService, { serviceType: 'postfix' }> {
  return service.serviceType === 'postfix';
}

function isRedisService(service: FleetDashboardService): service is Extract<FleetDashboardService, { serviceType: 'redis' }> {
  return service.serviceType === 'redis';
}

function isPostgresService(service: FleetDashboardService): service is Extract<FleetDashboardService, { serviceType: 'postgres' }> {
  return service.serviceType === 'postgres';
}

function isMariadbService(service: FleetDashboardService): service is Extract<FleetDashboardService, { serviceType: 'mariadb' }> {
  return service.serviceType === 'mariadb';
}

// A stuck transaction holds row locks and blocks purge (long-running idle transactions).
const MARIADB_STUCK_TRANSACTION_SECS = 300;

function serviceNeedsAttention(service: FleetDashboardService): boolean {
  if (!service.healthy) return true;
  if (!service.metrics) return false;
  if (isRobinService(service)) return service.metrics.memoryPct >= 80 || service.metrics.cpuPct >= 80;
  if (isRspamdService(service)) return !service.metrics.normalWorkerPingOk || !service.metrics.controllerAuthenticated;
  if (service.serviceType === 'cyrus') return !service.metrics.reachable;
  if (isDovecotService(service)) return !service.metrics.reachable;
  if (isPostfixService(service)) return !service.metrics.reachable || service.metrics.queueDeferred > 0;
  if (isClamavService(service)) return !service.metrics.pingOk;
  if (isRedisService(service)) return !service.metrics.reachable || service.metrics.evictedKeys24h > 0;
  if (isPostgresService(service)) return !service.metrics.reachable || service.metrics.deadlocks24h > 0 || service.metrics.connectionSaturationPct >= 80;
  if (isMariadbService(service)) {
    return !service.metrics.reachable
      || service.metrics.deadlocks24h > 0
      || service.metrics.connectionSaturationPct >= 80
      || service.metrics.oldestTrxAgeSecs >= MARIADB_STUCK_TRANSACTION_SECS
      || (service.metrics.isReplica && service.metrics.secondsBehindSource === null);
  }
  return false;
}
