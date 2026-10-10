import { describe, expect, it } from 'vitest';
import { catalogModuleToUpsert, parseCatalogV1, parseEntitledModuleRelease } from './module-contract.js';

function catalog(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 'robin-sheriff-catalog/v1',
    generatedAt: new Date().toISOString(),
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    modules: [{
      slug: 'robin-tools',
      displayName: 'Robin Tools',
      description: 'Diagnostics',
      tier: 'free',
      version: '1.0.0',
      minimumRobinAdminVersion: '1.0.0',
      publisher: {
        id: 'robin',
        displayName: 'Robin',
        kind: 'first-party',
        verified: true,
      },
      remoteScope: 'robinTools',
      exposedModule: './RobinToolsApp',
      remoteEntryPath: '/modules/robin-tools/remoteEntry.js',
      routeSlug: 'robin-tools',
      status: 'published',
      permissions: ['dns:query'],
      delivery: {
        mode: 'public-ghcr',
        available: true,
        services: [{
          name: 'frontend',
          repository: 'transilvlad/robin-tools',
          digest: `sha256:${'a'.repeat(64)}`,
          platforms: ['linux/amd64', 'linux/arm64'],
        }],
      },
      ...overrides,
    }],
  };
}

describe('module catalog contract', () => {
  it('admits drafts only through an entitled, matching paid release', () => {
    const input = catalog({ tier: 'paid', status: 'draft', delivery: { mode: 'sheriff-proxy', available: false, services: [] } });
    expect(() => parseCatalogV1(input)).toThrow(/status/);
    expect(parseEntitledModuleRelease(input.modules[0], 'robin-tools').status).toBe('draft');
    expect(() => parseEntitledModuleRelease(input.modules[0], 'robin-qa')).toThrow(/licensed module/);
    expect(() => parseEntitledModuleRelease(catalog().modules[0], 'robin-tools')).toThrow(/licensed module/);
  });
  it('accepts and sanitizes a valid catalog', () => {
    const parsed = parseCatalogV1(catalog());
    const entry = catalogModuleToUpsert(parsed.modules[0]);
    expect(entry.slug).toBe('robin-tools');
    expect(entry.metadata).not.toHaveProperty('install');
    expect(entry.metadata).toHaveProperty('publisher.kind', 'first-party');
    expect(entry.metadata).toHaveProperty('imageUrl', null);
    expect(entry.metadata).toHaveProperty('imageUrls', []);
    expect(entry.metadata).toHaveProperty('purchaseUrl', null);
  });

  it('accepts a host module definition for navigation snapshots', () => {
    const parsed = parseCatalogV1(catalog({
      moduleDefinition: {
        name: 'robin-tools',
        title: 'Robin Tools',
        description: 'DNS tools',
        defaultPath: '',
        navigation: [
          { label: 'Overview', path: '', iconName: 'overview' },
          { label: 'History', path: 'history', iconName: 'history' },
        ],
      },
    }));
    const entry = catalogModuleToUpsert(parsed.modules[0]);
    expect(entry.moduleDefinition).toEqual({
      name: 'robin-tools',
      title: 'Robin Tools',
      description: 'DNS tools',
      defaultPath: '',
      navigation: [
        { label: 'Overview', path: '', iconName: 'overview' },
        { label: 'History', path: 'history', iconName: 'history' },
      ],
    });
  });

  it('rejects arbitrary executable metadata', () => {
    expect(() => parseCatalogV1(catalog({
      install: { command: ['sh', '-c', 'id'] },
    }))).toThrow(/unsupported fields/);
  });

  it('rejects arbitrary module definition fields', () => {
    expect(() => parseCatalogV1(catalog({
      moduleDefinition: {
        title: 'Robin Tools',
        loader: 'https://example.test/loader.js',
      },
    }))).toThrow(/unsupported fields/);
  });

  it('rejects mutable or missing image digests when delivery is available', () => {
    expect(() => parseCatalogV1(catalog({
      delivery: {
        mode: 'public-ghcr',
        available: true,
        services: [{
          name: 'frontend',
          repository: 'transilvlad/robin-tools',
          digest: 'latest',
          platforms: ['linux/amd64'],
        }],
      },
    }))).toThrow(/digest is invalid/);
  });

  it('rejects expired catalogs', () => {
    const input = catalog();
    input.expiresAt = new Date(Date.now() - 1_000).toISOString();
    expect(() => parseCatalogV1(input)).toThrow(/expired/);
  });
});
