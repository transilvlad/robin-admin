import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { DashboardPage, pairDashboardCards } from './Dashboard';

const { getStats, getFleet, getPreferences, savePreferences, dismissSetupGuide, getOverview, getReporting, getMonitoringSummary, getBackendOverview, getTelemetrySources, features } = vi.hoisted(() => ({
  getStats: vi.fn(),
  getFleet: vi.fn(),
  getPreferences: vi.fn(),
  savePreferences: vi.fn(),
  dismissSetupGuide: vi.fn(),
  getOverview: vi.fn(),
  getReporting: vi.fn(),
  getMonitoringSummary: vi.fn(),
  getBackendOverview: vi.fn(),
  getTelemetrySources: vi.fn(),
  features: {
    mailboxes: true,
    users: true,
    aliases: true,
    autoAliases: true,
    queue: true,
    dmarc: true,
    reporting: true,
    robin: true,
    fleet: true,
    robinConfig: true,
    rspamd: true,
    clamav: true,
    fleetEnabled: true,
    monitoring: true,
    monitoringEnabled: true,
    modules: true,
    modulesEnabled: true,
    fleetServices: {
      total: 4,
      robin: 2,
      rspamd: 1,
      clamav: 1,
    },
  },
}));

vi.mock('../api/client', () => ({
  dashboardApi: {
    getStats,
    getFleet,
    getPreferences,
    savePreferences,
    dismissSetupGuide,
  },
  reportingApi: {
    getOverview,
  },
  dashboardReportingApi: {
    get: getReporting,
  },
  monitoringApi: {
    summary: getMonitoringSummary,
  },
  modulesApi: {
    getBackendOverview,
  },
  telemetryApi: {
    sources: getTelemetrySources,
  },
}));

vi.mock('../context/FeaturesContext', () => ({
  useFeatures: () => ({
    features,
  }),
}));

vi.mock('../context/ModulesContext', () => ({
  useModules: () => ({ modules: [] }),
}));

vi.mock('../components/charts', () => ({
  DonutChart: () => <div data-testid="donut-chart" />,
}));

vi.mock('../components/ui/PageHeader', () => ({
  PageHeader: ({ title, actions }: any) => (
    <div>
      <h1>{title}</h1>
      <div>{actions}</div>
    </div>
  ),
}));

vi.mock('../constants/appIcons', () => ({
  appIcons: new Proxy({}, { get: () => () => null }),
}));

function buildStats() {
  return {
    users: 10,
    aliases: 5,
    autoAliases: 2,
    admins: 1,
    queue: {
      total: 0,
      byState: {},
      byProtocol: {},
    },
    robinConnected: true,
    dmarc: {
      totalReports: 1,
      totalMessages: 100,
      errorMessages: 0,
      recentReports: 1,
      last30Days: 1,
    },
    tlsrpt: {
      totalReports: 1,
      last24Hours: 1,
      last30Days: 1,
      totalSuccess: 1,
      totalFailure: 0,
    },
    forensic: {
      totalReports: 0,
      last24Hours: 0,
      last30Days: 0,
    },
    configWarnings: {
      staticTestUsersEnabled: false,
      developmentOptionsEnabled: false,
      enabledReasons: [],
    },
    metrics: null,
    email24h: {
      received: 0,
      delivered: 0,
      rejected: 0,
    },
  };
}

function buildMonitoringSummary() {
  return {
    targets: [],
    checks: [],
    openIssues: [],
    recentIssues: [],
    recentObservations: [],
    weeklyIssueCounts: [],
  };
}

