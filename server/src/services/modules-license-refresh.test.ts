import { createHash, createPublicKey, generateKeyPairSync, sign, verify } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getModuleLicense: vi.fn(),
  upsertModuleLicense: vi.fn(),
  recordModuleLicenseRefreshError: vi.fn(),
  getConfigValue: vi.fn(),
  setConfigValue: vi.fn(),
  getModuleSummaryBySlug: vi.fn(),
  refreshInstalledModuleRelease: vi.fn(),
}));

vi.mock('../config.js', () => ({
  config: {
    nodeEnv: 'development',
    publicBaseUrl: 'https://admin.example.test',
    sheriff: {
      baseUrl: 'https://sheriff.example.test',
      rootPublicKeyPem: '',
    },
    modulesBootstrap: [],
  },
}));

vi.mock('../db/queries/config.js', () => ({
  getConfigValue: mocks.getConfigValue,
  setConfigValue: mocks.setConfigValue,
}));

vi.mock('../db/queries/modules.js', () => ({
  getModuleLicense: mocks.getModuleLicense,
  upsertModuleLicense: mocks.upsertModuleLicense,
  recordModuleLicenseRefreshError: mocks.recordModuleLicenseRefreshError,
  getModuleSummaryBySlug: mocks.getModuleSummaryBySlug,
  refreshInstalledModuleRelease: mocks.refreshInstalledModuleRelease,
  listModuleSummaries: vi.fn(),
  removeModuleCatalogEntriesNotIn: vi.fn(),
  replaceBootstrapInstalledModules: vi.fn(),
  upsertModuleCatalogEntries: vi.fn(),
}));

vi.mock('../logger.js', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}));

function signedEnvelope(payload: unknown, privateKey: string, keyId: string) {
  const signedPayload = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return {
    signedPayload,
    signature: sign(null, Buffer.from(signedPayload), privateKey).toString('base64url'),
    keyId,
    alg: 'Ed25519',
  };
}

function signedLease(payload: unknown, privateKey: string, keyId: string): string {
  const segment = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `rbsh1.${segment}.${sign(null, Buffer.from(segment), privateKey).toString('base64url')}.${Buffer.from(keyId).toString('base64url')}`;
}

