import { describe, expect, it, beforeEach, vi } from 'vitest';
import type { FleetService } from '../db/queries/fleet-services.js';
import * as fleetServices from '../db/queries/fleet-services.js';
import * as fleetAgentQueries from '../db/queries/fleet-agent-sync.js';
import * as fleetAgentSync from './fleet-agent-sync.js';
import * as rspamdQueries from '../db/queries/rspamd.js';

vi.mock('../db/queries/fleet-services.js', () => ({
  getFleetServiceById: vi.fn(),
  getFleetServiceSoftwareVersion: vi.fn(),
}));

vi.mock('../db/queries/rspamd.js', () => ({
  listActiveDkimSigningKeys: vi.fn(),
}));

vi.mock('../db/queries/secret-crypto.js', () => ({
  decryptStoredSecret: vi.fn((sealed: string) => {
    if (!sealed.startsWith('sealed:')) throw new Error('bad key');
    return sealed.slice('sealed:'.length);
  }),
}));

vi.mock('../db/queries/fleet-agent-sync.js', () => ({
  getFleetServiceSyncStatus: vi.fn(),
  listRobinConfigStoreEntriesForService: vi.fn(),
  listRspamdConfigStoreEntriesForService: vi.fn(),
  listDovecotConfigStoreEntriesForService: vi.fn(),
}));

const mockGetFleetServiceById = vi.mocked(fleetServices.getFleetServiceById);
const mockGetFleetServiceSyncStatus = vi.mocked(fleetAgentQueries.getFleetServiceSyncStatus);
const mockListRobinConfigStoreEntriesForService = vi.mocked(fleetAgentQueries.listRobinConfigStoreEntriesForService);
const mockListRspamdConfigStoreEntriesForService = vi.mocked(fleetAgentQueries.listRspamdConfigStoreEntriesForService);
const mockListDovecotConfigStoreEntriesForService = vi.mocked(fleetAgentQueries.listDovecotConfigStoreEntriesForService);
const mockGetFleetServiceSoftwareVersion = vi.mocked(fleetServices.getFleetServiceSoftwareVersion);
const mockListActiveDkimSigningKeys = vi.mocked(rspamdQueries.listActiveDkimSigningKeys);

function buildService(overrides: Partial<FleetService> = {}): FleetService {
  return {
    id: 1,
    serviceId: 'service-1',
    serviceType: 'robin',
    name: 'Service 1',
    description: null,
    apiUrl: 'https://service.test',
    healthUrl: null,
    metricsUrl: null,
    controllerUrl: null,
    normalUrl: null,
    enabled: true,
    createdAt: new Date('2024-01-01T00:00:00Z'),
    updatedAt: new Date('2024-01-01T00:00:00Z'),
    ...overrides,
  };
}

beforeEach(() => {
  mockGetFleetServiceById.mockReset();
  mockGetFleetServiceSyncStatus.mockReset();
  mockListRobinConfigStoreEntriesForService.mockReset();
  mockListRspamdConfigStoreEntriesForService.mockReset();
  mockGetFleetServiceSyncStatus.mockResolvedValue(null);
  mockGetFleetServiceSoftwareVersion.mockReset();
  mockListActiveDkimSigningKeys.mockReset();
  mockListActiveDkimSigningKeys.mockResolvedValue([]);
});