function buildFleet() {
  const robinServices = Array.from({ length: 2 }, (_, index) => ({
    serviceId: `robin-${index + 1}`,
    serviceType: 'robin' as const,
    name: `Robin ${index + 1}`,
    healthy: true,
    metrics: {
      serviceId: `robin-${index + 1}`,
      serviceType: 'robin' as const,
      memoryPct: 20 + index,
      cpuPct: 10 + index,
      threads: 5 + index,
      totalReceived: 1000 + index,
      totalDelivered: 900 + index,
      totalRejected: 100 + index,
      received24h: 100 + index,
      delivered24h: 90 + index,
      rejected24h: index,
      rblRejected24h: 0,
      virusRejected24h: 0,
      spamRejected24h: index,
      dosBlocked24h: 0,
    },
  }));

  const rspamdService = {
    serviceId: 'rspamd-core',
    serviceType: 'rspamd' as const,
    name: 'Rspamd Core',
    healthy: true,
    metrics: {
      serviceId: 'rspamd-core',
      serviceType: 'rspamd' as const,
      controllerReachable: true,
      controllerAuthenticated: true,
      controllerHealthy: true,
      controllerStatusCode: 200,
      normalWorkerPingOk: true,
      scannedMessages: 2000,
      spamMessages: 120,
      hamMessages: 1880,
      learnedSpam: 10,
      learnedHam: 20,
      totalActions: 160,
      actionBreakdown: {
        addHeader: 40,
        reject: 20,
        softReject: 10,
        greylist: 5,
        noAction: 70,
        rewriteSubject: 8,
        discard: 2,
        quarantine: 5,
      },
      connections: 12,
      uptimeSeconds: 3600,
      memoryAllocatedMB: 32,
      memoryResidentMB: 24,
      scanned24h: 1500,
      spam24h: 90,
      ham24h: 1410,
      learnedSpam24h: 6,
      learnedHam24h: 8,
      actionBreakdown24h: {
        addHeader: 35,
        reject: 15,
        softReject: 8,
        greylist: 4,
        noAction: 60,
        rewriteSubject: 5,
        discard: 1,
        quarantine: 3,
      },
      totalActions24h: 131,
    },
  };

  const clamavService = {
    serviceId: 'clamav-primary',
    serviceType: 'clamav' as const,
    name: 'ClamAV Primary',
    healthy: true,
    metrics: {
      serviceId: 'clamav-primary',
      serviceType: 'clamav' as const,
      pingOk: true,
      versionText: 'ClamAV 1.4.3',
      engineVersion: '1.4.3',
      databaseVersion: 123456,
      databaseUpdatedAt: '2025-01-01T00:00:00Z',
      statusText: 'ready',
      pools: 2,
      threadsLive: 4,
      threadsIdle: 2,
      threadsMax: 6,
      queueItems: 4,
      memoryHeapMB: 16,
      memoryMmapMB: 10,
      memoryUsedMB: 42,
      memoryFreeMB: 12,
      memoryReleasableMB: 3,
      memoryPoolsUsedMB: 20,
      memoryPoolsTotalMB: 24,
      rawStats: '',
      peakQueue24h: 9,
      peakMemoryMB24h: 48,
      unhealthySamples24h: 2,
    },
  };

  const services = [...robinServices, rspamdService, clamavService];

  return {
    fleet: {
      totalInstances: robinServices.length,
      healthyInstances: robinServices.length,
      totalReceived: 2001,
      totalDelivered: 1801,
      totalRejected: 201,
      received24h: 201,
      delivered24h: 181,
      rejected24h: 1,
      avgMemoryPct: 21,
      avgCpuPct: 11,
      rejectionBreakdown24h: {
        rbl: 0,
        virus: 0,
        spam: 1,
        dos: 0,
      },
    },
    overview: {
      totalServices: services.length,
      healthyServices: services.length,
      byType: {
        robin: {
          totalServices: robinServices.length,
          healthyServices: robinServices.length,
          totals: {
            totalInstances: robinServices.length,
            healthyInstances: robinServices.length,
            totalReceived: 2001,
            totalDelivered: 1801,
            totalRejected: 201,
            received24h: 201,
            delivered24h: 181,
            rejected24h: 1,
            avgMemoryPct: 21,
            avgCpuPct: 11,
            rejectionBreakdown24h: {
              rbl: 0,
              virus: 0,
              spam: 1,
              dos: 0,
            },
          },
        },
        rspamd: {
          totalServices: 1,
          healthyServices: 1,
          totals: {
            totalServices: 1,
            healthyServices: 1,
            totalScanned: 2000,
            totalSpam: 120,
            totalHam: 1880,
            scanned24h: 1500,
            spam24h: 90,
            ham24h: 1410,
            learnedSpam24h: 6,
            learnedHam24h: 8,
            totalActions24h: 131,
            avgMemoryResidentMB: 24,
            avgConnections: 12,
            actionBreakdown24h: {
              addHeader: 35,
              reject: 15,
              softReject: 8,
              greylist: 4,
              noAction: 60,
              rewriteSubject: 5,
              discard: 1,
              quarantine: 3,
            },
          },
        },
        clamav: {
          totalServices: 1,
          healthyServices: 1,
          totals: {
            totalServices: 1,
            healthyServices: 1,
            availableServices: 1,
            queueItems: 4,
            peakQueue24h: 9,
            avgMemoryUsedMB: 42,
            staleDatabaseServices: 1,
            unhealthySamples24h: 2,
            versions: ['ClamAV 1.4.3'],
          },
        },
      },
    },
    services,
    topServices: services,
    byType: {
      robin: robinServices,
      rspamd: [rspamdService],
      clamav: [clamavService],
    },
  };
}

