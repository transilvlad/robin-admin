import type { LucideIcon } from 'lucide-react';
import { Activity, Cylinder, Database, DatabaseZap, Inbox, Mail, Server, Zap } from 'lucide-react';
import { formatBytes, formatMetricNumber, formatMetricPercent, formatMetricRatio } from '../utils/format';
import type {
  ClamavFleetMetrics,
  ClamavFleetTotals,
  DovecotFleetMetrics,
  DovecotFleetTotals,
  FleetDashboardService,
  MariadbFleetMetrics,
  MariadbFleetTotals,
  PostfixFleetMetrics,
  PostfixFleetTotals,
  PostgresFleetMetrics,
  PostgresFleetTotals,
  RedisFleetMetrics,
  RedisFleetTotals,
  RobinFleetMetrics,
  RobinFleetTotals,
  RspamdFleetMetrics,
  RspamdFleetTotals,
} from '../types';

/**
 * Single source of truth for the set of fleet service types + their display and
 * dashboard-projection metadata. The dashboard, fleet pages, sidebar, and page
 * selectors all iterate this registry so every registered service shows up
 * generically — adding a type is one entry here, never per-file branching.
 */
export const FLEET_SERVICE_TYPES = ['robin', 'rspamd', 'clamav', 'dovecot', 'postfix', 'redis', 'postgres', 'mariadb'] as const;
export type FleetServiceType = (typeof FLEET_SERVICE_TYPES)[number];

export type ServiceTone = 'blue' | 'purple' | 'amber' | 'teal' | 'indigo' | 'rose' | 'sky' | 'emerald';
// Tone unions that match the dashboard card components' own prop types exactly.
export type OverviewTone = 'blue' | 'purple' | 'amber' | 'teal' | 'indigo' | 'rose' | 'sky' | 'emerald';
export type ThroughputTone = 'blue' | 'green' | 'red' | 'amber';

function fmt(n: number): string {
  return Number.isFinite(n) ? formatMetricNumber(n) : '0';
}

function fmtDuration(secs: number): string {
  if (!Number.isFinite(secs) || secs <= 0) return '0s';
  if (secs < 60) return `${Math.round(secs)}s`;
  if (secs < 3600) return `${Math.round(secs / 60)}m`;
  if (secs < 86400) return `${Math.round(secs / 3600)}h`;
  return `${Math.round(secs / 86400)}d`;
}

export interface ServiceOverviewCardData {
  title: string;
  status: string;
  primaryLabel: string;
  primaryValue: string;
  secondaryLabel: string;
  secondaryValue: string;
  footer: string;
  tone: OverviewTone;
}

export interface ThroughputCardData {
  title: string;
  value: string;
  subtitle: string;
  tone: ThroughputTone;
}

export interface CapacityPeakData {
  label: string;
  value: string;
  emphasize?: boolean;
}

export interface PressureData {
  title: string;
  totalLabel: string;
  values: number[];
  labels: string[];
  colors: string[];
}

/** A per-type entry of the server's `overview.byType`. */
type ByTypeEntry = { totalServices: number; healthyServices: number; totals: unknown };

export interface ServiceTypeMeta {
  type: FleetServiceType;
  label: string;
  icon: LucideIcon;
  tone: ServiceTone;
  badgeClass: string;
  /** URL prefix for this type's pages, e.g. `/dovecot`. Empty when it has no dedicated pages. */
  routeBase: string;
  hasMetricsPage: boolean;
  hasConfigPage: boolean;
  headlineCard: (entry: ByTypeEntry) => ServiceOverviewCardData;
  throughputCards: (entry: ByTypeEntry) => ThroughputCardData[];
  capacityPeaks: (services: FleetDashboardService[]) => CapacityPeakData[];
  pressure?: (entry: ByTypeEntry) => PressureData | null;
}

const BADGE: Record<ServiceTone, string> = {
  blue: 'bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300',
  purple: 'bg-purple-100 text-purple-700 dark:bg-purple-900/30 dark:text-purple-300',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300',
  teal: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-300',
  indigo: 'bg-indigo-100 text-indigo-700 dark:bg-indigo-900/30 dark:text-indigo-300',
  rose: 'bg-rose-100 text-rose-700 dark:bg-rose-900/30 dark:text-rose-300',
  sky: 'bg-sky-100 text-sky-700 dark:bg-sky-900/30 dark:text-sky-300',
  emerald: 'bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300',
};

