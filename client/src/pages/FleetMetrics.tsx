import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { CheckCircle2, RefreshCw, Search, Server } from 'lucide-react';
import { dashboardApi, metricsApi } from '../api/client';
import { LineChart, downsampleData, formatChartLabels } from '../components/charts';
import { Button } from '../components/ui/Button';
import { MetricValue } from '../components/ui/MetricCard';
import { PageHeader } from '../components/ui/PageHeader';
import { Spinner } from '../components/ui/Spinner';
import { Table, type Column } from '../components/ui/Table';
import { appIcons } from '../constants/appIcons';
import { getServiceTypeMeta } from '../constants/serviceTypes';
import { useServices } from '../context/ServiceContext';
import { formatBytes, formatMetricNumber, formatMetricPercent, formatMetricRatio } from '../utils/format';
import type {
  ClamavFleetDashboardService,
  ClamavFleetTotals,
  ClamavMetricsSnapshot,
  DovecotFleetDashboardService,
  DovecotFleetTotals,
  DovecotMetricsSnapshot,
  FleetDashboard,
  FleetDashboardService,
  MetricsSnapshot,
  PostfixFleetDashboardService,
  PostfixFleetTotals,
  PostfixMetricsSnapshot,
  PostgresFleetDashboardService,
  MariadbFleetDashboardService,
  MariadbFleetTotals,
  MariadbMetricsSnapshot,
  PostgresFleetTotals,
  PostgresMetricsSnapshot,
  RedisFleetDashboardService,
  RedisFleetTotals,
  RedisMetricsSnapshot,
  RobinFleetDashboardService,
  RobinFleetTotals,
  RspamdFleetDashboardService,
  RspamdFleetTotals,
  RspamdMetricsSnapshot,
} from '../types';

type WindowType = '6h' | '24h' | '7d';
type StatusFilter = 'all' | 'healthy' | 'down';

interface TrendPoint {
  timestamp: string;
  primary: number;
  secondary: number;
  tertiary: number;
}

const WINDOW_HOURS: Record<WindowType, number> = {
  '6h': 6,
  '24h': 24,
  '7d': 24 * 7,
};

const STORAGE_KEYS = {
  window: 'fleet-metrics-window',
  search: 'fleet-metrics-search',
  status: 'fleet-metrics-status',
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
    // Ignore localStorage failures.
  }
}