function buildRspamdOnlyFleet() {
  const fleet = buildFleet();
  const rspamdService = fleet.byType.rspamd[0];

  return {
    ...fleet,
    fleet: {
      totalInstances: 0,
      healthyInstances: 0,
      totalReceived: 0,
      totalDelivered: 0,
      totalRejected: 0,
      received24h: 0,
      delivered24h: 0,
      rejected24h: 0,
      avgMemoryPct: 0,
      avgCpuPct: 0,
      rejectionBreakdown24h: {
        rbl: 0,
        virus: 0,
        spam: 0,
        dos: 0,
      },
    },
    overview: {
      totalServices: 1,
      healthyServices: 1,
      byType: {
        robin: {
          totalServices: 0,
          healthyServices: 0,
          totals: {
            totalInstances: 0,
            healthyInstances: 0,
            totalReceived: 0,
            totalDelivered: 0,
            totalRejected: 0,
            received24h: 0,
            delivered24h: 0,
            rejected24h: 0,
            avgMemoryPct: 0,
            avgCpuPct: 0,
            rejectionBreakdown24h: {
              rbl: 0,
              virus: 0,
              spam: 0,
              dos: 0,
            },
          },
        },
        rspamd: fleet.overview.byType.rspamd,
        clamav: {
          totalServices: 0,
          healthyServices: 0,
          totals: {
            totalServices: 0,
            healthyServices: 0,
            availableServices: 0,
            queueItems: 0,
            peakQueue24h: 0,
            avgMemoryUsedMB: 0,
            staleDatabaseServices: 0,
            unhealthySamples24h: 0,
            versions: [],
          },
        },
      },
    },
    services: [rspamdService],
    topServices: [rspamdService],
    byType: {
      robin: [],
      rspamd: [rspamdService],
      clamav: [],
    },
  };
}

function buildDatabaseFleet() {
  const fleet = buildFleet();
  const redisService = {
    serviceId: 'suite-redis',
    serviceType: 'redis' as const,
    name: 'Suite Redis',
    healthy: true,
    metrics: {
      reachable: true,
      connectedClients: 42,
      instantaneousOpsPerSec: 12,
      opsProcessed24h: 1234,
      memoryUsedBytes: 2048,
      memFragmentationRatio: 1.1,
      evictedKeys24h: 0,
      unreachableSamples24h: 0,
      peakMemoryUsedBytes24h: 2048,
      peakConnectedClients24h: 42,
    },
  };
  const postgresService = {
    serviceId: 'suite-postgres',
    serviceType: 'postgres' as const,
    name: 'Suite PostgreSQL',
    healthy: true,
    metrics: {
      reachable: true,
      connectionsTotal: 8,
      connectionsActive: 2,
      xactCommit24h: 321,
      connectionSaturationPct: 8,
      cacheHitRatio: 0.995,
      deadlocks24h: 0,
      unreachableSamples24h: 0,
      peakConnectionsTotal24h: 8,
      peakConnectionSaturationPct24h: 8,
    },
  };

  return {
    ...fleet,
    overview: {
      ...fleet.overview,
      totalServices: fleet.overview.totalServices + 2,
      healthyServices: fleet.overview.healthyServices + 2,
      byType: {
        ...fleet.overview.byType,
        redis: {
          totalServices: 1,
          healthyServices: 1,
          totals: {
            totalServices: 1,
            healthyServices: 1,
            availableServices: 1,
            connectedClients: 42,
            memoryUsedBytes: 2048,
            hitRatio: 95,
            opsProcessed24h: 1234,
            evictedKeys24h: 0,
            peakMemoryUsedBytes24h: 2048,
            peakConnectedClients24h: 42,
            unreachableSamples24h: 0,
          },
        },
        postgres: {
          totalServices: 1,
          healthyServices: 1,
          totals: {
            totalServices: 1,
            healthyServices: 1,
            availableServices: 1,
            connectionsTotal: 8,
            cacheHitRatio: 0.995,
            xactCommit24h: 321,
            xactRollback24h: 2,
            deadlocks24h: 0,
            databaseSizeBytes: 1024,
            peakConnectionSaturationPct24h: 8,
            unreachableSamples24h: 0,
          },
        },
      },
    },
    services: [...fleet.services, redisService, postgresService],
    topServices: [...fleet.topServices, redisService, postgresService],
    byType: {
      ...fleet.byType,
      redis: [redisService],
      postgres: [postgresService],
    },
  };
}