describe('fleet agent sync service', () => {
  it('builds merged robin manifests from default plus override rows', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({
      serviceId: 'robin-east',
      serviceType: 'robin',
    }));
    mockListRobinConfigStoreEntriesForService.mockResolvedValue([
      {
        ownerId: 'default',
        fileName: 'config.json5',
        payloadJson: {
          host: '0.0.0.0',
          nested: { enabled: true, port: 25 },
        },
        updatedEpoch: 100,
        sha256: 'a'.repeat(64),
      },
      {
        ownerId: 'robin-east',
        fileName: 'config.json5',
        payloadJson: {
          nested: { port: 2525 },
          tls: true,
        },
        updatedEpoch: 150,
        sha256: 'b'.repeat(64),
      },
    ]);

    const manifest = await fleetAgentSync.buildManagedServiceManifest('robin-east');
    const file = await fleetAgentSync.getManagedServiceConfigFile('robin-east', 'config.json5');

    expect(manifest?.files).toEqual([
      expect.objectContaining({
        fileName: 'config.json5',
        payloadKind: 'json',
        source: 'merged',
      }),
    ]);
    expect(file).toEqual(expect.objectContaining({
      serviceId: 'robin-east',
      serviceType: 'robin',
      source: 'merged',
      payload: {
        host: '0.0.0.0',
        nested: { enabled: true, port: 2525 },
        tls: true,
      },
    }));
  });

  it('exposes rspamd managed text files with content hashes', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({
      serviceId: 'rspamd-core',
      serviceType: 'rspamd',
    }));
    mockListRspamdConfigStoreEntriesForService.mockResolvedValue([
      {
        ownerId: 'rspamd-core',
        fileName: 'dkim_signing.conf',
        payloadJson: {
          content: '# Managed by Robin Admin\nenabled = true;\n',
          managedBy: 'Robin Admin',
        },
        updatedEpoch: 200,
        sha256: 'c'.repeat(64),
      },
    ]);

    const manifest = await fleetAgentSync.buildManagedServiceManifest('rspamd-core');
    const file = await fleetAgentSync.getManagedServiceConfigFile('rspamd-core', 'dkim_signing.conf');

    expect(manifest?.files).toEqual([
      expect.objectContaining({
        fileName: 'dkim_signing.conf',
        payloadKind: 'text',
        source: 'override',
      }),
    ]);
    expect(file).toEqual(expect.objectContaining({
      payloadKind: 'text',
      payload: '# Managed by Robin Admin\nenabled = true;\n',
    }));
    expect(file?.etag).toBe(`"${file?.sha256}"`);
  });

  it('delivers active DKIM keys with the selector map in dkim_signing.conf', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({ serviceId: 'rspamd-core', serviceType: 'rspamd' }));
    mockListRspamdConfigStoreEntriesForService.mockResolvedValue([{
      ownerId: 'default',
      fileName: 'dkim_signing.conf',
      payloadJson: { content: '# Managed by Robin Admin\nenabled = true;\n' },
      updatedEpoch: 200,
      sha256: 'c'.repeat(64),
    }]);
    mockListActiveDkimSigningKeys.mockResolvedValue([
      { domain: 'example.test', selector: 's2', privateKeyEnc: 'sealed:PEM-EXAMPLE' },
      { domain: 'broken.test', selector: 's1', privateKeyEnc: 'unreadable' },
    ]);

    const manifest = await fleetAgentSync.buildManagedServiceManifest('rspamd-core');
    const conf = await fleetAgentSync.getManagedServiceConfigFile('rspamd-core', 'dkim_signing.conf');
    const key = await fleetAgentSync.getManagedServiceConfigFile('rspamd-core', 'dkim/example.test.s2.key');

    // A key that can't be decrypted is left out rather than failing the manifest.
    expect(manifest?.files.map((file) => file.fileName)).toEqual(['dkim_signing.conf', 'dkim/example.test.s2.key']);
    expect(conf?.payload).toContain('  "example.test" {\n    path = "$LOCAL_CONFDIR/local.d/dkim/example.test.s2.key";\n    selector = "s2";');
    expect(conf?.payload).not.toContain('broken.test');
    expect(key?.payload).toBe('PEM-EXAMPLE');
  });

  it('matches weak and strong etags', () => {
    expect(fleetAgentSync.etagMatches('W/"abc", "def"', '"def"')).toBe(true);
    expect(fleetAgentSync.etagMatches('"abc"', '"def"')).toBe(false);
  });

  it('serves the Dovecot include rendered for the version the agent reported', async () => {
    mockGetFleetServiceById.mockResolvedValue(buildService({ serviceId: 'mail', serviceType: 'dovecot' }));
    mockListDovecotConfigStoreEntriesForService.mockResolvedValue([
      {
        ownerId: 'mail',
        fileName: 'managed.json',
        payloadJson: { dovecotVersion: '2.3', disablePlaintextAuth: true },
        updatedEpoch: 300,
        sha256: 'd'.repeat(64),
      },
      {
        ownerId: 'mail',
        fileName: '50-robin-managed.conf',
        payloadJson: { content: '# Managed by Robin Admin\ndisable_plaintext_auth = yes\n', managedBy: 'robin-admin' },
        updatedEpoch: 300,
        sha256: 'e'.repeat(64),
      },
    ]);

    mockGetFleetServiceSoftwareVersion.mockResolvedValue(null);
    const unknown = await fleetAgentSync.getManagedServiceConfigFile('mail', '50-robin-managed.conf');
    expect(unknown?.payload).toContain('disable_plaintext_auth = yes');

    mockGetFleetServiceSoftwareVersion.mockResolvedValue('2.4.2');
    const file = await fleetAgentSync.getManagedServiceConfigFile('mail', '50-robin-managed.conf');
    expect(file?.payload).toContain('auth_allow_cleartext = no');
    expect(file?.payload).not.toContain('disable_plaintext_auth');
    expect(file?.sha256).not.toBe(unknown?.sha256);
    expect(file?.etag).toBe(`"${file?.sha256}"`);
  });
});