export function FleetMetricsPage() {
  const navigate = useNavigate();
  const {
    setSelectedRobinService,
    setSelectedRspamdService,
    setSelectedClamavService,
    setSelectedDovecotService,
    setSelectedPostfixService,
    setSelectedRedisService,
    setSelectedPostgresService,
    setSelectedMariadbService,
    clamavServices,
    dovecotServices,
    postfixServices,
    redisServices,
    postgresServices,
    mariadbServices,
    robinServices,
    rspamdServices,
  } = useServices();
  const [fleet, setFleet] = useState<FleetDashboard | null>(null);
  const [historyByType, setHistoryByType] = useState<Record<'robin' | 'rspamd' | 'clamav' | 'dovecot' | 'postfix' | 'redis' | 'postgres' | 'mariadb', TrendPoint[]>>({
    robin: [],
    rspamd: [],
    clamav: [],
    dovecot: [],
    postfix: [],
    redis: [],
    postgres: [],
    mariadb: [],
  });
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [window, setWindow] = useState<WindowType>(() => loadState(STORAGE_KEYS.window, '24h'));
  const [search, setSearch] = useState<string>(() => loadState(STORAGE_KEYS.search, ''));
  const [statusFilter, setStatusFilter] = useState<StatusFilter>(() => loadState(STORAGE_KEYS.status, 'all'));

  useEffect(() => { saveState(STORAGE_KEYS.window, window); }, [window]);
  useEffect(() => { saveState(STORAGE_KEYS.search, search); }, [search]);
  useEffect(() => { saveState(STORAGE_KEYS.status, statusFilter); }, [statusFilter]);

  const loadFleetMetrics = useCallback(async (showRefreshing = false) => {
    if (showRefreshing) {
      setIsRefreshing(true);
    }

    try {
      const fleetResponse = await dashboardApi.getFleet();
      setFleet(fleetResponse.data ?? null);
      setError('');
    } catch {
      setError('Failed to load fleet metrics');
    } finally {
      setIsLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  useEffect(() => {
    void loadFleetMetrics();
  }, [loadFleetMetrics]);

  useEffect(() => {
    if (!autoRefresh) return;
    const interval = setInterval(() => {
      void loadFleetMetrics(true);
    }, 60000);
    return () => clearInterval(interval);
  }, [autoRefresh, loadFleetMetrics]);

  useEffect(() => {
    if (!fleet) {
      setHistoryByType({ robin: [], rspamd: [], clamav: [], dovecot: [], postfix: [], redis: [], postgres: [], mariadb: [] });
      return;
    }

    const loadHistory = async () => {
      try {
        const [robin, rspamd, clamav, dovecot, postfix, redis, postgres, mariadb] = await Promise.all([
          loadRobinTrend(fleet.byType.robin, window),
          loadRspamdTrend(fleet.byType.rspamd, window),
          loadClamavTrend(fleet.byType.clamav, window),
          loadDovecotTrend(fleet.byType.dovecot, window),
          loadPostfixTrend(fleet.byType.postfix, window),
          loadRedisTrend(fleet.byType.redis, window),
          loadPostgresTrend(fleet.byType.postgres, window),
          loadMariadbTrend(fleet.byType.mariadb, window),
        ]);
        setHistoryByType({ robin, rspamd, clamav, dovecot, postfix, redis, postgres, mariadb });
      } catch {
        setHistoryByType({ robin: [], rspamd: [], clamav: [], dovecot: [], postfix: [], redis: [], postgres: [], mariadb: [] });
      }
    };

    void loadHistory();
  }, [fleet, window]);

  const filteredRobin = useMemo(
    () => filterServices(fleet?.byType.robin ?? [], search, statusFilter).sort(compareRobinServices),
    [fleet?.byType.robin, search, statusFilter],
  );
  const filteredRspamd = useMemo(
    () => filterServices(fleet?.byType.rspamd ?? [], search, statusFilter).sort(compareRspamdServices),
    [fleet?.byType.rspamd, search, statusFilter],
  );
  const filteredClamav = useMemo(
    () => filterServices(fleet?.byType.clamav ?? [], search, statusFilter).sort(compareClamavServices),
    [fleet?.byType.clamav, search, statusFilter],
  );
  const filteredDovecot = useMemo(
    () => filterServices(fleet?.byType.dovecot ?? [], search, statusFilter).sort(compareDovecotServices),
    [fleet?.byType.dovecot, search, statusFilter],
  );
  const filteredPostfix = useMemo(
    () => filterServices(fleet?.byType.postfix ?? [], search, statusFilter).sort(comparePostfixServices),
    [fleet?.byType.postfix, search, statusFilter],
  );
  const filteredRedis = useMemo(
    () => filterServices(fleet?.byType.redis ?? [], search, statusFilter).sort(compareRedisServices),
    [fleet?.byType.redis, search, statusFilter],
  );
  const filteredPostgres = useMemo(
    () => filterServices(fleet?.byType.postgres ?? [], search, statusFilter).sort(comparePostgresServices),
    [fleet?.byType.postgres, search, statusFilter],
  );
  const filteredMariadb = useMemo(
    () => filterServices(fleet?.byType.mariadb ?? [], search, statusFilter).sort(compareMariadbServices),
    [fleet?.byType.mariadb, search, statusFilter],
  );

  const robinChartLabels = useMemo(
    () => formatChartLabels(historyByType.robin.map((point) => point.timestamp), window),
    [historyByType.robin, window],
  );
  const rspamdChartLabels = useMemo(
    () => formatChartLabels(historyByType.rspamd.map((point) => point.timestamp), window),
    [historyByType.rspamd, window],
  );
  const clamavChartLabels = useMemo(
    () => formatChartLabels(historyByType.clamav.map((point) => point.timestamp), window),
    [historyByType.clamav, window],
  );
  const dovecotChartLabels = useMemo(
    () => formatChartLabels(historyByType.dovecot.map((point) => point.timestamp), window),
    [historyByType.dovecot, window],
  );
  const postfixChartLabels = useMemo(
    () => formatChartLabels(historyByType.postfix.map((point) => point.timestamp), window),
    [historyByType.postfix, window],
  );
  const redisChartLabels = useMemo(
    () => formatChartLabels(historyByType.redis.map((point) => point.timestamp), window),
    [historyByType.redis, window],
  );
  const postgresChartLabels = useMemo(
    () => formatChartLabels(historyByType.postgres.map((point) => point.timestamp), window),
    [historyByType.postgres, window],
  );
  const mariadbChartLabels = useMemo(
    () => formatChartLabels(historyByType.mariadb.map((point) => point.timestamp), window),
    [historyByType.mariadb, window],
  );

  const robinSeries = useMemo(() => [
    { label: 'Delivered', data: historyByType.robin.map((point) => point.primary), color: '#22c55e', fill: true },
    { label: 'Rejected', data: historyByType.robin.map((point) => point.secondary), color: '#ef4444', fill: false },
    { label: 'Connections', data: historyByType.robin.map((point) => point.tertiary), color: '#3b82f6', fill: false },
  ], [historyByType.robin]);

  const rspamdSeries = useMemo(() => [
    { label: 'Scanned', data: historyByType.rspamd.map((point) => point.primary), color: '#3b82f6', fill: true },
    { label: 'Spam', data: historyByType.rspamd.map((point) => point.secondary), color: '#ef4444', fill: false },
    { label: 'Actions', data: historyByType.rspamd.map((point) => point.tertiary), color: '#f97316', fill: false },
  ], [historyByType.rspamd]);

  const clamavSeries = useMemo(() => [
    { label: 'Queue', data: historyByType.clamav.map((point) => point.primary), color: '#3b82f6', fill: true },
    { label: 'Used memory', data: historyByType.clamav.map((point) => point.secondary), color: '#f97316', fill: false },
    { label: 'Unhealthy samples', data: historyByType.clamav.map((point) => point.tertiary), color: '#ef4444', fill: false },
  ], [historyByType.clamav]);

  const dovecotSeries = useMemo(() => [
    { label: 'Sessions', data: historyByType.dovecot.map((point) => point.primary), color: '#3b82f6', fill: true },
    { label: 'IMAP commands', data: historyByType.dovecot.map((point) => point.secondary), color: '#f97316', fill: false },
    { label: 'Logins', data: historyByType.dovecot.map((point) => point.tertiary), color: '#22c55e', fill: false },
  ], [historyByType.dovecot]);

  const postfixSeries = useMemo(() => [
    { label: 'Queue total', data: historyByType.postfix.map((point) => point.primary), color: '#3b82f6', fill: true },
    { label: 'Deferred', data: historyByType.postfix.map((point) => point.secondary), color: '#f97316', fill: false },
    { label: 'Oldest deferred age', data: historyByType.postfix.map((point) => point.tertiary), color: '#ef4444', fill: false },
  ], [historyByType.postfix]);

  const redisSeries = useMemo(() => [
    { label: 'Ops processed', data: historyByType.redis.map((point) => point.primary), color: '#3b82f6', fill: true },
    { label: 'Evicted keys', data: historyByType.redis.map((point) => point.secondary), color: '#ef4444', fill: false },
    { label: 'Connected clients', data: historyByType.redis.map((point) => point.tertiary), color: '#22c55e', fill: false },
  ], [historyByType.redis]);

  const postgresSeries = useMemo(() => [
    { label: 'Commits', data: historyByType.postgres.map((point) => point.primary), color: '#22c55e', fill: true },
    { label: 'Rollbacks', data: historyByType.postgres.map((point) => point.secondary), color: '#ef4444', fill: false },
    { label: 'Deadlocks', data: historyByType.postgres.map((point) => point.tertiary), color: '#f97316', fill: false },
  ], [historyByType.postgres]);
  const mariadbSeries = useMemo(() => [
    { label: 'Queries', data: historyByType.mariadb.map((point) => point.primary), color: '#22c55e', fill: true },
    { label: 'Slow queries', data: historyByType.mariadb.map((point) => point.secondary), color: '#f97316', fill: false },
    { label: 'Deadlocks', data: historyByType.mariadb.map((point) => point.tertiary), color: '#ef4444', fill: false },
  ], [historyByType.mariadb]);

  const hasRobinServices = (fleet?.byType.robin.length ?? 0) > 0;
  const hasRspamdServices = (fleet?.byType.rspamd.length ?? 0) > 0;
  const hasClamavServices = (fleet?.byType.clamav.length ?? 0) > 0;
  const hasDovecotServices = (fleet?.byType.dovecot.length ?? 0) > 0;
  const hasPostfixServices = (fleet?.byType.postfix.length ?? 0) > 0;
  const hasRedisServices = (fleet?.byType.redis.length ?? 0) > 0;
  const hasPostgresServices = (fleet?.byType.postgres.length ?? 0) > 0;
  const hasMariadbServices = (fleet?.byType.mariadb.length ?? 0) > 0;
  const hasFleetServices = hasRobinServices || hasRspamdServices || hasClamavServices || hasDovecotServices || hasPostfixServices || hasRedisServices || hasPostgresServices || hasMariadbServices;

  const robinMeta = getServiceTypeMeta('robin');
  const rspamdMeta = getServiceTypeMeta('rspamd');
  const clamavMeta = getServiceTypeMeta('clamav');
  const dovecotMeta = getServiceTypeMeta('dovecot');
  const postfixMeta = getServiceTypeMeta('postfix');
  const redisMeta = getServiceTypeMeta('redis');
  const postgresMeta = getServiceTypeMeta('postgres');
  const RobinTypeIcon = robinMeta.icon;
  const RspamdTypeIcon = rspamdMeta.icon;
  const ClamavTypeIcon = clamavMeta.icon;
  const DovecotTypeIcon = dovecotMeta.icon;
  const PostfixTypeIcon = postfixMeta.icon;
  const RedisTypeIcon = redisMeta.icon;
  const PostgresTypeIcon = postgresMeta.icon;
  const mariadbMeta = getServiceTypeMeta('mariadb');
  const MariadbTypeIcon = mariadbMeta.icon;

  const handleOpenService = useCallback((service: FleetDashboardService) => {
    if (service.serviceType === 'rspamd') {
      const match = rspamdServices.find((candidate) => candidate.serviceId === service.serviceId);
      if (match) {
        setSelectedRspamdService(match);
      }
      navigate('/rspamd/metrics');
      return;
    }

    if (service.serviceType === 'clamav') {
      const match = clamavServices.find((candidate) => candidate.serviceId === service.serviceId);
      if (match) {
        setSelectedClamavService(match);
      }
      navigate('/clamav/metrics');
      return;
    }

    if (service.serviceType === 'dovecot') {
      const match = dovecotServices.find((candidate) => candidate.serviceId === service.serviceId);
      if (match) {
        setSelectedDovecotService(match);
      }
      navigate('/dovecot/metrics');
      return;
    }

    if (service.serviceType === 'postfix') {
      const match = postfixServices.find((candidate) => candidate.serviceId === service.serviceId);
      if (match) {
        setSelectedPostfixService(match);
      }
      navigate('/postfix/metrics');
      return;
    }

    if (service.serviceType === 'redis') {
      const match = redisServices.find((candidate) => candidate.serviceId === service.serviceId);
      if (match) {
        setSelectedRedisService(match);
      }
      navigate('/redis/metrics');
      return;
    }

    if (service.serviceType === 'postgres') {
      const match = postgresServices.find((candidate) => candidate.serviceId === service.serviceId);
      if (match) {
        setSelectedPostgresService(match);
      }
      navigate('/postgres/metrics');
      return;
    }

    if (service.serviceType === 'mariadb') {
      const match = mariadbServices.find((candidate) => candidate.serviceId === service.serviceId);
      if (match) {
        setSelectedMariadbService(match);
      }
      navigate('/mariadb/metrics');
      return;
    }

    const match = robinServices.find((candidate) => candidate.serviceId === service.serviceId);
    if (match) {
      setSelectedRobinService(match);
    }
    navigate('/robin/metrics');
  }, [clamavServices, dovecotServices, mariadbServices, postfixServices, postgresServices, redisServices, navigate, robinServices, rspamdServices, setSelectedClamavService, setSelectedDovecotService, setSelectedMariadbService, setSelectedPostfixService, setSelectedPostgresService, setSelectedRedisService, setSelectedRobinService, setSelectedRspamdService]);

  const robinColumns: Column<RobinFleetDashboardService>[] = [
    {
      key: 'name',
      header: 'Robin service',
      render: (row) => (
        <div>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.serviceId}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge healthy={row.healthy} />,
    },
    {
      key: 'delivered24h',
      header: 'Delivered (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.delivered24h ?? 0).toLocaleString(),
    },
    {
      key: 'rejected24h',
      header: 'Rejected (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.rejected24h ?? 0).toLocaleString(),
    },
    {
      key: 'memory',
      header: 'Memory',
      className: 'text-right',
      render: (row) => formatMetricPercent(row.metrics?.memoryPct),
    },
    {
      key: 'cpu',
      header: 'CPU',
      className: 'text-right',
      render: (row) => formatMetricPercent(row.metrics?.cpuPct),
    },
  ];

  const rspamdColumns: Column<RspamdFleetDashboardService>[] = [
    {
      key: 'name',
      header: 'Rspamd service',
      render: (row) => (
        <div>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.serviceId}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge healthy={row.healthy} />,
    },
    {
      key: 'scanned24h',
      header: 'Scanned (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.scanned24h ?? 0).toLocaleString(),
    },
    {
      key: 'spam24h',
      header: 'Spam (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.spam24h ?? 0).toLocaleString(),
    },
    {
      key: 'actions24h',
      header: 'Actions (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.totalActions24h ?? 0).toLocaleString(),
    },
    {
      key: 'memory',
      header: 'Resident memory',
      className: 'text-right',
      render: (row) => `${formatMetricNumber(row.metrics?.memoryResidentMB)} MB`,
    },
  ];

  const clamavColumns: Column<ClamavFleetDashboardService>[] = [
    {
      key: 'name',
      header: 'ClamAV service',
      render: (row) => (
        <div>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.serviceId}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge healthy={row.healthy} />,
    },
    {
      key: 'queue',
      header: 'Queue',
      className: 'text-right',
      render: (row) => String(row.metrics?.queueItems ?? 0),
    },
    {
      key: 'queue24h',
      header: 'Peak queue (24h)',
      className: 'text-right',
      render: (row) => String(row.metrics?.peakQueue24h ?? 0),
    },
    {
      key: 'memory',
      header: 'Used memory',
      className: 'text-right',
      render: (row) => `${formatMetricNumber(row.metrics?.memoryUsedMB)} MB`,
    },
    {
      key: 'database',
      header: 'DB version',
      className: 'text-right',
      render: (row) => row.metrics?.databaseVersion ? `#${row.metrics.databaseVersion}` : '—',
    },
  ];

  const dovecotColumns: Column<DovecotFleetDashboardService>[] = [
    {
      key: 'name',
      header: 'Dovecot service',
      render: (row) => (
        <div>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.serviceId}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge healthy={row.healthy} />,
    },
    {
      key: 'sessions',
      header: 'Sessions',
      className: 'text-right',
      render: (row) => String(row.metrics?.sessionCount ?? 0),
    },
    {
      key: 'logins24h',
      header: 'Logins (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.logins24h ?? 0).toLocaleString(),
    },
    {
      key: 'imap24h',
      header: 'IMAP cmds (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.imapCommands24h ?? 0).toLocaleString(),
    },
    {
      key: 'auth24h',
      header: 'Auth ok / fail (24h)',
      className: 'text-right',
      render: (row) => `${(row.metrics?.authSuccess24h ?? 0).toLocaleString()} / ${(row.metrics?.authFailure24h ?? 0).toLocaleString()}`,
    },
  ];

  const postfixCounters = (fleet?.byType.postfix ?? []).some((service) => service.metrics?.messageCounters);
  const postfixColumns: Column<PostfixFleetDashboardService>[] = [
    {
      key: 'name',
      header: 'Postfix service',
      render: (row) => (
        <div>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.serviceId}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge healthy={row.healthy} />,
    },
    {
      key: 'queueTotal',
      header: 'Queue total',
      className: 'text-right',
      render: (row) => String(row.metrics?.queueTotal ?? 0),
    },
    {
      key: 'queueDeferred',
      header: 'Deferred',
      className: 'text-right',
      render: (row) => String(row.metrics?.queueDeferred ?? 0),
    },
    // With the Postfix log streaming, delivery outcomes replace the backlog
    // detail (still on the chart and the Postfix Metrics page).
    ...(postfixCounters ? (['delivered24h', 'rejected24h'] as const).map((key) => ({
      key,
      header: key === 'delivered24h' ? 'Delivered (24h)' : 'Rejected (24h)',
      className: 'text-right',
      render: (row: PostfixFleetDashboardService) => (row.metrics?.messageCounters ? row.metrics[key].toLocaleString() : '—'),
    })) : [
      {
        key: 'queueActive',
        header: 'Active',
        className: 'text-right',
        render: (row: PostfixFleetDashboardService) => String(row.metrics?.queueActive ?? 0),
      },
      {
        key: 'oldestDeferred',
        header: 'Oldest deferred',
        className: 'text-right',
        render: (row: PostfixFleetDashboardService) => formatAgeSecs(row.metrics?.oldestDeferredAgeSecs),
      },
    ]),
  ];

  const redisColumns: Column<RedisFleetDashboardService>[] = [
    {
      key: 'name',
      header: 'Redis service',
      render: (row) => (
        <div>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.serviceId}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge healthy={row.healthy} />,
    },
    {
      key: 'connectedClients',
      header: 'Clients',
      className: 'text-right',
      render: (row) => String(row.metrics?.connectedClients ?? 0),
    },
    {
      key: 'memoryUsedBytes',
      header: 'Memory used',
      className: 'text-right',
      render: (row) => formatBytes(row.metrics?.memoryUsedBytes),
    },
    {
      key: 'hitRatio',
      header: 'Hit ratio',
      className: 'text-right',
      render: (row) => formatMetricPercent(row.metrics?.hitRatio),
    },
    {
      key: 'opsProcessed24h',
      header: 'Ops (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.opsProcessed24h ?? 0).toLocaleString(),
    },
    {
      key: 'evictedKeys24h',
      header: 'Evicted (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.evictedKeys24h ?? 0).toLocaleString(),
    },
  ];

  const postgresColumns: Column<PostgresFleetDashboardService>[] = [
    {
      key: 'name',
      header: 'Postgres service',
      render: (row) => (
        <div>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.serviceId}</div>
        </div>
      ),
    },
    {
      key: 'status',
      header: 'Status',
      render: (row) => <StatusBadge healthy={row.healthy} />,
    },
    {
      key: 'connectionsTotal',
      header: 'Connections',
      className: 'text-right',
      render: (row) => String(row.metrics?.connectionsTotal ?? 0),
    },
    {
      key: 'connectionSaturationPct',
      header: 'Saturation',
      className: 'text-right',
      render: (row) => formatMetricPercent(row.metrics?.connectionSaturationPct),
    },
    {
      key: 'cacheHitRatio',
      header: 'Cache hit ratio',
      className: 'text-right',
      render: (row) => formatMetricRatio(row.metrics?.cacheHitRatio),
    },
    {
      key: 'deadlocks24h',
      header: 'Deadlocks (24h)',
      className: 'text-right',
      render: (row) => (row.metrics?.deadlocks24h ?? 0).toLocaleString(),
    },
  ];

  const mariadbColumns: Column<MariadbFleetDashboardService>[] = [
    {
      key: 'name',
      header: 'MariaDB service',
      render: (row) => (
        <div>
          <div className="font-medium">{row.name}</div>
          <div className="text-xs text-gray-500 dark:text-gray-400">{row.serviceId}</div>
        </div>
      ),
    },
    { key: 'status', header: 'Status', render: (row) => <StatusBadge healthy={row.healthy} /> },
    { key: 'threadsConnected', header: 'Connections', className: 'text-right', render: (row) => formatMetricNumber(row.metrics?.threadsConnected) },
    { key: 'connectionSaturationPct', header: 'Saturation', className: 'text-right', render: (row) => formatMetricPercent(row.metrics?.connectionSaturationPct) },
    { key: 'bufferPoolHitRatio', header: 'Buffer pool hit', className: 'text-right', render: (row) => formatMetricRatio(row.metrics?.bufferPoolHitRatio) },
    { key: 'oldestTrxAgeSecs', header: 'Oldest trx (s)', className: 'text-right', render: (row) => formatMetricNumber(row.metrics?.oldestTrxAgeSecs) },
    { key: 'deadlocks24h', header: 'Deadlocks (24h)', className: 'text-right', render: (row) => formatMetricNumber(row.metrics?.deadlocks24h) },
  ];

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
        icon={appIcons.fleetMetrics}
        title="Metrics"
        description="Review Robin, Rspamd, ClamAV, Dovecot, Postfix, Redis, PostgreSQL, and MariaDB together in one compact fleet-wide workspace."
        actions={(
          <>
            <div className="flex rounded-lg border border-gray-200 p-1 dark:border-robin-gray-700">
              {(['6h', '24h', '7d'] as WindowType[]).map((value) => (
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
            <label className="flex items-center gap-2 text-sm">
              <input
                type="checkbox"
                checked={autoRefresh}
                onChange={(event) => setAutoRefresh(event.target.checked)}
                className="h-4 w-4 rounded-sm accent-robin-orange"
              />
              Auto-refresh
            </label>
            <Button variant="secondary" onClick={() => void loadFleetMetrics(true)}>
              <RefreshCw className={`h-4 w-4 ${isRefreshing ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </>
        )}
      />

      <div className="flex flex-wrap gap-3">
        <CompactSummaryCard icon={<Server className="h-4 w-4" />} label="Total services" value={String(fleet?.overview.totalServices ?? 0)} />
        <CompactSummaryCard icon={<CheckCircle2 className="h-4 w-4" />} label="Healthy" value={String(fleet?.overview.healthyServices ?? 0)} />
        {hasRobinServices && (
          <CompactSummaryCard icon={<RobinTypeIcon className="h-4 w-4" />} badgeClass={robinMeta.badgeClass} label="Robin" value={String(fleet?.overview.byType.robin.totalServices ?? 0)} />
        )}
        {hasRspamdServices && (
          <CompactSummaryCard icon={<RspamdTypeIcon className="h-4 w-4" />} badgeClass={rspamdMeta.badgeClass} label="Rspamd" value={String(fleet?.overview.byType.rspamd.totalServices ?? 0)} />
        )}
        {hasClamavServices && (
          <CompactSummaryCard icon={<ClamavTypeIcon className="h-4 w-4" />} badgeClass={clamavMeta.badgeClass} label="ClamAV" value={String(fleet?.overview.byType.clamav.totalServices ?? 0)} />
        )}
        {hasDovecotServices && (
          <CompactSummaryCard icon={<DovecotTypeIcon className="h-4 w-4" />} badgeClass={dovecotMeta.badgeClass} label="Dovecot" value={String(fleet?.overview.byType.dovecot.totalServices ?? 0)} />
        )}
        {hasPostfixServices && (
          <CompactSummaryCard icon={<PostfixTypeIcon className="h-4 w-4" />} badgeClass={postfixMeta.badgeClass} label="Postfix" value={String(fleet?.overview.byType.postfix.totalServices ?? 0)} />
        )}
        {hasRedisServices && (
          <CompactSummaryCard icon={<RedisTypeIcon className="h-4 w-4" />} badgeClass={redisMeta.badgeClass} label="Redis" value={String(fleet?.overview.byType.redis.totalServices ?? 0)} />
        )}
        {hasPostgresServices && (
          <CompactSummaryCard icon={<PostgresTypeIcon className="h-4 w-4" />} badgeClass={postgresMeta.badgeClass} label="Postgres" value={String(fleet?.overview.byType.postgres.totalServices ?? 0)} />
        )}
        {hasMariadbServices && (
          <CompactSummaryCard icon={<MariadbTypeIcon className="h-4 w-4" />} badgeClass={mariadbMeta.badgeClass} label="MariaDB" value={String(fleet?.overview.byType.mariadb.totalServices ?? 0)} />
        )}
      </div>

      <div className="card p-4">
        <div className="flex flex-col gap-4 lg:flex-row">
          <div className="relative flex-1">
            <Search className="absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
            <input
              type="text"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Search any fleet service by name or id"
              className="input w-full pl-10"
            />
          </div>

          <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as StatusFilter)} className="input w-full lg:w-48">
            <option value="all">All statuses</option>
            <option value="healthy">Healthy only</option>
            <option value="down">Down only</option>
          </select>
        </div>

        {error && (
          <div className="mt-4 rounded-sm border border-red-200 bg-red-50 p-3 text-red-600 dark:border-red-800 dark:bg-red-900/20 dark:text-red-400">
            {error}
          </div>
        )}
      </div>

      {!hasFleetServices && (
        <div className="card p-8 text-center text-sm text-gray-500 dark:text-gray-400">
          No enabled fleet services are configured yet.
        </div>
      )}

      {hasRobinServices && (
      <ServiceSection
        icon={<RobinTypeIcon className="h-4 w-4" />}
        badgeClass={robinMeta.badgeClass}
        title="Robin"
        subtitle="Delivery throughput, rejection pressure, and runtime headroom across Robin services."
        totals={(
          <>
            <MiniMetricCard label="Delivered (24h)" value={String((fleet?.overview.byType.robin.totals as RobinFleetTotals | undefined)?.delivered24h ?? 0)} />
            <MiniMetricCard label="Rejected (24h)" value={String((fleet?.overview.byType.robin.totals as RobinFleetTotals | undefined)?.rejected24h ?? 0)} />
            <MiniMetricCard label="Avg memory" value={formatMetricPercent((fleet?.overview.byType.robin.totals as RobinFleetTotals | undefined)?.avgMemoryPct)} />
            <MiniMetricCard label="Avg CPU" value={formatMetricPercent((fleet?.overview.byType.robin.totals as RobinFleetTotals | undefined)?.avgCpuPct)} />
          </>
        )}
        chartTitle="Robin throughput trend"
        chartSubtitle="Aggregated delivery, rejection, and receipt deltas across enabled Robin services."
        chartLabels={robinChartLabels}
        chartSeries={robinSeries}
        chartEmptyMessage="No Robin history is available for this window yet."
        tableTitle="Robin services"
        tableDescription="Click a row to continue in the Robin metrics workspace."
        table={(
          <Table
            columns={robinColumns}
            data={filteredRobin}
            keyField="serviceId"
            emptyMessage="No Robin services match the current filters"
            onRowClick={(row) => handleOpenService(row)}
          />
        )}
      />
      )}

      {hasRspamdServices && (
      <ServiceSection
        icon={<RspamdTypeIcon className="h-4 w-4" />}
        badgeClass={rspamdMeta.badgeClass}
        title="Rspamd"
        subtitle="Scan volume, spam pressure, and action activity across managed Rspamd services."
        totals={(
          <>
            <MiniMetricCard label="Scanned (24h)" value={String((fleet?.overview.byType.rspamd.totals as RspamdFleetTotals | undefined)?.scanned24h ?? 0)} />
            <MiniMetricCard label="Spam (24h)" value={String((fleet?.overview.byType.rspamd.totals as RspamdFleetTotals | undefined)?.spam24h ?? 0)} />
            <MiniMetricCard label="Avg resident memory" value={`${formatMetricNumber((fleet?.overview.byType.rspamd.totals as RspamdFleetTotals | undefined)?.avgMemoryResidentMB)} MB`} />
            <MiniMetricCard label="Avg connections" value={formatMetricNumber((fleet?.overview.byType.rspamd.totals as RspamdFleetTotals | undefined)?.avgConnections)} />
          </>
        )}
        chartTitle="Rspamd activity trend"
        chartSubtitle="Aggregated scan, spam, and action deltas across enabled Rspamd services."
        chartLabels={rspamdChartLabels}
        chartSeries={rspamdSeries}
        chartEmptyMessage="No Rspamd history is available for this window yet."
        tableTitle="Rspamd services"
        tableDescription="Click a row to continue in the Rspamd metrics workspace."
        table={(
          <Table
            columns={rspamdColumns}
            data={filteredRspamd}
            keyField="serviceId"
            emptyMessage="No Rspamd services match the current filters"
            onRowClick={(row) => handleOpenService(row)}
          />
        )}
      />
      )}

      {hasClamavServices && (
      <ServiceSection
        icon={<ClamavTypeIcon className="h-4 w-4" />}
        badgeClass={clamavMeta.badgeClass}
        title="ClamAV"
        subtitle="Queue pressure, memory use, and signature freshness across ClamAV daemons."
        totals={(
          <>
            <MiniMetricCard label="Peak queue (24h)" value={String((fleet?.overview.byType.clamav.totals as ClamavFleetTotals | undefined)?.peakQueue24h ?? 0)} />
            <MiniMetricCard label="Stale databases" value={String((fleet?.overview.byType.clamav.totals as ClamavFleetTotals | undefined)?.staleDatabaseServices ?? 0)} />
            <MiniMetricCard label="Avg used memory" value={`${formatMetricNumber((fleet?.overview.byType.clamav.totals as ClamavFleetTotals | undefined)?.avgMemoryUsedMB)} MB`} />
            <MiniMetricCard label="Unhealthy samples" value={String((fleet?.overview.byType.clamav.totals as ClamavFleetTotals | undefined)?.unhealthySamples24h ?? 0)} />
          </>
        )}
        chartTitle="ClamAV runtime trend"
        chartSubtitle="Aggregated queue, memory, and health samples across enabled ClamAV services."
        chartLabels={clamavChartLabels}
        chartSeries={clamavSeries}
        chartEmptyMessage="No ClamAV history is available for this window yet."
        tableTitle="ClamAV services"
        tableDescription="Click a row to continue in the ClamAV metrics workspace."
        table={(
          <Table
            columns={clamavColumns}
            data={filteredClamav}
            keyField="serviceId"
            emptyMessage="No ClamAV services match the current filters"
            onRowClick={(row) => handleOpenService(row)}
          />
        )}
      />
      )}

      {hasDovecotServices && (
      <ServiceSection
        icon={<DovecotTypeIcon className="h-4 w-4" />}
        badgeClass={dovecotMeta.badgeClass}
        title="Dovecot"
        subtitle="Authentication volume, session load, and IMAP activity across managed Dovecot services."
        totals={(
          <>
            <MiniMetricCard label="Logins (24h)" value={String((fleet?.overview.byType.dovecot.totals as DovecotFleetTotals | undefined)?.logins24h ?? 0)} />
            <MiniMetricCard label="Sessions" value={String((fleet?.overview.byType.dovecot.totals as DovecotFleetTotals | undefined)?.sessions ?? 0)} />
            <MiniMetricCard label="IMAP commands (24h)" value={String((fleet?.overview.byType.dovecot.totals as DovecotFleetTotals | undefined)?.imapCommands24h ?? 0)} />
            <MiniMetricCard label="Mail deliveries (24h)" value={String((fleet?.overview.byType.dovecot.totals as DovecotFleetTotals | undefined)?.mailDeliveries24h ?? 0)} />
          </>
        )}
        chartTitle="Dovecot activity trend"
        chartSubtitle="Aggregated session, IMAP command, and login samples across enabled Dovecot services."
        chartLabels={dovecotChartLabels}
        chartSeries={dovecotSeries}
        chartEmptyMessage="No Dovecot history is available for this window yet."
        tableTitle="Dovecot services"
        tableDescription="Click a row to continue in the Dovecot metrics workspace."
        wideTable
        table={(
          <Table
            columns={dovecotColumns}
            data={filteredDovecot}
            keyField="serviceId"
            emptyMessage="No Dovecot services match the current filters"
            onRowClick={(row) => handleOpenService(row)}
          />
        )}
      />
      )}

      {hasPostfixServices && (
      <ServiceSection
        icon={<PostfixTypeIcon className="h-4 w-4" />}
        badgeClass={postfixMeta.badgeClass}
        title="Postfix"
        subtitle="Queue depth, deferral pressure, and delivery outcomes across managed Postfix services."
        totals={(
          <>
            <MiniMetricCard label="Queue total" value={String((fleet?.overview.byType.postfix.totals as PostfixFleetTotals | undefined)?.queueTotal ?? 0)} />
            <MiniMetricCard label="Deferred" value={String((fleet?.overview.byType.postfix.totals as PostfixFleetTotals | undefined)?.queueDeferred ?? 0)} />
            {postfixCounters ? (
              <>
                <MiniMetricCard label="Delivered (24h)" value={String((fleet?.overview.byType.postfix.totals as PostfixFleetTotals | undefined)?.delivered24h ?? 0)} />
                <MiniMetricCard label="Rejected (24h)" value={String((fleet?.overview.byType.postfix.totals as PostfixFleetTotals | undefined)?.rejected24h ?? 0)} />
              </>
            ) : (
              <>
                <MiniMetricCard label="Peak queue (24h)" value={String((fleet?.overview.byType.postfix.totals as PostfixFleetTotals | undefined)?.peakQueue24h ?? 0)} />
                <MiniMetricCard label="Max deferred age" value={formatAgeSecs((fleet?.overview.byType.postfix.totals as PostfixFleetTotals | undefined)?.maxDeferredAgeSecs)} />
              </>
            )}
          </>
        )}
        chartTitle="Postfix queue trend"
        chartSubtitle="Aggregated queue total, deferred depth, and oldest deferred age across enabled Postfix services."
        chartLabels={postfixChartLabels}
        chartSeries={postfixSeries}
        chartEmptyMessage="No Postfix history is available for this window yet."
        tableTitle="Postfix services"
        tableDescription="Click a row to continue in the Postfix metrics workspace."
        wideTable
        table={(
          <Table
            columns={postfixColumns}
            data={filteredPostfix}
            keyField="serviceId"
            emptyMessage="No Postfix services match the current filters"
            onRowClick={(row) => handleOpenService(row)}
          />
        )}
      />
      )}

      {hasRedisServices && (
      <ServiceSection
        icon={<RedisTypeIcon className="h-4 w-4" />}
        badgeClass={redisMeta.badgeClass}
        title="Redis"
        subtitle="Client load, memory pressure, and cache hit ratio across managed Redis services."
        totals={(
          <>
            <MiniMetricCard label="Connected clients" value={String((fleet?.overview.byType.redis.totals as RedisFleetTotals | undefined)?.connectedClients ?? 0)} />
            <MiniMetricCard label="Memory used" value={formatBytes((fleet?.overview.byType.redis.totals as RedisFleetTotals | undefined)?.memoryUsedBytes)} />
            <MiniMetricCard label="Hit ratio" value={formatMetricPercent((fleet?.overview.byType.redis.totals as RedisFleetTotals | undefined)?.hitRatio)} />
            <MiniMetricCard label="Ops (24h)" value={String((fleet?.overview.byType.redis.totals as RedisFleetTotals | undefined)?.opsProcessed24h ?? 0)} />
          </>
        )}
        chartTitle="Redis throughput trend"
        chartSubtitle="Aggregated ops processed, evicted keys, and connected clients across enabled Redis services."
        chartLabels={redisChartLabels}
        chartSeries={redisSeries}
        chartEmptyMessage="No Redis history is available for this window yet."
        tableTitle="Redis services"
        tableDescription="Click a row to continue in the Redis metrics workspace."
        table={(
          <Table
            columns={redisColumns}
            data={filteredRedis}
            keyField="serviceId"
            emptyMessage="No Redis services match the current filters"
            onRowClick={(row) => handleOpenService(row)}
          />
        )}
      />
      )}

      {hasPostgresServices && (
      <ServiceSection
        icon={<PostgresTypeIcon className="h-4 w-4" />}
        badgeClass={postgresMeta.badgeClass}
        title="PostgreSQL"
        subtitle="Connection saturation, transaction throughput, and cache efficiency across managed PostgreSQL services."
        totals={(
          <>
            <MiniMetricCard label="Connections" value={String((fleet?.overview.byType.postgres.totals as PostgresFleetTotals | undefined)?.connectionsTotal ?? 0)} />
            <MiniMetricCard label="Cache hit ratio" value={formatMetricRatio((fleet?.overview.byType.postgres.totals as PostgresFleetTotals | undefined)?.cacheHitRatio)} />
            <MiniMetricCard label="Commits (24h)" value={String((fleet?.overview.byType.postgres.totals as PostgresFleetTotals | undefined)?.xactCommit24h ?? 0)} />
            <MiniMetricCard label="Deadlocks (24h)" value={String((fleet?.overview.byType.postgres.totals as PostgresFleetTotals | undefined)?.deadlocks24h ?? 0)} />
          </>
        )}
        chartTitle="PostgreSQL transaction trend"
        chartSubtitle="Aggregated commits, rollbacks, and deadlocks across enabled PostgreSQL services."
        chartLabels={postgresChartLabels}
        chartSeries={postgresSeries}
        chartEmptyMessage="No PostgreSQL history is available for this window yet."
        tableTitle="PostgreSQL services"
        tableDescription="Click a row to continue in the PostgreSQL metrics workspace."
        table={(
          <Table
            columns={postgresColumns}
            data={filteredPostgres}
            keyField="serviceId"
            emptyMessage="No PostgreSQL services match the current filters"
            onRowClick={(row) => handleOpenService(row)}
            scrollLabel="PostgreSQL services table"
          />
        )}
      />
      )}

      {hasMariadbServices && (
      <ServiceSection
        icon={<MariadbTypeIcon className="h-4 w-4" />}
        badgeClass={mariadbMeta.badgeClass}
        title="MariaDB"
        subtitle="Connection saturation, query throughput, and transaction health across managed MariaDB services."
        totals={(
          <>
            <MiniMetricCard label="Connections" value={formatMetricNumber((fleet?.overview.byType.mariadb.totals as MariadbFleetTotals | undefined)?.threadsConnected)} />
            <MiniMetricCard label="Buffer pool hit" value={formatMetricRatio((fleet?.overview.byType.mariadb.totals as MariadbFleetTotals | undefined)?.bufferPoolHitRatio)} />
            <MiniMetricCard label="Queries (24h)" value={formatMetricNumber((fleet?.overview.byType.mariadb.totals as MariadbFleetTotals | undefined)?.questions24h)} />
            <MiniMetricCard label="Deadlocks (24h)" value={formatMetricNumber((fleet?.overview.byType.mariadb.totals as MariadbFleetTotals | undefined)?.deadlocks24h)} />
          </>
        )}
        chartTitle="MariaDB query trend"
        chartSubtitle="Aggregated queries, slow queries, and deadlocks across enabled MariaDB services."
        chartLabels={mariadbChartLabels}
        chartSeries={mariadbSeries}
        chartEmptyMessage="No MariaDB history is available for this window yet."
        tableTitle="MariaDB services"
        tableDescription="Click a row to continue in the MariaDB metrics workspace."
        table={(
          <Table
            columns={mariadbColumns}
            data={filteredMariadb}
            keyField="serviceId"
            emptyMessage="No MariaDB services match the current filters"
            onRowClick={(row) => handleOpenService(row)}
            scrollLabel="MariaDB services table"
          />
        )}
      />
      )}
    </div>
  );
}

function ServiceSection({
  icon,
  badgeClass,
  title,
  subtitle,
  totals,
  chartTitle,
  chartSubtitle,
  chartLabels,
  chartSeries,
  chartEmptyMessage,
  tableTitle,
  tableDescription,
  table,
  wideTable = false,
}: {
  icon: ReactNode;
  badgeClass: string;
  title: string;
  subtitle: string;
  totals: ReactNode;
  chartTitle: string;
  chartSubtitle: string;
  chartLabels: string[];
  chartSeries: Array<{ label: string; data: number[]; color: string; fill: boolean }>;
  chartEmptyMessage: string;
  tableTitle: string;
  tableDescription: string;
  table: ReactNode;
  // Tables with many numeric columns get the full width below 2xl, stacked
  // under the chart, instead of scrolling sideways beside it.
  wideTable?: boolean;
}) {
  return (
    <section className="card p-4">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div>
          <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
            <span className={`rounded-lg p-2 ${badgeClass}`}>{icon}</span>
            {title}
          </div>
          <p className="mt-2 text-sm text-gray-500 dark:text-gray-400">{subtitle}</p>
        </div>
        <div className="grid w-full gap-3 sm:grid-cols-2 xl:w-auto xl:grid-cols-4">{totals}</div>
      </div>

      <div className={`mt-4 grid gap-4 ${wideTable
        ? '2xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]'
        : 'xl:grid-cols-[minmax(0,1.2fr)_minmax(360px,0.8fr)]'}`}>
        <div className="min-w-0 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
          <h2 className="text-base font-semibold">{chartTitle}</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{chartSubtitle}</p>
          {chartLabels.length > 0 ? (
            <div className="mt-4">
              <LineChart labels={chartLabels} series={chartSeries} height={220} />
            </div>
          ) : (
            <div className="mt-4 rounded-lg border border-dashed border-gray-300 px-4 py-10 text-center text-sm text-gray-500 dark:border-robin-gray-700 dark:text-gray-400">
              {chartEmptyMessage}
            </div>
          )}
        </div>

        <div className="min-w-0 rounded-xl border border-gray-200 p-4 dark:border-robin-gray-700">
          <h2 className="text-base font-semibold">{tableTitle}</h2>
          <p className="mt-1 text-sm text-gray-500 dark:text-gray-400">{tableDescription}</p>
          <div className="mt-4 min-w-0">{table}</div>
        </div>
      </div>
    </section>
  );
}

function CompactSummaryCard({ icon, label, value, badgeClass }: { icon: ReactNode; label: string; value: string; badgeClass?: string }) {
  return (
    <div className="flex-1 min-w-[150px] rounded-xl border border-gray-200 bg-white px-4 py-3 dark:border-robin-gray-700 dark:bg-robin-gray-900/60">
      <div className="flex min-w-0 items-center justify-between gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</div>
          <MetricValue className="mt-1 text-gray-900 dark:text-white">{value}</MetricValue>
        </div>
        <div className={`shrink-0 rounded-lg p-2 ${badgeClass ?? 'bg-gray-100 text-gray-600 dark:bg-robin-gray-800 dark:text-gray-300'}`}>{icon}</div>
      </div>
    </div>
  );
}

function MiniMetricCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 rounded-xl border border-gray-200 bg-gray-50 px-3 py-2 dark:border-robin-gray-700 dark:bg-robin-gray-800/60">
      <div className="text-xs font-medium text-gray-500 dark:text-gray-400">{label}</div>
      <MetricValue className="mt-1 text-lg text-gray-900 dark:text-white">{value}</MetricValue>
    </div>
  );
}

function StatusBadge({ healthy }: { healthy: boolean }) {
  return (
    <span className={`inline-flex rounded-full px-2.5 py-1 text-xs font-medium ${
      healthy
        ? 'bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-400'
        : 'bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-400'
    }`}>
      {healthy ? 'Healthy' : 'Down'}
    </span>
  );
}

function filterServices<T extends FleetDashboardService>(services: T[], search: string, statusFilter: StatusFilter) {
  const normalizedSearch = search.trim().toLowerCase();
  return services.filter((service) => {
    const matchesSearch = normalizedSearch.length === 0
      || service.name.toLowerCase().includes(normalizedSearch)
      || service.serviceId.toLowerCase().includes(normalizedSearch);
    const matchesStatus = statusFilter === 'all'
      || (statusFilter === 'healthy' ? service.healthy : !service.healthy);
    return matchesSearch && matchesStatus;
  });
}

function compareRobinServices(left: RobinFleetDashboardService, right: RobinFleetDashboardService) {
  const leftActivity = (left.metrics?.delivered24h ?? 0) + (left.metrics?.rejected24h ?? 0);
  const rightActivity = (right.metrics?.delivered24h ?? 0) + (right.metrics?.rejected24h ?? 0);
  if (left.healthy !== right.healthy) {
    return Number(right.healthy) - Number(left.healthy);
  }
  if (leftActivity !== rightActivity) {
    return rightActivity - leftActivity;
  }
  return left.name.localeCompare(right.name);
}

function compareRspamdServices(left: RspamdFleetDashboardService, right: RspamdFleetDashboardService) {
  const leftActivity = (left.metrics?.scanned24h ?? 0) + (left.metrics?.totalActions24h ?? 0);
  const rightActivity = (right.metrics?.scanned24h ?? 0) + (right.metrics?.totalActions24h ?? 0);
  if (left.healthy !== right.healthy) {
    return Number(right.healthy) - Number(left.healthy);
  }
  if (leftActivity !== rightActivity) {
    return rightActivity - leftActivity;
  }
  return left.name.localeCompare(right.name);
}

function compareClamavServices(left: ClamavFleetDashboardService, right: ClamavFleetDashboardService) {
  const leftActivity = (left.metrics?.peakQueue24h ?? 0) + (left.metrics?.memoryUsedMB ?? 0);
  const rightActivity = (right.metrics?.peakQueue24h ?? 0) + (right.metrics?.memoryUsedMB ?? 0);
  if (left.healthy !== right.healthy) {
    return Number(right.healthy) - Number(left.healthy);
  }
  if (leftActivity !== rightActivity) {
    return rightActivity - leftActivity;
  }
  return left.name.localeCompare(right.name);
}

function compareDovecotServices(left: DovecotFleetDashboardService, right: DovecotFleetDashboardService) {
  const leftActivity = (left.metrics?.logins24h ?? 0) + (left.metrics?.imapCommands24h ?? 0);
  const rightActivity = (right.metrics?.logins24h ?? 0) + (right.metrics?.imapCommands24h ?? 0);
  if (left.healthy !== right.healthy) {
    return Number(right.healthy) - Number(left.healthy);
  }
  if (leftActivity !== rightActivity) {
    return rightActivity - leftActivity;
  }
  return left.name.localeCompare(right.name);
}

function comparePostfixServices(left: PostfixFleetDashboardService, right: PostfixFleetDashboardService) {
  const leftActivity = (left.metrics?.queueTotal ?? 0) + (left.metrics?.queueDeferred ?? 0);
  const rightActivity = (right.metrics?.queueTotal ?? 0) + (right.metrics?.queueDeferred ?? 0);
  if (left.healthy !== right.healthy) {
    return Number(right.healthy) - Number(left.healthy);
  }
  if (leftActivity !== rightActivity) {
    return rightActivity - leftActivity;
  }
  return left.name.localeCompare(right.name);
}

function compareRedisServices(left: RedisFleetDashboardService, right: RedisFleetDashboardService) {
  const leftActivity = (left.metrics?.instantaneousOpsPerSec ?? 0) + (left.metrics?.connectedClients ?? 0);
  const rightActivity = (right.metrics?.instantaneousOpsPerSec ?? 0) + (right.metrics?.connectedClients ?? 0);
  if (left.healthy !== right.healthy) {
    return Number(right.healthy) - Number(left.healthy);
  }
  if (leftActivity !== rightActivity) {
    return rightActivity - leftActivity;
  }
  return left.name.localeCompare(right.name);
}

function compareMariadbServices(left: MariadbFleetDashboardService, right: MariadbFleetDashboardService) {
  if (left.healthy !== right.healthy) {
    return Number(right.healthy) - Number(left.healthy);
  }
  const activity = (service: MariadbFleetDashboardService) => (service.metrics?.questions24h ?? 0) + (service.metrics?.threadsConnected ?? 0);
  return activity(right) - activity(left) || left.name.localeCompare(right.name);
}

function comparePostgresServices(left: PostgresFleetDashboardService, right: PostgresFleetDashboardService) {
  const leftActivity = (left.metrics?.connectionsTotal ?? 0) + (left.metrics?.xactCommit ?? 0);
  const rightActivity = (right.metrics?.connectionsTotal ?? 0) + (right.metrics?.xactCommit ?? 0);
  if (left.healthy !== right.healthy) {
    return Number(right.healthy) - Number(left.healthy);
  }
  if (leftActivity !== rightActivity) {
    return rightActivity - leftActivity;
  }
  return left.name.localeCompare(right.name);
}

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

async function loadRobinTrend(services: RobinFleetDashboardService[], window: WindowType) {
  if (services.length === 0) {
    return [];
  }

  const histories = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await metricsApi.getHistory<MetricsSnapshot[]>(
          WINDOW_HOURS[window],
          { serviceType: 'robin', serviceId: service.serviceId },
        );
        return response.data ?? [];
      } catch {
        return [];
      }
    }),
  );

  return aggregateRobinHistory(histories, window);
}

async function loadRspamdTrend(services: RspamdFleetDashboardService[], window: WindowType) {
  if (services.length === 0) {
    return [];
  }

  const histories = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await metricsApi.getHistory<RspamdMetricsSnapshot[]>(
          WINDOW_HOURS[window],
          { serviceType: 'rspamd', serviceId: service.serviceId },
        );
        return response.data ?? [];
      } catch {
        return [];
      }
    }),
  );

  return aggregateRspamdHistory(histories, window);
}

async function loadClamavTrend(services: ClamavFleetDashboardService[], window: WindowType) {
  if (services.length === 0) {
    return [];
  }

  const histories = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await metricsApi.getHistory<ClamavMetricsSnapshot[]>(
          WINDOW_HOURS[window],
          { serviceType: 'clamav', serviceId: service.serviceId },
        );
        return response.data ?? [];
      } catch {
        return [];
      }
    }),
  );

  return aggregateClamavHistory(histories, window);
}

async function loadDovecotTrend(services: DovecotFleetDashboardService[], window: WindowType) {
  if (services.length === 0) {
    return [];
  }

  const histories = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await metricsApi.getHistory<DovecotMetricsSnapshot[]>(
          WINDOW_HOURS[window],
          { serviceType: 'dovecot', serviceId: service.serviceId },
        );
        return response.data ?? [];
      } catch {
        return [];
      }
    }),
  );

  return aggregateDovecotHistory(histories, window);
}

async function loadPostfixTrend(services: PostfixFleetDashboardService[], window: WindowType) {
  if (services.length === 0) {
    return [];
  }

  const histories = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await metricsApi.getHistory<PostfixMetricsSnapshot[]>(
          WINDOW_HOURS[window],
          { serviceType: 'postfix', serviceId: service.serviceId },
        );
        return response.data ?? [];
      } catch {
        return [];
      }
    }),
  );

  return aggregatePostfixHistory(histories, window);
}

async function loadRedisTrend(services: RedisFleetDashboardService[], window: WindowType) {
  if (services.length === 0) {
    return [];
  }

  const histories = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await metricsApi.getHistory<RedisMetricsSnapshot[]>(
          WINDOW_HOURS[window],
          { serviceType: 'redis', serviceId: service.serviceId },
        );
        return response.data ?? [];
      } catch {
        return [];
      }
    }),
  );

  return aggregateRedisHistory(histories, window);
}

async function loadPostgresTrend(services: PostgresFleetDashboardService[], window: WindowType) {
  if (services.length === 0) {
    return [];
  }

  const histories = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await metricsApi.getHistory<PostgresMetricsSnapshot[]>(
          WINDOW_HOURS[window],
          { serviceType: 'postgres', serviceId: service.serviceId },
        );
        return response.data ?? [];
      } catch {
        return [];
      }
    }),
  );

  return aggregatePostgresHistory(histories, window);
}

async function loadMariadbTrend(services: MariadbFleetDashboardService[], window: WindowType) {
  if (services.length === 0) {
    return [];
  }
  const histories = await Promise.all(
    services.map(async (service) => {
      try {
        const response = await metricsApi.getHistory<MariadbMetricsSnapshot[]>(
          WINDOW_HOURS[window],
          { serviceType: 'mariadb', serviceId: service.serviceId },
        );
        return (response.data ?? []).filter((point) => point.reachable);
      } catch {
        return [];
      }
    }),
  );
  return aggregateCounterHistory(histories, window, (point) => [point.questions, point.slowQueries, point.deadlocks]);
}

/** Per-bucket increases of up to three cumulative counters, summed across services. */
function aggregateCounterHistory<T extends { timestamp: string }>(histories: T[][], window: WindowType, counters: (point: T) => [number, number, number]) {
  const bucketMinutes = window === '7d' ? 60 : 15;
  const buckets = new Map<string, TrendPoint>();
  for (const history of histories) {
    for (let index = 1; index < history.length; index += 1) {
      const [p0, p1, p2] = counters(history[index - 1]);
      const [c0, c1, c2] = counters(history[index]);
      const bucket = bucketTimestamp(history[index].timestamp, bucketMinutes);
      const entry = buckets.get(bucket) ?? { timestamp: bucket, primary: 0, secondary: 0, tertiary: 0 };
      entry.primary += Math.max(0, c0 - p0);
      entry.secondary += Math.max(0, c1 - p1);
      entry.tertiary += Math.max(0, c2 - p2);
      buckets.set(bucket, entry);
    }
  }
  return downsampleData(
    [...buckets.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    140,
  );
}

function aggregateRobinHistory(histories: MetricsSnapshot[][], window: WindowType) {
  const bucketMinutes = window === '7d' ? 60 : 15;
  const buckets = new Map<string, TrendPoint>();

  for (const history of histories) {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const current = history[index];
      const delivered = Math.max(0, current.emailReceiptSuccess - previous.emailReceiptSuccess);
      const rejected = Math.max(0, getRobinRejections(current) - getRobinRejections(previous));
      const received = Math.max(0, current.emailReceiptStart - previous.emailReceiptStart);
      const bucket = bucketTimestamp(current.timestamp, bucketMinutes);
      const entry = buckets.get(bucket) ?? { timestamp: bucket, primary: 0, secondary: 0, tertiary: 0 };
      entry.primary += delivered;
      entry.secondary += rejected;
      entry.tertiary += received;
      buckets.set(bucket, entry);
    }
  }

  return downsampleData(
    [...buckets.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    140,
  );
}

function aggregateRspamdHistory(histories: RspamdMetricsSnapshot[][], window: WindowType) {
  const bucketMinutes = window === '7d' ? 60 : 15;
  const buckets = new Map<string, TrendPoint>();

  for (const history of histories) {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const current = history[index];
      const scanned = Math.max(0, current.scannedMessages - previous.scannedMessages);
      const spam = Math.max(0, current.spamMessages - previous.spamMessages);
      const actions = Math.max(0, getRspamdActions(current) - getRspamdActions(previous));
      const bucket = bucketTimestamp(current.timestamp, bucketMinutes);
      const entry = buckets.get(bucket) ?? { timestamp: bucket, primary: 0, secondary: 0, tertiary: 0 };
      entry.primary += scanned;
      entry.secondary += spam;
      entry.tertiary += actions;
      buckets.set(bucket, entry);
    }
  }

  return downsampleData(
    [...buckets.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    140,
  );
}

function aggregateClamavHistory(histories: ClamavMetricsSnapshot[][], window: WindowType) {
  const bucketMinutes = window === '7d' ? 60 : 15;
  const buckets = new Map<string, TrendPoint>();

  for (const history of histories) {
    for (const current of history) {
      const bucket = bucketTimestamp(current.timestamp, bucketMinutes);
      const entry = buckets.get(bucket) ?? { timestamp: bucket, primary: 0, secondary: 0, tertiary: 0 };
      entry.primary += current.queueItems;
      entry.secondary += current.memoryUsedMB;
      entry.tertiary += current.pingOk ? 0 : 1;
      buckets.set(bucket, entry);
    }
  }

  return downsampleData(
    [...buckets.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    140,
  );
}

function aggregateDovecotHistory(histories: DovecotMetricsSnapshot[][], window: WindowType) {
  const bucketMinutes = window === '7d' ? 60 : 15;
  const buckets = new Map<string, TrendPoint>();

  for (const history of histories) {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const current = history[index];
      const bucket = bucketTimestamp(current.timestamp, bucketMinutes);
      const entry = buckets.get(bucket) ?? { timestamp: bucket, primary: 0, secondary: 0, tertiary: 0 };
      entry.primary += current.sessionCount;
      entry.secondary += Math.max(0, current.imapCommands - previous.imapCommands);
      entry.tertiary += Math.max(0, current.loginCount - previous.loginCount);
      buckets.set(bucket, entry);
    }
  }

  return downsampleData(
    [...buckets.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    140,
  );
}

function aggregatePostfixHistory(histories: PostfixMetricsSnapshot[][], window: WindowType) {
  const bucketMinutes = window === '7d' ? 60 : 15;
  const buckets = new Map<string, TrendPoint>();

  for (const history of histories) {
    for (const current of history) {
      const bucket = bucketTimestamp(current.timestamp, bucketMinutes);
      const entry = buckets.get(bucket) ?? { timestamp: bucket, primary: 0, secondary: 0, tertiary: 0 };
      entry.primary += current.queueTotal;
      entry.secondary += current.queueDeferred;
      entry.tertiary = Math.max(entry.tertiary, current.oldestDeferredAgeSecs);
      buckets.set(bucket, entry);
    }
  }

  return downsampleData(
    [...buckets.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    140,
  );
}

function aggregateRedisHistory(histories: RedisMetricsSnapshot[][], window: WindowType) {
  const bucketMinutes = window === '7d' ? 60 : 15;
  const buckets = new Map<string, TrendPoint>();

  for (const history of histories) {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const current = history[index];
      const ops = Math.max(0, current.totalCommandsProcessed - previous.totalCommandsProcessed);
      const evicted = Math.max(0, current.evictedKeys - previous.evictedKeys);
      const bucket = bucketTimestamp(current.timestamp, bucketMinutes);
      const entry = buckets.get(bucket) ?? { timestamp: bucket, primary: 0, secondary: 0, tertiary: 0 };
      entry.primary += ops;
      entry.secondary += evicted;
      entry.tertiary += current.connectedClients;
      buckets.set(bucket, entry);
    }
  }

  return downsampleData(
    [...buckets.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    140,
  );
}

function aggregatePostgresHistory(histories: PostgresMetricsSnapshot[][], window: WindowType) {
  const bucketMinutes = window === '7d' ? 60 : 15;
  const buckets = new Map<string, TrendPoint>();

  for (const history of histories) {
    for (let index = 1; index < history.length; index += 1) {
      const previous = history[index - 1];
      const current = history[index];
      const commits = Math.max(0, current.xactCommit - previous.xactCommit);
      const rollbacks = Math.max(0, current.xactRollback - previous.xactRollback);
      const deadlocks = Math.max(0, current.deadlocks - previous.deadlocks);
      const bucket = bucketTimestamp(current.timestamp, bucketMinutes);
      const entry = buckets.get(bucket) ?? { timestamp: bucket, primary: 0, secondary: 0, tertiary: 0 };
      entry.primary += commits;
      entry.secondary += rollbacks;
      entry.tertiary += deadlocks;
      buckets.set(bucket, entry);
    }
  }

  return downsampleData(
    [...buckets.values()].sort((left, right) => new Date(left.timestamp).getTime() - new Date(right.timestamp).getTime()),
    140,
  );
}

function bucketTimestamp(timestamp: string, bucketMinutes: number) {
  const date = new Date(timestamp);
  date.setSeconds(0, 0);
  const roundedMinutes = Math.floor(date.getMinutes() / bucketMinutes) * bucketMinutes;
  date.setMinutes(roundedMinutes);
  return date.toISOString();
}

function getRobinRejections(snapshot: MetricsSnapshot) {
  return snapshot.rblRejections + snapshot.virusRejections + snapshot.spamRejections;
}

function getRspamdActions(snapshot: RspamdMetricsSnapshot) {
  return snapshot.actionsAddHeader
    + snapshot.actionsReject
    + snapshot.actionsSoftReject
    + snapshot.actionsGreylist
    + snapshot.actionsNoAction
    + snapshot.actionsRewriteSubject
    + snapshot.actionsDiscard
    + snapshot.actionsQuarantine;
}