describe('module license refresh', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => vi.unstubAllGlobals());

  it('never probes or switches to another authority', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { getSheriffBaseUrl } = await import('./modules.js');
    expect(await getSheriffBaseUrl()).toBe('https://sheriff.example.test');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('blocks renewal at a different authority without sending the refresh credential', async () => {
    mocks.getModuleLicense.mockResolvedValue({
      status: 'active', refreshCredential: 'refresh-private', authorityUrl: 'https://other.example.test',
      leaseStartedAt: null, leaseExpiresAt: null,
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { refreshModuleLicenseIfNeeded } = await import('./modules.js');
    await refreshModuleLicenseIfNeeded('robin-qa', true);
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.recordModuleLicenseRefreshError).toHaveBeenCalledWith('robin-qa', expect.stringContaining('authority'), true);
  });

  it('does not renew a short lease on every request', async () => {
    mocks.getModuleLicense.mockResolvedValue({
      status: 'active', refreshCredential: 'refresh-private', authorityUrl: 'https://sheriff.example.test',
      leaseStartedAt: new Date(Date.now() - 60_000), leaseExpiresAt: new Date(Date.now() + 9 * 60_000),
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { refreshModuleLicenseIfNeeded } = await import('./modules.js');
    await refreshModuleLicenseIfNeeded('robin-qa');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('backs off transient failures while keeping manual validation available', async () => {
    mocks.getModuleLicense.mockResolvedValue({
      status: 'active', refreshCredential: 'refresh-private', authorityUrl: 'https://sheriff.example.test',
      leaseStartedAt: null, leaseExpiresAt: null, lastValidationError: 'temporary outage', updatedAt: new Date(),
    });
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    const { refreshModuleLicenseIfNeeded } = await import('./modules.js');
    await refreshModuleLicenseIfNeeded('robin-qa');
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([[403, true], [503, false], [429, false]])('records HTTP %s as terminal=%s', async (status, terminal) => {
    const instanceKeys = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' }, privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    mocks.getConfigValue.mockImplementation(async (key: string) => ({
      moduleInstanceId: 'instance-1', moduleInstancePublicKeyPem: instanceKeys.publicKey,
      moduleInstancePrivateKeyPem: instanceKeys.privateKey,
    })[key] ?? null);
    mocks.getModuleLicense.mockResolvedValue({
      status: 'active', refreshCredential: 'refresh-private', authorityUrl: 'https://sheriff.example.test',
      leaseStartedAt: null, leaseExpiresAt: null,
    });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ data: { publicKeys: [] } }), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: 'Rejected refresh-private' }), { status })));
    const { refreshModuleLicenseIfNeeded } = await import('./modules.js');
    await refreshModuleLicenseIfNeeded('robin-qa', true);
    expect(mocks.recordModuleLicenseRefreshError).toHaveBeenCalledWith('robin-qa', 'Rejected [redacted]', terminal);
    expect(mocks.upsertModuleLicense).not.toHaveBeenCalled();
  });

  it.each(['valid', 'missing', 'wrong-slug', 'bad-digest', 'bad-signature'])('verifies instance-bound renewal and safely handles %s release data', async (variant) => {
    const instanceKeys = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const sheriffKeys = generateKeyPairSync('ed25519', {
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    const instanceId = 'instance-1';
    const instanceFingerprint = createHash('sha256').update(`robin-admin:${instanceId}`).digest('hex');
    const instanceKeyThumbprint = createHash('sha256')
      .update(createPublicKey(instanceKeys.publicKey).export({ type: 'spki', format: 'der' }))
      .digest('base64url');
    // Dates are relative to the current clock so the lease never expires against
    // real wall-clock time (verifySheriffLeaseToken enforces requireUnexpired).
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();
    const issuedAt = new Date(now).toISOString();
    const expiresAt = new Date(now + DAY_MS).toISOString();
    const offlineGraceEndsAt = new Date(now + 4 * DAY_MS).toISOString();
    const leasePayload = {
      activationId: 'activation-1',
      issuedAt,
      expiresAt,
      offlineGraceEndsAt,
      moduleSlug: 'robin-qa',
      instanceId,
      instanceFingerprint,
      instanceKeyThumbprint,
      replacementAllowance: 2,
      replacementsUsed: 1,
    };
    const leaseToken = signedLease(leasePayload, sheriffKeys.privateKey, 'lease-key-1');

    mocks.getConfigValue.mockImplementation(async (key: string) => ({
      moduleInstanceId: instanceId,
      moduleInstancePublicKeyPem: instanceKeys.publicKey,
      moduleInstancePrivateKeyPem: instanceKeys.privateKey,
    })[key] ?? null);
    mocks.getModuleLicense.mockResolvedValue({
      moduleSlug: 'robin-qa',
      authorityUrl: 'https://sheriff.example.test',
      licenseKey: 'KEY-LAST',
      status: 'active',
      customerName: 'Acme',
      issuedTo: 'ops@example.test',
      leaseToken: 'old-token',
      activationId: 'activation-1',
      refreshCredential: 'refresh-old',
      instanceId,
      instanceFingerprint,
      instanceKeyThumbprint,
      leaseStartedAt: new Date(now - 7 * DAY_MS),
      leaseExpiresAt: new Date(now - 1 * DAY_MS),
      offlineGraceEndsAt: new Date(now + 1 * DAY_MS),
      replacementAllowance: 2,
      replacementsUsed: 0,
      refreshFailureTerminal: false,
      lastValidatedAt: new Date(now - 7 * DAY_MS),
      lastValidationError: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });

    let refreshBody: Record<string, string> | null = null;
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        success: true,
        data: {
          publicKeys: [{
            keyId: 'lease-key-1',
            alg: 'Ed25519',
            publicKeyPem: sheriffKeys.publicKey,
            status: 'active',
          }],
        },
      }), { status: 200 }))
      .mockImplementationOnce(async (_url: string, init: RequestInit) => {
        refreshBody = JSON.parse(String(init.body)) as Record<string, string>;
        const envelope = signedEnvelope({
          success: true,
          data: {
            release: variant === 'missing' ? null : {
              slug: variant === 'wrong-slug' ? 'other-module' : 'robin-qa', displayName: 'Robin QA', description: 'QA', tier: 'paid',
              version: '0.1.6', minimumRobinAdminVersion: '1.0.0', status: 'draft',
              publisher: { id: 'robin', displayName: 'Robin', kind: 'first-party', verified: true },
              remoteScope: 'robinQa', exposedModule: './RobinQaApp',
              remoteEntryPath: '/modules/robin-qa/remoteEntry.js', routeSlug: 'robin-qa', permissions: [],
              delivery: { mode: 'sheriff-proxy', available: true, services: [
                { name: 'frontend', repository: 'transilvlad/robin-qa', digest: variant === 'bad-digest' ? 'latest' : `sha256:${'a'.repeat(64)}`, platforms: ['linux/amd64'] },
              ] },
            },
            lease: {
              ...leasePayload,
              leaseToken,
              refreshCredential: 'refresh-new',
            },
          },
        }, sheriffKeys.privateKey, 'lease-key-1');
        if (variant === 'bad-signature') envelope.signature = Buffer.alloc(64).toString('base64url');
        return new Response(JSON.stringify(envelope), { status: 200 });
      }));

    const { refreshModuleLicenseIfNeeded } = await import('./modules.js');
    await refreshModuleLicenseIfNeeded('robin-qa');

    expect(refreshBody).toMatchObject({
      refreshCredential: 'refresh-old',
      instanceId,
      instancePublicKey: instanceKeys.publicKey,
      hostName: 'admin.example.test',
    });
    expect(verify(
      null,
      Buffer.from(`refresh:refresh-old:${instanceId}`),
      instanceKeys.publicKey,
      Buffer.from(refreshBody!.refreshSignature, 'base64url'),
    )).toBe(true);
    if (variant === 'bad-signature') {
      expect(mocks.upsertModuleLicense).not.toHaveBeenCalled();
      expect(mocks.refreshInstalledModuleRelease).not.toHaveBeenCalled();
      return;
    }
    expect(mocks.upsertModuleLicense).toHaveBeenCalledWith(expect.objectContaining({
      refreshCredential: 'refresh-new',
      leaseToken,
      replacementsUsed: 1,
    }));
    expect(mocks.recordModuleLicenseRefreshError).not.toHaveBeenCalled();
    if (variant !== 'valid') {
      expect(mocks.refreshInstalledModuleRelease).not.toHaveBeenCalled();
      return;
    }
    expect(mocks.refreshInstalledModuleRelease).toHaveBeenCalledWith(expect.objectContaining({
      slug: 'robin-qa', latestVersion: '0.1.6', displayName: 'Robin QA',
      metadata: expect.objectContaining({ status: 'draft' }),
    }));
  });
});
