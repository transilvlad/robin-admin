import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import router from './modules.js';
import * as modulesService from '../services/modules.js';
import * as moduleInstallerService from '../services/module-installer.js';
import { getConfig } from '../db/queries/config.js';

vi.mock('../middleware/auth.js', () => ({
  getCurrentAdmin: () => ({
    adminId: 1,
    name: 'Test Admin',
    email: 'admin@example.com',
    role: 'admin',
  }),
  requireAuth: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../middleware/rbac.js', () => ({
  requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
  requireViewer: (_req: unknown, _res: unknown, next: () => void) => next(),
}));

vi.mock('../services/modules.js', () => ({
  activateModuleLicense: vi.fn(),
  refreshModuleLicenseIfNeeded: vi.fn(),
  finalizeModuleInstallerAction: vi.fn(),
  getModuleForUi: vi.fn(),
  getModuleRegistryCredentials: vi.fn(async () => []),
  listModulesForUi: vi.fn(),
  ModuleAccessError: class ModuleAccessError extends Error {
    constructor(message: string, public readonly status = 403) {
      super(message);
    }
  },
  syncModuleCatalogFromSherif: vi.fn(),
}));

vi.mock('../services/module-installer.js', () => ({
  dispatchModuleInstallerAction: vi.fn(),
  getModuleInstallerJob: vi.fn(),
  getModuleInstallerStatus: vi.fn(),
  ModuleInstallerError: class ModuleInstallerError extends Error {
    constructor(message: string, public readonly status = 503) {
      super(message);
    }
  },
}));

vi.mock('../db/queries/config.js', () => ({
  getConfig: vi.fn(),
}));

const mockListModulesForUi = vi.mocked(modulesService.listModulesForUi);
const mockSyncModuleCatalogFromSherif = vi.mocked(modulesService.syncModuleCatalogFromSherif);
const mockActivateModuleLicense = vi.mocked(modulesService.activateModuleLicense);
const mockGetModuleForUi = vi.mocked(modulesService.getModuleForUi);
const mockGetModuleRegistryCredentials = vi.mocked(modulesService.getModuleRegistryCredentials);
const mockFinalizeModuleInstallerAction = vi.mocked(modulesService.finalizeModuleInstallerAction);
const mockDispatchModuleInstallerAction = vi.mocked(moduleInstallerService.dispatchModuleInstallerAction);
const mockGetModuleInstallerJob = vi.mocked(moduleInstallerService.getModuleInstallerJob);
const mockGetModuleInstallerStatus = vi.mocked(moduleInstallerService.getModuleInstallerStatus);
const mockGetConfig = vi.mocked(getConfig);

function buildModuleView(overrides: Record<string, unknown> = {}) {
  return {
    slug: 'robin-tools',
    displayName: 'Robin Tools',
    description: 'DNS tools',
    vendorName: 'Robin',
    tier: 'free',
    latestVersion: '0.1.0',
    installedVersion: null,
    routeSlug: 'robin-tools',
    remoteScope: 'robinTools',
    exposedModule: './RobinToolsApp',
    remoteEntryPath: '/modules/robin-tools/remoteEntry.js',
    remoteEntryUrl: null,
    probeUrl: null,
    installed: false,
    installerActions: ['install', 'upgrade', 'start', 'stop', 'uninstall'],
    installedSource: null,
    installedNotes: null,
    installedAt: null,
    lastSeenAt: null,
    requiresLicense: false,
    updateAvailable: false,
    active: false,
    activationStatus: 'not-installed',
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
    iconName: null,
    sortOrder: 1,
    metadata: { tags: ['free'] },
    moduleDefinition: null,
    syncedAt: new Date('2026-05-05T00:00:00Z'),
    licenseStatus: 'inactive',
    ...overrides,
  };
}

