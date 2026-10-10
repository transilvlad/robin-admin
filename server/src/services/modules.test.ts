import { generateKeyPairSync, sign } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ModuleSummary } from '../db/queries/modules.js';

vi.mock('../db/queries/modules.js', () => ({
  getModuleSummaryBySlug: vi.fn(),
  recordModuleInstall: vi.fn(),
  removeModuleInstall: vi.fn(),
  replaceBootstrapInstalledModules: vi.fn(),
  upsertModuleCatalogEntries: vi.fn(),
}));

function signLease(payload: Record<string, unknown>, privateKeyPem: string, keyId: string): string {
  const payloadSegment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = sign(null, Buffer.from(payloadSegment, 'utf8'), privateKeyPem).toString('base64url');
  return `rbsh1.${payloadSegment}.${signature}.${Buffer.from(keyId).toString('base64url')}`;
}

function buildSummary(overrides: Partial<ModuleSummary>): ModuleSummary {
  return {
    slug: 'robin-qa',
    displayName: 'Robin QA',
    description: null,
    vendorName: null,
    tier: 'paid',
    latestVersion: null,
    installedVersion: null,
    routeSlug: 'robin-qa',
    remoteScope: 'robinQa',
    exposedModule: './RobinQaApp',
    remoteEntryPath: '/modules/robin-qa/remoteEntry.js',
    remoteEntryUrl: '/modules/robin-qa/remoteEntry.js',
    probeUrl: null,
    backendUrl: null,
    assetBaseUrl: null,
    installed: true,
    installedSource: 'bootstrap',
    installedNotes: null,
    installedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastSeenAt: new Date('2026-01-01T00:00:00.000Z'),
    licenseStatus: 'active',
    licenseAuthorityUrl: 'https://sheriff.robinmta.com',
    customerName: 'Example Customer',
    issuedTo: 'admin@example.test',
    leaseToken: null,
    activationId: 'activation-1',
    instanceId: 'instance-1',
    instanceFingerprint: null,
    instanceKeyThumbprint: null,
    leaseStartedAt: new Date('2026-01-01T00:00:00.000Z'),
    leaseExpiresAt: new Date('2026-01-02T00:00:00.000Z'),
    offlineGraceEndsAt: new Date('2026-01-03T00:00:00.000Z'),
    replacementAllowance: 2,
    replacementsUsed: 0,
    refreshFailureTerminal: false,
    lastValidatedAt: new Date('2026-01-01T00:00:00.000Z'),
    lastValidationError: null,
    licenseKeyLast4: 'ABCD',
    iconName: null,
    sortOrder: 100,
    metadata: {},
    moduleDefinition: null,
    syncedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

describe('module license view model', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T12:00:00Z'));
    vi.resetModules();
    vi.stubEnv('SESSION_SECRET', 'test-session-secret');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('activates paid modules only with a valid signed lease for this instance', async () => {
    const { buildModuleViewModel } = await import('./modules.js');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const instanceFingerprint = 'f'.repeat(64);
    const instanceKeyThumbprint = 'thumbprint-1';
    const leaseToken = signLease({
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      moduleSlug: 'robin-qa',
      instanceFingerprint,
      instanceKeyThumbprint,
    }, privateKey, 'lease-key-1');

    const model = buildModuleViewModel(buildSummary({ leaseToken, instanceFingerprint, instanceKeyThumbprint }), {
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: null,
    }, [{ keyId: 'lease-key-1', alg: 'Ed25519', publicKeyPem: publicKey, status: 'active' }], { instanceFingerprint, instanceKeyThumbprint });

    expect(model.active).toBe(true);
    expect(model.activationStatus).toBe('active');
  }, 15_000);

  it('marks an update available only when latest version is newer than installed version', async () => {
    const { buildModuleViewModel } = await import('./modules.js');

    const model = buildModuleViewModel(buildSummary({
      latestVersion: '0.10.0',
      installedVersion: '0.9.0',
    }), {
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: null,
    });

    expect(model.updateAvailable).toBe(true);
  });

  it('does not mark an update when the installed version already matches latest', async () => {
    const { buildModuleViewModel } = await import('./modules.js');

    const model = buildModuleViewModel(buildSummary({
      latestVersion: '0.1.0',
      installedVersion: '0.1.0',
    }), {
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: null,
    });

    expect(model.updateAvailable).toBe(false);
  });

  it('rejects cached leases with invalid signatures', async () => {
    const { buildModuleViewModel } = await import('./modules.js');
    const instanceFingerprint = 'f'.repeat(64);
    const instanceKeyThumbprint = 'thumbprint-1';
    const leaseToken = `rbsh1.${Buffer.from(JSON.stringify({
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      moduleSlug: 'robin-qa',
      instanceFingerprint,
      instanceKeyThumbprint,
    })).toString('base64url')}.bad`;

    const model = buildModuleViewModel(buildSummary({ leaseToken, instanceFingerprint, instanceKeyThumbprint }), {
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: null,
    });

    expect(model.active).toBe(false);
    expect(model.activationStatus).toBe('invalid');
  });

  it('rejects a signed lease when the local SPKI thumbprint does not match', async () => {
    const { buildModuleViewModel } = await import('./modules.js');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const instanceFingerprint = 'f'.repeat(64);
    const leaseToken = signLease({
      issuedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2026-01-02T00:00:00.000Z',
      moduleSlug: 'robin-qa',
      instanceFingerprint,
      instanceKeyThumbprint: 'thumbprint-from-sheriff',
    }, privateKey, 'lease-key-1');

    const model = buildModuleViewModel(buildSummary({
      leaseToken,
      instanceFingerprint,
      instanceKeyThumbprint: 'thumbprint-from-sheriff',
    }), {
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: null,
    }, [{ keyId: 'lease-key-1', alg: 'Ed25519', publicKeyPem: publicKey, status: 'active' }], { instanceFingerprint, instanceKeyThumbprint: 'local-thumbprint' });

    expect(model.active).toBe(false);
    expect(model.activationStatus).toBe('invalid');
  });

  it('permits an expired lease only through signed offline grace after Sheriff is unreachable', async () => {
    vi.setSystemTime(new Date('2025-01-02T12:00:00Z'));
    const { buildModuleViewModel } = await import('./modules.js');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const instanceFingerprint = 'f'.repeat(64);
    const instanceKeyThumbprint = 'thumbprint-1';
    const leaseToken = signLease({
      issuedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-02T00:00:00.000Z',
      offlineGraceEndsAt: '2025-01-03T00:00:00.000Z',
      moduleSlug: 'robin-qa',
      instanceFingerprint,
      instanceKeyThumbprint,
    }, privateKey, 'lease-key-1');

    const model = buildModuleViewModel(buildSummary({
      leaseToken,
      instanceFingerprint,
      instanceKeyThumbprint,
      leaseExpiresAt: new Date('2025-01-02T00:00:00.000Z'),
      offlineGraceEndsAt: new Date('2025-01-03T00:00:00.000Z'),
      lastValidationError: 'fetch failed',
    }), {
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: null,
    }, [{ keyId: 'lease-key-1', alg: 'Ed25519', publicKeyPem: publicKey, status: 'active' }], { instanceFingerprint, instanceKeyThumbprint });

    expect(model.active).toBe(true);
    expect(model.activationStatus).toBe('grace');
  });

  it('denies access after signed offline grace expires', async () => {
    const { buildModuleViewModel } = await import('./modules.js');
    const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const instanceFingerprint = 'f'.repeat(64);
    const instanceKeyThumbprint = 'thumbprint-1';
    const leaseToken = signLease({
      issuedAt: '2025-01-01T00:00:00.000Z',
      expiresAt: '2025-01-02T00:00:00.000Z',
      offlineGraceEndsAt: '2025-01-03T00:00:00.000Z',
      moduleSlug: 'robin-qa',
      instanceFingerprint,
      instanceKeyThumbprint,
    }, privateKey, 'lease-key-1');

    const model = buildModuleViewModel(buildSummary({
      leaseToken,
      instanceFingerprint,
      instanceKeyThumbprint,
      leaseExpiresAt: new Date('2025-01-02T00:00:00.000Z'),
      offlineGraceEndsAt: new Date('2025-01-03T00:00:00.000Z'),
    }), {
      runtimeAvailable: true,
      runtimeStatus: 'reachable',
      runtimeMessage: null,
    }, [{ keyId: 'lease-key-1', alg: 'Ed25519', publicKeyPem: publicKey, status: 'active' }], { instanceFingerprint, instanceKeyThumbprint });

    expect(model.active).toBe(false);
    expect(model.activationStatus).toBe('expired');
  });

  it.each(['rejected', 'wrong-authority', 'wrong-instance', 'long-lease', 'forged-cache-expiry', 'long-grace'])(
    'denies a %s lease even when cached dates appear usable', async (scenario) => {
      const { buildModuleViewModel } = await import('./modules.js');
      const { publicKey, privateKey } = generateKeyPairSync('ed25519', {
        publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
      });
      const identity = { instanceFingerprint: 'f'.repeat(64), instanceKeyThumbprint: 'instance-key' };
      const leaseToken = signLease({
        ...identity, moduleSlug: 'robin-qa', issuedAt: '2026-01-01T00:00:00Z',
        expiresAt: scenario === 'long-lease' ? '2027-01-01T00:00:00Z'
          : scenario === 'forged-cache-expiry' ? '2026-01-01T01:00:00Z' : '2026-01-02T00:00:00Z',
        offlineGraceEndsAt: scenario === 'long-grace' ? '2027-01-01T00:00:00Z' : undefined,
      }, privateKey, 'lease-key');
      const model = buildModuleViewModel(buildSummary({
        ...identity, leaseToken, refreshFailureTerminal: scenario === 'rejected',
        licenseAuthorityUrl: scenario === 'wrong-authority' ? 'https://another.example.test' : 'https://sheriff.robinmta.com',
      }), { runtimeAvailable: true, runtimeStatus: 'reachable', runtimeMessage: null },
      [{ keyId: 'lease-key', alg: 'Ed25519', publicKeyPem: publicKey, status: 'active' }],
      scenario === 'wrong-instance' ? { ...identity, instanceFingerprint: 'e'.repeat(64) } : identity);
      expect(model.active).toBe(false);
    },
  );
});

describe('bootstrapInstalledModulesFromConfig', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.stubEnv('SESSION_SECRET', 'test-session-secret');
    vi.stubEnv('MODULES_BOOTSTRAP_JSON', JSON.stringify([{
      moduleSlug: 'robin-qa',
      install: false,
      remoteEntryUrl: 'https://admin.example.test/modules/robin-qa/remoteEntry.js',
      remoteScope: 'robinQa',
      exposedModule: './RobinQaApp',
      displayName: 'Robin QA',
      description: 'QA workflows.',
      vendorName: 'Robin',
      tier: 'paid',
      remoteEntryPath: '/modules/robin-qa/remoteEntry.js',
      routeSlug: 'robin-qa',
      iconName: 'search',
      sortOrder: 100,
      metadata: { source: 'local-runtime' },
      moduleDefinition: {
        name: 'robin-qa',
        title: 'Robin QA',
        navigation: [{ label: 'Overview', path: '' }],
      },
    }]));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('does not turn a disabled bootstrap runtime into a catalogue entry', async () => {
    const dbQueries = await import('../db/queries/modules.js');
    const { bootstrapInstalledModulesFromConfig } = await import('./modules.js');

    await bootstrapInstalledModulesFromConfig();

    expect(dbQueries.replaceBootstrapInstalledModules).toHaveBeenCalledWith([]);
    expect(dbQueries.upsertModuleCatalogEntries).not.toHaveBeenCalled();
  });

  it('keeps installed runtime metadata available independently of the catalogue', async () => {
    vi.stubEnv('MODULES_BOOTSTRAP_JSON', JSON.stringify([{
      moduleSlug: 'robin-sheriff',
      displayName: 'Robin Sheriff',
      tier: 'free',
      remoteEntryUrl: '/modules/robin-sheriff/remoteEntry.js',
      remoteScope: 'robinSheriff',
      metadata: { operatorConsole: true },
    }]));
    const dbQueries = await import('../db/queries/modules.js');
    const { bootstrapInstalledModulesFromConfig } = await import('./modules.js');

    await bootstrapInstalledModulesFromConfig();

    expect(dbQueries.replaceBootstrapInstalledModules).toHaveBeenCalledWith([
      expect.objectContaining({ displayName: 'Robin Sheriff', metadata: { operatorConsole: true } }),
    ]);
    expect(dbQueries.upsertModuleCatalogEntries).not.toHaveBeenCalled();
  });
});

