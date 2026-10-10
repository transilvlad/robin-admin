import type { UpsertModuleCatalogEntryInput } from '../db/queries/modules.js';

export const CATALOG_SCHEMA_VERSION = 'robin-sheriff-catalog/v1';

type PublisherKind = 'first-party' | 'third-party';
type DeliveryMode = 'public-ghcr' | 'sheriff-proxy';

interface CatalogPublisher {
  id: string;
  displayName: string;
  kind: PublisherKind;
  verified: true;
  supportUrl?: string;
  securityContact?: string;
}

interface CatalogService {
  name: 'frontend' | 'backend';
  repository: string;
  digest: string;
  platforms: Array<'linux/amd64' | 'linux/arm64'>;
}

interface CatalogModule {
  slug: string;
  displayName: string;
  description: string;
  tier: 'free' | 'paid';
  version: string;
  minimumRobinAdminVersion: string;
  publisher: CatalogPublisher;
  remoteScope: string;
  exposedModule: string;
  remoteEntryPath: string;
  routeSlug: string;
  iconName?: string;
  imageUrl?: string;
  imageUrls?: string[];
  purchaseUrl?: string;
  sortOrder?: number;
  moduleDefinition?: Record<string, unknown>;
  status: 'published' | 'deprecated' | 'draft';
  tags?: string[];
  permissions: string[];
  delivery: {
    mode: DeliveryMode;
    available: boolean;
    services: CatalogService[];
  };
}

function parseNavigationEntries(value: unknown, label: string): Array<Record<string, unknown>> {
  if (!Array.isArray(value) || value.length > 50) {
    throw new Error(`${label} is invalid`);
  }
  return value.map((item, index) => {
    const input = record(item, `${label}[${index}]`);
    exactKeys(input, ['label', 'path', 'iconName', 'indexLabel', 'children'], `${label}[${index}]`);
    const output: Record<string, unknown> = {
      label: string(input.label, `${label}[${index}].label`),
    };
    if (input.path !== undefined) {
      output.path = modulePath(input.path, `${label}[${index}].path`);
    }
    if (input.iconName !== undefined) {
      output.iconName = string(input.iconName, `${label}[${index}].iconName`, /^[a-z0-9-]{1,50}$/);
    }
    if (input.indexLabel !== undefined) {
      output.indexLabel = string(input.indexLabel, `${label}[${index}].indexLabel`);
    }
    if (input.children !== undefined) {
      output.children = parseNavigationEntries(input.children, `${label}[${index}].children`);
    }
    return output;
  });
}

function parseModuleDefinition(value: unknown, label: string): Record<string, unknown> {
  const input = record(value, label);
  exactKeys(input, ['name', 'title', 'description', 'defaultPath', 'navigation'], label);
  const output: Record<string, unknown> = {};
  if (input.name !== undefined) {
    output.name = string(input.name, `${label}.name`, SLUG);
  }
  if (input.title !== undefined) {
    output.title = string(input.title, `${label}.title`);
  }
  if (input.description !== undefined) {
    output.description = string(input.description, `${label}.description`);
  }
  if (input.defaultPath !== undefined) {
    output.defaultPath = modulePath(input.defaultPath, `${label}.defaultPath`);
  }
  if (input.navigation !== undefined) {
    output.navigation = parseNavigationEntries(input.navigation, `${label}.navigation`);
  }
  return output;
}

export interface CatalogV1 {
  schemaVersion: typeof CATALOG_SCHEMA_VERSION;
  generatedAt: string;
  expiresAt: string;
  modules: CatalogModule[];
}

const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;
const SCOPE = /^[A-Za-z][A-Za-z0-9]{1,63}$/;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/;
const PERMISSION = /^[a-z][a-z0-9-]*(?::[a-z][a-z0-9-]*)+$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REPOSITORY = /^[a-z0-9][a-z0-9._/-]{1,200}$/;

function url(value: unknown, label: string): string {
  const result = string(value, label);
  try {
    // Accepts any scheme (https:, mailto:, etc.) since purchase links
    // may point anywhere, including a mailto: address.
    new URL(result);
  } catch {
    throw new Error(`${label} must be a valid URL`);
  }
  return result;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, label: string, pattern?: RegExp): string {
  if (typeof value !== 'string' || !value.trim() || (pattern && !pattern.test(value))) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function modulePath(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.startsWith('/')) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

function date(value: unknown, label: string): string {
  const result = string(value, label);
  if (Number.isNaN(Date.parse(result))) {
    throw new Error(`${label} must be an ISO date-time`);
  }
  return result;
}

function exactKeys(value: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) {
    throw new Error(`${label} contains unsupported fields: ${unknown.join(', ')}`);
  }
}