describe('DashboardPage', () => {
  beforeEach(() => {
    cleanup();
    vi.clearAllMocks();
    getStats.mockResolvedValue({ data: buildStats() });
    getFleet.mockResolvedValue({ data: buildFleet() });
    getPreferences.mockResolvedValue({ data: { hidden: [] } });
    savePreferences.mockResolvedValue({ data: { hidden: [] } });
    getOverview.mockResolvedValue({ data: null });
    getReporting.mockResolvedValue({ data: null });
    getMonitoringSummary.mockResolvedValue({ data: buildMonitoringSummary() });
    getBackendOverview.mockResolvedValue({ data: null });
    getTelemetrySources.mockResolvedValue({ data: [] });
    Object.assign(features, { telemetry: false });
    Object.assign(features, {
      users: true,
      mailboxes: true,
      aliases: true,
      autoAliases: true,
      queue: true,
      dmarc: true,
      reporting: true,
      robin: true,
      fleet: true,
      robinConfig: true,
      rspamd: true,
      clamav: true,
      fleetEnabled: true,
      monitoring: true,
      monitoringEnabled: true,
      modules: true,
      modulesEnabled: true,
    });
  });

  it('shows every optional capability in the first-time guide when defaults are disabled', async () => {
    Object.assign(features, {
      mailboxes: false,
      dmarc: false,
      reporting: false,
      robin: false,
      fleet: false,
      fleetEnabled: false,
      monitoring: false,
      monitoringEnabled: false,
      modules: false,
      modulesEnabled: false,
    });
    getPreferences.mockResolvedValue({ data: { hidden: [], setupGuide: true } });
    dismissSetupGuide.mockResolvedValue({ success: true });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    const setup = await screen.findByRole('heading', { name: 'First-time setup' });
    const setupCard = setup.closest('section') as HTMLElement;

    const setupLinks = within(setupCard).getAllByRole('link').map((link) => ({
      label: link.textContent,
      href: link.getAttribute('href'),
    })).filter((link) => link.label?.startsWith('Enable '));
    expect(setupLinks).toEqual([
      expect.objectContaining({ label: expect.stringContaining('Enable mailboxes'), href: '/administration/integration?tab=capabilities' }),
      expect.objectContaining({ label: expect.stringContaining('Enable fleet'), href: '/administration/integration?tab=capabilities' }),
      expect.objectContaining({ label: expect.stringContaining('Enable monitoring'), href: '/administration/integration?tab=capabilities' }),
      expect.objectContaining({ label: expect.stringContaining('Enable reports'), href: '/administration/reporting' }),
      expect.objectContaining({ label: expect.stringContaining('Enable modules'), href: '/administration/integration?tab=modules' }),
    ]);

    fireEvent.click(within(setupCard).getByRole('button', { name: 'Dismiss' }));
    expect(screen.queryByRole('heading', { name: 'First-time setup' })).not.toBeInTheDocument();
    expect(dismissSetupGuide).toHaveBeenCalled();
  });

  it('summarises Telemetry hosts and lists silent ones when Telemetry is on', async () => {
    Object.assign(features, { telemetry: true });
    const now = Math.floor(Date.now() / 1000);
    getTelemetrySources.mockResolvedValue({
      data: { sources: [
        { name: 'worker-a', groups: ['worker'], query: '{instance="worker-a"}', series: 10, lastSeen: now - 30, silent: false },
        { name: 'service-a', groups: ['service'], query: '{instance="service-a"}', series: 10, lastSeen: now - 7200, silent: true },
      ] },
    });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    const heading = await screen.findByRole('heading', { name: 'Telemetry sources' });
    const card = heading.closest('.card') as HTMLElement;
    expect(within(card).getByRole('link', { name: /Sources/ })).toHaveAttribute('href', '/telemetry/sources');
    expect(within(card).getByRole('link', { name: /service-a/ })).toHaveAttribute('href', '/telemetry/explore?q=%7Binstance%3D%22service-a%22%7D');
    expect(within(card).queryByText('worker-a')).not.toBeInTheDocument();
  });

  it('does not ask for Telemetry sources when Telemetry is off', async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );
    await waitFor(() => expect(getStats).toHaveBeenCalled());
    expect(getTelemetrySources).not.toHaveBeenCalled();
    expect(screen.queryByRole('heading', { name: 'Telemetry hosts' })).not.toBeInTheDocument();
  });

  it('shows a compact per-type Fleet summary instead of a per-instance table', async () => {
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(getStats).toHaveBeenCalledOnce();
      expect(getFleet).toHaveBeenCalledOnce();
    });

    // The dashboard renders one fleet row per service type and pairs it with
    // Protection pressure. No separate "At-risk Services" tile and no
    // per-family "needing attention" duplication.
    const heading = await screen.findByRole('heading', { name: 'Fleet summary' });
    const fleetCard = heading.closest('.card') as HTMLElement;
    expect(screen.queryByRole('heading', { name: /Service fleet & activity/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();

    // One row per service type, using each type's own headline metric.
    expect(within(fleetCard).getByText('Robin')).toBeInTheDocument();
    expect(within(fleetCard).getByText('Delivered (24h)')).toBeInTheDocument();
    expect(within(fleetCard).getByText('Rspamd')).toBeInTheDocument();
    expect(within(fleetCard).getByText('Scanned (24h)')).toBeInTheDocument();
    expect(within(fleetCard).getByText('ClamAV')).toBeInTheDocument();
    expect(within(fleetCard).getByText('Queued now')).toBeInTheDocument();

    // Individual service instance names belong on Fleet -> Metrics.
    expect(screen.queryByText('Rspamd Core')).not.toBeInTheDocument();
    expect(screen.queryByText('ClamAV Primary')).not.toBeInTheDocument();

    expect(screen.queryByText('At-risk Services')).not.toBeInTheDocument();
    expect(screen.queryByText('Services needing attention')).not.toBeInTheDocument();
  });

  it('renders Redis and Postgres headline metrics in the Fleet summary panel', async () => {
    getFleet.mockResolvedValue({ data: buildDatabaseFleet() });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    const heading = await screen.findByRole('heading', { name: 'Fleet summary' });
    const fleetCard = heading.closest('.card') as HTMLElement;

    expect(within(fleetCard).getByText('Redis')).toBeInTheDocument();
    expect(within(fleetCard).getByText('Connected clients')).toBeInTheDocument();
    expect(within(fleetCard).getByText('42')).toBeInTheDocument();
    expect(within(fleetCard).getByText('Postgres')).toBeInTheDocument();
    expect(within(fleetCard).getByText('Connections')).toBeInTheDocument();
    expect(within(fleetCard).getByText('8')).toBeInTheDocument();
  });

  it('hides service families that have no enabled fleet services', async () => {
    getFleet.mockResolvedValue({ data: buildRspamdOnlyFleet() });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    // Rspamd-only fleet: only the Rspamd row renders in the compact Fleet
    // summary — Robin and ClamAV rows are absent.
    const heading = await screen.findByRole('heading', { name: 'Fleet summary' });
    const fleetCard = heading.closest('.card') as HTMLElement;
    expect(within(fleetCard).getByText('Rspamd')).toBeInTheDocument();
    expect(within(fleetCard).getByText('1,500')).toBeInTheDocument();
    expect(within(fleetCard).queryByText('Robin')).not.toBeInTheDocument();
    expect(within(fleetCard).queryByText('ClamAV')).not.toBeInTheDocument();
  });

  it('ranks Capacity peaks by highest utilization instead of always showing the same types', async () => {
    const fleet = buildDatabaseFleet();
    // Give Redis a configured memory ceiling so it becomes percent-eligible,
    // with usage higher than Robin/Postgres — proving the card re-ranks by
    // pressure instead of always surfacing the same fixed metrics.
    (fleet.byType.redis[0].metrics as { maxMemoryBytes?: number }).maxMemoryBytes = 2048;
    getFleet.mockResolvedValue({ data: fleet });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    const heading = await screen.findByRole('heading', { name: 'Capacity peaks' });
    const card = heading.closest('.card') as HTMLElement;
    const values = within(card).getAllByText(/%$/).map((el) => el.textContent);

    // Redis is at 100% usage (2048 / 2048) — higher than Robin's 21% memory
    // peak, Robin's 11% CPU peak, and Postgres's 8% saturation — so it must
    // lead the list even though it's never been one of the "usual" metrics.
    expect(values[0]).toBe('100%');
    expect(values).toEqual([...values].sort((a, b) => parseFloat(b!) - parseFloat(a!)));
  });

  it('shows a compact production warning when test users or development options are enabled', async () => {
    getStats.mockResolvedValue({
      data: {
        ...buildStats(),
        configWarnings: {
          staticTestUsersEnabled: true,
          developmentOptionsEnabled: true,
          enabledReasons: ['Static test users', 'server development options'],
        },
      },
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    expect(await screen.findByText(/Warning:/)).toBeInTheDocument();
    expect(screen.getByText(/Static test users and server development options are currently enabled\./)).toBeInTheDocument();
  });

  it('does not render mail or reporting data for a standalone Sheriff Admin', async () => {
    Object.assign(features, {
      users: false,
      aliases: false,
      autoAliases: false,
      queue: false,
      dmarc: false,
      reporting: false,
      robin: false,
      fleet: false,
      postfix: false,
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    expect(await screen.findByText('Admins')).toBeInTheDocument();
    expect(screen.queryByText('Robin delivered · 24h')).not.toBeInTheDocument();
    expect(screen.queryByText('Postfix queue')).not.toBeInTheDocument();
    expect(screen.queryByText('Robin queue pressure')).not.toBeInTheDocument();
    expect(screen.queryByText('TLSRPT')).not.toBeInTheDocument();
    expect(screen.queryByText('Forensic')).not.toBeInTheDocument();
    expect(screen.queryByText('DMARC')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Service fleet & activity' })).not.toBeInTheDocument();
    expect(getFleet).not.toHaveBeenCalled();
  });

  it('prioritizes Robin queue pressure over Postfix when Robin is present, and links Admins to the real route', async () => {
    Object.assign(features, { postfix: true });
    const fleet = buildFleet();
    (fleet.overview.byType as any).postfix = {
      totalServices: 1,
      healthyServices: 1,
      totals: {
        totalServices: 1,
        healthyServices: 1,
        availableServices: 1,
        queueActive: 2,
        queueDeferred: 3,
        queueHold: 0,
        queueIncoming: 0,
        queueTotal: 5,
        peakQueue24h: 8,
        peakDeferred24h: 4,
        maxDeferredAgeSecs: 0,
        unreachableSamples24h: 0,
      },
    };
    getFleet.mockResolvedValue({ data: fleet });
    getStats.mockResolvedValue({ data: { ...buildStats(), queue: { total: 7, byState: {}, byProtocol: {} } } });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    const mailTile = (await screen.findByText('Mail flow · 24h')).closest('.card') as HTMLElement;
    expect(screen.queryByText('Postfix queue')).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Postfix queue pressure' })).not.toBeInTheDocument();

    expect(within(mailTile).getByText(/7 queued/)).toBeInTheDocument();
    expect(within(mailTile).getByRole('link', { name: /Robin queue/ })).toHaveAttribute('href', '/robin/queue');

    expect(screen.getByRole('link', { name: /Admins/ })).toHaveAttribute('href', '/administration/access');

    // Postfix queue pressure should not reuse the Robin queue copy.
    expect(screen.queryByText('Messages queued')).not.toBeInTheDocument();
  });

  it('uses Postfix queue pressure as the mail fallback for Postfix-only deployments', async () => {
    Object.assign(features, {
      robin: false,
      queue: false,
      postfix: true,
      rspamd: false,
      clamav: false,
      fleetServices: {
        total: 1,
        robin: 0,
        rspamd: 0,
        clamav: 0,
        dovecot: 0,
        postfix: 1,
        redis: 0,
        postgres: 0,
      },
    });
    const postfixService = {
      serviceId: 'postfix-primary',
      serviceType: 'postfix' as const,
      name: 'Postfix Primary',
      healthy: true,
      metrics: {
        serviceId: 'postfix-primary',
        serviceType: 'postfix' as const,
        reachable: true,
        queueActive: 2,
        queueDeferred: 3,
        queueHold: 0,
        queueIncoming: 0,
        queueTotal: 5,
        oldestDeferredAgeSecs: 120,
        peakQueue24h: 8,
        peakDeferred24h: 4,
        maxDeferredAgeSecs24h: 120,
        unreachableSamples24h: 0,
      },
    };
    getFleet.mockResolvedValue({
      data: {
        fleet: {
          totalInstances: 0,
          healthyInstances: 0,
          totalReceived: 0,
          totalDelivered: 0,
          totalRejected: 0,
          received24h: 0,
          delivered24h: 0,
          rejected24h: 0,
          avgMemoryPct: 0,
          avgCpuPct: 0,
          rejectionBreakdown24h: { rbl: 0, virus: 0, spam: 0, dos: 0 },
        },
        overview: {
          totalServices: 1,
          healthyServices: 1,
          byType: {
            postfix: {
              totalServices: 1,
              healthyServices: 1,
              totals: {
                totalServices: 1,
                healthyServices: 1,
                availableServices: 1,
                queueActive: 2,
                queueDeferred: 3,
                queueHold: 0,
                queueIncoming: 0,
                queueTotal: 5,
                peakQueue24h: 8,
                peakDeferred24h: 4,
                maxDeferredAgeSecs: 120,
                unreachableSamples24h: 0,
              },
            },
          },
        },
        services: [postfixService],
        topServices: [postfixService],
        byType: {
          postfix: [postfixService],
        },
      },
    });

    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    const postfixCard = (await screen.findByRole('heading', { name: 'Postfix queue pressure' })).closest('.card') as HTMLElement;
    expect(within(postfixCard).getByText('5')).toBeInTheDocument();
    expect(within(postfixCard).getByText('Deferred')).toBeInTheDocument();
    expect(within(postfixCard).getByRole('link', { name: /Postfix metrics/ })).toHaveAttribute('href', '/postfix/metrics');
    expect(screen.queryByText('Robin flow & queue pressure')).not.toBeInTheDocument();
  });

  it('shows one headline tile per enabled integration and fleet health as a tile', async () => {
    getMonitoringSummary.mockResolvedValue({ data: { ...buildMonitoringSummary(), checks: [
      { id: 1, name: 'HTTPS one', targetId: 1, currentStatus: 'up', pausedAt: null },
      { id: 2, name: 'HTTPS two', targetId: 1, currentStatus: 'up', pausedAt: null },
      { id: 3, name: 'SMTP paused', targetId: 1, currentStatus: 'unknown', pausedAt: '2026-10-07T00:00:00Z' },
    ] } });
    render(
      <MemoryRouter>
        <DashboardPage />
      </MemoryRouter>
    );

    const fleetTile = (await screen.findByText('Fleet health')).closest('.card') as HTMLElement;
    expect(within(fleetTile).getByRole('link', { name: /Metrics/ })).toHaveAttribute('href', '/fleet/metrics');
    const checksTile = screen.getByText('External checks').closest('.card') as HTMLElement;
    expect(within(checksTile).getByText('2 / 3')).toBeInTheDocument();
    expect(within(checksTile).getByText(/1 paused/)).toBeInTheDocument();
    expect(screen.queryByText('Fleet healthy')).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Quick links' }).closest('.card')).not.toBeNull();
  });

});

describe('pairDashboardCards', () => {
  const ids = (rows: Array<Array<Array<{ id: string }>>>) => rows.map((row) => row.map((slot) => slot.map((card) => card.id)));
  const cards = (...names: string[]) => names.map((id) => ({ id }));

  it('keeps related cards together and stacks short cards beside a tall one', () => {
    expect(ids(pairDashboardCards(cards('mail-flow', 'monitoring', 'telemetry', 'message-outcomes', 'pressure', 'fleet', 'capacity-peaks')))).toEqual([
      [['mail-flow'], ['monitoring']],
      [['message-outcomes'], ['pressure']],
      [['fleet'], ['capacity-peaks', 'telemetry']],
    ]);
  });

  it('pairs slots whose partners are missing and gives a final lone slot the full row', () => {
    expect(ids(pairDashboardCards(cards('monitoring', 'telemetry')))).toEqual([[['monitoring'], ['telemetry']]]);
    expect(ids(pairDashboardCards(cards('mail-flow', 'message-outcomes', 'fleet')))).toEqual([
      [['mail-flow'], ['message-outcomes']],
      [['fleet']],
    ]);
    expect(ids(pairDashboardCards(cards('message-outcomes')))).toEqual([[['message-outcomes']]]);
    expect(pairDashboardCards([])).toEqual([]);
  });
});
