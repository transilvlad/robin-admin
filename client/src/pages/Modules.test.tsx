import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi, beforeEach } from 'vitest';
import { ModulesPage } from './Modules';

const mockState = {
  user: { role: 'admin' as const },
  modules: [] as Array<Record<string, unknown>>,
  isLoading: false,
  error: null as string | null,
  refresh: vi.fn(),
  updateModule: vi.fn(),
};

const apiMocks = vi.hoisted(() => ({
  sync: vi.fn(),
  activate: vi.fn(),
  installerAction: vi.fn(),
  getInstallerJob: vi.fn(),
  getInstallerStatus: vi.fn(),
}));

vi.mock('../context/AuthContext', () => ({
  useAuth: () => ({
    user: mockState.user,
  }),
}));

vi.mock('../context/ModulesContext', () => ({
  useModules: () => ({
    modules: mockState.modules,
    isLoading: mockState.isLoading,
    error: mockState.error,
    refresh: mockState.refresh,
    updateModule: mockState.updateModule,
  }),
}));

vi.mock('../api/client', () => ({
  ApiError: class ApiError extends Error {},
  modulesApi: apiMocks,
}));

describe('ModulesPage', () => {
  afterEach(cleanup);
  beforeEach(() => {
    mockState.modules = [];
    mockState.isLoading = false;
    mockState.error = null;
    mockState.refresh.mockReset();
    mockState.updateModule.mockReset();
    Object.values(apiMocks).forEach((mock) => mock.mockReset());
  });
  it('requires deliberate downtime approval before a maintenance upgrade', async () => {
    mockState.modules = [{
      slug: 'robin-tools', displayName: 'Robin Tools', tier: 'free',
      installed: true, installedSource: 'installer', installerActions: ['upgrade'],
      installerUpgradeStrategy: 'maintenance', installedVersion: '1.0.0', latestVersion: '1.1.0',
      updateAvailable: true, active: true, activationStatus: 'active', runtimeStatus: 'reachable', metadata: {},
    }];
    apiMocks.installerAction.mockResolvedValue({
      data: { jobId: 'maintenance-job', action: 'upgrade', moduleSlug: 'robin-tools', status: 'succeeded' },
    });
    apiMocks.getInstallerStatus.mockResolvedValue({ data: {} });
    render(<ModulesPage />);
    fireEvent.click(screen.getByRole('button', { name: /^update$/i }));
    const dialog = screen.getByRole('dialog', { name: 'Maintenance upgrade' });
    expect(within(dialog).getByText(/Container rollback cannot undo database migrations/)).toBeInTheDocument();
    const approve = within(dialog).getByRole('button', { name: 'Start maintenance upgrade' });
    expect(approve).toBeDisabled();
    expect(apiMocks.installerAction).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole('checkbox'));
    fireEvent.click(approve);
    await waitFor(() => expect(apiMocks.installerAction).toHaveBeenCalledWith('robin-tools', 'upgrade', true));
  });

  it('keeps the runtime badge but removes the duplicate runtime message block', () => {
    mockState.modules = [
      {
        slug: 'robin-qa',
        displayName: 'Robin QA',
        description: 'QA module',
        vendorName: 'Robin',
        tier: 'paid',
        latestVersion: '0.1.0',
        installedVersion: '0.1.0',
        routeSlug: 'robin-qa',
        remoteScope: 'robinQa',
        exposedModule: './RobinQaApp',
        remoteEntryPath: '/modules/robin-qa/remoteEntry.js',
        remoteEntryUrl: '/modules/robin-qa/remoteEntry.js',
        installed: true,
        installedSource: 'bootstrap',
        installedNotes: null,
        installedAt: '2026-05-06T00:00:00.000Z',
        lastSeenAt: '2026-05-06T00:00:00.000Z',
        requiresLicense: true,
        updateAvailable: false,
        active: true,
        activationStatus: 'active',
        activationMessage: 'License active until 2026-06-06T00:00:00.000Z.',
        runtimeAvailable: true,
        runtimeStatus: 'reachable',
        runtimeMessage: 'Module runtime is reachable.',
        customerName: 'Acme Corp',
        issuedTo: 'ops@example.com',
        leaseToken: 'lease-token',
        leaseStartedAt: '2026-05-06T00:00:00.000Z',
        leaseExpiresAt: '2026-06-06T00:00:00.000Z',
        offlineGraceEndsAt: '2026-06-08T00:00:00.000Z',
        replacementAllowance: 2,
        replacementsUsed: 1,
        refreshFailureTerminal: false,
        lastValidatedAt: '2026-05-06T00:00:00.000Z',
        lastValidationError: null,
        licenseKeyLast4: 'ABCD',
        iconName: 'search',
        sortOrder: 1,
        metadata: {},
        moduleDefinition: null,
        syncedAt: '2026-05-06T00:00:00.000Z',
      },
    ];

    render(<ModulesPage />);

    expect(screen.getByText('Runtime reachable')).toBeInTheDocument();
    expect(screen.queryByText('Module runtime is reachable.')).not.toBeInTheDocument();
    expect(screen.getByText('Installed (bootstrap)')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Uninstall' })).not.toBeInTheDocument();
    expect(screen.queryByText('Online')).not.toBeInTheDocument();
    expect(screen.getAllByText('Installed v0.1.0').length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /update/i })).not.toBeInTheDocument();
    expect(screen.getByText('••••ABCD')).toBeInTheDocument();
    expect(screen.getByText('Replacements 1/2')).toBeInTheDocument();
  });

  it('hides the free healthy activation message and removes the explainer card', () => {
    mockState.modules = [
      {
        slug: 'robin-tools',
        displayName: 'Robin Tools',
        description: 'Utilities module',
        vendorName: 'Robin',
        tier: 'free',
        latestVersion: '0.1.0',
        installedVersion: '0.1.0',
        routeSlug: 'robin-tools',
        remoteScope: 'robinTools',
        exposedModule: './RobinToolsApp',
        remoteEntryPath: '/modules/robin-tools/remoteEntry.js',
        remoteEntryUrl: '/modules/robin-tools/remoteEntry.js',
        installed: true,
        installedSource: 'bootstrap',
        installedNotes: null,
        installedAt: '2026-05-06T00:00:00.000Z',
        lastSeenAt: '2026-05-06T00:00:00.000Z',
        requiresLicense: false,
        updateAvailable: false,
        active: true,
        activationStatus: 'active',
        activationMessage: null,
        runtimeAvailable: true,
        runtimeStatus: 'reachable',
        runtimeMessage: 'Module runtime is reachable.',
        customerName: null,
        issuedTo: null,
        leaseToken: null,
        leaseStartedAt: null,
        leaseExpiresAt: null,
        lastValidatedAt: null,
        lastValidationError: null,
        licenseKeyLast4: null,
        iconName: 'wrench',
        sortOrder: 2,
        metadata: {},
        moduleDefinition: null,
        syncedAt: '2026-05-06T00:00:00.000Z',
      },
    ];

    const { container } = render(<ModulesPage />);

    expect(screen.queryByText('This free module is installed and available.')).not.toBeInTheDocument();
    expect(screen.queryByText('Activation behavior')).not.toBeInTheDocument();
    const cardGrid = within(container).getByTestId('module-list');
    expect(within(cardGrid).getByText('Robin Tools')).toBeInTheDocument();
  });

  it('hides Start/Stop/Uninstall for the self-hosted operator console module', () => {
    mockState.modules = [
      {
        slug: 'robin-sheriff',
        displayName: 'Robin Sheriff',
        description: 'Operator console',
        vendorName: 'Robin',
        tier: 'free',
        latestVersion: '0.1.0',
        installedVersion: '0.1.0',
        routeSlug: 'robin-sheriff',
        remoteScope: 'robinSheriff',
        exposedModule: './RobinSheriffApp',
        remoteEntryPath: '/modules/robin-sheriff/remoteEntry.js',
        remoteEntryUrl: '/modules/robin-sheriff/remoteEntry.js',
        installed: true,
        installedSource: 'bootstrap',
        installedNotes: null,
        installedAt: '2026-05-06T00:00:00.000Z',
        lastSeenAt: '2026-05-06T00:00:00.000Z',
        requiresLicense: false,
        updateAvailable: false,
        active: true,
        activationStatus: 'active',
        activationMessage: null,
        runtimeAvailable: false,
        runtimeStatus: 'unknown',
        runtimeMessage: null,
        customerName: null,
        issuedTo: null,
        leaseToken: null,
        leaseStartedAt: null,
        leaseExpiresAt: null,
        lastValidatedAt: null,
        lastValidationError: null,
        licenseKeyLast4: null,
        iconName: 'sheriff',
        sortOrder: 1,
        metadata: { operatorConsole: true },
        moduleDefinition: null,
        syncedAt: '2026-05-06T00:00:00.000Z',
      },
    ];

    const { container } = render(<ModulesPage />);
    const cardGrid = within(container).getByTestId('module-list');

    expect(within(cardGrid).queryByRole('button', { name: /^start$/i })).not.toBeInTheDocument();
    expect(within(cardGrid).queryByRole('button', { name: /^stop$/i })).not.toBeInTheDocument();
    expect(within(cardGrid).queryByRole('button', { name: /^uninstall$/i })).not.toBeInTheDocument();
  });

  it('shows Update only when the installed module is behind the catalog version', () => {
    mockState.modules = [
      {
        slug: 'robin-tools',
        displayName: 'Robin Tools',
        description: 'Utilities module',
        vendorName: 'Robin',
        tier: 'free',
        latestVersion: '0.2.0',
        installerActions: ['upgrade', 'start', 'stop', 'uninstall'],
        installedVersion: '0.1.0',
        routeSlug: 'robin-tools',
        remoteScope: 'robinTools',
        exposedModule: './RobinToolsApp',
        remoteEntryPath: '/modules/robin-tools/remoteEntry.js',
        remoteEntryUrl: '/modules/robin-tools/remoteEntry.js',
        installed: true,
        installedSource: 'bootstrap',
        installedNotes: null,
        installedAt: '2026-05-06T00:00:00.000Z',
        lastSeenAt: '2026-05-06T00:00:00.000Z',
        requiresLicense: false,
        updateAvailable: true,
        active: true,
        activationStatus: 'active',
        activationMessage: null,
        runtimeAvailable: true,
        runtimeStatus: 'reachable',
        runtimeMessage: 'Module runtime is reachable.',
        customerName: null,
        issuedTo: null,
        leaseToken: null,
        leaseStartedAt: null,
        leaseExpiresAt: null,
        lastValidatedAt: null,
        lastValidationError: null,
        licenseKeyLast4: null,
        iconName: 'wrench',
        sortOrder: 2,
        metadata: {},
        moduleDefinition: null,
        syncedAt: '2026-05-06T00:00:00.000Z',
      },
    ];

    render(<ModulesPage />);

    expect(screen.getAllByText('Installed v0.1.0').length).toBeGreaterThan(0);
    expect(screen.getByText('Latest v0.2.0')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /update/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /upgrade/i })).not.toBeInTheDocument();
  });

  it('shows sanitized catalog trust metadata and disables unavailable delivery', () => {
    mockState.modules = [{
      slug: 'robin-paid',
      displayName: 'Robin Paid',
      description: 'Paid module',
      vendorName: 'Robin Labs',
      tier: 'paid',
      latestVersion: '1.2.3',
      installerActions: ['install'],
      installed: false,
      updateAvailable: false,
      active: false,
      activationStatus: 'not-installed',
      activationMessage: null,
      runtimeAvailable: false,
      runtimeStatus: 'unknown',
      runtimeMessage: null,
      metadata: {
        publisher: { displayName: 'Robin Labs', verified: true, kind: 'first-party' },
        delivery: {
          mode: 'sheriff-proxy',
          available: false,
          services: [{ name: 'frontend', digest: `sha256:${'a'.repeat(64)}` }],
        },
        permissions: ['mail:read', 'queue:manage'],
      },
    }];

    render(<ModulesPage />);

    expect(screen.getByText('Robin Labs')).toBeInTheDocument();
    expect(screen.getByText('Verified · first-party')).toBeInTheDocument();
    expect(screen.getByText('Unavailable (sheriff-proxy)')).toBeInTheDocument();
    expect(screen.getByText(`sha256:${'a'.repeat(64)}`)).toBeInTheDocument();
    expect(screen.getByText('mail:read')).toBeInTheDocument();
    const installButtons = screen.getAllByRole('button', { name: /^install$/i });
    expect(installButtons[installButtons.length - 1]).toBeDisabled();
  });

  it('polls accepted installer jobs and reports success only after completion', async () => {
    mockState.modules = [{
      slug: 'robin-tools',
      displayName: 'Robin Tools',
      description: 'Utilities',
      installedSource: 'installer',
      installerActions: ['start', 'stop', 'uninstall'],
      vendorName: 'Robin',
      tier: 'free',
      installed: true,
      installedVersion: '0.1.0',
      updateAvailable: false,
      active: true,
      activationStatus: 'active',
      activationMessage: null,
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: null,
      metadata: {},
      moduleDefinition: null,
    }];
    let finishJob!: (value: unknown) => void;
    const pendingJob = new Promise((resolve) => {
      finishJob = resolve;
    });
    apiMocks.installerAction.mockResolvedValue({
      success: true,
      data: {
        jobId: 'job-1',
        action: 'stop',
        moduleSlug: 'robin-tools',
        status: 'accepted',
        message: null,
      },
    });
    apiMocks.getInstallerJob.mockReturnValue(pendingJob);
    mockState.refresh.mockResolvedValue(undefined);
    apiMocks.getInstallerStatus.mockResolvedValue({ success: true, data: { moduleSlug: 'robin-tools' } });

    render(<ModulesPage />);
    const stopButtons = screen.getAllByRole('button', { name: /^stop$/i });
    fireEvent.click(stopButtons[stopButtons.length - 1]);

    await waitFor(() => expect(apiMocks.getInstallerJob).toHaveBeenCalledWith('robin-tools', 'job-1'));
    expect(screen.getByText('stop · accepted')).toBeInTheDocument();
    expect(screen.queryByText(/completed successfully/i)).not.toBeInTheDocument();

    finishJob({
      success: true,
      data: {
        jobId: 'job-1',
        action: 'stop',
        moduleSlug: 'robin-tools',
        status: 'succeeded',
        message: 'Stopped.',
        data: { progress: 100 },
      },
    });

    await waitFor(() => expect(screen.getByText('Robin Tools: stop completed successfully.')).toBeInTheDocument());
    expect(mockState.refresh).toHaveBeenCalled();
    expect(apiMocks.getInstallerStatus).toHaveBeenCalledWith('robin-tools');
    expect(screen.getByText('stop · succeeded · 100%')).toBeInTheDocument();
  });
});
