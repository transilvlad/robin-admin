import { query } from '../connection.js';

export type ModuleTier = 'free' | 'paid';
export type ModuleLicenseStatus = 'inactive' | 'active' | 'expired' | 'invalid';

export interface ModuleCatalogEntry {
  slug: string;
  displayName: string;
  description: string | null;
  vendorName: string | null;
  tier: ModuleTier;
  latestVersion: string | null;
  remoteScope: string;
  exposedModule: string;
  remoteEntryPath: string | null;
  routeSlug: string;
  iconName: string | null;
  sortOrder: number;
  metadata: Record<string, unknown>;
  moduleDefinition: Record<string, unknown> | null;
  syncedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface ModuleInstallRecord {
  id: number;
  moduleSlug: string;
  displayName: string | null;
  description: string | null;
  vendorName: string | null;
  tier: ModuleTier | null;
  latestVersion: string | null;
  routeSlug: string | null;
  remoteScope: string | null;
  exposedModule: string | null;
  remoteEntryPath: string | null;
  iconName: string | null;
  sortOrder: number | null;
  metadata: Record<string, unknown>;
  moduleDefinition: Record<string, unknown> | null;
  remoteEntryUrl: string;
  installedVersion: string | null;
  probeUrl: string | null;
  backendUrl: string | null;
  assetBaseUrl: string | null;
  installedSource: string;
  notes: string | null;
  createdAt: Date;
  updatedAt: Date;
  lastSeenAt: Date;
}

export interface ModuleLicenseRecord {
  moduleSlug: string;
  authorityUrl: string | null;
  licenseKey: string;
  status: ModuleLicenseStatus;
  customerName: string | null;
  issuedTo: string | null;
  leaseToken: string | null;
  activationId: string | null;
  refreshCredential: string | null;
  instanceId: string | null;
  instanceFingerprint: string | null;
  instanceKeyThumbprint: string | null;
  leaseStartedAt: Date | null;
  leaseExpiresAt: Date | null;
  offlineGraceEndsAt: Date | null;
  replacementAllowance: number | null;
  replacementsUsed: number | null;
  refreshFailureTerminal: boolean;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertModuleCatalogEntryInput {
  slug: string;
  displayName: string;
  description?: string | null;
  vendorName?: string | null;
  tier: ModuleTier;
  latestVersion?: string | null;
  remoteScope: string;
  exposedModule?: string;
  remoteEntryPath?: string | null;
  routeSlug?: string;
  iconName?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
  moduleDefinition?: Record<string, unknown> | null;
}

export interface BootstrapInstalledModuleInput {
  moduleSlug: string;
  remoteEntryUrl: string;
  install?: boolean;
  installedVersion?: string | null;
  probeUrl?: string;
  backendUrl?: string;
  assetBaseUrl?: string;
  remoteScope?: string;
  exposedModule?: string;
  installedSource?: string;
  notes?: string;
  displayName?: string;
  description?: string | null;
  vendorName?: string | null;
  tier?: ModuleTier;
  latestVersion?: string | null;
  remoteEntryPath?: string | null;
  routeSlug?: string;
  iconName?: string | null;
  sortOrder?: number;
  metadata?: Record<string, unknown>;
  moduleDefinition?: Record<string, unknown>;
}

export interface UpsertModuleLicenseInput {
  moduleSlug: string;
  authorityUrl: string;
  licenseKey: string;
  status: ModuleLicenseStatus;
  customerName?: string | null;
  issuedTo?: string | null;
  leaseToken?: string | null;
  activationId?: string | null;
  refreshCredential?: string | null;
  instanceId?: string | null;
  instanceFingerprint?: string | null;
  instanceKeyThumbprint?: string | null;
  leaseStartedAt?: Date | null;
  leaseExpiresAt?: Date | null;
  offlineGraceEndsAt?: Date | null;
  replacementAllowance?: number | null;
  replacementsUsed?: number | null;
  refreshFailureTerminal?: boolean;
  lastValidatedAt?: Date | null;
  lastValidationError?: string | null;
}

export interface ModuleSummary {
  slug: string;
  displayName: string;
  description: string | null;
  vendorName: string | null;
  tier: ModuleTier;
  latestVersion: string | null;
  installedVersion: string | null;
  routeSlug: string;
  remoteScope: string | null;
  exposedModule: string | null;
  remoteEntryPath: string | null;
  remoteEntryUrl: string | null;
  probeUrl: string | null;
  backendUrl: string | null;
  assetBaseUrl: string | null;
  installed: boolean;
  installedSource: string | null;
  installedNotes: string | null;
  installedAt: Date | null;
  lastSeenAt: Date | null;
  licenseStatus: ModuleLicenseStatus;
  licenseAuthorityUrl: string | null;
  customerName: string | null;
  issuedTo: string | null;
  leaseToken: string | null;
  activationId: string | null;
  instanceId: string | null;
  instanceFingerprint: string | null;
  instanceKeyThumbprint: string | null;
  leaseStartedAt: Date | null;
  leaseExpiresAt: Date | null;
  offlineGraceEndsAt: Date | null;
  replacementAllowance: number | null;
  replacementsUsed: number | null;
  refreshFailureTerminal: boolean;
  lastValidatedAt: Date | null;
  lastValidationError: string | null;
  licenseKeyLast4: string | null;
  iconName: string | null;
  sortOrder: number;
  metadata: Record<string, unknown>;
  moduleDefinition: Record<string, unknown> | null;
  syncedAt: Date | null;
}

interface DbModuleCatalogEntry {
  slug: string;
  display_name: string;
  description: string | null;
  vendor_name: string | null;
  tier: ModuleTier;
  latest_version: string | null;
  remote_scope: string;
  exposed_module: string;
  remote_entry_path: string | null;
  route_slug: string;
  icon_name: string | null;
  sort_order: number;
  metadata_json: Record<string, unknown> | null;
  module_definition_json: Record<string, unknown> | null;
  synced_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface DbModuleInstallRecord {
  id: number;
  module_slug: string;
  display_name: string | null;
  description: string | null;
  vendor_name: string | null;
  tier: ModuleTier | null;
  latest_version: string | null;
  route_slug: string | null;
  remote_scope: string | null;
  exposed_module: string | null;
  remote_entry_path: string | null;
  icon_name: string | null;
  sort_order: number | null;
  metadata_json: Record<string, unknown> | null;
  module_definition_json: Record<string, unknown> | null;
  remote_entry_url: string;
  installed_version: string | null;
  probe_url: string | null;
  backend_url: string | null;
  asset_base_url: string | null;
  remote_scope_override: string | null;
  exposed_module_override: string | null;
  installed_source: string;
  notes: string | null;
  created_at: Date;
  updated_at: Date;
  last_seen_at: Date;
}

interface DbModuleLicenseRecord {
  module_slug: string;
  authority_url: string | null;
  license_key: string;
  status: ModuleLicenseStatus;
  customer_name: string | null;
  issued_to: string | null;
  lease_token: string | null;
  activation_id: string | null;
  refresh_credential: string | null;
  instance_id: string | null;
  instance_fingerprint: string | null;
  instance_key_thumbprint: string | null;
  lease_started_at: Date | null;
  lease_expires_at: Date | null;
  offline_grace_ends_at: Date | null;
  replacement_allowance: number | null;
  replacements_used: number | null;
  refresh_failure_terminal: boolean;
  last_validated_at: Date | null;
  last_validation_error: string | null;
  created_at: Date;
  updated_at: Date;
}

interface DbModuleSummary {
  slug: string;
  display_name: string | null;
  description: string | null;
  vendor_name: string | null;
  tier: ModuleTier | null;
  latest_version: string | null;
  installed_version: string | null;
  route_slug: string | null;
  remote_scope: string | null;
  exposed_module: string | null;
  remote_entry_path: string | null;
  remote_entry_url: string | null;
  probe_url: string | null;
  backend_url: string | null;
  asset_base_url: string | null;
  installed_source: string | null;
  notes: string | null;
  install_created_at: Date | null;
  last_seen_at: Date | null;
  license_status: ModuleLicenseStatus | null;
  authority_url: string | null;
  customer_name: string | null;
  issued_to: string | null;
  lease_token: string | null;
  activation_id: string | null;
  instance_id: string | null;
  instance_fingerprint: string | null;
  instance_key_thumbprint: string | null;
  lease_started_at: Date | null;
  lease_expires_at: Date | null;
  offline_grace_ends_at: Date | null;
  replacement_allowance: number | null;
  replacements_used: number | null;
  refresh_failure_terminal: boolean | null;
  last_validated_at: Date | null;
  last_validation_error: string | null;
  license_key_last4: string | null;
  icon_name: string | null;
  sort_order: number | null;
  metadata_json: Record<string, unknown> | null;
  module_definition_json: Record<string, unknown> | null;
  synced_at: Date | null;
}

function mapCatalogEntry(row: DbModuleCatalogEntry): ModuleCatalogEntry {
  return {
    slug: row.slug,
    displayName: row.display_name,
    description: row.description,
    vendorName: row.vendor_name,
    tier: row.tier,
    latestVersion: row.latest_version,
    remoteScope: row.remote_scope,
    exposedModule: row.exposed_module,
    remoteEntryPath: row.remote_entry_path,
    routeSlug: row.route_slug,
    iconName: row.icon_name,
    sortOrder: row.sort_order,
    metadata: row.metadata_json ?? {},
    moduleDefinition: row.module_definition_json,
    syncedAt: row.synced_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapInstallRecord(row: DbModuleInstallRecord): ModuleInstallRecord {
  return {
    id: row.id,
    moduleSlug: row.module_slug,
    displayName: row.display_name,
    description: row.description,
    vendorName: row.vendor_name,
    tier: row.tier,
    latestVersion: row.latest_version,
    routeSlug: row.route_slug,
    remoteScope: row.remote_scope ?? row.remote_scope_override,
    exposedModule: row.exposed_module ?? row.exposed_module_override,
    remoteEntryPath: row.remote_entry_path,
    iconName: row.icon_name,
    sortOrder: row.sort_order,
    metadata: row.metadata_json ?? {},
    moduleDefinition: row.module_definition_json,
    remoteEntryUrl: row.remote_entry_url,
    installedVersion: row.installed_version,
    probeUrl: row.probe_url,
    backendUrl: row.backend_url,
    assetBaseUrl: row.asset_base_url,
    installedSource: row.installed_source,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}

function mapLicenseRecord(row: DbModuleLicenseRecord): ModuleLicenseRecord {
  return {
    moduleSlug: row.module_slug,
    authorityUrl: row.authority_url,
    licenseKey: row.license_key,
    status: row.status,
    customerName: row.customer_name,
    issuedTo: row.issued_to,
    leaseToken: row.lease_token,
    activationId: row.activation_id,
    refreshCredential: row.refresh_credential,
    instanceId: row.instance_id,
    instanceFingerprint: row.instance_fingerprint,
    instanceKeyThumbprint: row.instance_key_thumbprint,
    leaseStartedAt: row.lease_started_at,
    leaseExpiresAt: row.lease_expires_at,
    offlineGraceEndsAt: row.offline_grace_ends_at,
    replacementAllowance: row.replacement_allowance,
    replacementsUsed: row.replacements_used,
    refreshFailureTerminal: row.refresh_failure_terminal,
    lastValidatedAt: row.last_validated_at,
    lastValidationError: row.last_validation_error,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapModuleSummary(row: DbModuleSummary): ModuleSummary {
  return {
    slug: row.slug,
    displayName: row.display_name ?? row.slug,
    description: row.description,
    vendorName: row.vendor_name,
    tier: row.tier ?? 'free',
    latestVersion: row.latest_version,
    installedVersion: row.installed_version,
    routeSlug: row.route_slug ?? row.slug,
    remoteScope: row.remote_scope,
    exposedModule: row.exposed_module,
    remoteEntryPath: row.remote_entry_path,
    remoteEntryUrl: row.remote_entry_url,
    probeUrl: row.probe_url,
    backendUrl: row.backend_url,
    assetBaseUrl: row.asset_base_url,
    installed: Boolean(row.remote_entry_url),
    installedSource: row.installed_source,
    installedNotes: row.notes,
    installedAt: row.install_created_at,
    lastSeenAt: row.last_seen_at,
    licenseStatus: row.license_status ?? 'inactive',
    licenseAuthorityUrl: row.authority_url,
    customerName: row.customer_name,
    issuedTo: row.issued_to,
    leaseToken: row.lease_token,
    activationId: row.activation_id,
    instanceId: row.instance_id,
    instanceFingerprint: row.instance_fingerprint,
    instanceKeyThumbprint: row.instance_key_thumbprint,
    leaseStartedAt: row.lease_started_at,
    leaseExpiresAt: row.lease_expires_at,
    offlineGraceEndsAt: row.offline_grace_ends_at,
    replacementAllowance: row.replacement_allowance,
    replacementsUsed: row.replacements_used,
    refreshFailureTerminal: row.refresh_failure_terminal ?? false,
    lastValidatedAt: row.last_validated_at,
    lastValidationError: row.last_validation_error,
    licenseKeyLast4: row.license_key_last4,
    iconName: row.icon_name,
    sortOrder: row.sort_order ?? 1000,
    metadata: row.metadata_json ?? {},
    moduleDefinition: row.module_definition_json,
    syncedAt: row.synced_at,
  };
}

export async function upsertModuleCatalogEntries(entries: UpsertModuleCatalogEntryInput[]): Promise<number> {
  if (entries.length === 0) {
    return 0;
  }

  for (const entry of entries) {
    await query(
       `INSERT INTO modules_catalog (
         slug, display_name, description, vendor_name, tier, latest_version,
         remote_scope, exposed_module, remote_entry_path, route_slug,
         icon_name, sort_order, metadata_json, module_definition_json, synced_at, updated_at
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14::jsonb, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT (slug) DO UPDATE SET
         display_name = EXCLUDED.display_name,
         description = EXCLUDED.description,
         vendor_name = EXCLUDED.vendor_name,
         tier = EXCLUDED.tier,
         latest_version = EXCLUDED.latest_version,
         remote_scope = EXCLUDED.remote_scope,
         exposed_module = EXCLUDED.exposed_module,
         remote_entry_path = EXCLUDED.remote_entry_path,
         route_slug = EXCLUDED.route_slug,
         icon_name = EXCLUDED.icon_name,
         sort_order = EXCLUDED.sort_order,
         metadata_json = EXCLUDED.metadata_json,
         module_definition_json = EXCLUDED.module_definition_json,
         synced_at = CURRENT_TIMESTAMP,
         updated_at = CURRENT_TIMESTAMP`,
      [
        entry.slug,
        entry.displayName,
        entry.description ?? null,
        entry.vendorName ?? null,
        entry.tier,
        entry.latestVersion ?? null,
        entry.remoteScope,
        entry.exposedModule ?? './module',
        entry.remoteEntryPath ?? null,
        entry.routeSlug ?? entry.slug,
        entry.iconName ?? null,
        entry.sortOrder ?? 1000,
        JSON.stringify(entry.metadata ?? {}),
        entry.moduleDefinition ? JSON.stringify(entry.moduleDefinition) : null,
      ],
    );
  }

  return entries.length;
}
export async function removeModuleCatalogEntriesNotIn(slugs: string[]): Promise<number> {
  const result = slugs.length === 0
    ? await query(
      `DELETE FROM modules_catalog`,
    )
    : await query(
      `DELETE FROM modules_catalog
       WHERE NOT (slug = ANY($1::text[]))`,
      [slugs],
    );
  return result.rowCount ?? 0;
}

export async function snapshotInstalledModulesFromCatalog(): Promise<number> {
  const result = await query(
    `UPDATE modules_installed AS installed
     SET display_name = catalog.display_name,
         description = catalog.description,
         vendor_name = catalog.vendor_name,
         tier = COALESCE(installed.tier, catalog.tier),
         latest_version = COALESCE(catalog.latest_version, installed.latest_version),
         route_slug = COALESCE(installed.route_slug, catalog.route_slug),
         remote_scope = COALESCE(installed.remote_scope, installed.remote_scope_override, catalog.remote_scope),
         exposed_module = COALESCE(installed.exposed_module, installed.exposed_module_override, catalog.exposed_module),
         remote_entry_path = COALESCE(installed.remote_entry_path, catalog.remote_entry_path),
         icon_name = catalog.icon_name,
         sort_order = catalog.sort_order,
         metadata_json = COALESCE(installed.metadata_json, '{}'::jsonb) || catalog.metadata_json,
         module_definition_json = COALESCE(installed.module_definition_json, catalog.module_definition_json),
         updated_at = CURRENT_TIMESTAMP
     FROM modules_catalog AS catalog
     WHERE catalog.slug = installed.module_slug
       AND installed.metadata_json->>'releaseSource' IS DISTINCT FROM 'entitlement'`,
  );
  return result.rowCount ?? 0;
}

export async function listModuleCatalogEntries(): Promise<ModuleCatalogEntry[]> {
  const result = await query<DbModuleCatalogEntry>(
    `SELECT slug, display_name, description, vendor_name, tier, latest_version,
            remote_scope, exposed_module, remote_entry_path, route_slug,
            icon_name, sort_order, metadata_json, module_definition_json, synced_at, created_at, updated_at
     FROM modules_catalog
     ORDER BY sort_order ASC, display_name ASC`,
  );

  return result.rows.map(mapCatalogEntry);
}

export async function replaceBootstrapInstalledModules(entries: BootstrapInstalledModuleInput[]): Promise<void> {
  await query(`DELETE FROM modules_installed WHERE installed_source = 'bootstrap' AND module_slug != ALL($1::varchar[])`, [entries.map((entry) => entry.moduleSlug)]);

  for (const entry of entries) {
    await query(
      `INSERT INTO modules_installed (
         module_slug, display_name, description, vendor_name, tier, latest_version,
         route_slug, remote_scope, exposed_module, remote_entry_path, icon_name,
         sort_order, metadata_json, module_definition_json,
         remote_entry_url, installed_version, probe_url, backend_url, asset_base_url,
         installed_source, notes,
         created_at, updated_at, last_seen_at
       )
       VALUES (
         $1, $2, $3, $4, $5, $6,
         $7, $8, $9, $10, $11,
         $12, $13::jsonb, $14::jsonb,
         $15, $16, $17, $18, $19,
         $20, $21,
         CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
       )
       ON CONFLICT (module_slug) DO UPDATE SET
         display_name = CASE WHEN modules_installed.metadata_json->>'releaseSource' = 'entitlement' THEN modules_installed.display_name ELSE EXCLUDED.display_name END,
         description = CASE WHEN modules_installed.metadata_json->>'releaseSource' = 'entitlement' THEN modules_installed.description ELSE EXCLUDED.description END,
         vendor_name = CASE WHEN modules_installed.metadata_json->>'releaseSource' = 'entitlement' THEN modules_installed.vendor_name ELSE EXCLUDED.vendor_name END,
         tier = EXCLUDED.tier,
         latest_version = COALESCE(modules_installed.latest_version, EXCLUDED.latest_version),
         route_slug = EXCLUDED.route_slug,
         remote_scope = EXCLUDED.remote_scope,
         exposed_module = EXCLUDED.exposed_module,
         remote_entry_path = EXCLUDED.remote_entry_path,
         icon_name = EXCLUDED.icon_name,
         sort_order = EXCLUDED.sort_order,
         metadata_json = EXCLUDED.metadata_json || modules_installed.metadata_json,
         module_definition_json = EXCLUDED.module_definition_json,
         remote_entry_url = EXCLUDED.remote_entry_url,
         installed_version = EXCLUDED.installed_version,
         probe_url = EXCLUDED.probe_url,
         backend_url = EXCLUDED.backend_url,
         asset_base_url = EXCLUDED.asset_base_url,
         installed_source = EXCLUDED.installed_source,
         notes = EXCLUDED.notes,
         updated_at = CURRENT_TIMESTAMP,
         last_seen_at = CURRENT_TIMESTAMP
       WHERE modules_installed.installed_source = 'bootstrap'`,
      [
        entry.moduleSlug,
        entry.displayName ?? null,
        entry.description ?? null,
        entry.vendorName ?? null,
        entry.tier ?? null,
        entry.latestVersion ?? null,
        entry.routeSlug ?? entry.moduleSlug,
        entry.remoteScope ?? null,
        entry.exposedModule ?? null,
        entry.remoteEntryPath ?? null,
        entry.iconName ?? null,
        entry.sortOrder ?? null,
        JSON.stringify(entry.metadata ?? {}),
        entry.moduleDefinition ? JSON.stringify(entry.moduleDefinition) : null,
        entry.remoteEntryUrl,
        entry.installedVersion ?? null,
        entry.probeUrl ?? null,
        entry.backendUrl ?? null,
        entry.assetBaseUrl ?? null,
        entry.installedSource ?? 'bootstrap',
        entry.notes ?? null,
      ],
    );
  }
}

export interface RecordModuleInstallInput {
  moduleSlug: string;
  displayName?: string | null;
  description?: string | null;
  vendorName?: string | null;
  tier?: ModuleTier | null;
  latestVersion?: string | null;
  routeSlug?: string | null;
  remoteScope?: string | null;
  exposedModule?: string | null;
  remoteEntryPath?: string | null;
  iconName?: string | null;
  sortOrder?: number | null;
  metadata?: Record<string, unknown> | null;
  moduleDefinition?: Record<string, unknown> | null;
  remoteEntryUrl: string;
  installedVersion?: string | null;
  probeUrl?: string | null;
  backendUrl?: string | null;
  assetBaseUrl?: string | null;
  installedSource?: string;
  notes?: string | null;
}

export async function recordModuleInstall(input: RecordModuleInstallInput): Promise<void> {
  await query(
    `INSERT INTO modules_installed (
       module_slug, display_name, description, vendor_name, tier, latest_version,
       route_slug, remote_scope, exposed_module, remote_entry_path, icon_name,
       sort_order, metadata_json, module_definition_json,
       remote_entry_url, installed_version, probe_url, backend_url, asset_base_url,
       installed_source, notes, created_at, updated_at, last_seen_at
     )
     VALUES (
       $1, $2, $3, $4, $5, $6,
       $7, $8, $9, $10, $11,
       $12, $13::jsonb, $14::jsonb,
       $15, $16, $17, $18, $19,
       $20, $21, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
     )
     ON CONFLICT (module_slug) DO UPDATE SET
       display_name = EXCLUDED.display_name,
       description = EXCLUDED.description,
       vendor_name = EXCLUDED.vendor_name,
       tier = EXCLUDED.tier,
       latest_version = EXCLUDED.latest_version,
       route_slug = EXCLUDED.route_slug,
       remote_scope = EXCLUDED.remote_scope,
       exposed_module = EXCLUDED.exposed_module,
       remote_entry_path = EXCLUDED.remote_entry_path,
       icon_name = EXCLUDED.icon_name,
       sort_order = EXCLUDED.sort_order,
       metadata_json = EXCLUDED.metadata_json,
       module_definition_json = EXCLUDED.module_definition_json,
       remote_entry_url = EXCLUDED.remote_entry_url,
       installed_version = EXCLUDED.installed_version,
       probe_url = EXCLUDED.probe_url,
       backend_url = EXCLUDED.backend_url,
       asset_base_url = EXCLUDED.asset_base_url,
       installed_source = EXCLUDED.installed_source,
       notes = EXCLUDED.notes,
       updated_at = CURRENT_TIMESTAMP,
       last_seen_at = CURRENT_TIMESTAMP`,
    [
      input.moduleSlug,
      input.displayName ?? null,
      input.description ?? null,
      input.vendorName ?? null,
      input.tier ?? null,
      input.latestVersion ?? null,
      input.routeSlug ?? input.moduleSlug,
      input.remoteScope ?? null,
      input.exposedModule ?? null,
      input.remoteEntryPath ?? null,
      input.iconName ?? null,
      input.sortOrder ?? null,
      JSON.stringify(input.metadata ?? {}),
      input.moduleDefinition ? JSON.stringify(input.moduleDefinition) : null,
      input.remoteEntryUrl,
      input.installedVersion ?? null,
      input.probeUrl ?? null,
      input.backendUrl ?? null,
      input.assetBaseUrl ?? null,
      input.installedSource ?? 'installer',
      input.notes ?? null,
    ],
  );
}

export async function removeModuleInstall(moduleSlug: string): Promise<void> {
  await query(`DELETE FROM modules_installed WHERE module_slug = $1 AND installed_source != 'bootstrap'`, [moduleSlug]);
}

export async function refreshInstalledModuleRelease(input: UpsertModuleCatalogEntryInput): Promise<void> {
  // Release discovery never creates an install or changes its runtime endpoints/ownership.
  await query(
    `UPDATE modules_installed SET
       display_name = $2, description = $3, vendor_name = $4,
       latest_version = $5, icon_name = $6, sort_order = $7,
       metadata_json = $8::jsonb,
       module_definition_json = COALESCE(module_definition_json, $9::jsonb),
       updated_at = CURRENT_TIMESTAMP
     WHERE module_slug = $1`,
    [input.slug, input.displayName, input.description ?? null, input.vendorName ?? null,
      input.latestVersion ?? null, input.iconName ?? null, input.sortOrder ?? 1000,
      JSON.stringify({ ...input.metadata, releaseSource: 'entitlement' }), JSON.stringify(input.moduleDefinition ?? null)],
  );
}

export async function listInstalledModules(): Promise<ModuleInstallRecord[]> {
  const result = await query<DbModuleInstallRecord>(
    `SELECT id, module_slug, display_name, description, vendor_name, tier,
            latest_version, route_slug, remote_scope, exposed_module, remote_entry_path,
            icon_name, sort_order, metadata_json, module_definition_json,
            remote_entry_url, probe_url, backend_url, asset_base_url,
            installed_version,
            remote_scope_override, exposed_module_override,
            installed_source, notes, created_at, updated_at, last_seen_at
     FROM modules_installed
     ORDER BY module_slug ASC`,
  );

  return result.rows.map(mapInstallRecord);
}

export async function upsertModuleLicense(input: UpsertModuleLicenseInput): Promise<ModuleLicenseRecord> {
  const result = await query<DbModuleLicenseRecord>(
    `INSERT INTO module_licenses (
       module_slug, license_key, status, customer_name, issued_to, lease_token,
       activation_id, refresh_credential, instance_id, instance_fingerprint, instance_key_thumbprint,
       lease_started_at, lease_expires_at, offline_grace_ends_at,
       replacement_allowance, replacements_used, refresh_failure_terminal,
       last_validated_at, last_validation_error,
       authority_url, created_at, updated_at
     )
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
     ON CONFLICT (module_slug) DO UPDATE SET
       license_key = EXCLUDED.license_key,
       authority_url = EXCLUDED.authority_url,
       status = EXCLUDED.status,
       customer_name = EXCLUDED.customer_name,
       issued_to = EXCLUDED.issued_to,
       lease_token = EXCLUDED.lease_token,
       activation_id = EXCLUDED.activation_id,
       refresh_credential = EXCLUDED.refresh_credential,
       instance_id = EXCLUDED.instance_id,
       instance_fingerprint = EXCLUDED.instance_fingerprint,
       instance_key_thumbprint = EXCLUDED.instance_key_thumbprint,
       lease_started_at = EXCLUDED.lease_started_at,
       lease_expires_at = EXCLUDED.lease_expires_at,
       offline_grace_ends_at = EXCLUDED.offline_grace_ends_at,
       replacement_allowance = EXCLUDED.replacement_allowance,
       replacements_used = EXCLUDED.replacements_used,
       refresh_failure_terminal = EXCLUDED.refresh_failure_terminal,
       last_validated_at = EXCLUDED.last_validated_at,
       last_validation_error = EXCLUDED.last_validation_error,
       updated_at = CURRENT_TIMESTAMP
     RETURNING module_slug, authority_url, license_key, status, customer_name, issued_to, lease_token,
               activation_id, refresh_credential, instance_id, instance_fingerprint, instance_key_thumbprint,
               lease_started_at, lease_expires_at, offline_grace_ends_at,
               replacement_allowance, replacements_used, refresh_failure_terminal,
               last_validated_at, last_validation_error,
               created_at, updated_at`,
    [
      input.moduleSlug,
      input.licenseKey,
      input.status,
      input.customerName ?? null,
      input.issuedTo ?? null,
      input.leaseToken ?? null,
      input.activationId ?? null,
      input.refreshCredential ?? null,
      input.instanceId ?? null,
      input.instanceFingerprint ?? null,
      input.instanceKeyThumbprint ?? null,
      input.leaseStartedAt ?? null,
      input.leaseExpiresAt ?? null,
      input.offlineGraceEndsAt ?? null,
      input.replacementAllowance ?? null,
      input.replacementsUsed ?? null,
      input.refreshFailureTerminal ?? false,
      input.lastValidatedAt ?? null,
      input.lastValidationError ?? null,
      input.authorityUrl,
    ],
  );

  return mapLicenseRecord(result.rows[0]);
}

export async function getModuleLicense(moduleSlug: string): Promise<ModuleLicenseRecord | null> {
  const result = await query<DbModuleLicenseRecord>(
    `SELECT module_slug, authority_url, license_key, status, customer_name, issued_to, lease_token,
            activation_id, refresh_credential, instance_id, instance_fingerprint, instance_key_thumbprint,
            lease_started_at, lease_expires_at, offline_grace_ends_at,
            replacement_allowance, replacements_used, refresh_failure_terminal,
            last_validated_at, last_validation_error, created_at, updated_at
     FROM module_licenses
     WHERE module_slug = $1`,
    [moduleSlug],
  );
  return result.rows[0] ? mapLicenseRecord(result.rows[0]) : null;
}

// Licenses this robin-admin instance has locally activated (one row per module).
// Marks which Sheriff-issued licenses are active on this deployment.
// `license_key` stores the key suffix/preview captured at activation.
export async function listLocalModuleLicenseKeys(): Promise<Array<{ moduleSlug: string; licenseKey: string; status: string }>> {
  const result = await query<{ module_slug: string; license_key: string; status: string }>(
    `SELECT module_slug, license_key, status FROM module_licenses`,
  );
  return result.rows.map((row) => ({
    moduleSlug: row.module_slug,
    licenseKey: row.license_key,
    status: row.status,
  }));
}

export async function recordModuleLicenseRefreshError(
  moduleSlug: string,
  message: string,
  terminal: boolean,
): Promise<void> {
  await query(
    `UPDATE module_licenses
     SET last_validation_error = $2,
         refresh_failure_terminal = refresh_failure_terminal OR $3,
         updated_at = CURRENT_TIMESTAMP
     WHERE module_slug = $1`,
    [moduleSlug, message, terminal],
  );
}

export async function listModuleSummaries(): Promise<ModuleSummary[]> {
  const result = await query<DbModuleSummary>(
    `WITH module_keys AS (
       SELECT slug AS module_slug FROM modules_catalog
       UNION
       SELECT module_slug FROM modules_installed
     )
     SELECT
       module_keys.module_slug AS slug,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(installed.display_name, catalog.display_name) ELSE COALESCE(catalog.display_name, installed.display_name) END AS display_name,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(installed.description, catalog.description) ELSE COALESCE(catalog.description, installed.description) END AS description,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(installed.vendor_name, catalog.vendor_name) ELSE COALESCE(catalog.vendor_name, installed.vendor_name) END AS vendor_name,
       COALESCE(installed.tier, catalog.tier) AS tier,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(installed.latest_version, catalog.latest_version) ELSE COALESCE(catalog.latest_version, installed.latest_version) END AS latest_version,
       COALESCE(installed.route_slug, catalog.route_slug) AS route_slug,
       COALESCE(installed.remote_scope, installed.remote_scope_override, catalog.remote_scope) AS remote_scope,
       COALESCE(installed.exposed_module, installed.exposed_module_override, catalog.exposed_module) AS exposed_module,
       COALESCE(installed.remote_entry_path, catalog.remote_entry_path) AS remote_entry_path,
       installed.remote_entry_url,
       installed.installed_version,
       installed.probe_url,
       installed.backend_url,
       installed.asset_base_url,
       installed.installed_source,
       installed.notes,
       installed.created_at AS install_created_at,
       installed.last_seen_at,
       licenses.status AS license_status,
       licenses.authority_url,
       licenses.customer_name,
       licenses.issued_to,
       licenses.lease_token,
       licenses.activation_id,
       licenses.instance_id,
       licenses.instance_fingerprint,
       licenses.instance_key_thumbprint,
       licenses.lease_started_at,
       licenses.lease_expires_at,
       licenses.offline_grace_ends_at,
       licenses.replacement_allowance,
       licenses.replacements_used,
       licenses.refresh_failure_terminal,
       licenses.last_validated_at,
       licenses.last_validation_error,
       RIGHT(licenses.license_key, 4) AS license_key_last4,
       COALESCE(catalog.icon_name, installed.icon_name) AS icon_name,
       COALESCE(catalog.sort_order, installed.sort_order) AS sort_order,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(catalog.metadata_json, '{}'::jsonb) || COALESCE(installed.metadata_json, '{}'::jsonb) ELSE COALESCE(installed.metadata_json, '{}'::jsonb) || COALESCE(catalog.metadata_json, '{}'::jsonb) END AS metadata_json,
       COALESCE(installed.module_definition_json, catalog.module_definition_json) AS module_definition_json,
       catalog.synced_at
     FROM module_keys
     LEFT JOIN modules_catalog AS catalog ON catalog.slug = module_keys.module_slug
     LEFT JOIN modules_installed AS installed ON installed.module_slug = module_keys.module_slug
     LEFT JOIN module_licenses AS licenses ON licenses.module_slug = module_keys.module_slug
     ORDER BY COALESCE(catalog.sort_order, installed.sort_order, 1000) ASC,
              COALESCE(catalog.display_name, installed.display_name, module_keys.module_slug) ASC`,
  );

  return result.rows.map(mapModuleSummary);
}

export async function getModuleSummaryBySlug(slug: string): Promise<ModuleSummary | null> {
  const result = await query<DbModuleSummary>(
    `WITH module_keys AS (
       SELECT $1::varchar AS module_slug
     )
     SELECT
       module_keys.module_slug AS slug,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(installed.display_name, catalog.display_name) ELSE COALESCE(catalog.display_name, installed.display_name) END AS display_name,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(installed.description, catalog.description) ELSE COALESCE(catalog.description, installed.description) END AS description,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(installed.vendor_name, catalog.vendor_name) ELSE COALESCE(catalog.vendor_name, installed.vendor_name) END AS vendor_name,
       COALESCE(installed.tier, catalog.tier) AS tier,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(installed.latest_version, catalog.latest_version) ELSE COALESCE(catalog.latest_version, installed.latest_version) END AS latest_version,
       COALESCE(installed.route_slug, catalog.route_slug) AS route_slug,
       COALESCE(installed.remote_scope, installed.remote_scope_override, catalog.remote_scope) AS remote_scope,
       COALESCE(installed.exposed_module, installed.exposed_module_override, catalog.exposed_module) AS exposed_module,
       COALESCE(installed.remote_entry_path, catalog.remote_entry_path) AS remote_entry_path,
       installed.remote_entry_url,
       installed.installed_version,
       installed.probe_url,
       installed.backend_url,
       installed.asset_base_url,
       installed.installed_source,
       installed.notes,
       installed.created_at AS install_created_at,
       installed.last_seen_at,
       licenses.status AS license_status,
       licenses.authority_url,
       licenses.customer_name,
       licenses.issued_to,
       licenses.lease_token,
       licenses.activation_id,
       licenses.instance_id,
       licenses.instance_fingerprint,
       licenses.instance_key_thumbprint,
       licenses.lease_started_at,
       licenses.lease_expires_at,
       licenses.offline_grace_ends_at,
       licenses.replacement_allowance,
       licenses.replacements_used,
       licenses.refresh_failure_terminal,
       licenses.last_validated_at,
       licenses.last_validation_error,
       RIGHT(licenses.license_key, 4) AS license_key_last4,
       COALESCE(catalog.icon_name, installed.icon_name) AS icon_name,
       COALESCE(catalog.sort_order, installed.sort_order) AS sort_order,
       CASE WHEN installed.tier = 'paid' THEN COALESCE(catalog.metadata_json, '{}'::jsonb) || COALESCE(installed.metadata_json, '{}'::jsonb) ELSE COALESCE(installed.metadata_json, '{}'::jsonb) || COALESCE(catalog.metadata_json, '{}'::jsonb) END AS metadata_json,
       COALESCE(installed.module_definition_json, catalog.module_definition_json) AS module_definition_json,
       catalog.synced_at
     FROM module_keys
     LEFT JOIN modules_catalog AS catalog ON catalog.slug = module_keys.module_slug
     LEFT JOIN modules_installed AS installed ON installed.module_slug = module_keys.module_slug
     LEFT JOIN module_licenses AS licenses ON licenses.module_slug = module_keys.module_slug
     WHERE catalog.slug IS NOT NULL OR installed.module_slug IS NOT NULL`,
    [slug],
  );

  return result.rows[0] ? mapModuleSummary(result.rows[0]) : null;
}