function status(entry: ByTypeEntry): string {
  return `${entry.healthyServices}/${entry.totalServices} healthy`;
}

function peak<T>(services: FleetDashboardService[], pick: (metrics: NonNullable<T>) => number): number {
  return services.reduce((max, service) => {
    const m = (service as { metrics: T | null }).metrics;
    return m ? Math.max(max, pick(m as NonNullable<T>)) : max;
  }, 0);
}

// Like `peak`, but as a percentage of each service's own capacity ceiling
// (e.g. memory used / memory limit) rather than a raw peak value — only
// meaningful when that ceiling is actually configured, so services reporting
// a zero/unset ceiling are skipped instead of producing a bogus percentage.
function peakPercent<T>(
  services: FleetDashboardService[],
  used: (metrics: NonNullable<T>) => number,
  ceiling: (metrics: NonNullable<T>) => number
): number | null {
  let highest: number | null = null;
  for (const service of services) {
    const m = (service as { metrics: T | null }).metrics;
    if (!m) continue;
    const max = ceiling(m as NonNullable<T>);
    if (!(max > 0)) continue;
    const pct = (used(m as NonNullable<T>) / max) * 100;
    if (highest === null || pct > highest) highest = pct;
  }
  return highest;
}

export const SERVICE_TYPE_REGISTRY: Record<FleetServiceType, ServiceTypeMeta> = {
  robin: {
    type: 'robin',
    label: 'Robin',
    icon: Server,
    tone: 'blue',
    badgeClass: BADGE.blue,
    routeBase: '/robin',
    hasMetricsPage: true,
    hasConfigPage: true,
    headlineCard: (entry) => {
      const t = entry.totals as RobinFleetTotals;
      return {
        title: 'Robin', status: status(entry), tone: 'blue',
        // `received24h`/`totalReceived` are sourced from robin_email_receipt_start
        // — every SMTP connection GREETED, not messages. Robin's actual accepted
        // message count is receipt_success ("Delivered"). Label honestly so a port
        // being probed doesn't read as thousands of "received" emails.
        primaryLabel: 'Delivered (24h)', primaryValue: fmt(t.delivered24h),
        secondaryLabel: 'Connections (24h)', secondaryValue: fmt(t.received24h),
        footer: `Rejected ${fmt(t.rejected24h)} · Avg CPU ${formatMetricPercent(t.avgCpuPct)}`,
      };
    },
    throughputCards: (entry) => {
      const t = entry.totals as RobinFleetTotals;
      return [
        { title: 'Robin delivered', value: fmt(t.delivered24h), subtitle: `Rejected ${fmt(t.rejected24h)}`, tone: 'green' },
        { title: 'Robin connections', value: fmt(t.received24h), subtitle: `All-time ${fmt(t.totalReceived)}`, tone: 'blue' },
      ];
    },
    capacityPeaks: (services) => [
      { label: 'Robin peak memory', value: `${peak<{ memoryPct: number }>(services, (m) => m.memoryPct)}%` },
      { label: 'Robin peak CPU', value: `${peak<{ cpuPct: number }>(services, (m) => m.cpuPct)}%` },
    ],
    pressure: (entry) => {
      const t = entry.totals as RobinFleetTotals;
      const b = t.rejectionBreakdown24h;
      const values = [b.rbl, b.virus, b.spam, b.dos];
      return {
        title: 'Robin rejection pressure (24h)',
        totalLabel: `${fmt(values.reduce((a, v) => a + v, 0))} events`,
        values,
        labels: ['RBL', 'Virus', 'Spam', 'DoS'],
        colors: ['#3b82f6', '#8b5cf6', '#f59e0b', '#ef4444'],
      };
    },
  },
  rspamd: {
    type: 'rspamd',
    label: 'Rspamd',
    icon: Activity,
    tone: 'purple',
    badgeClass: BADGE.purple,
    routeBase: '/rspamd',
    hasMetricsPage: true,
    hasConfigPage: true,
    headlineCard: (entry) => {
      const t = entry.totals as RspamdFleetTotals;
      return {
        title: 'Rspamd', status: status(entry), tone: 'purple',
        primaryLabel: 'Scanned (24h)', primaryValue: fmt(t.scanned24h),
        secondaryLabel: 'Actions (24h)', secondaryValue: fmt(t.totalActions24h),
        footer: `Spam ${fmt(t.spam24h)} · Avg RSS ${fmt(t.avgMemoryResidentMB)} MB`,
      };
    },
    throughputCards: (entry) => {
      const t = entry.totals as RspamdFleetTotals;
      return [
        { title: 'Rspamd scanned', value: fmt(t.scanned24h), subtitle: `Spam ${fmt(t.spam24h)}`, tone: 'blue' },
        { title: 'Rspamd actions', value: fmt(t.totalActions24h), subtitle: `Learned spam ${fmt(t.learnedSpam24h)}`, tone: 'red' },
      ];
    },
    capacityPeaks: (services) => [
      { label: 'Rspamd peak RSS', value: `${fmt(peak<{ memoryResidentMB: number }>(services, (m) => m.memoryResidentMB))} MB` },
      { label: 'Rspamd peak connections', value: fmt(peak<{ connections: number }>(services, (m) => m.connections)) },
    ],
    pressure: (entry) => {
      const t = entry.totals as RspamdFleetTotals;
      const a = t.actionBreakdown24h;
      const values = [a.addHeader, a.reject, a.softReject, a.greylist, a.noAction, a.rewriteSubject, a.discard, a.quarantine];
      return {
        title: 'Rspamd action mix (24h)',
        totalLabel: `${fmt(values.reduce((s, v) => s + v, 0))} actions`,
        values,
        labels: ['Add header', 'Reject', 'Soft reject', 'Greylist', 'No action', 'Rewrite', 'Discard', 'Quarantine'],
        colors: ['#f59e0b', '#ef4444', '#f97316', '#eab308', '#22c55e', '#3b82f6', '#a855f7', '#ec4899'],
      };
    },
  },
  clamav: {
    type: 'clamav',
    label: 'ClamAV',
    icon: Database,
    tone: 'amber',
    badgeClass: BADGE.amber,
    routeBase: '/clamav',
    hasMetricsPage: true,
    hasConfigPage: true,
    headlineCard: (entry) => {
      const t = entry.totals as ClamavFleetTotals;
      return {
        title: 'ClamAV', status: status(entry), tone: 'amber',
        primaryLabel: 'Queued now', primaryValue: fmt(t.queueItems),
        secondaryLabel: 'Peak queue (24h)', secondaryValue: fmt(t.peakQueue24h),
        footer: `${fmt(t.staleDatabaseServices)} stale DB service${t.staleDatabaseServices === 1 ? '' : 's'} · ${fmt(t.unhealthySamples24h)} unhealthy sample${t.unhealthySamples24h === 1 ? '' : 's'}`,
      };
    },
    throughputCards: (entry) => {
      const t = entry.totals as ClamavFleetTotals;
      return [
        { title: 'ClamAV queued', value: fmt(t.queueItems), subtitle: `Peak ${fmt(t.peakQueue24h)}`, tone: t.queueItems > 0 ? 'amber' : 'green' },
        { title: 'ClamAV stale DBs', value: fmt(t.staleDatabaseServices), subtitle: `${fmt(t.unhealthySamples24h)} unhealthy samples`, tone: t.staleDatabaseServices > 0 || t.unhealthySamples24h > 0 ? 'red' : 'green' },
      ];
    },
    capacityPeaks: (services) => {
      const poolPct = peakPercent<{ memoryPoolsUsedMB: number; memoryPoolsTotalMB: number }>(
        services, (m) => m.memoryPoolsUsedMB, (m) => m.memoryPoolsTotalMB
      );
      return [
        { label: 'ClamAV peak queue', value: fmt(peak<{ queueItems: number }>(services, (m) => m.queueItems)), emphasize: peak<{ queueItems: number }>(services, (m) => m.queueItems) > 0 },
        { label: 'ClamAV peak memory', value: `${fmt(peak<{ memoryUsedMB: number }>(services, (m) => m.memoryUsedMB))} MB` },
        ...(poolPct !== null ? [{ label: 'ClamAV memory pool used', value: `${fmt(poolPct)}%` }] : []),
      ];
    },
  },
  dovecot: {
    type: 'dovecot',
    label: 'Dovecot',
    icon: Inbox,
    tone: 'teal',
    badgeClass: BADGE.teal,
    routeBase: '/dovecot',
    hasMetricsPage: true,
    hasConfigPage: true,
    headlineCard: (entry) => {
      const t = entry.totals as DovecotFleetTotals;
      return {
        title: 'Dovecot', status: status(entry), tone: 'teal',
        primaryLabel: 'Sessions', primaryValue: fmt(t.sessions),
        secondaryLabel: 'Logins (24h)', secondaryValue: fmt(t.logins24h),
        footer: `Users ${fmt(t.users)} · Auth fail ${fmt(t.authFailure24h)} (24h)`,
      };
    },
    throughputCards: (entry) => {
      const t = entry.totals as DovecotFleetTotals;
      return [
        { title: 'Dovecot logins', value: fmt(t.logins24h), subtitle: `Sessions ${fmt(t.sessions)}`, tone: 'blue' },
        { title: 'Dovecot IMAP cmds', value: fmt(t.imapCommands24h), subtitle: `Deliveries ${fmt(t.mailDeliveries24h)}`, tone: 'green' },
      ];
    },
    capacityPeaks: (services) => [
      { label: 'Dovecot peak sessions', value: fmt(peak<{ peakSessions24h: number }>(services, (m) => m.peakSessions24h)) },
      { label: 'Dovecot users', value: fmt(peak<{ userCount: number }>(services, (m) => m.userCount)) },
    ],
  },
  postfix: {
    type: 'postfix',
    label: 'Postfix',
    icon: Mail,
    tone: 'indigo',
    badgeClass: BADGE.indigo,
    routeBase: '/postfix',
    hasMetricsPage: true,
    hasConfigPage: true,
    headlineCard: (entry) => {
      const t = entry.totals as PostfixFleetTotals;
      return {
        title: 'Postfix', status: status(entry), tone: 'indigo',
        primaryLabel: 'Queue total', primaryValue: fmt(t.queueTotal),
        secondaryLabel: 'Deferred', secondaryValue: fmt(t.queueDeferred),
        footer: `Active ${fmt(t.queueActive)} · Peak queue ${fmt(t.peakQueue24h)} (24h)`,
      };
    },
    throughputCards: (entry) => {
      const t = entry.totals as PostfixFleetTotals;
      return [
        ...(t.messageCounters ? [{ title: 'Postfix delivered', value: fmt(t.delivered24h), subtitle: `Rejected ${fmt(t.rejected24h)} · Bounced ${fmt(t.bounced24h)} (24h)`, tone: t.bounced24h > 0 ? 'amber' as const : 'green' as const }] : []),
        { title: 'Postfix queue', value: fmt(t.queueTotal), subtitle: `Deferred ${fmt(t.queueDeferred)}`, tone: t.queueDeferred > 0 ? 'amber' : 'green' },
        { title: 'Postfix deferred age', value: fmtDuration(t.maxDeferredAgeSecs), subtitle: `Peak deferred ${fmt(t.peakDeferred24h)}`, tone: t.maxDeferredAgeSecs > 0 ? 'red' : 'green' },
      ];
    },
    capacityPeaks: (services) => [
      { label: 'Postfix peak queue', value: fmt(peak<{ peakQueue24h: number }>(services, (m) => m.peakQueue24h)), emphasize: peak<{ peakQueue24h: number }>(services, (m) => m.peakQueue24h) > 0 },
      { label: 'Postfix peak deferred', value: fmt(peak<{ peakDeferred24h: number }>(services, (m) => m.peakDeferred24h)) },
    ],
  },
  redis: {
    type: 'redis',
    label: 'Redis',
    icon: Zap,
    tone: 'rose',
    badgeClass: BADGE.rose,
    routeBase: '/redis',
    hasMetricsPage: true,
    hasConfigPage: true,
    headlineCard: (entry) => {
      const t = entry.totals as RedisFleetTotals;
      return {
        title: 'Redis', status: status(entry), tone: 'rose',
        primaryLabel: 'Connected clients', primaryValue: fmt(t.connectedClients),
        secondaryLabel: 'Hit ratio', secondaryValue: formatMetricPercent(t.hitRatio),
        footer: `Ops (24h) ${fmt(t.opsProcessed24h)} · Evicted ${fmt(t.evictedKeys24h)} (24h)`,
      };
    },
    throughputCards: (entry) => {
      const t = entry.totals as RedisFleetTotals;
      return [
        { title: 'Redis ops (24h)', value: fmt(t.opsProcessed24h), subtitle: `Evicted ${fmt(t.evictedKeys24h)}`, tone: 'blue' },
        { title: 'Redis hit ratio', value: formatMetricPercent(t.hitRatio), subtitle: `Clients ${fmt(t.connectedClients)}`, tone: t.hitRatio >= 90 ? 'green' : 'amber' },
      ];
    },
    capacityPeaks: (services) => {
      const memPct = peakPercent<{ peakMemoryUsedBytes24h: number; maxMemoryBytes: number }>(
        services, (m) => m.peakMemoryUsedBytes24h, (m) => m.maxMemoryBytes
      );
      return [
        { label: 'Redis peak memory', value: `${fmt(peak<{ peakMemoryUsedBytes24h: number }>(services, (m) => m.peakMemoryUsedBytes24h) / (1024 * 1024))} MB` },
        { label: 'Redis peak clients', value: fmt(peak<{ peakConnectedClients24h: number }>(services, (m) => m.peakConnectedClients24h)) },
        // Only meaningful when maxmemory is actually configured — an unset
        // ceiling (the common dev default) means "no limit", not "0% used".
        ...(memPct !== null ? [{ label: 'Redis memory used', value: `${fmt(memPct)}%` }] : []),
      ];
    },
  },
  postgres: {
    type: 'postgres',
    label: 'Postgres',
    icon: Cylinder,
    tone: 'sky',
    badgeClass: BADGE.sky,
    routeBase: '/postgres',
    hasMetricsPage: true,
    hasConfigPage: true,
    headlineCard: (entry) => {
      const t = entry.totals as PostgresFleetTotals;
      return {
        title: 'Postgres', status: status(entry), tone: 'sky',
        primaryLabel: 'Connections', primaryValue: fmt(t.connectionsTotal),
        secondaryLabel: 'Cache hit ratio', secondaryValue: formatMetricRatio(t.cacheHitRatio),
        footer: `Commits (24h) ${fmt(t.xactCommit24h)} · Deadlocks ${fmt(t.deadlocks24h)} (24h)`,
      };
    },
    throughputCards: (entry) => {
      const t = entry.totals as PostgresFleetTotals;
      return [
        { title: 'Postgres transactions (24h)', value: fmt(t.xactCommit24h + t.xactRollback24h), subtitle: `Rollbacks ${fmt(t.xactRollback24h)}`, tone: 'blue' },
        { title: 'Postgres cache hit ratio', value: formatMetricRatio(t.cacheHitRatio), subtitle: `Connections ${fmt(t.connectionsTotal)}`, tone: t.cacheHitRatio >= 0.9 ? 'green' : 'amber' },
      ];
    },
    capacityPeaks: (services) => [
      { label: 'Postgres peak connections', value: fmt(peak<{ peakConnectionsTotal24h: number }>(services, (m) => m.peakConnectionsTotal24h)) },
      { label: 'Postgres peak saturation', value: `${fmt(peak<{ peakConnectionSaturationPct24h: number }>(services, (m) => m.peakConnectionSaturationPct24h))}%` },
    ],
  },
  mariadb: {
    type: 'mariadb',
    label: 'MariaDB',
    icon: DatabaseZap,
    tone: 'emerald',
    badgeClass: BADGE.emerald,
    routeBase: '/mariadb',
    hasMetricsPage: true,
    hasConfigPage: true,
    headlineCard: (entry) => {
      const t = entry.totals as MariadbFleetTotals;
      return {
        title: 'MariaDB', status: status(entry), tone: 'emerald',
        primaryLabel: 'Connections', primaryValue: fmt(t.threadsConnected),
        secondaryLabel: 'Buffer pool hit ratio', secondaryValue: formatMetricRatio(t.bufferPoolHitRatio),
        footer: `Oldest transaction ${fmtDuration(t.maxOldestTrxAgeSecs)} · Deadlocks ${fmt(t.deadlocks24h)} (24h)`,
      };
    },
    throughputCards: (entry) => {
      const t = entry.totals as MariadbFleetTotals;
      return [
        { title: 'MariaDB queries (24h)', value: fmt(t.questions24h), subtitle: `Slow queries ${fmt(t.slowQueries24h)}`, tone: 'blue' },
        { title: 'MariaDB lock waits', value: fmt(t.trxLockWaits), subtitle: `Oldest transaction ${fmtDuration(t.maxOldestTrxAgeSecs)}`, tone: t.trxLockWaits > 0 ? 'amber' : 'green' },
      ];
    },
    capacityPeaks: (services) => [
      { label: 'MariaDB peak connections', value: fmt(peak<{ peakThreadsConnected24h: number }>(services, (m) => m.peakThreadsConnected24h)) },
      { label: 'MariaDB peak saturation', value: `${fmt(peak<{ peakConnectionSaturationPct24h: number }>(services, (m) => m.peakConnectionSaturationPct24h))}%` },
    ],
  },
};

