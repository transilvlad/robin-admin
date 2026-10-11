/**
 * Type definitions for Robin Admin client.
 */

// Admin roles
import type { OperationsPolicy } from '../constants/operationsSettings';
export type AdminRole = 'viewer' | 'editor' | 'admin';

// Admin user
export interface Admin {
  id: number;
  uid: string;
  name: string;
  email: string;
  role: AdminRole;
  allowedCidrs: string[];
  createdAt: string;
  updatedAt: string;
  lastLogin: string | null;
  disabled: boolean;
}

// Current user session
export interface CurrentUser {
  id: number;
  uid: string;
  name: string;
  email: string;
  role: AdminRole;
  allowedCidrs?: string[];
  createdAt?: string;
  lastLogin?: string | null;
  csrfToken?: string;
}

// Mail user (Dovecot virtual user). Backend tolerates schema variation
// across deployments — non-standard column values come through in `extra`.
export interface MailUser {
  id: number;
  email: string;
  uid: number;
  gid: number;
  home: string | null;
  maildir: string | null;
  extra?: Record<string, unknown>;
}

// Alias
export interface Alias {
  id: number;
  source: string;
  destination: string;
}

// Queue item
export interface QueueItem {
  id: number;
  queueUid: string;
  state: string;
  nextAttemptAt: number;
  claimedUntil: number;
  claimOwner: string | null;
  createdEpoch: number;
  updatedEpoch: number;
  retryCount: number;
  protocol: string | null;
  sessionUid: string | null;
  lastError: string | null;
}

// Audit log entry
export interface AuditLogEntry {
  id: number;
  adminId: number | null;
  adminEmail?: string;
  action: string;
  entityType: string;
  entityId: string | null;
  oldValues: Record<string, unknown> | null;
  newValues: Record<string, unknown> | null;
  details?: Record<string, unknown> | null;
  ipAddress: string | null;
  createdAt: string;
}

// API response types
export interface ApiResponse<T = unknown> {
  success: boolean;
  data?: T;
  error?: string;
  configurationError?: string | null;
  message?: string;
  details?: string[];
}

