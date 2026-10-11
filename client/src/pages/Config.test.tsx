import { beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { ConfigPageView } from './Config';
import { ApiError } from '../api/client';
import { ConfirmProvider } from '../context/ConfirmContext';

function renderPage(section: 'security' | 'integration' | 'reporting') {
  return render(<MemoryRouter><ConfirmProvider><ConfigPageView section={section} /></ConfirmProvider></MemoryRouter>);
}

const {
  configGet,
  configGetRuntime,
  configUpdate,
  configReportingUsage,
  cleanupReporting,
  cleanupAuditLog,
  ipJailList,
  ipJailCreate,
  refreshFeatures,
  modulePolicyGet,
  modulePolicySave,
  moduleIdentityGet,
} = vi.hoisted(() => ({
  configGet: vi.fn(),
  configGetRuntime: vi.fn(),
  configUpdate: vi.fn(),
  configReportingUsage: vi.fn(),
  cleanupReporting: vi.fn(),
  cleanupAuditLog: vi.fn(),
  ipJailList: vi.fn(),
  ipJailCreate: vi.fn(),
  refreshFeatures: vi.fn(),
  modulePolicyGet: vi.fn(),
  modulePolicySave: vi.fn(),
  moduleIdentityGet: vi.fn(),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {
    constructor(message: string, public status = 400, public details?: string[]) {
      super(message);
    }
  },
  configApi: {
    get: configGet,
    getRuntime: configGetRuntime,
    update: configUpdate,
    getReportingUsage: configReportingUsage,
    cleanupReporting,
    cleanupAuditLog,
    rotateIngestionSecret: vi.fn(),
    clearLoginLocks: vi.fn(),
  },
  modulePolicyApi: { get: modulePolicyGet, save: modulePolicySave },
  moduleIdentityApi: { get: moduleIdentityGet },
  ipJailApi: {
    list: ipJailList,
    create: ipJailCreate,
    update: vi.fn(),
    lift: vi.fn(),
  },
}));

vi.mock('../components/ui/Button', () => ({
  Button: ({ children, onClick, isLoading, disabled, variant }: any) => (
    <button type="button" onClick={onClick} disabled={disabled || isLoading} data-variant={variant}>
      {children}
    </button>
  ),
}));

vi.mock('../components/ui/Input', () => ({
  Input: ({ label, value, onChange, ...rest }: any) => (
    <label>
      <span>{label}</span>
      <input value={value ?? ''} onChange={onChange} {...rest} />
    </label>
  ),
}));

vi.mock('../components/ui/PageHeader', () => ({
  PageHeader: ({ title, description, actions }: any) => (
    <div>
      <h1>{title}</h1>
      <p>{description}</p>
      <div>{actions}</div>
    </div>
  ),
}));

vi.mock('../constants/appIcons', () => ({
  appIcons: new Proxy({}, { get: () => () => null }),
}));

vi.mock('../hooks/useAuth', () => ({
  useIsAdmin: () => true,
}));

vi.mock('../context/FeaturesContext', () => ({
  useFeatures: () => ({
    refresh: refreshFeatures,
  }),
}));

function buildAdminConfig() {
  return {
    reportingRetentionDays: 365,
    reportingCacheMiB: 128,
    reportingCacheEntries: 200,
    reportingCacheTtlSeconds: 300,
    reportingSourceConcurrency: 2,
    reportingSourceQueueSize: 8,
    reportingSourceQueueWaitMs: 30000,
    auditLogRetentionDays: 0,
    gravatarEnabled: true,
    gravatarDefault: 'monsterid',
    reportingMtaStsChecksEnabled: false,
    reportingTlsrptChecksEnabled: false,
    reportingDaneChecksEnabled: false,
    reportingBimiChecksEnabled: false,
    reportingIntegrationEnabled: true,
    sessionTimeoutMinutes: 60,
    sessionAbsoluteLifetimeMinutes: 1440,
    maxLoginAttempts: 5,
    loginLockoutMinutes: 15,
    loginProtectionEnabled: true,
    loginMaxAttemptsPerEmail: 5,
    loginMaxAttemptsPerIp: 20,
    globalIpAllowlist: '',
    ingestionAuthRequired: true,
    ingestionAllowedCidrs: '127.0.0.0/8',
    ingestionSecretConfigured: false,
    csrfProtectionEnabled: true,
    allowedOrigins: '',
    trustedProxyCidrs: '',
    allowPrivateServiceUrls: false,
    apiKeyMaxLifetimeDays: 365,
    fleetEnabled: false,
    mailboxesEnabled: false,
    monitoringEnabled: false,
    modulesEnabled: false,
    robinConfigTableName: 'robin_config_store',
    alertDeliveryRetentionDays: 30,
    reportingDefaultWindowDays: 30,
    reportingStaleAfterDays: 7,
    reportingAnalysisDebounceMs: 10000,
    reportingAnalysisConcurrency: 4,
    reportingNonCompliantRateThreshold: 0.02,
    reportingNonCompliantMinVolume: 10,
    reportingNonCompliantAbsoluteFloor: 100,
    detectionUnknownSenderMinVolume: 50,
    detectionSpoofingMinFailCount: 100,
    detectionMisconfiguredMinVolume: 1000,
    detectionDmarcFailingPassRate: 0.95,
    detectionTlsFailureRate: 0.1,
    detectionTlsMinFailures: 10,
    detectionForensicSpikeMultiplier: 2,
    detectionForensicSpikeMinRecent: 3,
    detectionForensicClusterMinOccurrences: 2,
    detectionForensicClusterMaxIssues: 10,
    detectionRequiredRuns: 2,
    detectionGraceRuns: 2,
    sourceIdentityTtlDays: 30,
    sourceIdentityConcurrency: 12,
    sourceIdentityTimeoutMs: 3000,
    dnsResolvers: '1.1.1.1,8.8.8.8,9.9.9.9',
    senderEnrichmentDnsTimeoutMs: 3000,
    metricsPollIntervalMs: 60000,
    metricsRetentionDays: 14,
    logDefaultLines: 200,
    logMaxLines: 1000,
    agentImage: 'ghcr.io/transilvlad/robin-admin-agent:latest',
    agentInstallUrl: 'https://raw.githubusercontent.com/transilvlad/robin-admin/main/agent/install.sh',
    agentReleaseUrl: 'https://github.com/transilvlad/robin-admin/releases/latest/download',
    agentDeployGuideUrl: 'https://github.com/transilvlad/robin-admin/blob/main/doc/agent-deployment.md',
  };
}

function buildRuntimeConfig() {
  return {
    nodeEnv: 'production',
    port: 3000,
    logLevel: 'info',
    cookieDomain: 'admin.example.com',
    cookieSecure: true,
    allowedOrigins: ['https://admin.example.com'],
    bodyLimit: '50mb',
    rateLimit: { windowMs: 60000, maxRequests: 100, loginMaxRequests: 5 },
    postgres: {
      host: 'postgres',
      port: 5432,
      database: 'robin',
      user: 'robin',
      poolMax: 30,
      poolMin: 4,
      idleTimeoutMillis: 60000,
      connectionTimeoutMillis: 10000,
    },
    robin: { apiUrl: 'http://robin:8090', apiAuthConfigured: true },
    alerting: {
      enabled: true,
      evaluationIntervalMs: 30000,
      deliveryConcurrency: 4,
      instanceName: 'Robin Admin',
      encryptionKeyConfigured: true,
    },
    sheriff: {
      catalogBaseUrl: 'https://sheriff.robinmta.com',
      rootPublicKeyConfigured: true,
    },
    moduleInstaller: { url: 'http://127.0.0.1:3041', signingSecretConfigured: true },
    moduleProxySecretModules: ['robin-qa'],
    bootstrapModules: [],
  };
}

function buildReportingUsage() {
  return {
    dmarc: {
      reports: 2,
      records: 4,
      oldestReportDate: '2026-08-01T00:00:00.000Z',
      newestReportDate: '2026-08-18T00:00:00.000Z',
      storageBytes: 2048,
    },
    tlsrpt: {
      reports: 1,
      policies: 2,
      failures: 3,
      oldestReportDate: '2026-08-02T00:00:00.000Z',
      newestReportDate: '2026-08-17T00:00:00.000Z',
      storageBytes: 1024,
    },
    forensic: {
      reports: 5,
      oldestReportDate: '2026-08-03T00:00:00.000Z',
      newestReportDate: '2026-08-16T00:00:00.000Z',
      storageBytes: 512,
    },
  };
}

describe('ConfigPageView', () => {
  it('saves Mailboxes enablement and refreshes navigation through Integrations', async () => {
    renderPage('integration');
    const toggle = await screen.findByRole('checkbox', { name: 'Enable mailboxes' });
    expect(toggle).not.toBeChecked();
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({ mailboxesEnabled: true })));
    expect(refreshFeatures).toHaveBeenCalledOnce();
  });
  beforeEach(() => {
    cleanup();
    localStorage.clear();
    window.history.pushState({}, '', '/');
    vi.clearAllMocks();
    configGet.mockResolvedValue({ data: buildAdminConfig() });
    configGetRuntime.mockResolvedValue({ data: buildRuntimeConfig() });
    configUpdate.mockResolvedValue({ data: buildAdminConfig() });
    modulePolicyGet.mockResolvedValue({ success: true, data: { policies: [], trust: { issuer: 'urn:test:admin', keys: [] } } });
    modulePolicySave.mockImplementation(async policy => ({ success: true, data: policy }));
    configReportingUsage.mockResolvedValue({ data: buildReportingUsage() });
    cleanupReporting.mockResolvedValue({ data: { dmarc: 1, tlsrpt: 2, forensic: 3, total: 6 } });
    cleanupAuditLog.mockResolvedValue({ data: { deleted: 42 } });
    ipJailList.mockResolvedValue({ data: [] });
    ipJailCreate.mockResolvedValue({ data: { id: 1 } });
  });

  it('saves integration config without any singleton rspamd settings call', async () => {
    renderPage('integration');

    await screen.findByText('Integrations');

    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    await waitFor(() => {
      expect(configUpdate).toHaveBeenCalledOnce();
    });
    expect(refreshFeatures).toHaveBeenCalledOnce();
    expect(await screen.findByText('Configuration saved successfully')).toBeInTheDocument();
  });

  it('saves module policies from the page action without updating unrelated config', async () => {
    const policy = { slug: 'robin-qa', directoryRead: false, lifecycleRead: false, maxBodyMiB: 5, timeoutSeconds: 30 };
    modulePolicyGet.mockResolvedValue({ success: true, data: { policies: [policy], trust: { issuer: 'urn:test:admin', keys: [] } } });
    renderPage('integration');
    fireEvent.click(await screen.findByRole('button', { name: 'Modules' }));
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Maximum body (MiB)' }), { target: { value: '16' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    expect(await screen.findByText('Module policies saved successfully')).toBeInTheDocument();
    expect(modulePolicySave).toHaveBeenCalledWith({ ...policy, maxBodyMiB: 16 });
    expect(configUpdate).not.toHaveBeenCalled();
  });

  it('renders integrations in a predictable visual order with current capability copy', async () => {
    renderPage('integration');

    expect(await screen.findByText('Optional capabilities, service registry behavior, and shared integration defaults.')).toBeInTheDocument();

    const cards = screen.getByTestId('integration-cards');
    expect(Array.from(cards.children).map((card) => card.getAttribute('data-testid'))).toEqual([
      'capability-switches-card',
      'fleet-operations-card',
    ]);
    for (const card of Array.from(cards.children)) {
      expect(card).toHaveClass('min-w-0');
      expect(card).not.toHaveClass('xl:col-span-2');
      expect(card.querySelector('section')).not.toHaveClass('xl:col-span-2');
      expect(card.querySelector('section')).toHaveClass('min-w-0');
    }
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Capability switches',
      'Fleet operations',
    ]);

    expect(screen.getByText('Enable monitoring')).toBeInTheDocument();
    const capabilitySwitches = ['Mailboxes', 'Fleet', 'Monitoring', 'Telemetry', 'Reports', 'Modules'].map(name => screen.getByRole('checkbox', { name: `Enable ${name.toLowerCase()}` }));
    expect(capabilitySwitches).toHaveLength(6);
    for (const toggle of capabilitySwitches) {
      expect(toggle).toHaveAccessibleDescription(/retained when disabled\.$/);
      expect(toggle.closest('label')).toHaveClass('rounded-lg');
    }
    expect(screen.getByRole('checkbox', { name: 'Enable mailboxes' })).toHaveAccessibleDescription(/enables mailbox APIs/);
    expect(screen.getByRole('checkbox', { name: 'Enable monitoring' })).toHaveAccessibleDescription(/runs scheduled checks/);
    expect(screen.getByRole('checkbox', { name: /Enable reports/ })).toBeChecked();
    expect(screen.getByText('Enable modules')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Reports integration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Robin config store' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Module runtime status' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Avatar defaults' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Config store' }));
    expect(Array.from(cards.children).map((card) => card.getAttribute('data-testid'))).toEqual([
      'robin-config-store-card',
    ]);
    const tableName = await screen.findByRole('textbox', { name: 'Config-store table name' });
    expect(tableName).toHaveValue('robin_config_store');
    expect(tableName).toHaveAttribute('pattern', '[A-Za-z_][A-Za-z0-9_]*');
    expect(tableName).toHaveAttribute('maxlength', '63');
    expect(tableName).toBeRequired();
    expect(screen.getByText('default')).toBeInTheDocument();
    expect(screen.getByText('server_id')).toBeInTheDocument();
    expect(screen.getByText(/Saving takes effect immediately/)).toBeInTheDocument();
    expect(screen.getByText(/does not control Fleet availability or navigation/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Modules' }));
    expect(Array.from(cards.children).map((card) => card.getAttribute('data-testid'))).toEqual([
      'module-runtime-card',
      'module-host-policy-card',
    ]);
    expect(screen.getByText('https://sheriff.robinmta.com')).toBeInTheDocument();
    expect(screen.queryByText('Local Sheriff')).not.toBeInTheDocument();
    expect(screen.getByText(/Module proxy secrets are hidden/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Sheriff base URL')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Avatars' }));
    expect(Array.from(cards.children).map((card) => card.getAttribute('data-testid'))).toEqual([
      'avatar-defaults-card',
    ]);
    expect(screen.getByRole('heading', { name: 'Avatar defaults' })).toBeInTheDocument();

    expect(screen.queryByRole('heading', { name: 'Service ownership' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Robin integration' })).not.toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Rspamd controls' })).not.toBeInTheDocument();
    expect(screen.queryByText('Enable isolated Rspamd integration')).not.toBeInTheDocument();
    expect(screen.queryByText('Manage Robin signing query')).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Config store' }));
    const updatedTableName = await screen.findByRole('textbox', { name: 'Config-store table name' });
    fireEvent.change(updatedTableName, { target: { value: 'existing_robin_configs' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => {
      expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({
        robinConfigTableName: 'existing_robin_configs',
      }));
    });
  });

  it('surfaces config-store table validation errors from the server', async () => {
    configUpdate.mockRejectedValueOnce(new ApiError(
      'Robin config-store table name must start with a letter or underscore',
      400
    ));
    renderPage('integration');

    fireEvent.click(await screen.findByRole('button', { name: 'Config store' }));
    const tableName = await screen.findByRole('textbox', { name: 'Config-store table name' });
    fireEvent.change(tableName, { target: { value: 'invalid-table-name' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));

    expect(await screen.findByText(
      'Robin config-store table name must start with a letter or underscore'
    )).toBeInTheDocument();
  });

  it('renders reporting usage and cleans all raw reporting stores', async () => {
    renderPage('reporting');

    const cards = await screen.findByTestId('reporting-cards');
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Posture checks',
    ]);
    expect(screen.queryByText(/Robin Tools/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/Existing report data and ingestion settings remain unchanged/)).not.toBeInTheDocument();
    expect(screen.getByText(/current MTA-STS policy checks/)).toBeInTheDocument();
    expect(screen.getByText(/_smtp\._tls/)).toBeInTheDocument();
    expect(screen.getByText(/MX TLSA checks/)).toBeInTheDocument();
    expect(screen.getByText(/BIMI record checks/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Enable reports/ })).not.toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /MTA-STS/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /TLSRPT/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /DANE/ })).not.toBeChecked();
    expect(screen.getByRole('checkbox', { name: /BIMI/ })).not.toBeChecked();

    fireEvent.click(screen.getByRole('button', { name: 'Analysis' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Analysis windows',
      'Read capacity',
    ]);
    expect(screen.getByRole('spinbutton', { name: 'Cache budget (MiB)' })).toHaveValue(128);
    const queueSize = screen.getByRole('spinbutton', { name: 'Waiting source reads' });
    expect(queueSize).toHaveAttribute('min', '0');
    fireEvent.change(queueSize, { target: { value: '0' } });
    fireEvent.click(screen.getByRole('button', { name: /save settings/i }));
    await waitFor(() => expect(configUpdate).toHaveBeenCalledWith(expect.objectContaining({ reportingSourceQueueSize: 0 })));

    fireEvent.click(screen.getByRole('button', { name: 'Detection' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Source classification',
      'Issue detection',
    ]);
    expect(screen.getByRole('heading', { name: 'Issue detection' }).closest('section')).not.toHaveClass('xl:col-span-2');

    fireEvent.click(screen.getByRole('button', { name: 'DNS' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'DNS enrichment',
    ]);
    expect(screen.getByRole('heading', { name: 'DNS enrichment' }).closest('section')).toHaveClass('xl:col-span-2');

    fireEvent.click(screen.getByRole('button', { name: 'Ingestion' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Report ingestion',
    ]);
    expect(screen.getByRole('checkbox', { name: /Require ingestion authentication/ })).toBeChecked();
    const rotateButton = screen.getByRole('button', { name: /rotate secret/i });
    expect(rotateButton).toBeDisabled();
    const secretInput = screen.getByLabelText(/Shared secret/);
    expect(secretInput).toHaveAttribute('minlength', '20');
    fireEvent.change(secretInput, { target: { value: 'a'.repeat(20) } });
    expect(rotateButton).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retention' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Raw report retention',
    ]);
    expect(screen.getByRole('heading', { name: 'Raw report retention' }).closest('section')).toHaveClass('xl:col-span-2');

    const retention = screen.getByRole('spinbutton', { name: 'Report retention (days)' });
    expect(retention).toHaveAttribute('min', '1');
    expect(retention).toHaveAttribute('max', '3650');
    expect(retention).toHaveValue(365);

    expect(await screen.findByText('DMARC reports')).toBeInTheDocument();
    expect(screen.getByText('TLSRPT reports')).toBeInTheDocument();
    expect(screen.getByText('Forensic reports')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /cleanup old reports/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(cleanupReporting).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Cleaned up 6 old reports (1 DMARC, 2 TLSRPT, 3 forensic)')).toBeInTheDocument();
  });

  it('cleans up the audit log via the security section retention control', async () => {
    renderPage('security');

    fireEvent.click(await screen.findByRole('button', { name: 'Audit' }));
    const retention = await screen.findByRole('spinbutton', { name: 'Audit log retention (days)' });
    expect(retention).toHaveAttribute('min', '0');
    expect(retention).toHaveAttribute('max', '3650');
    expect(retention).toHaveValue(0);

    fireEvent.click(screen.getByRole('button', { name: /cleanup old audit log entries/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Confirm' }));

    await waitFor(() => {
      expect(cleanupAuditLog).toHaveBeenCalledOnce();
    });
    expect(await screen.findByText('Cleaned up 42 old audit log entries')).toBeInTheDocument();
  });

  it('renders Security controls in risk order with accurate constraints', async () => {
    renderPage('security');

    expect(await screen.findByText('Browser session policy, login defenses, network trust boundaries, and emergency IP blocks.')).toBeInTheDocument();

    const cards = screen.getByTestId('security-cards');
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Session and login policy',
    ]);

    expect(screen.getByText(/API-key requests are exempt/)).toBeInTheDocument();
    expect(screen.getByText(/cannot be shorter than idle timeout/)).toBeInTheDocument();
    expect(screen.getByText(/Account locks use the per-account threshold/)).toBeInTheDocument();

    expect(screen.getByRole('spinbutton', { name: 'Idle timeout (minutes)' })).toHaveAttribute('min', '5');
    expect(screen.getByRole('spinbutton', { name: 'Idle timeout (minutes)' })).toHaveAttribute('max', '1440');
    expect(screen.getByRole('spinbutton', { name: 'Absolute lifetime (minutes)' })).toHaveAttribute('min', '60');
    expect(screen.getByRole('spinbutton', { name: 'Absolute lifetime (minutes)' })).toHaveAttribute('max', '10080');
    expect(screen.getByRole('spinbutton', { name: 'Lockout duration (minutes)' })).toHaveAttribute('max', '60');
    expect(screen.getByRole('spinbutton', { name: 'Account attempt cap' })).toHaveAttribute('max', '10');
    expect(screen.getByRole('spinbutton', { name: 'Attempts per account' })).toHaveAttribute('max', '50');
    expect(screen.getByRole('spinbutton', { name: 'Attempts per IP' })).toHaveAttribute('max', '500');

    fireEvent.click(screen.getByRole('button', { name: 'Audit' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Audit log retention',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Runtime' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Runtime status',
    ]);

    fireEvent.click(screen.getByRole('button', { name: 'Network' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'Network and service trust',
    ]);
    expect(screen.getByText(/This controls CORS only/)).toBeInTheDocument();
    expect(screen.getByText(/forwarded client IP used by allowlists/)).toBeInTheDocument();
    expect(screen.getByText(/outbound Fleet connectors/)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'IP Jail' }));
    expect(within(cards).getAllByRole('heading').map((heading) => heading.textContent)).toEqual([
      'IP jail',
    ]);
    expect(screen.getByRole('heading', { name: 'IP jail' }).closest('section')).toHaveClass('xl:col-span-2');

    expect(screen.getByRole('button', { name: /add jail entry/i })).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'IP or CIDR' }), {
      target: { value: ' 203.0.113.42 ' },
    });

    fireEvent.change(screen.getByLabelText('Expires at, local time (blank = infinite)'), {
      target: { value: '2030-01-02T03:04' },
    });
    fireEvent.click(screen.getByRole('button', { name: /add jail entry/i }));

    await waitFor(() => {
      expect(ipJailCreate).toHaveBeenCalledWith({
        cidr: '203.0.113.42',
        reason: undefined,
        expiresAt: new Date('2030-01-02T03:04').toISOString(),
      });
    });

  });

  it('opens the module identity rotation panel from the Security tab', async () => {
    moduleIdentityGet.mockResolvedValue({
      success: true,
      data: {
        issuer: 'urn:robin-admin:fixture',
        trust: { issuer: 'urn:robin-admin:fixture', keys: [{ kid: 'fixture-public-kid', kty: 'OKP', crv: 'Ed25519', x: 'fixture', alg: 'EdDSA', use: 'sig' }] },
        trustFingerprint: 'a'.repeat(64),
        stage: 'stable',
        active: { kid: 'fixture-public-kid', createdAt: '2026-10-05T00:00:00.000Z' },
        pending: null,
        retiring: null,
        retentionMs: 360000,
        trustExportConfigured: true,
        configuredModules: [],
        affectedModules: [],
        activationReadiness: [],
        retirementReadiness: [],
      },
    });
    window.history.pushState({}, '', '/administration/security?tab=identity');
    renderPage('security');
    expect(await screen.findByText('Module identity signing keys')).toBeInTheDocument();
    expect(await screen.findAllByText('fixture-public-kid')).toHaveLength(2);
    expect(moduleIdentityGet).toHaveBeenCalledOnce();
  });
});