describe('finalizeModuleInstallerAction', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv('SESSION_SECRET', 'test-session-secret');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.clearAllMocks();
  });

  it('records the explicit installer runtime, including its independent readiness path', async () => {
    const dbQueries = await import('../db/queries/modules.js');
    const { finalizeModuleInstallerAction } = await import('./modules.js');
    vi.mocked(dbQueries.getModuleSummaryBySlug).mockResolvedValueOnce(
      buildSummary({
        slug: 'robin-tools',
        displayName: 'Robin Tools',
        tier: 'free',
        routeSlug: 'robin-tools',
        remoteScope: 'robinTools',
        exposedModule: './RobinToolsApp',
        remoteEntryPath: '/modules/robin-tools/remoteEntry.js',
      }),
    );

    await finalizeModuleInstallerAction('install', 'robin-tools', '1.2.3', { mode: 'docker', runtime: {
      backendUrl: 'http://module-api:4000/module', assetBaseUrl: 'http://module-ui', probeUrl: 'http://module-api:4000/ready',
    } });

    expect(dbQueries.recordModuleInstall).toHaveBeenCalledWith({
      moduleSlug: 'robin-tools',
      displayName: 'Robin Tools',
      description: null,
      vendorName: null,
      tier: 'free',
      latestVersion: null,
      routeSlug: 'robin-tools',
      remoteScope: 'robinTools',
      exposedModule: './RobinToolsApp',
      remoteEntryPath: '/modules/robin-tools/remoteEntry.js',
      iconName: null,
      sortOrder: 100,
      metadata: {},
      moduleDefinition: null,
      remoteEntryUrl: '/modules/robin-tools/remoteEntry.js',
      installedVersion: '1.2.3',
      backendUrl: 'http://module-api:4000/module',
      assetBaseUrl: 'http://module-ui',
      probeUrl: 'http://module-api:4000/ready',
      installedSource: 'installer',
    });
  });

  it('supports a frontend-only module without guessing a backend from port mappings', async () => {
    const dbQueries = await import('../db/queries/modules.js');
    const { finalizeModuleInstallerAction } = await import('./modules.js');
    vi.mocked(dbQueries.getModuleSummaryBySlug).mockResolvedValueOnce(
      buildSummary({
        slug: 'robin-tools',
        displayName: 'Robin Tools',
        tier: 'free',
        routeSlug: 'robin-tools',
        remoteScope: 'robinTools',
        exposedModule: './RobinToolsApp',
        remoteEntryPath: '/modules/robin-tools/remoteEntry.js',
      }),
    );

    await finalizeModuleInstallerAction('install', 'robin-tools', '1.2.3', {
      mode: 'docker',
      runtime: { backendUrl: null, assetBaseUrl: 'http://host.docker.internal:3080', probeUrl: 'http://host.docker.internal:3080/ready' },
      plan: {
        services: [
          { name: 'frontend', ports: [{ hostIp: '127.0.0.1', hostPort: 3080 }] },
          { name: 'backend', ports: [] },
        ],
      },
    });

    expect(dbQueries.recordModuleInstall).toHaveBeenCalledWith({
      moduleSlug: 'robin-tools',
      displayName: 'Robin Tools',
      description: null,
      vendorName: null,
      tier: 'free',
      latestVersion: null,
      routeSlug: 'robin-tools',
      remoteScope: 'robinTools',
      exposedModule: './RobinToolsApp',
      remoteEntryPath: '/modules/robin-tools/remoteEntry.js',
      iconName: null,
      sortOrder: 100,
      metadata: {},
      moduleDefinition: null,
      remoteEntryUrl: '/modules/robin-tools/remoteEntry.js',
      installedVersion: '1.2.3',
      backendUrl: null,
      assetBaseUrl: 'http://host.docker.internal:3080',
      probeUrl: 'http://host.docker.internal:3080/ready',
      installedSource: 'installer',
    });
  });

  it.each([undefined, { mode: 'dry-run', plan: { services: [] } }, { mode: 'docker', runtime: {} }])('does not record incomplete or simulated installs', async data => {
    const dbQueries = await import('../db/queries/modules.js');
    const { finalizeModuleInstallerAction } = await import('./modules.js');
    vi.mocked(dbQueries.getModuleSummaryBySlug).mockResolvedValueOnce(buildSummary({ tier: 'free' }));
    await expect(finalizeModuleInstallerAction('install', 'robin-qa', '1.2.3', data)).rejects.toThrow(/Installer/);
    expect(dbQueries.recordModuleInstall).not.toHaveBeenCalled();
  });

  it('removes the modules_installed row on a successful uninstall', async () => {
    const dbQueries = await import('../db/queries/modules.js');
    const { finalizeModuleInstallerAction } = await import('./modules.js');

    await finalizeModuleInstallerAction('uninstall', 'robin-tools', '1.2.3');

    expect(dbQueries.removeModuleInstall).toHaveBeenCalledWith('robin-tools');
    expect(dbQueries.recordModuleInstall).not.toHaveBeenCalled();
  });

  it('does nothing for start/stop actions', async () => {
    const dbQueries = await import('../db/queries/modules.js');
    const { finalizeModuleInstallerAction } = await import('./modules.js');

    await finalizeModuleInstallerAction('start', 'robin-tools', '1.2.3');

    expect(dbQueries.recordModuleInstall).not.toHaveBeenCalled();
    expect(dbQueries.removeModuleInstall).not.toHaveBeenCalled();
  });
});