function parsePublisher(value: unknown, label: string): CatalogPublisher {
  const input = record(value, label);
  exactKeys(input, ['id', 'displayName', 'kind', 'verified', 'supportUrl', 'securityContact'], label);
  const kind = input.kind;
  if (kind !== 'first-party' && kind !== 'third-party') {
    throw new Error(`${label}.kind is invalid`);
  }
  if (input.verified !== true) {
    throw new Error(`${label}.verified must be true`);
  }
  const supportUrl = input.supportUrl === undefined ? undefined : string(input.supportUrl, `${label}.supportUrl`);
  if (supportUrl && !supportUrl.startsWith('https://')) {
    throw new Error(`${label}.supportUrl must use HTTPS`);
  }
  return {
    id: string(input.id, `${label}.id`, SLUG),
    displayName: string(input.displayName, `${label}.displayName`),
    kind,
    verified: true,
    supportUrl,
    securityContact: input.securityContact === undefined
      ? undefined
      : string(input.securityContact, `${label}.securityContact`),
  };
}

function parseServices(value: unknown, available: boolean, label: string): CatalogService[] {
  if (!Array.isArray(value) || value.length > 2 || (available && value.length === 0)) {
    throw new Error(`${label} is invalid`);
  }

  return value.map((item, index) => {
    const service = record(item, `${label}[${index}]`);
    exactKeys(service, ['name', 'repository', 'digest', 'platforms'], `${label}[${index}]`);
    if (service.name !== 'frontend' && service.name !== 'backend') {
      throw new Error(`${label}[${index}].name is invalid`);
    }
    if (!Array.isArray(service.platforms) || service.platforms.length === 0) {
      throw new Error(`${label}[${index}].platforms is invalid`);
    }
    const platforms = service.platforms.map((platform) => {
      if (platform !== 'linux/amd64' && platform !== 'linux/arm64') {
        throw new Error(`${label}[${index}].platforms contains an unsupported platform`);
      }
      return platform;
    });
    return {
      name: service.name,
      repository: string(service.repository, `${label}[${index}].repository`, REPOSITORY),
      digest: string(service.digest, `${label}[${index}].digest`, DIGEST),
      platforms: [...new Set(platforms)],
    };
  });
}

function parseModule(value: unknown, index: number, includeDraft = false): CatalogModule {
  const label = `catalog.modules[${index}]`;
  const input = record(value, label);
  exactKeys(input, [
    'slug', 'displayName', 'description', 'tier', 'version', 'minimumRobinAdminVersion',
    'publisher', 'remoteScope', 'exposedModule', 'remoteEntryPath', 'routeSlug',
    'iconName', 'imageUrl', 'imageUrls', 'purchaseUrl', 'sortOrder', 'moduleDefinition', 'status', 'tags', 'permissions', 'delivery',
  ], label);
  if (input.tier !== 'free' && input.tier !== 'paid') {
    throw new Error(`${label}.tier is invalid`);
  }
  if (input.status !== 'published' && input.status !== 'deprecated' && !(includeDraft && input.status === 'draft')) {
    throw new Error(`${label}.status is invalid`);
  }
  const permissions = Array.isArray(input.permissions)
    ? input.permissions.map((permission) => string(permission, `${label}.permissions`, PERMISSION))
    : null;
  if (!permissions || new Set(permissions).size !== permissions.length) {
    throw new Error(`${label}.permissions is invalid`);
  }
  const delivery = record(input.delivery, `${label}.delivery`);
  exactKeys(delivery, ['mode', 'available', 'services'], `${label}.delivery`);
  if (delivery.mode !== 'public-ghcr' && delivery.mode !== 'sheriff-proxy') {
    throw new Error(`${label}.delivery.mode is invalid`);
  }
  if (typeof delivery.available !== 'boolean') {
    throw new Error(`${label}.delivery.available is invalid`);
  }
  if ((input.tier === 'free') !== (delivery.mode === 'public-ghcr')) {
    throw new Error(`${label}.tier and delivery.mode are inconsistent`);
  }
  const tags = input.tags === undefined
    ? []
    : Array.isArray(input.tags)
      ? input.tags.map((tag) => string(tag, `${label}.tags`, /^[a-z0-9-]{1,40}$/))
      : null;
  if (!tags) {
    throw new Error(`${label}.tags is invalid`);
  }
  return {
    slug: string(input.slug, `${label}.slug`, SLUG),
    displayName: string(input.displayName, `${label}.displayName`),
    description: string(input.description, `${label}.description`),
    tier: input.tier,
    version: string(input.version, `${label}.version`, VERSION),
    minimumRobinAdminVersion: string(input.minimumRobinAdminVersion, `${label}.minimumRobinAdminVersion`, VERSION),
    publisher: parsePublisher(input.publisher, `${label}.publisher`),
    remoteScope: string(input.remoteScope, `${label}.remoteScope`, SCOPE),
    exposedModule: string(input.exposedModule, `${label}.exposedModule`, /^\.[/][A-Za-z0-9/_-]+$/),
    remoteEntryPath: string(
      input.remoteEntryPath,
      `${label}.remoteEntryPath`,
      /^\/modules\/[a-z0-9-]+\/remoteEntry\.js$/,
    ),
    routeSlug: string(input.routeSlug, `${label}.routeSlug`, SLUG),
    iconName: input.iconName === undefined ? undefined : string(input.iconName, `${label}.iconName`, /^[a-z0-9-]{1,50}$/),
    imageUrl: input.imageUrl === undefined ? undefined : url(input.imageUrl, `${label}.imageUrl`),
    imageUrls: input.imageUrls === undefined
      ? undefined
      : (Array.isArray(input.imageUrls)
        ? input.imageUrls.map((entry, index) => url(entry, `${label}.imageUrls[${index}]`))
        : (() => { throw new Error(`${label}.imageUrls is invalid`); })()),
    purchaseUrl: input.purchaseUrl === undefined ? undefined : url(input.purchaseUrl, `${label}.purchaseUrl`),
    sortOrder: input.sortOrder === undefined ? undefined : Number(input.sortOrder),
    moduleDefinition: input.moduleDefinition === undefined
      ? undefined
      : parseModuleDefinition(input.moduleDefinition, `${label}.moduleDefinition`),
    status: input.status,
    tags,
    permissions,
    delivery: {
      mode: delivery.mode,
      available: delivery.available,
      services: parseServices(delivery.services, delivery.available, `${label}.delivery.services`),
    },
  };
}