export interface PaginatedResponse<T> extends ApiResponse<T[]> {
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

// Dashboard stats
export interface DashboardStats {
  users: number;
  aliases: number;
  autoAliases: number;
  admins: number;
  queue: {
    total: number;
    byState: Record<string, number>;
    byProtocol: Record<string, number>;
  };
  robinConnected: boolean;
  dmarc: {
    totalReports: number;
    totalMessages: number;
    errorMessages: number;
    recentReports: number;
    last30Days: number;
  };
  tlsrpt?: {
    totalReports: number;
    last24Hours: number;
    last30Days: number;
    totalSuccess: number;
    totalFailure: number;
  };
  forensic?: {
    totalReports: number;
    last24Hours: number;
    last30Days: number;
  };
  configWarnings?: {
    staticTestUsersEnabled: boolean;
    developmentOptionsEnabled: boolean;
    enabledReasons: string[];
  };
  metrics?: {
    // Memory
    memoryUsedMB: number;
    memoryMaxMB: number;
    memoryCommittedMB: number;
    memoryPct: number;
    // Threads
    threads: number;
    threadsDaemon: number;
    threadsPeak: number;
    threadsStarted: number;
    // CPU
    cpuPct: number;
    processCpuPct: number;
    cpuCount: number;
    loadAverage: number;
    // GC
    gcPauseSeconds: number;
    gcPauseCount: number;
    gcMemoryAllocatedMB: number;
    gcMemoryPromotedMB: number;
    gcLiveDataMB: number;
    // Buffers
    bufferCount: number;
    bufferMemoryMB: number;
    // Email
    totalReceived: number;
    totalDelivered: number;
    totalLimited: number;
    totalExceptions: number;
    // Rejections
    rblRejections: number;
    virusRejections: number;
    spamRejections: number;
    totalRejected: number;
    // DoS
    dosRatelimit: number;
    dosConnlimit: number;
    dosTarpit: number;
    dosSlowTransfer: number;
    dosCommandFlood: number;
    totalDosBlocked: number;
    // Other
    whitelistBypasses: number;
    adaptiveRatelimit: number;
    geoipBlocked: number;
    geoipLimited: number;
    distributedErrors: number;
  } | null;
  email24h: {
    received: number;
    delivered: number;
    rejected: number;
  };
}

// Setup status
export interface SetupStatus {
  setupRequired: boolean;
}

// Admin configuration
export interface AdminConfig extends OperationsPolicy {
  telemetrySourceWindowDays: number;
  telemetrySourceLabel: string;
  telemetryGroupLabel: string;
  telemetrySourceSelector: string;
  telemetrySilentAfterSeconds: number;
  telemetrySourceRefreshSeconds: number;
  telemetrySourceLimit: number;
  telemetryIngestBodyLimitBytes: number;
  telemetryRequestTimeoutMs: number;
  telemetryQueryMaxPoints: number;
  telemetryQueryMaxSeries: number;
  telemetryQueryMaxRangeDays: number;
  monitoringConcurrency: number;
  monitoringManualConcurrency: number;
  monitoringManualQueueSize: number;
  monitoringQueueWaitMs: number;
  monitoringObservationRetentionDays: number;
  monitoringHistoryRetentionDays: number;
  reportingRetentionDays: number;
  reportingCacheMiB: number;
  reportingCacheEntries: number;
  reportingCacheTtlSeconds: number;
  reportingSourceConcurrency: number;
  reportingSourceQueueSize: number;
  reportingSourceQueueWaitMs: number;
  auditLogRetentionDays: number;
  gravatarEnabled: boolean;
  gravatarDefault: string;
  reportingMtaStsChecksEnabled: boolean;
  reportingTlsrptChecksEnabled: boolean;
  reportingDaneChecksEnabled: boolean;
  reportingBimiChecksEnabled: boolean;
  reportingIntegrationEnabled: boolean;
  sessionTimeoutMinutes: number;
  sessionAbsoluteLifetimeMinutes: number;
  maxLoginAttempts: number;
  loginLockoutMinutes: number;
  loginProtectionEnabled: boolean;
  loginMaxAttemptsPerEmail: number;
  loginMaxAttemptsPerIp: number;
  globalIpAllowlist: string;
  ingestionAuthRequired: boolean;
  ingestionAllowedCidrs: string;
  ingestionSecretConfigured: boolean;
  csrfProtectionEnabled: boolean;
  allowedOrigins: string;
  trustedProxyCidrs: string;
  allowPrivateServiceUrls: boolean;
  apiKeyMaxLifetimeDays: number;
  fleetEnabled: boolean;
  mailboxesEnabled: boolean;
  monitoringEnabled: boolean;
  telemetryEnabled: boolean;
  modulesEnabled: boolean;
  robinConfigTableName: string;
  alertDeliveryRetentionDays: number;
  reportingDefaultWindowDays: number;
  reportingStaleAfterDays: number;
  reportingAnalysisDebounceMs: number;
  reportingAnalysisConcurrency: number;
  reportingNonCompliantRateThreshold: number;
  reportingNonCompliantMinVolume: number;
  reportingNonCompliantAbsoluteFloor: number;
  detectionUnknownSenderMinVolume: number;
  detectionSpoofingMinFailCount: number;
  detectionMisconfiguredMinVolume: number;
  detectionDmarcFailingPassRate: number;
  detectionTlsFailureRate: number;
  detectionTlsMinFailures: number;
  detectionForensicSpikeMultiplier: number;
  detectionForensicSpikeMinRecent: number;
  detectionForensicClusterMinOccurrences: number;
  detectionForensicClusterMaxIssues: number;
  detectionRequiredRuns: number;
  detectionGraceRuns: number;
  sourceIdentityTtlDays: number;
  sourceIdentityConcurrency: number;
  sourceIdentityTimeoutMs: number;
  dnsResolvers: string;
  senderEnrichmentDnsTimeoutMs: number;
  metricsPollIntervalMs: number;
  metricsRetentionDays: number;
  logDefaultLines: number;
  logMaxLines: number;
  agentImage: string;
  agentInstallUrl: string;
  agentReleaseUrl: string;
  agentDeployGuideUrl: string;
}

export interface RuntimeConfig {
  telemetry: { storeConfigured: boolean; storeAddress: string };
  nodeEnv: string;
  port: number;
  logLevel: string;
  cookieDomain: string;
  cookieSecure: boolean;
  allowedOrigins: string[];
  bodyLimit: string;
  rateLimit: {
    windowMs: number;
    maxRequests: number;
    loginMaxRequests: number;
  };
  postgres: {
    host: string;
    port: number;
    database: string;
    user: string;
    poolMax: number;
    poolMin: number;
    idleTimeoutMillis: number;
    connectionTimeoutMillis: number;
  };
  robin: {
    apiUrl: string;
    apiAuthConfigured: boolean;
  };
  alerting: {
    enabled: boolean;
    evaluationIntervalMs: number;
    deliveryConcurrency: number;
    instanceName: string;
    encryptionKeyConfigured: boolean;
  };
  sheriff: {
    catalogBaseUrl: string;
    rootPublicKeyConfigured: boolean;
  };
  moduleInstaller: {
    url: string;
    signingSecretConfigured: boolean;
  };
  moduleProxySecretModules: string[];
  bootstrapModules: string[];
}

// Single source of truth lives in the service-type registry.
import type { FleetServiceType } from '../constants/serviceTypes';
export { FLEET_SERVICE_TYPES } from '../constants/serviceTypes';
export type { FleetServiceType };

export interface FleetService {
  id: number;
  serviceId: string;
  serviceType: FleetServiceType;
  name: string;
  description: string | null;
  apiUrl: string | null;
  healthUrl: string | null;
  metricsUrl: string | null;
  controllerUrl: string | null;
  normalUrl: string | null;
  /** The `host` label this service's machine sends Telemetry under. */
  telemetrySource: string | null;
  enabled: boolean;
  agentId?: string | null;
  collectionMode?: 'direct' | 'agent';
  logAgentId?: string | null;
  configAgentId?: string | null;
  createdAt: string;
  updatedAt: string;
}

// A service an agent is responsible for, with the per-axis capability flags the
// server derives (metrics/config = agent-mode owner; logs = owner or log agent).
export interface AgentServiceResponsibility extends FleetService {
  collectMetrics: boolean;
  collectConfig: boolean;
  collectLogs: boolean;
}

// ── robin-agent (unified fleet agent) ───────────────────────────────────────
export type FleetAgentStatus = 'pending' | 'online' | 'offline';

export interface DiscoveredService {
  serviceType: string;
  name?: string;
  detail?: string;
  source?: string;
}

export interface FleetAgent {
  id: number;
  agentId: string;
  name: string;
  hostname: string | null;
  os: string | null;
  arch: string | null;
  agentVersion: string | null;
  status: FleetAgentStatus;
  labels: Record<string, unknown>;
  discovered: DiscoveredService[];
  metadata: Record<string, unknown>;
  enrolledAt: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface FleetAgentEnrollment {
  token: string;
  expiresAt: string;
}

export interface CreatedFleetAgent {
  agent: FleetAgent;
  enrollment: FleetAgentEnrollment;
}

export interface RobinInstance extends FleetService {
  serviceType: 'robin';
  apiUrl: string;
  metricsUrl: string | null;
}

export interface FleetServiceHealth {
  serviceId: string;
  serviceType: FleetServiceType;
  healthy: boolean;
  status?: number;
  latency?: number;
  checkedAt?: string;
  error?: string;
}

export interface FleetServiceCounts {
  total: number;
  robin: number;
  rspamd: number;
  clamav: number;
  dovecot: number;
  postfix: number;
  redis: number;
  postgres: number;
  mariadb: number;
}

export interface ClamdManagedConfig {
  tcpAddr: string;
  tcpPort: number;
  localSocket: string;
  localSocketMode: string;
  maxScanSize: string;
  maxFileSize: string;
  maxRecursion: number;
  maxFiles: number;
  scanArchive: boolean;
  maxThreads: number;
  readTimeoutSeconds: number;
  user: string;
  logFile: string;
  logVerbose: boolean;
  virusEvent: string;
  notifyClamdOnUpdate: boolean;
  detectPua: boolean;
  heuristicAlerts: boolean;
  scanPdf: boolean;
  scanHtml: boolean;
  scanOle2: boolean;
  maxScanTimeMs: number;
}

export interface FreshclamManagedConfig {
  enabled: boolean;
  daemon: boolean;
  checks: number;
  databaseMirror: string[];
  privateMirror: string[];
  updateLogFile: string;
  databaseOwner: string;
  notifyClamd: string;
  connectTimeoutSeconds: number;
  receiveTimeoutSeconds: number;
  httpProxyServer: string;
  httpProxyPort: number | null;
  httpProxyUsername: string;
  httpProxyPassword: string;
}

export interface ClamavConfigState {
  serviceId: string | null;
  serviceName: string | null;
  clamd: ClamdManagedConfig;
  freshclam: FreshclamManagedConfig;
}

export type DovecotConfigVersion = '2.3' | '2.4';

export interface DovecotManagedConfig {
  dovecotVersion: DovecotConfigVersion;
  authCacheSize: string;
  authCacheTtl: string;
  authCacheNegativeTtl: string;
  authFailureDelay: string;
  disablePlaintextAuth: boolean;
  mailMaxUseripConnections: number;
  imapIdleNotifyInterval: string;
  imapMaxLineLength: string;
  mailMaxLockTimeout: string;
  protocols: string;
  mailRetentionDays: number;
}

/** A per-file managed config entry (shared shape across services). */
export interface ManagedConfigFileEntry {
  key: string;
  fileName: string;
  values: Record<string, unknown>;
  rendered: string;
}

export interface DovecotConfigState {
  serviceId: string | null;
  serviceName: string | null;
  managed: DovecotManagedConfig;
  /** `dovecot --version` as the service's agent last reported it. */
  detectedVersion?: string | null;
  managedFiles: ManagedConfigFileEntry[];
}

export interface PostfixManagedConfig {
  messageSizeLimit: number;
  mailboxSizeLimit: number;
  maximalQueueLifetime: string;
  bounceQueueLifetime: string;
  defaultProcessLimit: number;
  defaultDestinationConcurrencyLimit: number;
  smtpdClientConnectionCountLimit: number;
  smtpdClientConnectionRateLimit: number;
  smtpdClientMessageRateLimit: number;
  smtpdClientRecipientRateLimit: number;
  smtpdClientAuthRateLimit: number;
  notifyClasses: string;
  headerChecks: string[];
  bodyChecks: string[];
}

export interface PostfixConfigState {
  serviceId: string | null;
  serviceName: string | null;
  managed: PostfixManagedConfig;
  managedFiles: ManagedConfigFileEntry[];
}

export type RedisMaxmemoryPolicy =
  | 'noeviction'
  | 'allkeys-lru'
  | 'allkeys-lfu'
  | 'allkeys-random'
  | 'volatile-lru'
  | 'volatile-lfu'
  | 'volatile-random'
  | 'volatile-ttl';

export type RedisLogLevel = 'debug' | 'verbose' | 'notice' | 'warning';

export interface RedisManagedConfig {
  maxmemory: string;
  maxmemoryPolicy: RedisMaxmemoryPolicy;
  save: string;
  appendonly: boolean;
  appendfsync: 'always' | 'everysec' | 'no';
  timeout: number;
  tcpKeepalive: number;
  maxclients: number;
  slowlogLogSlowerThan: number;
  slowlogMaxLen: number;
  loglevel: RedisLogLevel;
  notifyKeyspaceEvents: string;
  lazyfreeLazyEviction: boolean;
  lazyfreeLazyExpire: boolean;
  lazyfreeLazyServerDel: boolean;
  lazyfreeLazyUserDel: boolean;
  lazyfreeLazyUserFlush: boolean;
  hz: number;
  activeDefrag: boolean;
  latencyMonitorThreshold: number;
  stopWritesOnBgsaveError: boolean;
  rdbCompression: boolean;
  maxmemoryClients: string;
}

export interface RedisConfigState {
  serviceId: string | null;
  serviceName: string | null;
  managed: RedisManagedConfig;
}

export interface RedisSlowlogEntry {
  id: number;
  timestampEpoch: number;
  durationMicros: number;
  command: string[];
  clientAddress: string;
  clientName: string;
}

export interface RedisClientEntry {
  id: number;
  addr: string;
  name: string;
  ageSecs: number;
  idleSecs: number;
  db: number;
  cmd: string;
  user: string;
}

export interface PostgresManagedConfig {
  workMem: string;
  maintenanceWorkMem: string;
  effectiveCacheSize: string;
  logMinDurationStatement: number;
  statementTimeout: number;
  idleInTransactionSessionTimeout: number;
  autovacuum: boolean;
  autovacuumVacuumScaleFactor: number;
  autovacuumAnalyzeScaleFactor: number;
  autovacuumNaptime: number;
  checkpointTimeout: number;
  maxWalSize: string;
  minWalSize: string;
  randomPageCost: number;
  defaultStatisticsTarget: number;
  logConnections: boolean;
  logDisconnections: boolean;
  effectiveIoConcurrency: number;
  maxParallelWorkersPerGather: number;
  checkpointCompletionTarget: number;
  walCompression: boolean;
  synchronousCommit: string;
  logLockWaits: boolean;
  logTempFiles: number;
}

export interface PostgresRestartRequiredSetting {
  name: string;
  setting: string;
  unit: string | null;
  pendingRestart: boolean;
}

export interface PostgresConfigState {
  serviceId: string | null;
  serviceName: string | null;
  managed: PostgresManagedConfig;
  restartRequired?: PostgresRestartRequiredSetting[];
}

export interface PostgresActivityRow {
  pid: number;
  usename: string | null;
  state: string | null;
  waitEventType: string | null;
  waitEvent: string | null;
  query: string | null;
  ageSecs: number;
}

export interface PostgresLockRow {
  pid: number;
  relation: string | null;
  mode: string | null;
  granted: boolean;
  blockedByPids: number[];
}

export interface PostgresTableSizeRow {
  schema: string;
  table: string;
  totalBytes: number;
}

export interface PostgresStatStatementRow {
  query: string;
  calls: number;
  totalExecMs: number;
  meanExecMs: number;
}

export interface PostgresStatStatementsResult {
  available: boolean;
  rows: PostgresStatStatementRow[];
}

/** A value per managed dynamic variable; null leaves the server's own setting. */
export type MariadbManagedConfig = Record<string, number | boolean | string | null>;

export interface MariadbConfigState {
  serviceId: string;
  serviceName: string;
  managed: MariadbManagedConfig;
  /** The running server's value per managed key (instance scopes, when reachable). */
  live: Record<string, string>;
  flavor: 'mariadb' | 'mysql' | null;
  serverSettings: Array<{ name: string; setting: string }>;
  applyError?: string | null;
}

export interface MariadbProcessRow {
  id: number;
  user: string | null;
  host: string | null;
  db: string | null;
  command: string | null;
  timeSecs: number;
  state: string | null;
  info: string | null;
}

export interface MariadbTransactionRow {
  trxId: string;
  state: string;
  startedAt: string;
  ageSecs: number;
  threadId: number;
  user: string | null;
  host: string | null;
  db: string | null;
  command: string | null;
  query: string | null;
  rowsLocked: number;
  tablesLocked: number;
  blockedByThreadIds: number[];
}

export interface MariadbSchemaRow {
  schema: string;
  tables: number;
  totalBytes: number;
  freeBytes: number;
}

export interface MariadbTableRow {
  schema: string;
  table: string;
  engine: string | null;
  rows: number;
  totalBytes: number;
  freeBytes: number;
}

export interface MariadbStatementsResult {
  available: boolean;
  rows: Array<{ schema: string | null; digest: string; calls: number; totalMs: number; meanMs: number; rowsExamined: number }>;
}

export interface ServiceLogs {
  serviceType: FleetServiceType;
  serviceId: string;
  source: string;
  available: boolean;
  lines: string[];
  error?: string;
}

// ── Fleet config-sync (robin-admin → agent → service) ──────────────────────
export type FleetServiceApplyStatus = 'unknown' | 'pending' | 'succeeded' | 'failed';

export interface FleetServiceSyncStatus {
  serviceId: string;
  manifestSha256: string | null;
  manifestEtag: string | null;
  manifestFileCount: number | null;
  lastSeenAt: string | null;
  lastManifestPulledAt: string | null;
  lastFilePulledAt: string | null;
  lastApplyStartedAt: string | null;
  lastApplyFinishedAt: string | null;
  lastApplyStatus: FleetServiceApplyStatus;
  lastApplyError: string | null;
  lastAppliedSha256: string | null;
  lastAppliedFileCount: number | null;
  agentVersion: string | null;
  syncRequestedAt: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export type FleetSyncLogEventType =
  | 'manifest_pulled'
  | 'apply_started'
  | 'apply_succeeded'
  | 'apply_failed'
  | 'registered'
  | 'sync_requested';

export interface FleetServiceSyncLogEntry {
  id: number;
  serviceId: string;
  eventType: FleetSyncLogEventType;
  applyStatus: FleetServiceApplyStatus | null;
  manifestSha256: string | null;
  appliedSha256: string | null;
  fileCount: number | null;
  agentVersion: string | null;
  message: string | null;
  metadataJson: Record<string, unknown>;
  createdAt: string;
}

// Available features. Mailboxes is enabled independently of table readiness; the
// fleet reflects the control-plane toggle, service flags reflect registry
// presence, and robinConfig reflects the fixed Robin config-store schema.
export interface Features {
  /** Workspace enablement, independent of mailbox schema readiness and Fleet. */
  mailboxes: boolean;
  users: boolean;
  aliases: boolean;
  autoAliases: boolean;
  queue: boolean;
  dmarc: boolean;
  reporting: boolean;
  robin: boolean;
  fleet: boolean;
  monitoring: boolean;
  /** Telemetry is enabled and a store is configured. */
  telemetry: boolean;
  modules: boolean;
  robinConfig: boolean;
  rspamd: boolean;
  clamav: boolean;
  dovecot: boolean;
  postfix: boolean;
  redis: boolean;
  postgres: boolean;
  mariadb: boolean;
  fleetEnabled: boolean;
  monitoringEnabled: boolean;
  telemetryEnabled: boolean;
  telemetryStoreConfigured: boolean;
  modulesEnabled: boolean;
  fleetServices: FleetServiceCounts;
  /** What each service can do in its setup (loaded after sign-in). */
  capabilities?: FleetCapabilities;
}

export interface CapabilityState {
  available: boolean;
  /** Why the feature is hidden in this setup. */
  reason?: string;
}

export interface ServiceCapabilities {
  serviceId: string;
  serviceType: FleetServiceType;
  name: string;
  enabled: boolean;
  features: Record<string, CapabilityState>;
}

export interface FleetCapabilities {
  services: ServiceCapabilities[];
  /** Per type, the features at least one enabled service has. */
  byType: Partial<Record<FleetServiceType, Record<string, boolean>>>;
}

export type SetupAgent = 'none' | 'local' | 'container' | 'ssh';

export interface SetupChoice {
  agent: SetupAgent;
  reachable: boolean;
}

export interface CapabilityRuleInfo {
  id: string;
  label: string;
  surface: string;
  types: FleetServiceType[];
}

export interface CapabilityMatrix {
  rules: CapabilityRuleInfo[];
  setups: SetupChoice[];
  matrix: Record<FleetServiceType, Array<{ setup: SetupChoice; features: Record<string, CapabilityState> }>>;
}

export type ModuleTier = 'free' | 'paid';
export type ModuleActivationStatus = 'active' | 'grace' | 'license-required' | 'expired' | 'invalid' | 'not-installed';
export type ModuleRuntimeStatus = 'reachable' | 'unreachable' | 'unknown';
export type ModuleInstallerAction = 'install' | 'upgrade' | 'start' | 'stop' | 'uninstall';

export interface ModuleNavigationEntry {
  label: string;
  path?: string;
  iconName?: string;
  indexLabel?: string;
  children?: ModuleNavigationEntry[];
}

export interface ModuleDefinition {
  name?: string;
  title?: string;
  description?: string;
  defaultPath?: string;
  navigation?: ModuleNavigationEntry[];
}

export interface AdminModule {
  configuredAuthorityUrl: string;
  licenseAuthorityUrl: string | null;
  deploymentLabel: string;
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
  installed: boolean;
  installedSource: string | null;
  installedNotes: string | null;
  installedAt: string | null;
  lastSeenAt: string | null;
  requiresLicense: boolean;
  updateAvailable: boolean;
  active: boolean;
  activationStatus: ModuleActivationStatus;
  installerActions: Array<'install' | 'upgrade' | 'start' | 'stop' | 'uninstall'>;
  installerUpgradeStrategy: 'stage-first' | 'maintenance' | null;
  activationMessage: string | null;
  runtimeAvailable: boolean;
  runtimeStatus: ModuleRuntimeStatus;
  runtimeMessage: string | null;
  customerName: string | null;
  issuedTo: string | null;
  leaseToken: string | null;
  activationId: string | null;
  instanceId: string | null;
  instanceFingerprint: string | null;
  instanceKeyThumbprint: string | null;
  leaseStartedAt: string | null;
  leaseExpiresAt: string | null;
  offlineGraceEndsAt: string | null;
  replacementAllowance: number | null;
  replacementsUsed: number | null;
  refreshFailureTerminal: boolean;
  lastValidatedAt: string | null;
  lastValidationError: string | null;
  licenseKeyLast4: string | null;
  iconName: string | null;
  sortOrder: number;
  metadata: Record<string, unknown>;
  moduleDefinition: ModuleDefinition | null;
  syncedAt: string | null;
}

export interface ModuleCatalogSyncResult {
  syncedAt: string;
  moduleCount: number;
  modules: string[];
  source: string;
}

export interface ModuleInstallerResult {
  jobId: string;
  action: ModuleInstallerAction;
  moduleSlug: string;
  version?: string;
  status: 'accepted' | 'running' | 'succeeded' | 'failed' | 'unknown';
  message: string | null;
  data?: Record<string, unknown>;
}

export interface RspamdPathProbe {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  error?: string;
}

export interface RspamdManagedFileState {
  path: string;
  exists: boolean;
  readable: boolean;
  writable: boolean;
  managed: boolean;
  managementEnabled: boolean;
  content: string | null;
}

export interface RspamdSettings {
  serviceId?: string | null;
  serviceName?: string | null;
  rspamdControllerUrl: string;
  rspamdNormalUrl: string;
  // The passwords are write-only: responses only say whether each is set.
  hasControllerPassword: boolean;
  hasEnablePassword: boolean;
  rspamdConfigDir: string;
  rspamdStoreDir: string;
  rspamdTrainingDir: string;
}

export interface RspamdManagedConfig {
  rspamdDkimEnabled: boolean;
  rspamdDkimPathTemplate: string;
  rspamdDkimSignAuthenticated: boolean;
  rspamdDkimSignLocal: boolean;
  rspamdDkimUseDomain: string;
  rspamdDkimTryFallback: boolean;
  rspamdDkimFallbackSelector: string;
  rspamdDkimCheckPubkey: boolean;
  rspamdDkimAllowPubkeyMismatch: boolean;
  rspamdBayesBackend: string;
  rspamdBayesRedisServers: string;
  rspamdBayesTokenizer: string;
  rspamdBayesMinLearns: number;
  rspamdBayesAutolearnEnabled: boolean;
  rspamdBayesSpamThreshold: number;
  rspamdBayesJunkThreshold: number | null;
  rspamdBayesHamThreshold: number;
  rspamdBayesCheckBalance: boolean;
  rspamdBayesMinBalance: number;
}

export interface RspamdStatus {
  available: boolean;
  enabled: boolean;
  controllerReachable: boolean;
  controllerAuthenticated: boolean;
  controllerStatusCode: number | null;
  controllerPingOk: boolean;
  controllerPingStatusCode: number | null;
  controllerHealthyOk: boolean;
  controllerHealthyStatusCode: number | null;
  controllerStatAuthOk: boolean;
  controllerStatStatusCode: number | null;
  normalWorkerPingOk: boolean;
  normalWorkerPingStatusCode: number | null;
  configDir: RspamdPathProbe;
  storeDir: RspamdPathProbe;
  trainingDir: RspamdPathProbe;
  reasons: string[];
  siblingSuggestion: {
    configDir: string;
    storeDir: string;
    trainingDir: string;
  } | null;
}

export interface RspamdManagedFileEntry {
  key: string;
  fileName: string;
  values: Record<string, unknown>;
  rendered: string;
  state: RspamdManagedFileState;
}

export interface RspamdConfigState {
  settings: RspamdSettings;
  managedConfig: RspamdManagedConfig;
  status: RspamdStatus;
  files: {
    dkim: RspamdManagedFileState;
    bayes: RspamdManagedFileState;
  };
  managedFiles: RspamdManagedFileEntry[];
}

export type RspamdAdvancedValueType = 'string' | 'number' | 'boolean' | 'stringList';
export type RspamdMultimapSourceType = 'local' | 'http' | 'https' | 'redis' | 'selector' | 'external';

export interface RspamdRulesAdvancedOption {
  id: string;
  key: string;
  valueType: RspamdAdvancedValueType;
  stringValue: string;
  numberValue: number | null;
  booleanValue: boolean;
  listValue: string[];
}

export interface RspamdActionThreshold {
  id: string;
  name: string;
  threshold: number;
  enabled: boolean;
  flags: string[];
  subject: string;
  growFactor: number | null;
  unknownWeight: number | null;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdSymbolRule {
  id: string;
  name: string;
  weight: number;
  description: string;
  oneShot: boolean;
  enabled: boolean;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdGroupRule {
  id: string;
  name: string;
  description: string;
  maxScore: number | null;
  minScore: number | null;
  enabled: boolean;
  options: RspamdRulesAdvancedOption[];
  symbols: RspamdSymbolRule[];
}

export interface RspamdSettingsCondition {
  authenticated: boolean | null;
  local: boolean | null;
  ips: string[];
  from: string[];
  rcpt: string[];
  domains: string[];
  headers: string[];
  selector: string;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdActionOverride {
  id: string;
  action: string;
  threshold: number;
}

export interface RspamdScoreOverride {
  id: string;
  name: string;
  score: number;
}

export interface RspamdSettingsApply {
  actionOverrides: RspamdActionOverride[];
  enableSymbols: string[];
  disableSymbols: string[];
  enableGroups: string[];
  disableGroups: string[];
  symbolScores: RspamdScoreOverride[];
  groupScores: RspamdScoreOverride[];
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdSettingsProfile {
  id: string;
  name: string;
  profileId: string;
  priority: number;
  enabled: boolean;
  description: string;
  conditions: RspamdSettingsCondition;
  apply: RspamdSettingsApply;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdCompositeRule {
  id: string;
  name: string;
  expression: string;
  description: string;
  score: number | null;
  policy: string;
  group: string;
  enabled: boolean;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdLocalMap {
  id: string;
  slug: string;
  name: string;
  description: string;
  content: string;
}

export interface RspamdMultimapSource {
  type: RspamdMultimapSourceType;
  localMapSlug: string;
  url: string;
  redisKey: string;
  selector: string;
  externalDefinition: string;
  backend: string;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdMultimapRule {
  id: string;
  name: string;
  ruleType: string;
  selector: string;
  description: string;
  score: number | null;
  oneShot: boolean;
  regexp: boolean;
  enabled: boolean;
  filter: string;
  source: RspamdMultimapSource;
  options: RspamdRulesAdvancedOption[];
}

export interface RspamdRulesDocument {
  actions: RspamdActionThreshold[];
  groups: RspamdGroupRule[];
  settingsProfiles: RspamdSettingsProfile[];
  composites: RspamdCompositeRule[];
  multimaps: RspamdMultimapRule[];
  localMaps: RspamdLocalMap[];
}

export interface RspamdRulesFileManagement {
  actions: boolean | null;
  groups: boolean | null;
  settings: boolean | null;
  composites: boolean | null;
  multimap: boolean | null;
}

export interface RspamdRulesValidationState {
  errors: string[];
  warnings: string[];
}

export interface RspamdRulesState {
  settings: RspamdSettings;
  status: RspamdStatus;
  fileManagement: RspamdRulesFileManagement;
  document: RspamdRulesDocument;
  files: {
    actions: RspamdManagedFileState;
    groups: RspamdManagedFileState;
    settings: RspamdManagedFileState;
    composites: RspamdManagedFileState;
    multimap: RspamdManagedFileState;
    localMaps: RspamdManagedFileState[];
  };
  validation: RspamdRulesValidationState;
}

export interface RspamdDkimDomain {
  id: number;
  domain: string;
  signDomain: string;
  enabled: boolean;
  autoRotateEnabled: boolean;
  rotateIntervalDays: number | null;
  retainOldDays: number;
  createdAt: string;
  updatedAt: string;
  activeSelector: string | null;
  activeSelectorActivatedAt: string | null;
}

export interface RspamdDkimSelector {
  id: number;
  domainId: number;
  selector: string;
  publicKeyTxt: string;
  publicKeyP: string;
  algorithm: string;
  keyBits: number;
  state: 'active' | 'retired' | 'revoked';
  /** False once a retired key has been purged. */
  hasPrivateKey: boolean;
  activatedAt: string;
  retiredAt: string | null;
  purgeAfter: string | null;
  privateKeyDeletedAt: string | null;
  createdAt: string;
}

export interface RspamdTrainingImportJob {
  id: number;
  sourceFilename: string | null;
  label: 'spam' | 'ham';
  status: 'processing' | 'completed' | 'failed';
  totalFiles: number;
  totalSamples: number;
  learnedSamples: number;
  errorCount: number;
  errors: string[];
  createdBy: number | null;
  createdAt: string;
  completedAt: string | null;
}

export interface RspamdTrainingSample {
  id: number;
  importId: number | null;
  filename: string;
  contentHash: string;
  label: 'spam' | 'ham';
  sourceType: 'eml' | 'mbox' | 'archive';
  storedRelpath: string;
  sizeBytes: number;
  learnStatus: 'pending' | 'learned' | 'failed';
  learnError: string | null;
  createdAt: string;
  learnedAt: string | null;
  relabeledAt: string | null;
}

export interface RspamdFuzzyPreset {
  id: string;
  label: string;
  flag: number;
  weight: number;
}

export interface RspamdClassifierStatusEntry {
  symbol: string;
  type: string;
  revision: number | null;
  size: number | null;
  users: number | null;
  languages: string[];
}

export interface RspamdClassifierSummary {
  serviceId: string | null;
  defaultTransport: 'checkv2' | 'checkv3';
  defaultClassifier: string;
  controllerReachable: boolean;
  controllerAuthenticated: boolean;
  normalWorkerReachable: boolean;
  fuzzyPresets: RspamdFuzzyPreset[];
  statfiles: RspamdClassifierStatusEntry[];
  learnedMessages: number | null;
  symbolsByType: string[];
}

export interface RspamdScanRequestMetadata {
  envelopeFrom: string;
  recipients: string[];
  clientIp: string;
  helo: string;
  hostname: string;
  authenticatedUser: string;
  settingsId: string;
  queueId: string;
}

export interface RspamdScanRunSummary {
  id: number;
  serviceId: string;
  actorAdminId: number | null;
  parentRunId: number | null;
  transport: 'checkv2' | 'checkv3';
  sourceMode: 'raw' | 'upload' | 'replay';
  sourceFileName: string | null;
  messageHash: string;
  rawMessageRelpath: string | null;
  messageSizeBytes: number;
  metadata: RspamdScanRequestMetadata;
  summaryAction: string | null;
  summaryScore: number | null;
  summaryRequiredScore: number | null;
  summarySymbols: string[];
  isSkipped: boolean;
  createdAt: string;
}

export interface RspamdScanActionRecord {
  id: number;
  runId: number;
  serviceId: string;
  actorAdminId: number | null;
  actionType: 'learn_spam' | 'learn_ham' | 'fuzzy_add' | 'fuzzy_remove';
  details: Record<string, unknown>;
  createdAt: string;
}

export interface RspamdScanRunDetail extends RspamdScanRunSummary {
  result: Record<string, unknown>;
  actions: RspamdScanActionRecord[];
  rawMessage: string;
}

// DMARC types
export interface DmarcReporter {
  id: number;
  name: string;
  displayName: string;
  reportCount: number;
}

export interface DmarcReport {
  id: number;
  reportId: string;
  reporterId: number;
  reporterName?: string;
  orgName: string;
  email: string;
  domain: string;
  dateBegin: string;
  dateEnd: string;
  policy: string;
  subdomainPolicy: string;
  dkimAlignment: string;
  spfAlignment: string;
  pct: number;
  totalCount: number;
  errorCount: number;
  createdAt: string;
}

export interface DmarcRecord {
  id: number;
  reportId: number;
  sourceIp: string;
  count: number;
  disposition: string;
  dkim: string;
  spf: string;
  reasonType: string;
  reasonComment: string;
  headerFrom: string;
  envelopeFrom: string;
  envelopeTo: string;
  dkimDomain: string;
  dkimResult: string;
  dkimSelector: string;
  spfDomain: string;
  spfResult: string;
  spfScope: string;
  recordType: number;
}

export interface DmarcChartData {
  date: string;
  values: number[];
}

export interface DmarcStats {
  totalReports: number;
  totalMessages: number;
  errorMessages: number;
  recentReports: number;
  last30Days: number;
}

export interface DmarcReportDetail {
  report: DmarcReport;
  records: DmarcRecord[];
  summary: { type: number; count: number; msgCount: number }[];
}

// Per-record bucket labels for the DMARC raw report tabs. Mirror
// SenderClassification: own_server requires FCrDNS+PSL alignment with
// the report domain, authorized means in the SPF record, forwarders
// split by DKIM compliance, unknown is everything else.
export const RECORD_TYPE_LABELS = [
  'Own servers',           // 0 — FCrDNS aligns with report domain's org
  'Authorized',            // 1 — IP is in the report domain's SPF
  'DKIM Forwarders',       // 2 — DKIM-aligned pass without SPF (compliant)
  'Suspicious forwarders', // 3 — Forwarder pattern with broken DKIM
  'Unknown',               // 4 — Spoofers / impersonators / unclassified
];

export const RECORD_TYPE_COLORS = [
  '#059669', // Emerald — own servers
  '#3B82F6', // Blue    — authorized
  '#06B6D4', // Cyan    — DKIM forwarders
  '#F97316', // Orange  — suspicious forwarders
  '#EF4444', // Red     — unknown
];

// DMARC chart series — the four DMARC-standard classes, matching
// server/db/queries/dmarc.ts getChartData. Compliant + benign_relay together
// account for mail nobody should chase; actionable is the number that matters.
export const DMARC_CHART_LABELS = [
  'Compliant',
  'Authenticated (unaligned)',
  'Benign relay (forwarded)',
  'Actionable failure',
];

export const DMARC_CHART_COLORS = [
  '#059669', // Emerald — compliant
  '#3B82F6', // Blue    — authenticated but unaligned
  '#06B6D4', // Cyan    — forwarding / mailing list
  '#EF4444', // Red     — actionable
];

// Robin Configuration
export interface RobinConfigEntry {
  serverId: string;
  fileName: string;
  config: Record<string, unknown>;
  updatedAt: string;
  sha256: string;
}

// TLSRPT (TLS Reporting) types
export interface TlsrptReport {
  id: number;
  report_id: string;
  organization_name: string | null;
  contact_info: string | null;
  date_begin: string;
  date_end: string;
  total_success: number;
  total_failure: number;
  created_at: string;
}

export interface TlsrptPolicy {
  id: number;
  report_id: number;
  policy_type: string;
  policy_domain: string;
  policy_string: string[] | null;
  mx_host: string | null;
  success_count: number;
  failure_count: number;
  failures: TlsrptFailure[];
}

export interface TlsrptFailure {
  id: number;
  policy_id: number;
  result_type: string;
  sending_mta_ip: string | null;
  receiving_mx_hostname: string | null;
  receiving_ip: string | null;
  failed_session_count: number;
  failure_reason_code: string | null;
  additional_info: string | null;
}

export interface TlsrptReportDetail {
  report: TlsrptReport;
  policies: TlsrptPolicy[];
}

export interface TlsrptChartData {
  date: string;
  success: number;
  failure: number;
}

export interface TlsrptStats {
  totalReports: number;
  last24Hours: number;
  last30Days: number;
  totalSuccess: number;
  totalFailure: number;
  topFailureTypes: { type: string; count: number }[];
}

export interface TlsrptDomain {
  domain: string;
  count: number;
}

// Forensic (AFRF) types
export interface ForensicReport {
  id: number;
  feedback_type: string;
  user_agent: string | null;
  original_mail_from: string | null;
  original_rcpt_to: string | null;
  received_date: string | null;
  source_ip: string | null;
  reported_domain: string | null;
  auth_failure: string | null;
  authentication_results: string | null;
  delivery_result: string | null;
  incidents: number;
  dkim_domain: string | null;
  subject: string | null;
  created_at: string;
  // Full detail fields
  version?: string | null;
  reported_uri?: string[] | null;
  original_envelope_id?: string | null;
  dkim_selector?: string | null;
  dkim_identity?: string | null;
  spf_dns?: string | null;
  arrival_date?: string | null;
  original_headers?: string | null;
}

export interface ForensicChartData {
  label: string;
  count: number;
}

export interface ForensicStats {
  totalReports: number;
  last24Hours: number;
  last30Days: number;
  byFeedbackType: { type: string; count: number }[];
  byAuthFailure: { type: string; count: number }[];
  topDomains: { domain: string; count: number }[];
  topSourceIps: { ip: string; count: number }[];
}

// Robin Metrics types
export interface MetricsSnapshot {
  timestamp: string;
  // Email counters
  emailReceiptStart: number;
  emailReceiptSuccess: number;
  emailReceiptLimit: number;
  emailReceiptException: number;
  // Rejections
  rblRejections: number;
  virusRejections: number;
  spamRejections: number;
  // DoS
  dosRatelimitRejections: number;
  dosConnlimitRejections: number;
  dosTarpitCount: number;
  dosSlowtransferRejections: number;
  dosCommandfloodRejections: number;
  // Other
  whitelistBypasses: number;
  adaptiveRatelimitApplied: number;
  geoipBlockRejections: number;
  geoipLimitApplied: number;
  distributedStoreErrors: number;
  // JVM Memory
  jvmMemoryUsed: number;
  jvmMemoryMax: number;
  jvmMemoryCommitted: number;
  // JVM Threads
  jvmThreadsLive: number;
  jvmThreadsDaemon: number;
  jvmThreadsPeak: number;
  jvmThreadsStarted: number;
  // JVM GC
  jvmGcPauseSeconds: number;
  jvmGcPauseCount: number;
  jvmGcMemoryAllocated: number;
  jvmGcMemoryPromoted: number;
  jvmGcLiveDataSize: number;
  jvmGcMaxDataSize: number;
  // JVM Buffers
  jvmBufferCount: number;
  jvmBufferMemoryUsed: number;
  jvmBufferTotalCapacity: number;
  // System
  cpuUsage: number;
  processCpuUsage: number;
  systemCpuCount: number;
  systemLoadAverage: number;
  // Computed
  totalRejections?: number;
  memoryPct?: number;
  // Rates
  rateEmailStart?: number;
  rateEmailSuccess?: number;
  rateRejections?: number;
  deliveryRate?: number;
  rejectionRate?: number;
}

export interface MetricsStats {
  serviceType?: FleetServiceType;
  serviceId?: string | null;
  live: {
    memoryUsedMB: number;
    memoryMaxMB: number;
    memoryPct: number;
    threads: number;
    cpuPct: number;
    totalReceived: number;
    totalDelivered: number;
    totalRejected: number;
  } | null;
  rates: {
    deliveryRate: number;
    rejectionRate: number;
  } | null;
  totals24h: {
    delivered: number;
    rejected: number;
  };
  historyCount: number;
}

export interface RobinFleetMetrics {
  serviceId: string | null;
  serviceType: 'robin';
  memoryUsedMB: number;
  memoryMaxMB: number;
  memoryCommittedMB: number;
  memoryPct: number;
  threads: number;
  threadsDaemon: number;
  threadsPeak: number;
  threadsStarted: number;
  cpuPct: number;
  processCpuPct: number;
  cpuCount: number;
  loadAverage: number;
  gcPauseSeconds: number;
  gcPauseCount: number;
  gcMemoryAllocatedMB: number;
  gcMemoryPromotedMB: number;
  gcLiveDataMB: number;
  bufferCount: number;
  bufferMemoryMB: number;
  totalReceived: number;
  totalDelivered: number;
  totalLimited: number;
  totalExceptions: number;
  rblRejections: number;
  virusRejections: number;
  spamRejections: number;
  totalRejected: number;
  dosRatelimit: number;
  dosConnlimit: number;
  dosTarpit: number;
  dosSlowTransfer: number;
  dosCommandFlood: number;
  totalDosBlocked: number;
  whitelistBypasses: number;
  adaptiveRatelimit: number;
  geoipBlocked: number;
  geoipLimited: number;
  distributedErrors: number;
  received24h: number;
  delivered24h: number;
  rejected24h: number;
  rblRejected24h: number;
  virusRejected24h: number;
  spamRejected24h: number;
  dosBlocked24h: number;
}

export interface RspamdActionBreakdown {
  addHeader: number;
  reject: number;
  softReject: number;
  greylist: number;
  noAction: number;
  rewriteSubject: number;
  discard: number;
  quarantine: number;
}

export interface RspamdFleetMetrics {
  serviceId: string | null;
  serviceType: 'rspamd';
  controllerReachable: boolean;
  controllerAuthenticated: boolean;
  controllerHealthy: boolean;
  controllerStatusCode: number | null;
  normalWorkerPingOk: boolean;
  scannedMessages: number;
  spamMessages: number;
  hamMessages: number;
  learnedSpam: number;
  learnedHam: number;
  totalActions: number;
  actionBreakdown: RspamdActionBreakdown;
  connections: number;
  uptimeSeconds: number;
  memoryAllocatedMB: number;
  memoryResidentMB: number;
  scanned24h: number;
  spam24h: number;
  ham24h: number;
  learnedSpam24h: number;
  learnedHam24h: number;
  actionBreakdown24h: RspamdActionBreakdown;
  totalActions24h: number;
}

export interface ClamavFleetMetrics {
  serviceId: string | null;
  serviceType: 'clamav';
  pingOk: boolean;
  versionText: string | null;
  engineVersion: string | null;
  databaseVersion: number | null;
  databaseUpdatedAt: string | null;
  statusText: string | null;
  pools: number;
  threadsLive: number;
  threadsIdle: number;
  threadsMax: number;
  queueItems: number;
  memoryHeapMB: number;
  memoryMmapMB: number;
  memoryUsedMB: number;
  memoryFreeMB: number;
  memoryReleasableMB: number;
  memoryPoolsUsedMB: number;
  memoryPoolsTotalMB: number;
  rawStats: string;
  peakQueue24h: number;
  peakMemoryMB24h: number;
  unhealthySamples24h: number;
}

export interface DovecotFleetMetrics {
  serviceId: string | null;
  serviceType: 'dovecot';
  reachable: boolean;
  authSuccess: number;
  authFailure: number;
  loginCount: number;
  imapCommands: number;
  mailDeliveries: number;
  sessionCount: number;
  userCount: number;
  logins24h: number;
  authSuccess24h: number;
  authFailure24h: number;
  imapCommands24h: number;
  mailDeliveries24h: number;
  peakSessions24h: number;
  unreachableSamples24h: number;
}

export interface PostfixFleetMetrics {
  serviceId: string | null;
  serviceType: 'postfix';
  reachable: boolean;
  queueActive: number;
  queueDeferred: number;
  queueHold: number;
  queueIncoming: number;
  queueTotal: number;
  oldestDeferredAgeSecs: number;
  /** Delivered/deferred/bounced/rejected come from the service's log stream. */
  messageCounters: boolean;
  delivered24h: number;
  deferred24h: number;
  bounced24h: number;
  rejected24h: number;
  peakQueue24h: number;
  peakDeferred24h: number;
  maxDeferredAgeSecs24h: number;
  unreachableSamples24h: number;
}

export interface RedisFleetMetrics {
  serviceId: string | null;
  serviceType: 'redis';
  reachable: boolean;
  role: string;
  uptimeSecs: number;
  connectedClients: number;
  blockedClients: number;
  maxClients: number;
  memoryUsedBytes: number;
  memoryPeakBytes: number;
  memoryRssBytes: number;
  maxMemoryBytes: number;
  memFragmentationRatio: number;
  evictedKeys: number;
  expiredKeys: number;
  keyspaceHits: number;
  keyspaceMisses: number;
  hitRatio: number;
  instantaneousOpsPerSec: number;
  totalCommandsProcessed: number;
  totalConnectionsReceived: number;
  rejectedConnections: number;
  connectedSlaves: number;
  masterLinkStatus: string;
  dbKeys: number;
  dbExpires: number;
  pubsubChannels: number;
  opsProcessed24h: number;
  evictedKeys24h: number;
  expiredKeys24h: number;
  peakMemoryUsedBytes24h: number;
  peakConnectedClients24h: number;
  unreachableSamples24h: number;
}

export interface PostgresFleetMetrics {
  serviceId: string | null;
  serviceType: 'postgres';
  reachable: boolean;
  serverVersionNum: number;
  connectionsTotal: number;
  connectionsActive: number;
  connectionsIdle: number;
  connectionsIdleInTxn: number;
  connectionsWaiting: number;
  maxConnections: number;
  connectionSaturationPct: number;
  xactCommit: number;
  xactRollback: number;
  /** 0..1 */
  commitRatio: number;
  /** 0..1 */
  cacheHitRatio: number;
  deadlocks: number;
  tempFiles: number;
  tempBytes: number;
  databaseSizeBytes: number;
  oldestXactAgeSecs: number;
  oldestIdleInTxnSecs: number;
  blockedQueries: number;
  deadTuplesTotal: number;
  replicationLagBytes: number;
  xactCommit24h: number;
  xactRollback24h: number;
  deadlocks24h: number;
  tempFiles24h: number;
  tempBytes24h: number;
  peakConnectionsTotal24h: number;
  peakConnectionSaturationPct24h: number;
  unreachableSamples24h: number;
}

export interface MariadbFleetMetrics {
  serviceId: string | null;
  serviceType: 'mariadb';
  reachable: boolean;
  version: string;
  threadsConnected: number;
  threadsRunning: number;
  maxConnections: number;
  connectionSaturationPct: number;
  /** 0..1 */
  bufferPoolHitRatio: number;
  trxActive: number;
  oldestTrxAgeSecs: number;
  trxLockWaits: number;
  databaseSizeBytes: number | null;
  schemaCount: number;
  isReplica: boolean;
  secondsBehindSource: number | null;
  questions24h: number;
  commits24h: number;
  rollbacks24h: number;
  slowQueries24h: number;
  deadlocks24h: number;
  rowLockWaits24h: number;
  peakThreadsConnected24h: number;
  peakConnectionSaturationPct24h: number;
  peakOldestTrxAgeSecs24h: number;
  unreachableSamples24h: number;
}

export interface RobinFleetDashboardService {
  serviceId: string;
  serviceType: 'robin';
  name: string;
  healthy: boolean;
  metrics: RobinFleetMetrics | null;
}

export interface RspamdFleetDashboardService {
  serviceId: string;
  serviceType: 'rspamd';
  name: string;
  healthy: boolean;
  metrics: RspamdFleetMetrics | null;
}

export interface ClamavFleetDashboardService {
  serviceId: string;
  serviceType: 'clamav';
  name: string;
  healthy: boolean;
  metrics: ClamavFleetMetrics | null;
}

export interface DovecotFleetDashboardService {
  serviceId: string;
  serviceType: 'dovecot';
  name: string;
  healthy: boolean;
  metrics: DovecotFleetMetrics | null;
}

export interface PostfixFleetDashboardService {
  serviceId: string;
  serviceType: 'postfix';
  name: string;
  healthy: boolean;
  metrics: PostfixFleetMetrics | null;
}

export interface RedisFleetDashboardService {
  serviceId: string;
  serviceType: 'redis';
  name: string;
  healthy: boolean;
  metrics: RedisFleetMetrics | null;
}

export interface PostgresFleetDashboardService {
  serviceId: string;
  serviceType: 'postgres';
  name: string;
  healthy: boolean;
  metrics: PostgresFleetMetrics | null;
}

export interface MariadbFleetDashboardService {
  serviceId: string;
  serviceType: 'mariadb';
  name: string;
  healthy: boolean;
  metrics: MariadbFleetMetrics | null;
}

export type FleetDashboardService = RobinFleetDashboardService | RspamdFleetDashboardService | ClamavFleetDashboardService | DovecotFleetDashboardService | PostfixFleetDashboardService | RedisFleetDashboardService | PostgresFleetDashboardService | MariadbFleetDashboardService;

export interface RobinFleetTotals {
  totalInstances: number;
  healthyInstances: number;
  totalReceived: number;
  totalDelivered: number;
  totalRejected: number;
  received24h: number;
  delivered24h: number;
  rejected24h: number;
  avgMemoryPct: number;
  avgCpuPct: number;
  rejectionBreakdown24h: {
    rbl: number;
    virus: number;
    spam: number;
    dos: number;
  };
}

export interface RspamdFleetTotals {
  totalServices: number;
  healthyServices: number;
  totalScanned: number;
  totalSpam: number;
  totalHam: number;
  scanned24h: number;
  spam24h: number;
  ham24h: number;
  learnedSpam24h: number;
  learnedHam24h: number;
  totalActions24h: number;
  avgMemoryResidentMB: number;
  avgConnections: number;
  actionBreakdown24h: RspamdActionBreakdown;
}

export interface ClamavFleetTotals {
  totalServices: number;
  healthyServices: number;
  availableServices: number;
  queueItems: number;
  peakQueue24h: number;
  avgMemoryUsedMB: number;
  staleDatabaseServices: number;
  unhealthySamples24h: number;
  versions: string[];
}

export interface DovecotFleetTotals {
  totalServices: number;
  healthyServices: number;
  availableServices: number;
  sessions: number;
  users: number;
  logins24h: number;
  authSuccess24h: number;
  authFailure24h: number;
  imapCommands24h: number;
  mailDeliveries24h: number;
  peakSessions24h: number;
  unreachableSamples24h: number;
}

export interface PostfixFleetTotals {
  totalServices: number;
  healthyServices: number;
  availableServices: number;
  queueActive: number;
  queueDeferred: number;
  queueHold: number;
  queueIncoming: number;
  queueTotal: number;
  messageCounters: boolean;
  delivered24h: number;
  deferred24h: number;
  bounced24h: number;
  rejected24h: number;
  peakQueue24h: number;
  peakDeferred24h: number;
  maxDeferredAgeSecs: number;
  unreachableSamples24h: number;
}

export interface RedisFleetTotals {
  totalServices: number;
  healthyServices: number;
  availableServices: number;
  connectedClients: number;
  memoryUsedBytes: number;
  hitRatio: number;
  opsProcessed24h: number;
  evictedKeys24h: number;
  peakMemoryUsedBytes24h: number;
  peakConnectedClients24h: number;
  unreachableSamples24h: number;
}

export interface PostgresFleetTotals {
  totalServices: number;
  healthyServices: number;
  availableServices: number;
  connectionsTotal: number;
  cacheHitRatio: number;
  xactCommit24h: number;
  xactRollback24h: number;
  deadlocks24h: number;
  databaseSizeBytes: number;
  peakConnectionSaturationPct24h: number;
  unreachableSamples24h: number;
}

export interface MariadbFleetTotals {
  totalServices: number;
  healthyServices: number;
  availableServices: number;
  threadsConnected: number;
  threadsRunning: number;
  /** 0..1, averaged over services with metrics */
  bufferPoolHitRatio: number;
  databaseSizeBytes: number;
  trxLockWaits: number;
  maxOldestTrxAgeSecs: number;
  questions24h: number;
  commits24h: number;
  slowQueries24h: number;
  deadlocks24h: number;
  peakThreadsConnected24h: number;
  peakConnectionSaturationPct24h: number;
  unreachableSamples24h: number;
}

export interface FleetDashboard {
  fleet: RobinFleetTotals;
  overview: {
    totalServices: number;
    healthyServices: number;
    byType: {
      robin: {
        totalServices: number;
        healthyServices: number;
        totals: RobinFleetTotals;
      };
      rspamd: {
        totalServices: number;
        healthyServices: number;
        totals: RspamdFleetTotals;
      };
      clamav: {
        totalServices: number;
        healthyServices: number;
        totals: ClamavFleetTotals;
      };
      dovecot: {
        totalServices: number;
        healthyServices: number;
        totals: DovecotFleetTotals;
      };
      postfix: {
        totalServices: number;
        healthyServices: number;
        totals: PostfixFleetTotals;
      };
      redis: {
        totalServices: number;
        healthyServices: number;
        totals: RedisFleetTotals;
      };
      postgres: {
        totalServices: number;
        healthyServices: number;
        totals: PostgresFleetTotals;
      };
      mariadb: {
        totalServices: number;
        healthyServices: number;
        totals: MariadbFleetTotals;
      };
    };
  };
  services: FleetDashboardService[];
  topServices: FleetDashboardService[];
  byType: {
    robin: RobinFleetDashboardService[];
    rspamd: RspamdFleetDashboardService[];
    clamav: ClamavFleetDashboardService[];
    dovecot: DovecotFleetDashboardService[];
    postfix: PostfixFleetDashboardService[];
    redis: RedisFleetDashboardService[];
    postgres: PostgresFleetDashboardService[];
    mariadb: MariadbFleetDashboardService[];
  };
}

export interface RspamdMetricsSnapshot {
  serviceId: string | null;
  serviceType: 'rspamd';
  timestamp: string;
  controllerReachable: boolean;
  controllerAuthenticated: boolean;
  controllerStatusCode: number | null;
  controllerPingOk: boolean;
  controllerPingStatusCode: number | null;
  controllerHealthyOk: boolean;
  controllerHealthyStatusCode: number | null;
  controllerStatAuthenticated: boolean;
  controllerStatStatusCode: number | null;
  normalWorkerPingOk: boolean;
  normalWorkerPingStatusCode: number | null;
  scannedMessages: number;
  learnedSpam: number;
  learnedHam: number;
  actionsAddHeader: number;
  actionsReject: number;
  actionsSoftReject: number;
  actionsGreylist: number;
  actionsNoAction: number;
  actionsRewriteSubject: number;
  actionsDiscard: number;
  actionsQuarantine: number;
  spamMessages: number;
  hamMessages: number;
  connections: number;
  uptimeSeconds: number;
  memoryAllocatedBytes: number;
  memoryResidentBytes: number;
  rawMetrics?: Record<string, unknown>;
  totalActions?: number;
  actionBreakdown?: RspamdActionBreakdown;
}

export interface ClamavMetricsSnapshot {
  serviceId: string | null;
  serviceType: 'clamav';
  timestamp: string;
  pingOk: boolean;
  versionText: string | null;
  engineVersion: string | null;
  databaseVersion: number | null;
  databaseUpdatedAt: string | null;
  statusText: string | null;
  pools: number;
  threadsLive: number;
  threadsIdle: number;
  threadsMax: number;
  queueItems: number;
  memoryHeapMB: number;
  memoryMmapMB: number;
  memoryUsedMB: number;
  memoryFreeMB: number;
  memoryReleasableMB: number;
  memoryPoolsUsedMB: number;
  memoryPoolsTotalMB: number;
  rawStats: string;
}

export interface DovecotMetricsSnapshot {
  serviceId: string | null;
  serviceType: 'dovecot';
  timestamp: string;
  reachable: boolean;
  authSuccess: number;
  authFailure: number;
  loginCount: number;
  imapCommands: number;
  mailDeliveries: number;
  sessionCount: number;
  userCount: number;
  rawStats: string;
}

export interface PostfixMetricsSnapshot {
  serviceId: string | null;
  serviceType: 'postfix';
  timestamp: string;
  reachable: boolean;
  queueActive: number;
  queueDeferred: number;
  queueHold: number;
  queueIncoming: number;
  queueTotal: number;
  oldestDeferredAgeSecs: number;
  messagesDelivered: number;
  messagesDeferred: number;
  messagesBounced: number;
  messagesRejected: number;
  rawStats: string;
}

export interface RedisMetricsSnapshot {
  serviceId: string | null;
  serviceType: 'redis';
  timestamp: string;
  reachable: boolean;
  role: string;
  uptimeSecs: number;
  connectedClients: number;
  blockedClients: number;
  maxClients: number;
  memoryUsedBytes: number;
  memoryPeakBytes: number;
  memoryRssBytes: number;
  maxMemoryBytes: number;
  memFragmentationRatio: number;
  evictedKeys: number;
  expiredKeys: number;
  keyspaceHits: number;
  keyspaceMisses: number;
  hitRatio: number;
  instantaneousOpsPerSec: number;
  totalCommandsProcessed: number;
  totalConnectionsReceived: number;
  rejectedConnections: number;
  totalNetInputBytes: number;
  totalNetOutputBytes: number;
  connectedSlaves: number;
  masterLinkStatus: string;
  rdbChangesSinceLastSave: number;
  rdbLastSaveTime: number;
  rdbLastBgsaveStatus: string;
  aofEnabled: boolean;
  aofLastWriteStatus: string;
  dbKeys: number;
  dbExpires: number;
  pubsubChannels: number;
  rawInfo: string;
}

export interface PostgresMetricsSnapshot {
  serviceId: string | null;
  serviceType: 'postgres';
  timestamp: string;
  reachable: boolean;
  serverVersionNum: number;
  connectionsTotal: number;
  connectionsActive: number;
  connectionsIdle: number;
  connectionsIdleInTxn: number;
  connectionsWaiting: number;
  maxConnections: number;
  connectionSaturationPct: number;
  xactCommit: number;
  xactRollback: number;
  commitRatio: number;
  blksHit: number;
  blksRead: number;
  cacheHitRatio: number;
  tupReturned: number;
  tupFetched: number;
  tupInserted: number;
  tupUpdated: number;
  tupDeleted: number;
  deadlocks: number;
  tempFiles: number;
  tempBytes: number;
  conflicts: number;
  databaseSizeBytes: number;
  oldestXactAgeSecs: number;
  oldestIdleInTxnSecs: number;
  blockedQueries: number;
  checkpointsTimed: number;
  checkpointsReq: number;
  buffersCheckpoint: number;
  replicationLagBytes: number;
  deadTuplesTotal: number;
  rawStats: string;
}

export interface MariadbMetricsSnapshot {
  serviceId: string | null;
  serviceType: 'mariadb';
  timestamp: string;
  reachable: boolean;
  version: string;
  uptimeSecs: number;
  threadsConnected: number;
  threadsRunning: number;
  threadsCached: number;
  maxConnections: number;
  maxUsedConnections: number;
  connectionSaturationPct: number;
  abortedConnects: number;
  abortedClients: number;
  questions: number;
  comSelect: number;
  comInsert: number;
  comUpdate: number;
  comDelete: number;
  comCommit: number;
  comRollback: number;
  slowQueries: number;
  bytesReceived: number;
  bytesSent: number;
  bufferPoolReadRequests: number;
  bufferPoolReads: number;
  /** 0..1 */
  bufferPoolHitRatio: number;
  bufferPoolPagesTotal: number;
  bufferPoolPagesFree: number;
  bufferPoolPagesDirty: number;
  rowLockWaits: number;
  rowLockTimeMs: number;
  deadlocks: number;
  historyListLength: number;
  trxActive: number;
  oldestTrxAgeSecs: number;
  trxLockWaits: number;
  createdTmpDiskTables: number;
  createdTmpTables: number;
  openedTables: number;
  schemaCount: number;
  databaseSizeBytes: number | null;
  isReplica: boolean;
  replicaIoRunning: boolean;
  replicaSqlRunning: boolean;
  secondsBehindSource: number | null;
  rawStats: string;
}

export interface MariadbMetricsStats {
  serviceType: 'mariadb';
  serviceId: string | null;
  live: {
    reachable: boolean;
    version: string;
    threadsConnected: number;
    threadsRunning: number;
    maxConnections: number;
    connectionSaturationPct: number;
    bufferPoolHitRatio: number;
    trxActive: number;
    oldestTrxAgeSecs: number;
    trxLockWaits: number;
    databaseSizeBytes: number | null;
    schemaCount: number;
    isReplica: boolean;
    secondsBehindSource: number | null;
  } | null;
  totals24h: {
    questions: number;
    comCommit: number;
    comRollback: number;
    comInsert: number;
    comUpdate: number;
    comDelete: number;
    slowQueries: number;
    deadlocks: number;
    rowLockWaits: number;
    abortedConnects: number;
    createdTmpDiskTables: number;
    peakThreadsConnected: number;
    peakConnectionSaturationPct: number;
    peakOldestTrxAgeSecs: number;
    unreachableSamples: number;
  };
  historyCount: number;
}

export interface RspamdMetricsStats {
  serviceType: 'rspamd';
  serviceId: string | null;
  live: {
    controllerReachable: boolean;
    controllerAuthenticated: boolean;
    normalWorkerPingOk: boolean;
    scannedMessages: number;
    spamMessages: number;
    hamMessages: number;
    learnedSpam: number;
    learnedHam: number;
    connections: number;
    uptimeSeconds: number;
    memoryAllocatedMB: number;
    memoryResidentMB: number;
    totalActions: number;
    actionBreakdown: RspamdActionBreakdown;
  } | null;
  totals24h: {
    scanned: number;
    spam: number;
    ham: number;
    learnedSpam: number;
    learnedHam: number;
    actions: RspamdActionBreakdown;
    totalActions: number;
  };
  historyCount: number;
}

export interface ClamavMetricsStats {
  serviceType: 'clamav';
  serviceId: string | null;
  live: {
    pingOk: boolean;
    engineVersion: string | null;
    databaseVersion: number | null;
    databaseUpdatedAt: string | null;
    statusText: string | null;
    pools: number;
    queueItems: number;
    threadsLive: number;
    threadsIdle: number;
    threadsMax: number;
    memoryUsedMB: number;
    memoryHeapMB: number;
    memoryMmapMB: number;
    memoryFreeMB: number;
    memoryReleasableMB: number;
    memoryPoolsUsedMB: number;
    memoryPoolsTotalMB: number;
  } | null;
  totals24h: {
    queueDelta: number;
    peakQueue: number;
    peakMemoryMB: number;
    unhealthySamples: number;
  };
  historyCount: number;
}

export interface DovecotMetricsStats {
  serviceType: 'dovecot';
  serviceId: string | null;
  live: {
    reachable: boolean;
    authSuccess: number;
    authFailure: number;
    loginCount: number;
    imapCommands: number;
    mailDeliveries: number;
    sessionCount: number;
    userCount: number;
  } | null;
  totals24h: {
    logins: number;
    authSuccess: number;
    authFailure: number;
    imapCommands: number;
    mailDeliveries: number;
    peakSessions: number;
    unreachableSamples: number;
  };
  historyCount: number;
}

export interface PostfixMetricsStats {
  serviceType: 'postfix';
  serviceId: string | null;
  live: {
    reachable: boolean;
    queueActive: number;
    queueDeferred: number;
    queueHold: number;
    queueIncoming: number;
    queueTotal: number;
    oldestDeferredAgeSecs: number;
  } | null;
  totals24h: {
    peakQueue: number;
    peakDeferred: number;
    maxDeferredAgeSecs: number;
    unreachableSamples: number;
    delivered: number;
    deferred: number;
    bounced: number;
    rejected: number;
  };
  historyCount: number;
}

export interface PostfixQueueMessage {
  queueId: string;
  queueName: string;
  arrivalTime: string | null;
  size: number;
  sender: string;
  recipients: Array<{ address: string; delayReason: string | null }>;
  forcedExpire: boolean;
}

export type PostfixQueueAction = 'hold' | 'release' | 'requeue' | 'delete';

export interface DovecotSession {
  user: string;
  service: string;
  pid: string;
  ip: string;
  destIp: string;
}

export interface DovecotQuotaResult {
  available: boolean;
  reason: string | null;
  rows: Array<{ user: string; quotaName: string; type: string; value: number; limit: number | null; percent: number }>;
}

export interface DovecotUserLookup {
  user: string;
  exists: boolean;
  fields: Record<string, string>;
  quota: DovecotQuotaResult | null;
}

export interface RedisMetricsStats {
  serviceType: 'redis';
  serviceId: string | null;
  live: {
    reachable: boolean;
    role: string;
    connectedClients: number;
    blockedClients: number;
    memoryUsedBytes: number;
    memoryPeakBytes: number;
    hitRatio: number;
    instantaneousOpsPerSec: number;
    evictedKeys: number;
    expiredKeys: number;
    dbKeys: number;
    dbExpires: number;
    connectedSlaves: number;
  } | null;
  totals24h: {
    opsProcessed: number;
    evictedKeys: number;
    expiredKeys: number;
    peakMemoryUsedBytes: number;
    peakConnectedClients: number;
    unreachableSamples: number;
  };
  historyCount: number;
}

export interface PostgresMetricsStats {
  serviceType: 'postgres';
  serviceId: string | null;
  live: {
    reachable: boolean;
    connectionsTotal: number;
    connectionsActive: number;
    connectionsIdle: number;
    maxConnections: number;
    connectionSaturationPct: number;
    cacheHitRatio: number;
    commitRatio: number;
    deadTuplesTotal: number;
    blockedQueries: number;
    databaseSizeBytes: number;
  } | null;
  totals24h: {
    xactCommit: number;
    xactRollback: number;
    deadlocks: number;
    tempFiles: number;
    tempBytes: number;
    peakConnectionsTotal: number;
    peakConnectionSaturationPct: number;
    unreachableSamples: number;
  };
  historyCount: number;
}

export interface ClamavScanResult {
  serviceId: string;
  serviceName: string | null;
  fileName: string;
  sizeBytes: number;
  clean: boolean;
  infected: boolean;
  viruses: string[];
  rawResponse: string;
  durationMs: number;
  scannedAt: string;
}

export * from './alerts';