let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use('/modules', router);
  server = app.listen(0);

  await new Promise<void>((resolve) => {
    server.once('listening', () => resolve());
  });

  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}/modules`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
});

beforeEach(() => {
  mockGetModuleForUi.mockReset();
  mockGetConfig.mockResolvedValue({ modulesEnabled: true } as never);
  vi.clearAllMocks();
});

describe('modules routes', () => {
  it.each([undefined, false, 'true'])('rejects maintenance upgrades without a boolean acknowledgement (%s)', async acknowledged => {
    mockGetModuleForUi.mockResolvedValueOnce(buildModuleView({
      installed: true, installedSource: 'installer', installerUpgradeStrategy: 'maintenance',
    }) as never);
    const response = await fetch(`${baseUrl}/robin-tools/upgrade`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maintenanceAcknowledged: acknowledged }),
    });
    expect(response.status).toBe(400);
    expect(mockDispatchModuleInstallerAction).not.toHaveBeenCalled();
    expect(mockGetModuleRegistryCredentials).not.toHaveBeenCalled();
  });
  it('propagates explicit maintenance acknowledgement without accepting browser policy', async () => {
    mockGetModuleForUi.mockResolvedValueOnce(buildModuleView({
      installed: true, installedSource: 'installer', installerUpgradeStrategy: 'maintenance',
    }) as never);
    mockDispatchModuleInstallerAction.mockResolvedValueOnce({
      jobId: 'maintenance-job', action: 'upgrade', moduleSlug: 'robin-tools', version: '0.1.0', status: 'accepted', message: null,
    });
    const response = await fetch(`${baseUrl}/robin-tools/upgrade`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ maintenanceAcknowledged: true }),
    });
    expect(response.status).toBe(202);
    expect(mockDispatchModuleInstallerAction).toHaveBeenCalledWith('upgrade', 'robin-tools', '0.1.0', [], true);
  });
  it('forces renewal and returns the resulting license state', async () => {
    mockGetModuleForUi.mockResolvedValueOnce(buildModuleView({ slug: 'robin-qa', active: true }) as never);
    const response = await fetch(`${baseUrl}/robin-qa/refresh-license`, { method: 'POST' });
    expect(response.status).toBe(200);
    expect(modulesService.refreshModuleLicenseIfNeeded).toHaveBeenCalledWith('robin-qa', true);
    expect((await response.json()).data.active).toBe(true);
  });

  it('returns not found after renewing an unknown module', async () => {
    mockGetModuleForUi.mockResolvedValueOnce(null);
    const response = await fetch(`${baseUrl}/missing/refresh-license`, { method: 'POST' });
    expect(response.status).toBe(404);
  });

  it('lists merged modules for the UI', async () => {
    mockListModulesForUi.mockResolvedValueOnce([
      {
        slug: 'robin-qa',
        displayName: 'Robin QA',
        description: 'QA placeholder module',
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
        installedAt: new Date('2026-05-05T00:00:00Z'),
        lastSeenAt: new Date('2026-05-05T00:00:00Z'),
        requiresLicense: true,
        updateAvailable: false,
        active: false,
        activationStatus: 'license-required',
        activationMessage: 'A valid license key is required before this module can activate.',
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
        iconName: null,
        sortOrder: 1,
        metadata: { tags: ['qa'] },
        moduleDefinition: null,
        syncedAt: new Date('2026-05-05T00:00:00Z'),
        licenseStatus: 'inactive',
      },
    ] as never);

    const response = await fetch(baseUrl);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data).toHaveLength(1);
    expect(body.data[0]).toMatchObject({
      slug: 'robin-qa',
      activationStatus: 'license-required',
      remoteScope: 'robinQa',
    });
  });

  it('runs a manual Sherif sync', async () => {
    mockSyncModuleCatalogFromSherif.mockResolvedValueOnce({
      syncedAt: '2026-05-05T00:00:00.000Z',
      moduleCount: 1,
      modules: ['robin-qa'],
      source: 'manual',
    });

    const response = await fetch(`${baseUrl}/sync`, { method: 'POST' });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockSyncModuleCatalogFromSherif).toHaveBeenCalledWith('manual');
    expect(body.data).toMatchObject({
      moduleCount: 1,
      modules: ['robin-qa'],
      source: 'manual',
    });
  });

  it('activates a license and returns the updated module view', async () => {
    mockActivateModuleLicense.mockResolvedValueOnce({
      slug: 'robin-qa',
      displayName: 'Robin QA',
      description: 'QA placeholder module',
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
      installedAt: new Date('2026-05-05T00:00:00Z'),
      lastSeenAt: new Date('2026-05-05T00:00:00Z'),
      requiresLicense: true,
      updateAvailable: false,
      active: true,
      activationStatus: 'active',
      activationMessage: 'License active.',
      customerName: 'Acme Corp',
      issuedTo: 'ops@example.com',
      leaseToken: 'lease-token',
      leaseStartedAt: new Date('2026-05-05T00:00:00Z'),
      leaseExpiresAt: new Date('2026-06-05T00:00:00Z'),
      lastValidatedAt: new Date('2026-05-05T00:00:00Z'),
      lastValidationError: null,
      licenseKeyLast4: 'ABCD',
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: 'Module runtime is reachable.',
      iconName: null,
      sortOrder: 1,
      metadata: {},
      moduleDefinition: null,
      syncedAt: new Date('2026-05-05T00:00:00Z'),
      licenseStatus: 'active',
    } as never);

    const response = await fetch(`${baseUrl}/robin-qa/activate`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ licenseKey: 'RBSH-RQ-TEST-KEY' }),
    });
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(mockActivateModuleLicense).toHaveBeenCalledWith('robin-qa', 'RBSH-RQ-TEST-KEY');
    expect(body.data).toMatchObject({
      slug: 'robin-qa',
      activationStatus: 'active',
      active: true,
    });
  });

  it('dispatches module install jobs through the installer service', async () => {
    mockGetModuleForUi.mockResolvedValueOnce(buildModuleView() as never);
    mockDispatchModuleInstallerAction.mockResolvedValueOnce({
      jobId: 'job-1',
      action: 'install',
      moduleSlug: 'robin-tools',
      status: 'accepted',
      message: null,
    });

    const response = await fetch(`${baseUrl}/robin-tools/install`, { method: 'POST' });
    const body = await response.json();

    expect(response.status).toBe(202);
    expect(mockDispatchModuleInstallerAction).toHaveBeenCalledWith(
      'install',
      'robin-tools',
      '0.1.0',
      [],
      false,
    );
    expect(body.data).toMatchObject({
      jobId: 'job-1',
      action: 'install',
      moduleSlug: 'robin-tools',
      status: 'accepted',
    });
  });

  it.each(['upgrade', 'start', 'stop', 'uninstall'])('rejects %s without installer ownership and capability', async (action) => {
    mockGetModuleForUi.mockResolvedValueOnce(buildModuleView({ installed: true, installedSource: 'bootstrap', installerActions: [] }) as never);
    const response = await fetch(`${baseUrl}/robin-tools/${action}`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(response.status).toBe(409);
    expect(mockDispatchModuleInstallerAction).not.toHaveBeenCalled();
  });

  it('rejects catalog install specs and arbitrary installer fields', async () => {
    const response = await fetch(`${baseUrl}/robin-tools/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ installSpec: { image: 'attacker/image:latest' } }),
    });

    expect(response.status).toBe(400);
    expect(mockDispatchModuleInstallerAction).not.toHaveBeenCalled();
  });

  it('rejects registry credentials supplied by the browser', async () => {
    const response = await fetch(`${baseUrl}/robin-tools/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        version: '0.1.0',
        registryCredentials: [{
          repository: 'paid/tools',
          registry: 'sheriff.robinmta.com',
          username: 'attacker',
          password: 'attacker-token',
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        }],
      }),
    });

    expect(response.status).toBe(400);
    expect(mockGetModuleRegistryCredentials).not.toHaveBeenCalled();
    expect(mockDispatchModuleInstallerAction).not.toHaveBeenCalled();
  });

  it('derives and dispatches two scoped paid registry credentials server-side', async () => {
    const paidModule = buildModuleView({
      tier: 'paid',
      latestVersion: '1.2.3',
      leaseToken: 'stored-valid-lease',
      activationId: 'activation-1',
      metadata: {
        delivery: {
          mode: 'sheriff-proxy',
          available: true,
          services: [
            { name: 'frontend', repository: 'paid/tools-frontend', digest: `sha256:${'a'.repeat(64)}`, platforms: ['linux/amd64'] },
            { name: 'backend', repository: 'paid/tools-backend', digest: `sha256:${'b'.repeat(64)}`, platforms: ['linux/amd64'] },
          ],
        },
      },
    });
    const credentials = [
      {
        repository: 'paid/tools-frontend',
        registry: 'sheriff.robinmta.com' as const,
        username: 'activation-1',
        password: 'frontend-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
      {
        repository: 'paid/tools-backend',
        registry: 'sheriff.robinmta.com' as const,
        username: 'activation-1',
        password: 'backend-token',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    mockGetModuleForUi.mockResolvedValueOnce(paidModule as never);
    mockGetModuleRegistryCredentials.mockResolvedValueOnce(credentials);
    mockDispatchModuleInstallerAction.mockResolvedValueOnce({
      jobId: 'paid-job',
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.2.3',
      status: 'accepted',
      message: null,
    });

    const response = await fetch(`${baseUrl}/robin-tools/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ version: '1.2.3' }),
    });

    expect(response.status).toBe(202);
    expect(mockGetModuleRegistryCredentials).toHaveBeenCalledWith(paidModule, '1.2.3');
    expect(mockDispatchModuleInstallerAction).toHaveBeenCalledWith(
      'install',
      'robin-tools',
      '1.2.3',
      credentials,
      false,
    );
  });

  it('polls installer status and jobs with GET requests', async () => {
    mockGetModuleInstallerStatus.mockResolvedValueOnce({ moduleSlug: 'robin-tools' });
    mockGetModuleInstallerJob.mockResolvedValueOnce({
      jobId: 'job-1',
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '0.1.0',
      status: 'running',
      message: null,
    });

    const statusResponse = await fetch(`${baseUrl}/robin-tools/status`);
    const jobResponse = await fetch(`${baseUrl}/robin-tools/jobs/job-1`);

    expect(statusResponse.status).toBe(200);
    expect(jobResponse.status).toBe(200);
    expect(mockGetModuleInstallerStatus).toHaveBeenCalledWith('robin-tools');
    expect(mockGetModuleInstallerJob).toHaveBeenCalledWith('job-1');
    expect(mockFinalizeModuleInstallerAction).not.toHaveBeenCalled();
  });

  it('records a successful install job so the module shows as installed', async () => {
    const jobData = { mode: 'docker', runtime: {
      backendUrl: 'http://module-api:4000', assetBaseUrl: 'http://module-ui', probeUrl: 'http://module-api:4000/ready',
    } };
    mockGetModuleInstallerJob.mockResolvedValueOnce({
      jobId: 'job-2',
      action: 'install',
      moduleSlug: 'robin-tools',
      version: '1.0.0',
      status: 'succeeded',
      message: null,
      data: jobData,
    });

    const jobResponse = await fetch(`${baseUrl}/robin-tools/jobs/job-2`);

    expect(jobResponse.status).toBe(200);
    expect(mockFinalizeModuleInstallerAction).toHaveBeenCalledWith('install', 'robin-tools', '1.0.0', jobData);
  });
});