export function parseCatalogV1(value: unknown): CatalogV1 {
  const input = record(value, 'catalog');
  exactKeys(input, ['schemaVersion', 'generatedAt', 'expiresAt', 'modules'], 'catalog');
  if (input.schemaVersion !== CATALOG_SCHEMA_VERSION) {
    throw new Error(`Unsupported catalog schema version: ${String(input.schemaVersion)}`);
  }
  const generatedAt = date(input.generatedAt, 'catalog.generatedAt');
  const expiresAt = date(input.expiresAt, 'catalog.expiresAt');
  if (Date.parse(expiresAt) <= Date.now() || Date.parse(expiresAt) <= Date.parse(generatedAt)) {
    throw new Error('Catalog is expired or has an invalid validity window');
  }
  if (!Array.isArray(input.modules) || input.modules.length > 100) {
    throw new Error('catalog.modules is invalid');
  }
  const modules = input.modules.map((module, index) => parseModule(module, index));
  if (new Set(modules.map((moduleEntry) => moduleEntry.slug)).size !== modules.length) {
    throw new Error('Catalog contains duplicate module slugs');
  }
  return {
    schemaVersion: CATALOG_SCHEMA_VERSION,
    generatedAt,
    expiresAt,
    modules,
  };
}

// Only call after verifying the signed renewal envelope and its instance-bound lease.
export function parseEntitledModuleRelease(value: unknown, moduleSlug: string): CatalogModule {
  const release = parseModule(value, 0, true);
  if (release.slug !== moduleSlug || release.tier !== 'paid') {
    throw new Error('Entitled release does not match the licensed module');
  }
  return release;
}

export function catalogModuleToUpsert(moduleEntry: CatalogModule): UpsertModuleCatalogEntryInput {
  return {
    slug: moduleEntry.slug,
    displayName: moduleEntry.displayName,
    description: moduleEntry.description,
    vendorName: moduleEntry.publisher.displayName,
    tier: moduleEntry.tier,
    latestVersion: moduleEntry.version,
    remoteScope: moduleEntry.remoteScope,
    exposedModule: moduleEntry.exposedModule,
    remoteEntryPath: moduleEntry.remoteEntryPath,
    routeSlug: moduleEntry.routeSlug,
    iconName: moduleEntry.iconName ?? null,
    sortOrder: moduleEntry.sortOrder ?? 1000,
    metadata: {
      schemaVersion: CATALOG_SCHEMA_VERSION,
      status: moduleEntry.status,
      tags: moduleEntry.tags ?? [],
      minimumRobinAdminVersion: moduleEntry.minimumRobinAdminVersion,
      publisher: moduleEntry.publisher,
      permissions: moduleEntry.permissions,
      delivery: moduleEntry.delivery,
      imageUrl: moduleEntry.imageUrl ?? null,
      imageUrls: moduleEntry.imageUrls ?? [],
      purchaseUrl: moduleEntry.purchaseUrl ?? null,
    },
    moduleDefinition: moduleEntry.moduleDefinition ?? null,
  };
}