export function getServiceTypeMeta(type: FleetServiceType): ServiceTypeMeta {
  return SERVICE_TYPE_REGISTRY[type];
}

export const SERVICE_TYPE_LIST: ServiceTypeMeta[] = FLEET_SERVICE_TYPES.map((type) => SERVICE_TYPE_REGISTRY[type]);

// ---------------------------------------------------------------------------
// Per-service table projection — drives the dashboard's rich fleet table so a
// new service type contributes its own Activity + Current-state cells here,
// never by branching in the page. Capacity cells reuse `capacityPeaks([svc])`.
// ---------------------------------------------------------------------------

export interface MetricPair {
  label: string;
  value: string;
}

export interface ServiceTableRow {
  /** 24-hour activity counters. */
  activity: MetricPair[];
  /** Latest live sample. */
  state: MetricPair[];
  /** Shown when `activity` is empty (or as extra context beneath it). */
  activityNote?: string;
}

const EMPTY_ROW: ServiceTableRow = { activity: [], state: [], activityNote: 'No live metrics.' };

export function getServiceTableRow(service: FleetDashboardService): ServiceTableRow {
  if (!service.metrics) return EMPTY_ROW;

  switch (service.serviceType) {
    case 'robin': {
      const m = service.metrics as RobinFleetMetrics;
      return {
        // received24h is receipt_start (SMTP connections greeted), NOT messages —
        // keep it as context so it never masquerades as delivered mail.
        activity: [
          { label: 'Delivered', value: fmt(m.delivered24h) },
          { label: 'Rejected', value: fmt(m.rejected24h) },
        ],
        activityNote: `Connections (24h) ${fmt(m.received24h)}`,
        state: [
          { label: 'Memory', value: formatMetricPercent(m.memoryPct) },
          { label: 'CPU', value: formatMetricPercent(m.cpuPct) },
        ],
      };
    }
    case 'rspamd': {
      const m = service.metrics as RspamdFleetMetrics;
      return {
        activity: [
          { label: 'Scanned', value: fmt(m.scanned24h) },
          { label: 'Actions', value: fmt(m.totalActions24h) },
          { label: 'Spam', value: fmt(m.spam24h) },
          { label: 'Learned spam', value: fmt(m.learnedSpam24h) },
        ],
        state: [
          { label: 'Resident memory (RSS)', value: `${fmt(m.memoryResidentMB)} MB` },
          { label: 'Connections', value: fmt(m.connections) },
          { label: 'Uptime', value: fmtDuration(m.uptimeSeconds) },
        ],
      };
    }
    case 'clamav': {
      const m = service.metrics as ClamavFleetMetrics;
      return {
        activity: [
          { label: 'Peak queue · 24h', value: fmt(m.peakQueue24h) },
          { label: 'Unhealthy samples', value: fmt(m.unhealthySamples24h) },
        ],
        state: [
          { label: 'Queued', value: fmt(m.queueItems) },
          { label: 'Engine', value: m.engineVersion ?? '—' },
          { label: 'Signature DB', value: m.databaseVersion != null ? fmt(m.databaseVersion) : '—' },
          { label: 'Memory used', value: `${fmt(m.memoryUsedMB)} MB` },
          { label: 'Threads · live / max', value: `${fmt(m.threadsLive)} / ${fmt(m.threadsMax)}` },
        ],
      };
    }
    case 'dovecot': {
      const m = service.metrics as DovecotFleetMetrics;
      return {
        activity: [
          { label: 'Logins', value: fmt(m.logins24h) },
          { label: 'Authentication failures', value: fmt(m.authFailure24h) },
          { label: 'IMAP commands', value: fmt(m.imapCommands24h) },
          { label: 'Mail deliveries', value: fmt(m.mailDeliveries24h) },
        ],
        state: [
          { label: 'Sessions', value: fmt(m.sessionCount) },
          { label: 'Users', value: fmt(m.userCount) },
        ],
      };
    }
    case 'postfix': {
      const m = service.metrics as PostfixFleetMetrics;
      return {
        activity: m.messageCounters ? [
          { label: 'Delivered', value: fmt(m.delivered24h) },
          { label: 'Deferred', value: fmt(m.deferred24h) },
          { label: 'Bounced', value: fmt(m.bounced24h) },
          { label: 'Rejected', value: fmt(m.rejected24h) },
        ] : [],
        activityNote: m.messageCounters ? undefined : 'Message counts need the Postfix log stream from a robin-agent; queue state is shown alongside.',
        state: [
          { label: 'Queue total', value: fmt(m.queueTotal) },
          { label: 'Deferred', value: fmt(m.queueDeferred) },
          { label: 'Active', value: fmt(m.queueActive) },
          { label: 'On hold', value: fmt(m.queueHold) },
          { label: 'Oldest deferred age', value: fmtDuration(m.oldestDeferredAgeSecs) },
        ],
      };
    }
    case 'redis': {
      const m = service.metrics as RedisFleetMetrics;
      return {
        activity: [
          { label: 'Operations processed', value: fmt(m.opsProcessed24h) },
          { label: 'Evicted keys', value: fmt(m.evictedKeys24h) },
        ],
        state: [
          { label: 'Connected clients', value: fmt(m.connectedClients) },
          { label: 'Operations / second', value: fmt(m.instantaneousOpsPerSec) },
          { label: 'Hit ratio', value: formatMetricPercent(m.hitRatio) },
          { label: 'Memory used', value: formatBytes(m.memoryUsedBytes) },
          { label: 'Memory fragmentation', value: `${formatMetricNumber(m.memFragmentationRatio)}×` },
        ],
      };
    }
    case 'postgres': {
      const m = service.metrics as PostgresFleetMetrics;
      return {
        activity: [
          { label: 'Transactions', value: fmt(m.xactCommit24h + m.xactRollback24h) },
          { label: 'Commits', value: fmt(m.xactCommit24h) },
          { label: 'Rollbacks', value: fmt(m.xactRollback24h) },
          { label: 'Deadlocks', value: fmt(m.deadlocks24h) },
        ],
        state: [
          { label: 'Total connections', value: fmt(m.connectionsTotal) },
          { label: 'Active connections', value: fmt(m.connectionsActive) },
          { label: 'Cache hit ratio', value: formatMetricRatio(m.cacheHitRatio) },
          { label: 'Connection saturation', value: formatMetricPercent(m.connectionSaturationPct) },
        ],
      };
    }
    case 'mariadb': {
      const m = service.metrics as MariadbFleetMetrics;
      return {
        activity: [
          { label: 'Queries', value: fmt(m.questions24h) },
          { label: 'Commits', value: fmt(m.commits24h) },
          { label: 'Slow queries', value: fmt(m.slowQueries24h) },
          { label: 'Deadlocks', value: fmt(m.deadlocks24h) },
        ],
        state: [
          { label: 'Connections', value: `${fmt(m.threadsConnected)} / ${fmt(m.maxConnections)}` },
          { label: 'Running', value: fmt(m.threadsRunning) },
          { label: 'Buffer pool hit ratio', value: formatMetricRatio(m.bufferPoolHitRatio) },
          { label: 'Oldest transaction', value: fmtDuration(m.oldestTrxAgeSecs) },
          ...(m.isReplica ? [{ label: 'Replica lag', value: m.secondsBehindSource === null ? 'stopped' : fmtDuration(m.secondsBehindSource) }] : []),
        ],
      };
    }
    default:
      return EMPTY_ROW;
  }
}
