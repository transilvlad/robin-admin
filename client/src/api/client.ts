/**
 * API client for Robin Admin backend.
 * 
 * This module provides typed API methods for all Robin Admin endpoints.
 * All methods return promises that resolve to typed response objects.
 * 
 * Usage:
 *   import { authApi, usersApi } from './api/client';
 *   const user = await authApi.login(email, password);
 *   const users = await usersApi.list(1, 50);
 * 
 * Error Handling:
 *   API errors throw ApiError with status code and message.
 *   Use try/catch to handle errors in components.
 * 
 * Authentication:
 *   Credentials are sent via cookies (credentials: 'include').
 *   JWT token is managed by AuthContext, not this module.
 */

import type {
  TelemetryAlertIssue,
  TelemetryAlertIssueStatus,
  TelemetryAlertPreview,
  TelemetryAlertRule,
  TelemetryAlertRuleInput,
} from '../types/telemetry-alerts';
import type {
  ApiResponse,
  PaginatedResponse,
  Admin,
  AdminConfig,
  RuntimeConfig,
  AdminRole,
  MailUser,
  Alias,
  QueueItem,
   AuditLogEntry,
   AdminModule,
   ClamavFleetMetrics,
  CurrentUser,
  ClamavConfigState,
  ClamavMetricsSnapshot,
  ClamavMetricsStats,
  ClamavScanResult,
  DovecotConfigState,
  DovecotManagedConfig,
  ManagedConfigFileEntry,
  DovecotMetricsSnapshot,
  DovecotQuotaResult,
  DovecotSession,
  DovecotUserLookup,
  DovecotMetricsStats,
  PostfixConfigState,
  ServiceLogs,
  FleetServiceSyncStatus,
  FleetServiceSyncLogEntry,
  FleetAgent,
  CreatedFleetAgent,
  FleetAgentEnrollment,
  PostfixManagedConfig,
  PostfixMetricsSnapshot,
  PostfixMetricsStats,
  PostfixQueueAction,
  PostfixQueueMessage,
  RedisConfigState,
  RedisManagedConfig,
  RedisMetricsSnapshot,
  RedisMetricsStats,
  RedisSlowlogEntry,
  RedisClientEntry,
  PostgresConfigState,
  PostgresManagedConfig,
  PostgresMetricsSnapshot,
  PostgresMetricsStats,
  PostgresActivityRow,
  PostgresLockRow,
  PostgresTableSizeRow,
  PostgresStatStatementsResult,
  MariadbConfigState,
  MariadbManagedConfig,
  MariadbMetricsSnapshot,
  MariadbMetricsStats,
  MariadbProcessRow,
  MariadbSchemaRow,
  MariadbStatementsResult,
  MariadbTableRow,
  MariadbTransactionRow,
  FreshclamManagedConfig,
  AgentServiceResponsibility,
  DashboardStats,
  FleetDashboard,
  FleetService,
  FleetServiceCounts,
  FleetServiceHealth,
  FleetServiceType,
  Features,
  RspamdClassifierSummary,
  RspamdConfigState,
  RspamdManagedFileEntry,
  RspamdFuzzyPreset,
  RspamdRulesDocument,
  RspamdRulesFileManagement,
  RspamdRulesState,
  RspamdDkimDomain,
  RspamdDkimSelector,
  RspamdMetricsSnapshot,
  RspamdMetricsStats,
  RspamdSettings,
  RspamdScanActionRecord,
  RspamdScanRequestMetadata,
  RspamdScanRunDetail,
  RspamdScanRunSummary,
  RspamdStatus,
  RobinInstance,
  RspamdTrainingImportJob,
  RspamdTrainingSample,
  SetupStatus,
  DmarcReport,
  DmarcReporter,
  DmarcChartData,
  DmarcStats,
  DmarcReportDetail,
  TlsrptReport,
  TlsrptReportDetail,
  TlsrptChartData,
  TlsrptStats,
  TlsrptDomain,
  ForensicReport,
  ForensicChartData,
  ForensicStats,
   MetricsSnapshot,
   MetricsStats,
   ModuleInstallerAction,
   ModuleInstallerResult,
   ModuleCatalogSyncResult,
 } from '../types';
import type {
  AlertDelivery,
  AlertJson,
  AlertSubscription,
  AlertWebhook,
  AlertWebhookAdapter,
  AlertWebhookResponse,
} from '../types/alerts';
import type { TelemetryConnection, TelemetryConnectionUpdate, TelemetrySnapshot } from '../types/telemetry-settings';

export const telemetrySettingsApi = {
  connection: () => request<ApiResponse<TelemetryConnection>>('/config/telemetry/connection'),
  save: (value: TelemetryConnectionUpdate) => request<ApiResponse<TelemetryConnection>>('/config/telemetry/connection/save', { method: 'POST', body: JSON.stringify(value) }),
  test: (value: TelemetryConnectionUpdate) => request<ApiResponse<{ reachable: boolean }>>('/config/telemetry/connection/test', { method: 'POST', body: JSON.stringify(value) }),
  snapshots: () => request<ApiResponse<TelemetrySnapshot[]>>('/config/telemetry/storage/snapshots'),
  createSnapshot: () => request<ApiResponse<TelemetrySnapshot>>('/config/telemetry/storage/snapshots', { method: 'POST' }),
  deleteSnapshot: (name: string) => request<ApiResponse<void>>(`/config/telemetry/storage/snapshots/${encodeURIComponent(name)}`, { method: 'DELETE' }),
};
import type {
  MonitoringCheck,
  MonitoringCheckDay,
  MonitoringLocationDay,
  MonitoringCheckType,
  MonitoringConfiguration,
  MonitoringImportReport,
  MonitoringHeartbeat,
  MonitoringHeartbeatHealth,
  MonitoringProbeLocation,
  MonitoringProbeLocationsResponse,
  MonitoringIssue,
  MonitoringObservation,
  MonitoringSummary,
  MonitoringTarget,
  MonitoringTargetType,
} from '../types/monitoring';
import type {
  TelemetryAnnotation,
  TelemetryDashboard,
  TelemetryDashboardContent,
  TelemetryDashboardSummary,
  TelemetryDashboardVersion,
  TelemetryPanel,
  TelemetryPanelQueries,
  TelemetryRangeData,
  TelemetryStatus,
  TelemetryStoreHealth,
  TelemetryTemplate,
  TelemetryVariable,
  TelemetryVariableValues,
} from '../types/telemetry';
import type {
  PublicIncidentArchive,
  PublicMaintenanceSchedule,
  PublicStatusPage,
  PublicStatusPageReport,
  StatusPageAdminSummary,
  StatusPageComponent,
  StatusPageMaintenance,
  StatusPageMaintenanceStatus,
  StatusPageReport,
  StatusPageReportImpact,
  StatusPageReportImportResult,
  StatusPageUpdateStatus,
  StatusPageReportUpdate,
  StatusPageSection,
  StatusPageSettings,
} from '../types/status-page';
import type {
  AdminEmailSubscription,
  EmailDelivery,
  EmailRelay,
  EmailRelayType,
  EmailSenderProfile,
  EmailSenderProfileKey,
  EmailSmtpSecurity,
  EmailTransportAdminView,
  EmailTlsMode,
  StatusPageSubscriber,
} from '../types/email';
import type { DmarcSortKey, ForensicSortKey, SortDirection, TlsrptSortKey } from '../types/raw-reporting';

// Honor Vite's --base setting so the SPA works when served at a non-root
// path (e.g. /admin/). BASE_URL has a trailing slash — strip it so we end
// up with `/admin/api` rather than `/admin//api`.
const API_BASE = `${import.meta.env.BASE_URL.replace(/\/$/, '')}/api`;
const REQUEST_TIMEOUT_MS = 30_000;
let csrfToken: string | null = null;

/**
 * Custom error class for API errors.
 * Includes HTTP status code and optional validation details.
 */
class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: string[]
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

/**
 * Core request function for all API calls.
 * 
 * @param endpoint - API endpoint path (e.g., '/users')
 * @param options - Fetch options (method, body, headers)
 * @returns Parsed JSON response
 * @throws ApiError if response is not ok or success is false
 * 
 * Browser requests include credentials so session cookies are sent.
 */
async function request<T>(
  endpoint: string,
  options: RequestInit = {}
): Promise<T> {
  const method = (options.method || 'GET').toUpperCase();
  const unsafe = !['GET', 'HEAD', 'OPTIONS'].includes(method);
  const csrfExempt = endpoint === '/auth/login'
    || endpoint === '/setup';

  if (unsafe && !csrfExempt && !csrfToken) {
    try {
      const csrfResponse = await fetch(`${API_BASE}/auth/csrf`, {
        credentials: 'include',
      });
      const csrfData = await parseResponseBody(csrfResponse);
      csrfToken = csrfData.data?.csrfToken ?? null;
    } catch {
      csrfToken = null;
    }
  }

  const headers = new Headers(options.headers as HeadersInit | undefined);
  const body = options.body;
  const shouldSetJson = !headers.has('Content-Type')
    && body !== undefined
    && !(body instanceof FormData)
    && !(body instanceof Blob)
    && !(body instanceof ArrayBuffer)
    && !ArrayBuffer.isView(body as ArrayBufferView | null);
  if (shouldSetJson) {
    headers.set('Content-Type', 'application/json');
  }
  if (unsafe && csrfToken) {
    headers.set('X-CSRF-Token', csrfToken);
  }

  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const abortFromCaller = () => controller.abort();
  options.signal?.addEventListener('abort', abortFromCaller, { once: true });

  let response: Response;
  try {
    response = await fetch(`${API_BASE}${endpoint}`, {
      ...options,
      headers,
      credentials: 'include',
      signal: controller.signal,
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new ApiError('Request timed out or was cancelled', 0);
    }
    throw new ApiError(error instanceof Error ? error.message : 'Network request failed', 0);
  } finally {
    window.clearTimeout(timeout);
    options.signal?.removeEventListener('abort', abortFromCaller);
  }

  const data = await parseResponseBody(response);
  if (data?.data?.csrfToken) {
    csrfToken = data.data.csrfToken;
  }

  if (!response.ok || data.success === false) {
    throw new ApiError(
      data.error || response.statusText || `Request failed (${response.status})`,
      response.status,
      data.details
    );
  }

  return data as T;
}

async function parseResponseBody(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  if (!text.trim()) {
    return {};
  }

  try {
    return JSON.parse(text) as Record<string, any>;
  } catch {
    throw new ApiError(
      response.ok ? 'Server returned an invalid response' : response.statusText || 'Request failed',
      response.status,
    );
  }
}

export interface MetricsScopeOptions {
  serviceType?: FleetServiceType;
  serviceId?: string;
}

function buildMetricsSearchParams(
  scope?: string | MetricsScopeOptions,
  extra?: Record<string, string | number | undefined>,
): URLSearchParams {
  const params = new URLSearchParams();

  if (typeof scope === 'string') {
    if (scope) {
      params.set('serviceId', scope);
    }
  } else if (scope) {
    if (scope.serviceType) {
      params.set('serviceType', scope.serviceType);
    }
    if (scope.serviceId) {
      params.set('serviceId', scope.serviceId);
    }
  }

  if (extra) {
    for (const [key, value] of Object.entries(extra)) {
      if (value !== undefined) {
        params.set(key, String(value));
      }
    }
  }

  return params;
}

function withQueryString(endpoint: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${endpoint}?${query}` : endpoint;
}

// Auth API
export const authApi = {
  login: (email: string, password: string) =>
    request<ApiResponse<CurrentUser>>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    }),

  logout: () =>
    request<ApiResponse>('/auth/logout', { method: 'POST' }).finally(() => {
      csrfToken = null;
    }),

  me: () =>
    request<ApiResponse<CurrentUser>>('/auth/me'),

  getSetupStatus: () =>
    request<ApiResponse<SetupStatus>>('/setup/status'),

  csrf: () =>
    request<ApiResponse<{ csrfToken: string }>>('/auth/csrf'),

  requestPasswordRecovery: (email: string) =>
    request<ApiResponse<void>>('/auth/recovery/request', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),

  resetPassword: (token: string, password: string) =>
    request<ApiResponse<void>>('/auth/recovery/reset', {
      method: 'POST',
      body: JSON.stringify({ token, password }),
    }),

  setup: (setupId: string, name: string, email: string, password: string) =>
    request<ApiResponse<Admin>>('/setup', {
      method: 'POST',
      body: JSON.stringify({ setupId, name, email, password }),
    }),

};

export interface ApiKey {
  id: number;
  name: string;
  keyPrefix: string;
  role: AdminRole;
  scopes: string[];
  allowedCidrs: string[];
  createdBy: number | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  lastUsedAt: string | null;
  lastUsedIp: string | null;
}

export interface CreatedApiKey extends ApiKey {
  plainText: string;
}

export interface IpJailEntry {
  id: number;
  cidr: string;
  reason: string | null;
  createdBy: number | null;
  createdAt: string;
  expiresAt: string | null;
  liftedAt: string | null;
  liftedBy: number | null;
}

export const apiKeysApi = {
  list: () =>
    request<ApiResponse<ApiKey[]>>('/api-keys'),

  create: (data: {
    name: string;
    role: AdminRole;
    scopes: string[];
    allowedCidrs?: string;
    expiresAt?: string;
  }) =>
    request<ApiResponse<CreatedApiKey>>('/api-keys', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  revoke: (id: number) =>
    request<ApiResponse>(`/api-keys/${id}/revoke`, { method: 'POST' }),

  delete: (id: number) =>
    request<ApiResponse>(`/api-keys/${id}`, { method: 'DELETE' }),
};

export const ipJailApi = {
  list: (includeInactive = false) =>
    request<ApiResponse<IpJailEntry[]>>(`/security/ip-jail?includeInactive=${includeInactive ? 'true' : 'false'}`),

  create: (data: { cidr: string; reason?: string; expiresAt?: string | null }) =>
    request<ApiResponse<IpJailEntry>>('/security/ip-jail', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: { expiresAt?: string | null }) =>
    request<ApiResponse>(`/security/ip-jail/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  lift: (id: number) =>
    request<ApiResponse>(`/security/ip-jail/${id}/lift`, { method: 'POST' }),
};

export const rspamdApi = {
  getStatus: (serviceId?: string) =>
    request<ApiResponse<RspamdStatus>>(withQueryString('/rspamd/status', buildMetricsSearchParams(
      serviceId ? { serviceId } : undefined,
    ))),

  getSettings: (serviceId?: string) =>
    request<ApiResponse<{ settings: RspamdSettings; status: RspamdStatus }>>(withQueryString(
      '/rspamd/settings',
      buildMetricsSearchParams(serviceId ? { serviceId } : undefined),
    )),

  // Password fields are write-only: send one to set it, '' to clear it.
  updateSettings: (
    settings: Partial<Omit<RspamdSettings, 'hasControllerPassword' | 'hasEnablePassword'>> & {
      rspamdControllerPassword?: string;
      rspamdEnablePassword?: string;
    },
    serviceId?: string,
  ) =>
    request<ApiResponse<{ settings: RspamdSettings; status: RspamdStatus }>>('/rspamd/settings', {
      method: 'PUT',
      body: JSON.stringify({
        ...settings,
        serviceId: serviceId ?? settings.serviceId,
      }),
    }),

  getConfig: (serviceId?: string) =>
    request<ApiResponse<RspamdConfigState>>(withQueryString(
      '/rspamd/config',
      buildMetricsSearchParams(serviceId ? { serviceId } : undefined),
    )),

  updateConfig: (
    managedConfig: Partial<RspamdConfigState['managedConfig']>,
    fileManagement?: { dkim?: boolean; bayes?: boolean },
    serviceId?: string,
  ) =>
    request<ApiResponse<RspamdConfigState>>('/rspamd/config', {
      method: 'PUT',
      body: JSON.stringify({ managedConfig, fileManagement, serviceId }),
    }),

  // Save one per-file managed config (redis.conf, logging.inc, …) by its key.
  saveConfigFile: (key: string, values: Record<string, unknown>, serviceId?: string) =>
    request<ApiResponse<RspamdManagedFileEntry>>(withQueryString(
      `/rspamd/config/files/${encodeURIComponent(key)}`,
      buildMetricsSearchParams(serviceId ? { serviceId } : undefined),
    ), {
      method: 'PUT',
      body: JSON.stringify({ values }),
    }),

  reload: (serviceId?: string) =>
    request<ApiResponse<{ response: string }>>('/rspamd/reload', {
      method: 'POST',
      body: JSON.stringify(serviceId ? { serviceId } : {}),
    }),

  getConfigScopes: () =>
    request<ApiResponse<string[]>>('/rspamd/config/scopes'),

  resetConfigFile: (key: string, serviceId?: string) =>
    request<ApiResponse<RspamdConfigState>>(withQueryString(
      `/rspamd/config/files/${encodeURIComponent(key)}`,
      buildMetricsSearchParams(serviceId ? { serviceId } : undefined),
    ), { method: 'DELETE' }),

  getRules: (serviceId?: string) =>
    request<ApiResponse<RspamdRulesState>>(withQueryString(
      '/rspamd/rules',
      buildMetricsSearchParams(serviceId ? { serviceId } : undefined),
    )),

  previewRules: (
    document: RspamdRulesDocument,
    fileManagement?: Partial<RspamdRulesFileManagement>,
    serviceId?: string,
  ) =>
    request<ApiResponse<RspamdRulesState>>('/rspamd/rules/preview', {
      method: 'POST',
      body: JSON.stringify({ document, fileManagement, serviceId }),
    }),

  updateRules: (
    document: RspamdRulesDocument,
    fileManagement?: Partial<RspamdRulesFileManagement>,
    serviceId?: string,
  ) =>
    request<ApiResponse<RspamdRulesState>>('/rspamd/rules', {
      method: 'PUT',
      body: JSON.stringify({ document, fileManagement, serviceId }),
    }),

  getClassifiers: (serviceId?: string) =>
    request<ApiResponse<RspamdClassifierSummary>>(withQueryString(
      '/rspamd/classifiers',
      buildMetricsSearchParams(serviceId ? { serviceId } : undefined),
    )),

  updateClassifiers: (
    updates: Partial<Pick<RspamdClassifierSummary, 'defaultTransport' | 'defaultClassifier'>> & {
      fuzzyPresets?: RspamdFuzzyPreset[];
    },
    serviceId?: string,
  ) =>
    request<ApiResponse<RspamdClassifierSummary>>('/rspamd/classifiers', {
      method: 'PUT',
      body: JSON.stringify({ ...updates, serviceId }),
    }),

  scanMessage: (payload: {
    serviceId?: string;
    transport?: 'checkv2' | 'checkv3';
    rawMessage: string;
    fileName?: string | null;
    metadata: Partial<RspamdScanRequestMetadata>;
  }) =>
    request<ApiResponse<RspamdScanRunDetail>>('/rspamd/scan', {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  scanFile: async (payload: {
    serviceId?: string;
    transport?: 'checkv2' | 'checkv3';
    fileName: string;
    bytes: ArrayBuffer;
    metadata: Partial<RspamdScanRequestMetadata>;
  }) => {
    const params = new URLSearchParams();
    if (payload.serviceId) params.set('serviceId', payload.serviceId);
    if (payload.transport) params.set('transport', payload.transport);
    if (payload.fileName) params.set('fileName', payload.fileName);
    return request<ApiResponse<RspamdScanRunDetail>>(`/rspamd/scan-file?${params.toString()}`, {
      method: 'POST',
      body: payload.bytes,
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Rspamd-Scan-Metadata': JSON.stringify(payload.metadata ?? {}),
      },
    });
  },

  listScans: (options: { serviceId?: string; page?: number; limit?: number } = {}) =>
    request<PaginatedResponse<RspamdScanRunSummary>>(withQueryString(
      '/rspamd/scans',
      buildMetricsSearchParams(
        options.serviceId ? { serviceId: options.serviceId } : undefined,
        { page: options.page, limit: options.limit },
      ),
    )),

  getScan: (id: number, serviceId?: string) =>
    request<ApiResponse<RspamdScanRunDetail>>(withQueryString(
      `/rspamd/scans/${id}`,
      buildMetricsSearchParams(serviceId ? { serviceId } : undefined),
    )),

  replayScan: (id: number, serviceId?: string) =>
    request<ApiResponse<RspamdScanRunDetail>>(`/rspamd/scans/${id}/replay`, {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  learnScan: (id: number, payload: { label: 'spam' | 'ham'; classifier?: string; serviceId?: string }) =>
    request<ApiResponse<RspamdScanActionRecord>>(`/rspamd/scans/${id}/learn`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  fuzzyScan: (id: number, payload: {
    operation: 'add' | 'remove';
    presetId?: string;
    flag?: number;
    weight?: number;
    serviceId?: string;
  }) =>
    request<ApiResponse<RspamdScanActionRecord>>(`/rspamd/scans/${id}/fuzzy`, {
      method: 'POST',
      body: JSON.stringify(payload),
    }),

  listDomains: () =>
    request<ApiResponse<RspamdDkimDomain[]>>('/rspamd/dkim/domains'),

  createDomain: (data: Partial<RspamdDkimDomain> & { domain: string; signDomain?: string }) =>
    request<ApiResponse<RspamdDkimDomain>>('/rspamd/dkim/domains', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateDomain: (id: number, data: Partial<RspamdDkimDomain>) =>
    request<ApiResponse<RspamdDkimDomain>>(`/rspamd/dkim/domains/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  listSelectors: (domainId: number) =>
    request<ApiResponse<RspamdDkimSelector[]>>(`/rspamd/dkim/domains/${domainId}/selectors`),

  createKey: (domainId: number) =>
    request<ApiResponse<RspamdDkimSelector>>(`/rspamd/dkim/domains/${domainId}/keys`, { method: 'POST' }),

  importKey: (domainId: number, data: { privateKey: string; selector?: string }) =>
    request<ApiResponse<RspamdDkimSelector>>(`/rspamd/dkim/domains/${domainId}/import`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  rotateKey: (domainId: number) =>
    request<ApiResponse<RspamdDkimSelector>>(`/rspamd/dkim/domains/${domainId}/rotate`, { method: 'POST' }),

  revokeSelector: (selectorId: number) =>
    request<ApiResponse>(`/rspamd/dkim/selectors/${selectorId}/revoke`, { method: 'POST' }),

  importTrainingFile: async (label: 'spam' | 'ham', fileName: string, bytes: ArrayBuffer, serviceId?: string) => {
    if (!csrfToken) {
      try {
        const csrfResponse = await fetch(`${API_BASE}/auth/csrf`, {
          credentials: 'include',
        });
        const csrfData = await csrfResponse.json();
        csrfToken = csrfData.data?.csrfToken ?? null;
      } catch {
        csrfToken = null;
      }
    }

    return request<ApiResponse<{
      job: RspamdTrainingImportJob | null;
      samples: RspamdTrainingSample[];
      skipped: Array<{ fileName: string; reason: string }>;
    }>>(`/rspamd/training/import-file?label=${encodeURIComponent(label)}&fileName=${encodeURIComponent(fileName)}${serviceId ? `&serviceId=${encodeURIComponent(serviceId)}` : ''}`, {
      method: 'POST',
      body: bytes,
      headers: {
        'Content-Type': 'application/octet-stream',
      },
    });
  },

  getImport: (id: number) =>
    request<ApiResponse<RspamdTrainingImportJob>>(`/rspamd/training/imports/${id}`),

  listSamples: (options: {
    page?: number;
    limit?: number;
    label?: 'spam' | 'ham' | '';
    status?: 'pending' | 'learned' | 'failed' | '';
    search?: string;
  } = {}) => {
    const params = new URLSearchParams();
    if (options.page) params.set('page', String(options.page));
    if (options.limit) params.set('limit', String(options.limit));
    if (options.label) params.set('label', options.label);
    if (options.status) params.set('status', options.status);
    if (options.search) params.set('search', options.search);
    return request<PaginatedResponse<RspamdTrainingSample>>(`/rspamd/training/samples?${params.toString()}`);
  },

  getSample: (id: number) =>
    request<ApiResponse<RspamdTrainingSample>>(`/rspamd/training/samples/${id}`),

  learnSample: (id: number, classifier?: string, serviceId?: string) =>
    request<ApiResponse<RspamdTrainingSample>>(`/rspamd/training/samples/${id}/learn`, {
      method: 'POST',
      body: JSON.stringify({ classifier, serviceId }),
    }),

  relabelSample: (id: number, label: 'spam' | 'ham', classifier?: string, serviceId?: string) =>
    request<ApiResponse<RspamdTrainingSample>>(`/rspamd/training/samples/${id}/relabel`, {
      method: 'POST',
      body: JSON.stringify({ label, classifier, serviceId }),
    }),

  deleteSample: (id: number) =>
    request<ApiResponse<RspamdTrainingSample>>(`/rspamd/training/samples/${id}`, { method: 'DELETE' }),
};

// Profile API
export const profileApi = {
  get: () =>
    request<ApiResponse<CurrentUser>>('/profile'),

  update: (name: string, email: string) =>
    request<ApiResponse<CurrentUser>>('/profile', {
      method: 'PUT',
      body: JSON.stringify({ name, email }),
    }),

  changePassword: (currentPassword: string, newPassword: string) =>
    request<ApiResponse>('/profile/password', {
      method: 'PUT',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
};

// Config API
export interface ModuleHostPolicy {
  slug: string;
  directoryRead: boolean;
  lifecycleRead: boolean;
  maxBodyMiB: number;
  timeoutSeconds: number;
}
export interface ModuleIdentityTrust {
  issuer: string;
  keys: Array<{ kid: string; kty: string; crv: string; x: string; alg: string; use: string }>;
}
export interface ModuleIdentityReadiness {
  moduleSlug: string;
  ready: boolean;
  acknowledgedAt: string | null;
  evidence: string | null;
}
export interface ModuleIdentityRotationStatus {
  issuer: string;
  trust: ModuleIdentityTrust;
  trustFingerprint: string;
  stage: 'stable' | 'pending' | 'retiring' | 'retirement-ready';
  active: { kid: string; createdAt: string };
  pending: { kid: string; createdAt: string } | null;
  retiring: { kid: string; createdAt: string; retireAfter: string; trustRemovalPreparedAt: string | null } | null;
  retentionMs: number;
  trustExportConfigured: boolean;
  configuredModules: string[];
  affectedModules: string[];
  activationReadiness: ModuleIdentityReadiness[];
  retirementReadiness: ModuleIdentityReadiness[];
}
export const modulePolicyApi = {
  get: () => request<ApiResponse<{ policies: ModuleHostPolicy[]; trust: ModuleIdentityTrust }>>('/config/modules/policies'),
  save: (policy: ModuleHostPolicy) => {
    const { slug, ...body } = policy;
    return request<ApiResponse<ModuleHostPolicy>>(`/config/modules/policies/${encodeURIComponent(slug)}`, { method: 'PUT', body: JSON.stringify(body) });
  },
};
export const moduleIdentityApi = {
  get: () => request<ApiResponse<ModuleIdentityRotationStatus>>('/module-identity'),
  prepare: () => request<ApiResponse<ModuleIdentityRotationStatus>>('/module-identity/prepare', { method: 'POST', body: JSON.stringify({}) }),
  acknowledge: (phase: 'activation' | 'retirement', moduleSlug: string, evidence: string) =>
    request<ApiResponse<ModuleIdentityRotationStatus>>('/module-identity/acknowledgements', {
      method: 'POST',
      body: JSON.stringify({ phase, moduleSlug, evidence }),
    }),
  activate: () => request<ApiResponse<ModuleIdentityRotationStatus>>('/module-identity/activate', { method: 'POST', body: JSON.stringify({}) }),
  cancel: () => request<ApiResponse<ModuleIdentityRotationStatus>>('/module-identity/cancel', { method: 'POST', body: JSON.stringify({}) }),
  prepareRetirement: () => request<ApiResponse<ModuleIdentityRotationStatus>>('/module-identity/retirement/prepare', { method: 'POST', body: JSON.stringify({}) }),
  retire: () => request<ApiResponse<ModuleIdentityRotationStatus>>('/module-identity/retire', { method: 'POST', body: JSON.stringify({}) }),
  rollback: () => request<ApiResponse<ModuleIdentityRotationStatus>>('/module-identity/rollback', { method: 'POST', body: JSON.stringify({ acknowledge: true }) }),
};

export const configApi = {
  get: () =>
    request<ApiResponse<AdminConfig>>('/config'),

  getRuntime: () =>
    request<ApiResponse<RuntimeConfig>>('/config/runtime'),

  update: (updates: Partial<AdminConfig>) =>
    request<ApiResponse<AdminConfig>>('/config', {
      method: 'PUT',
      body: JSON.stringify(updates),
    }),

  getReportingUsage: () =>
    request<ApiResponse<{
      dmarc: {
        reports: number;
        records: number;
        oldestReportDate: string | null;
        newestReportDate: string | null;
        storageBytes: number;
      };
      tlsrpt: {
        reports: number;
        policies: number;
        failures: number;
        oldestReportDate: string | null;
        newestReportDate: string | null;
        storageBytes: number;
      };
      forensic: {
        reports: number;
        oldestReportDate: string | null;
        newestReportDate: string | null;
        storageBytes: number;
      };
    }>>('/config/reporting-usage'),

  cleanupReporting: () =>
    request<ApiResponse<{ dmarc: number; tlsrpt: number; forensic: number; total: number }>>('/config/cleanup-reporting', {
      method: 'POST',
    }),

  cleanupAuditLog: () =>
    request<ApiResponse<{ deleted: number }>>('/config/cleanup-audit-log', {
      method: 'POST',
    }),

  rotateIngestionSecret: (secret: string) =>
    request<ApiResponse<{ ingestionSecretConfigured: boolean }>>('/config/ingestion-secret', {
      method: 'POST',
      body: JSON.stringify({ secret }),
    }),

  clearLoginLocks: (email?: string) =>
    request<ApiResponse<{ cleared: number }>>('/config/clear-login-locks', {
      method: 'POST',
      body: JSON.stringify({ email }),
    }),
};

// Dashboard API
export const dashboardApi = {
  getStats: (scope?: string | MetricsScopeOptions) =>
    request<ApiResponse<DashboardStats>>(withQueryString('/dashboard', buildMetricsSearchParams(scope))),

  getFeatures: () =>
    request<ApiResponse<Features>>('/dashboard/features'),

  getFleet: () =>
    request<ApiResponse<FleetDashboard>>('/dashboard/fleet'),

  getPreferences: () =>
    request<ApiResponse<{ hidden: string[]; setupGuide?: boolean }>>('/dashboard/preferences'),

  dismissSetupGuide: () =>
    request<ApiResponse<void>>('/dashboard/setup-guide', { method: 'DELETE' }),

  savePreferences: (hidden: string[]) =>
    request<ApiResponse<{ hidden: string[] }>>('/dashboard/preferences', {
      method: 'PUT',
      body: JSON.stringify({ hidden }),
    }),
};

export const modulesApi = {
  list: () =>
    request<ApiResponse<AdminModule[]>>('/modules'),

  get: (slug: string) =>
    request<ApiResponse<AdminModule>>(`/modules/${encodeURIComponent(slug)}`),

  sync: () =>
    request<ApiResponse<ModuleCatalogSyncResult>>('/modules/sync', {
      method: 'POST',
    }),

  activate: (slug: string, licenseKey: string) =>
    request<ApiResponse<AdminModule>>(`/modules/${encodeURIComponent(slug)}/activate`, {
      method: 'POST',
      body: JSON.stringify({ licenseKey }),
    }),

  refreshLicense: (slug: string) =>
    request<ApiResponse<AdminModule>>(`/modules/${encodeURIComponent(slug)}/refresh-license`, {
      method: 'POST',
    }),

  recordPurchaseClick: (slug: string) =>
    request<ApiResponse<void>>(`/modules/${encodeURIComponent(slug)}/purchase-click`, {
      method: 'POST',
    }),

  installerAction: (slug: string, action: ModuleInstallerAction, maintenanceAcknowledged = false) =>
    request<ApiResponse<ModuleInstallerResult>>(`/modules/${encodeURIComponent(slug)}/${action}`, {
      method: 'POST',
      body: JSON.stringify({ maintenanceAcknowledged }),
    }),

  getInstallerJob: (slug: string, jobId: string) =>
    request<ApiResponse<ModuleInstallerResult>>(
      `/modules/${encodeURIComponent(slug)}/jobs/${encodeURIComponent(jobId)}`,
    ),

  getInstallerStatus: (slug: string) =>
    request<ApiResponse<Record<string, unknown>>>(`/modules/${encodeURIComponent(slug)}/status`),

  getBackendOverview: (slug: string) =>
    request<ApiResponse<{ moduleCount: number; licenseCount: number }>>(
      `/modules/${encodeURIComponent(slug)}/overview`,
    ),
};

// Admins API
export const adminsApi = {
  list: (page = 1, limit = 50) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    return request<PaginatedResponse<Admin>>(`/admins?${params}`);
  },

  get: (id: number) =>
    request<ApiResponse<Admin>>(`/admins/${id}`),

  create: (data: {
    name: string;
    email: string;
    password: string;
    role: AdminRole;
    allowedCidrs?: string;
    disabled?: boolean;
  }) =>
    request<ApiResponse<Admin>>('/admins', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (id: number, data: { name?: string; email?: string; password?: string; role?: AdminRole; allowedCidrs?: string; disabled?: boolean }) =>
    request<ApiResponse<Admin>>(`/admins/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: number) =>
    request<ApiResponse>(`/admins/${id}`, { method: 'DELETE' }),
};

// Users API
export const usersApi = {
  schema: () => request<ApiResponse<{ columns: string[]; knownOptional: string[]; extraColumns: string[] }>>('/users/schema'),
  list: (page = 1, limit = 50, search?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    return request<PaginatedResponse<MailUser>>(`/users?${params}`);
  },

  get: (id: number) =>
    request<ApiResponse<MailUser>>(`/users/${id}`),

  create: (email: string, password: string, uid?: number, gid?: number) =>
    request<ApiResponse<MailUser>>('/users', {
      method: 'POST',
      body: JSON.stringify({ email, password, uid, gid }),
    }),

  update: (id: number, data: { email?: string; password?: string; uid?: number; gid?: number }) =>
    request<ApiResponse<MailUser>>(`/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: number) =>
    request<ApiResponse>(`/users/${id}`, { method: 'DELETE' }),
};

// Aliases API
export const aliasesApi = {
  list: (page = 1, limit = 50, search?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    return request<PaginatedResponse<Alias>>(`/aliases?${params}`);
  },

  get: (id: number) =>
    request<ApiResponse<Alias>>(`/aliases/${id}`),

  create: (source: string, destination: string) =>
    request<ApiResponse<Alias>>('/aliases', {
      method: 'POST',
      body: JSON.stringify({ source, destination }),
    }),

  update: (id: number, data: { source?: string; destination?: string }) =>
    request<ApiResponse<Alias>>(`/aliases/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (id: number) =>
    request<ApiResponse>(`/aliases/${id}`, { method: 'DELETE' }),

  // Auto-aliases
  listAuto: (page = 1, limit = 50, search?: string) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (search) params.set('search', search);
    return request<PaginatedResponse<Alias>>(`/aliases/auto?${params}`);
  },

  getAuto: (id: number) =>
    request<ApiResponse<Alias>>(`/aliases/auto/${id}`),

  createAuto: (source: string, destination: string) =>
    request<ApiResponse<Alias>>('/aliases/auto', {
      method: 'POST',
      body: JSON.stringify({ source, destination }),
    }),

  updateAuto: (id: number, data: { source?: string; destination?: string }) =>
    request<ApiResponse<Alias>>(`/aliases/auto/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteAuto: (id: number) =>
    request<ApiResponse>(`/aliases/auto/${id}`, { method: 'DELETE' }),
};

// Queue API
export const queueApi = {
  // The Robin queue is one shared table every Robin instance claims from, so
  // listing isn't per service; only actions go through a chosen instance.
  list: (page = 1, limit = 50, filters?: { state?: string; protocol?: string; search?: string }) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filters?.state) params.set('state', filters.state);
    if (filters?.protocol) params.set('protocol', filters.protocol);
    if (filters?.search) params.set('search', filters.search);
    return request<PaginatedResponse<QueueItem>>(`/queue?${params}`);
  },

  get: (uid: string) =>
    request<ApiResponse<QueueItem>>(`/queue/${uid}`),

  getStats: () =>
    request<ApiResponse<{ total: number; byState: Record<string, number>; byProtocol: Record<string, number> }>>('/queue/stats'),

  retry: (uid: string, serviceId?: string) =>
    request<ApiResponse>(`/queue/${uid}/retry${serviceId ? `?serviceId=${serviceId}` : ''}`, { method: 'POST' }),

  delete: (uid: string, serviceId?: string) =>
    request<ApiResponse>(`/queue/${uid}${serviceId ? `?serviceId=${serviceId}` : ''}`, { method: 'DELETE' }),

  bounce: (uid: string, serviceId?: string) =>
    request<ApiResponse>(`/queue/${uid}/bounce${serviceId ? `?serviceId=${serviceId}` : ''}`, { method: 'POST' }),

  bulkRetry: (uids: string[], serviceId?: string) =>
    request<ApiResponse>(`/queue/bulk/retry${serviceId ? `?serviceId=${serviceId}` : ''}`, {
      method: 'POST',
      body: JSON.stringify({ uids }),
    }),

  bulkDelete: (uids: string[], serviceId?: string) =>
    request<ApiResponse>(`/queue/bulk/delete${serviceId ? `?serviceId=${serviceId}` : ''}`, {
      method: 'POST',
      body: JSON.stringify({ uids }),
    }),

  bulkBounce: (uids: string[], serviceId?: string) =>
    request<ApiResponse>(`/queue/bulk/bounce${serviceId ? `?serviceId=${serviceId}` : ''}`, {
      method: 'POST',
      body: JSON.stringify({ uids }),
    }),
};

// Audit API
export const auditApi = {
  list: (page = 1, limit = 50, filters?: {
    adminId?: number;
    entityType?: string;
    action?: string;
    startDate?: string;
    endDate?: string;
  }) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filters?.adminId) params.set('adminId', String(filters.adminId));
    if (filters?.entityType) params.set('entityType', filters.entityType);
    if (filters?.action) params.set('action', filters.action);
    if (filters?.startDate) params.set('startDate', filters.startDate);
    if (filters?.endDate) params.set('endDate', filters.endDate);
    return request<PaginatedResponse<AuditLogEntry>>(`/audit?${params}`);
  },
};

// DMARC API
export const dmarcApi = {
  listReports: (page = 1, limit = 50, filters?: {
    domain?: string;
    reporterId?: number;
    startDate?: string;
    endDate?: string;
    sortBy?: DmarcSortKey;
    sortOrder?: SortDirection;
  }) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filters?.domain) params.set('domain', filters.domain);
    if (filters?.reporterId) params.set('reporterId', String(filters.reporterId));
    if (filters?.startDate) params.set('startDate', filters.startDate);
    if (filters?.endDate) params.set('endDate', filters.endDate);
    if (filters?.sortBy) params.set('sortBy', filters.sortBy);
    if (filters?.sortOrder) params.set('sortOrder', filters.sortOrder);
    return request<PaginatedResponse<DmarcReport>>(`/dmarc/reports?${params}`);
  },

  getReport: (id: number) =>
    request<ApiResponse<DmarcReportDetail>>(`/dmarc/reports/${id}`),

  getChartData: (startDate?: string, endDate?: string, domain?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (domain) params.set('domain', domain);
    return request<ApiResponse<DmarcChartData[]>>(`/dmarc/chart?${params}`);
  },

  getReporters: () =>
    request<ApiResponse<DmarcReporter[]>>('/dmarc/reporters'),

  getStats: () =>
    request<ApiResponse<DmarcStats>>('/dmarc/stats'),
};

export const robinConfigApi = {
  list: () =>
    request<ApiResponse<import('../types/robin-config').ConfigEntry[]>>('/robin-config'),

  getAll: () =>
    request<ApiResponse<import('../types/robin-config').ConfigEntry[]>>('/robin-config'),

  getServerIds: () =>
    request<ApiResponse<string[]>>('/robin-config/server-ids'),

  // Force Robin to re-pull config from the DB and hot-reload (Robin self-syncs).
  reload: (serverId?: string) =>
    request<ApiResponse<{ status?: string; message?: string }>>(
      '/robin-config/reload',
      { method: 'POST', body: JSON.stringify({ serverId }) }
    ),

  getFiles: () =>
    request<ApiResponse<import('../types/robin-config').ConfigFileInfo[]>>('/robin-config/files'),

  getFile: (fileName: string, serverId = 'default') =>
    request<ApiResponse<import('../types/robin-config').ConfigFileData>>(
      `/robin-config/file/${fileName}?serverId=${encodeURIComponent(serverId)}`
    ),

  get: (serverId: string, fileName: string) =>
    request<ApiResponse<import('../types/robin-config').ConfigEntry>>(`/robin-config/${serverId}/${fileName}`),

  update: (serverId: string, fileName: string, config: Record<string, unknown>) =>
    request<ApiResponse<import('../types/robin-config').ConfigEntry>>(
      `/robin-config/${serverId}/${fileName}`,
      { method: 'PUT', body: JSON.stringify({ config }) }
    ),

  getClamavLink: (serverId: string) =>
    request<ApiResponse<import('../types/robin-config').RobinClamavLinkState>>(`/robin-config/clamav-link/${encodeURIComponent(serverId)}`),

  setClamavLink: (serverId: string, serviceId: string | null) =>
    request<ApiResponse<import('../types/robin-config').RobinClamavLinkState>>(
      `/robin-config/clamav-link/${encodeURIComponent(serverId)}`,
      { method: 'PUT', body: JSON.stringify({ serviceId }) }
    ),

  delete: (serverId: string, fileName: string) =>
    request<ApiResponse<void>>(`/robin-config/${serverId}/${fileName}`, { method: 'DELETE' }),
};

export const clamavApi = {
  getConfig: (serviceId: string) =>
    request<ApiResponse<ClamavConfigState>>(`/clamav/config?serviceId=${encodeURIComponent(serviceId)}`),

  updateConfig: (serviceId: string, payload: Partial<ClamavConfigState>) =>
    request<ApiResponse<ClamavConfigState>>('/clamav/config', {
      method: 'PUT',
      body: JSON.stringify({ serviceId, ...payload }),
    }),

  getStatus: (serviceId: string) =>
    request<ApiResponse<ClamavFleetMetrics & {
      serviceName: string | null;
      endpoint: { host: string; port: number };
      freshclam: FreshclamManagedConfig;
      privateNetworkOnly: true;
    }>>(`/clamav/status?serviceId=${encodeURIComponent(serviceId)}`),

  getRenderedConfig: (serviceId: string) =>
    request<ApiResponse<{ clamd: string; freshclam: string }>>(`/clamav/config/rendered?serviceId=${encodeURIComponent(serviceId)}`),

  reload: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/clamav/reload', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getConfigScopes: () =>
    request<ApiResponse<string[]>>('/clamav/config/scopes'),

  resetConfigFile: (serviceId: string, key: string) =>
    request<ApiResponse<ClamavConfigState>>(
      `/clamav/config/files/${encodeURIComponent(key)}?serviceId=${encodeURIComponent(serviceId)}`,
      { method: 'DELETE' },
    ),

  getMetricsHistory: (serviceId: string, hours = 24) =>
    request<ApiResponse<ClamavMetricsSnapshot[]>>(`/metrics/history?serviceType=clamav&serviceId=${encodeURIComponent(serviceId)}&hours=${hours}`),

  getMetricsStats: (serviceId: string) =>
    request<ApiResponse<ClamavMetricsStats>>(`/metrics/stats?serviceType=clamav&serviceId=${encodeURIComponent(serviceId)}`),

  getMetricsRaw: async (serviceId: string) => {
    const response = await fetch(`${API_BASE}/metrics/raw?serviceType=clamav&serviceId=${encodeURIComponent(serviceId)}`, {
      credentials: 'include',
    });
    return response.text();
  },

  scanFile: async (serviceId: string, file: File) => {
    return request<ApiResponse<ClamavScanResult>>(`/clamav/scan?serviceId=${encodeURIComponent(serviceId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/octet-stream',
        'X-Filename': encodeURIComponent(file.name),
      },
      body: file,
    });
  },
};

export const dovecotApi = {
  getConfig: (serviceId: string) =>
    request<ApiResponse<DovecotConfigState>>(`/dovecot/config?serviceId=${encodeURIComponent(serviceId)}`),

  updateConfig: (serviceId: string, payload: Partial<DovecotManagedConfig>) =>
    request<ApiResponse<DovecotConfigState>>('/dovecot/config', {
      method: 'PUT',
      body: JSON.stringify({ serviceId, ...payload }),
    }),

  saveConfigFile: (serviceId: string, key: string, values: Record<string, unknown>) =>
    request<ApiResponse<ManagedConfigFileEntry>>(
      `/dovecot/config/files/${encodeURIComponent(key)}?serviceId=${encodeURIComponent(serviceId)}`,
      { method: 'PUT', body: JSON.stringify({ values }) },
    ),


  getSessions: (serviceId: string) =>
    request<ApiResponse<DovecotSession[]>>(`/dovecot/sessions?serviceId=${encodeURIComponent(serviceId)}`),

  kickUser: (serviceId: string, user: string) =>
    request<ApiResponse<{ response: string }>>('/dovecot/sessions/kick', {
      method: 'POST',
      body: JSON.stringify({ serviceId, user }),
    }),

  getQuota: (serviceId: string) =>
    request<ApiResponse<DovecotQuotaResult>>(`/dovecot/quota?serviceId=${encodeURIComponent(serviceId)}`),

  lookupUser: (serviceId: string, user: string) =>
    request<ApiResponse<DovecotUserLookup>>(`/dovecot/users/${encodeURIComponent(user)}?serviceId=${encodeURIComponent(serviceId)}`),

  getRenderedConfig: (serviceId: string) =>
    request<ApiResponse<{ managed: string; renderedFor?: string; detectedVersion?: string | null }>>(`/dovecot/config/rendered?serviceId=${encodeURIComponent(serviceId)}`),

  reload: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/dovecot/reload', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getConfigScopes: () =>
    request<ApiResponse<string[]>>('/dovecot/config/scopes'),

  resetConfigFile: (serviceId: string, key: string) =>
    request<ApiResponse<DovecotConfigState>>(
      `/dovecot/config/files/${encodeURIComponent(key)}?serviceId=${encodeURIComponent(serviceId)}`,
      { method: 'DELETE' },
    ),

  getMetricsHistory: (serviceId: string, hours = 24) =>
    request<ApiResponse<DovecotMetricsSnapshot[]>>(`/metrics/history?serviceType=dovecot&serviceId=${encodeURIComponent(serviceId)}&hours=${hours}`),

  getMetricsStats: (serviceId: string) =>
    request<ApiResponse<DovecotMetricsStats>>(`/metrics/stats?serviceType=dovecot&serviceId=${encodeURIComponent(serviceId)}`),

  getMetricsRaw: async (serviceId: string) => {
    const response = await fetch(`${API_BASE}/metrics/raw?serviceType=dovecot&serviceId=${encodeURIComponent(serviceId)}`, {
      credentials: 'include',
    });
    return response.text();
  },
};

export const postfixApi = {
  getConfig: (serviceId: string) =>
    request<ApiResponse<PostfixConfigState>>(`/postfix/config?serviceId=${encodeURIComponent(serviceId)}`),

  updateConfig: (serviceId: string, payload: Partial<PostfixManagedConfig>) =>
    request<ApiResponse<PostfixConfigState>>('/postfix/config', {
      method: 'PUT',
      body: JSON.stringify({ serviceId, ...payload }),
    }),

  saveConfigFile: (serviceId: string, key: string, values: Record<string, unknown>) =>
    request<ApiResponse<ManagedConfigFileEntry>>(
      `/postfix/config/files/${encodeURIComponent(key)}?serviceId=${encodeURIComponent(serviceId)}`,
      { method: 'PUT', body: JSON.stringify({ values }) },
    ),



  getQueue: (serviceId: string) =>
    request<ApiResponse<PostfixQueueMessage[]>>(`/postfix/queue?serviceId=${encodeURIComponent(serviceId)}`),

  getQueuedMessage: (serviceId: string, queueId: string) =>
    request<ApiResponse<{ content: string }>>(`/postfix/queue/${encodeURIComponent(queueId)}?serviceId=${encodeURIComponent(serviceId)}`),

  queueAction: (serviceId: string, action: PostfixQueueAction, queueIds: string[]) =>
    request<ApiResponse<{ response: string }>>('/postfix/queue/actions', {
      method: 'POST',
      body: JSON.stringify({ serviceId, action, queueIds }),
    }),

  deliverMessage: (serviceId: string, queueId: string) =>
    request<ApiResponse<{ response: string }>>(`/postfix/queue/${encodeURIComponent(queueId)}/deliver`, {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getRenderedConfig: (serviceId: string) =>
    request<ApiResponse<{ mainCf: string; headerChecks: string; bodyChecks: string }>>(`/postfix/config/rendered?serviceId=${encodeURIComponent(serviceId)}`),

  reload: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/postfix/reload', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getConfigScopes: () =>
    request<ApiResponse<string[]>>('/postfix/config/scopes'),

  resetConfigFile: (serviceId: string, key: string) =>
    request<ApiResponse<PostfixConfigState>>(
      `/postfix/config/files/${encodeURIComponent(key)}?serviceId=${encodeURIComponent(serviceId)}`,
      { method: 'DELETE' },
    ),

  flushQueue: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/postfix/flush', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getMetricsHistory: (serviceId: string, hours = 24) =>
    request<ApiResponse<PostfixMetricsSnapshot[]>>(`/metrics/history?serviceType=postfix&serviceId=${encodeURIComponent(serviceId)}&hours=${hours}`),

  getMetricsStats: (serviceId: string) =>
    request<ApiResponse<PostfixMetricsStats>>(`/metrics/stats?serviceType=postfix&serviceId=${encodeURIComponent(serviceId)}`),

  getMetricsRaw: async (serviceId: string) => {
    const response = await fetch(`${API_BASE}/metrics/raw?serviceType=postfix&serviceId=${encodeURIComponent(serviceId)}`, {
      credentials: 'include',
    });
    return response.text();
  },
};

export const redisApi = {
  getConfig: (serviceId: string) =>
    request<ApiResponse<RedisConfigState>>(`/redis/config?serviceId=${encodeURIComponent(serviceId)}`),

  updateConfig: (serviceId: string, payload: Partial<RedisManagedConfig>) =>
    request<ApiResponse<RedisConfigState & { applyError: string | null }>>('/redis/config', {
      method: 'PUT',
      body: JSON.stringify({ serviceId, ...payload }),
    }),

  getStatus: (serviceId: string) =>
    request<ApiResponse<{
      serviceId: string;
      serviceName: string | null;
      reachable: boolean;
      managed: RedisManagedConfig;
      metrics: RedisMetricsSnapshot | null;
    }>>(`/redis/status?serviceId=${encodeURIComponent(serviceId)}`),

  getRenderedConfig: (serviceId: string) =>
    request<ApiResponse<{ managed: string }>>(`/redis/config/rendered?serviceId=${encodeURIComponent(serviceId)}`),

  reload: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/redis/reload', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getConfigScopes: () =>
    request<ApiResponse<string[]>>('/redis/config/scopes'),

  resetConfig: (serviceId: string) =>
    request<ApiResponse<RedisConfigState & { applyError: string | null }>>(`/redis/config?serviceId=${encodeURIComponent(serviceId)}`, { method: 'DELETE' }),

  getSlowlog: (serviceId: string) =>
    request<ApiResponse<RedisSlowlogEntry[]>>(`/redis/slowlog?serviceId=${encodeURIComponent(serviceId)}`),

  resetSlowlog: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/redis/slowlog/reset', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getClients: (serviceId: string) =>
    request<ApiResponse<RedisClientEntry[]>>(`/redis/clients?serviceId=${encodeURIComponent(serviceId)}`),

  killClient: (serviceId: string, clientId: number) =>
    request<ApiResponse<{ response: string }>>('/redis/clients/kill', {
      method: 'POST',
      body: JSON.stringify({ serviceId, clientId }),
    }),

  bgsave: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/redis/bgsave', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  bgrewriteaof: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/redis/bgrewriteaof', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  resetStats: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/redis/stats/reset', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getMetricsHistory: (serviceId: string, hours = 24) =>
    request<ApiResponse<RedisMetricsSnapshot[]>>(`/metrics/history?serviceType=redis&serviceId=${encodeURIComponent(serviceId)}&hours=${hours}`),

  getMetricsStats: (serviceId: string) =>
    request<ApiResponse<RedisMetricsStats>>(`/metrics/stats?serviceType=redis&serviceId=${encodeURIComponent(serviceId)}`),

  getMetricsRaw: async (serviceId: string) => {
    const response = await fetch(`${API_BASE}/metrics/raw?serviceType=redis&serviceId=${encodeURIComponent(serviceId)}`, {
      credentials: 'include',
    });
    return response.text();
  },
};

export const postgresApi = {
  getConfig: (serviceId: string) =>
    request<ApiResponse<PostgresConfigState>>(`/postgres/config?serviceId=${encodeURIComponent(serviceId)}`),

  updateConfig: (serviceId: string, payload: Partial<PostgresManagedConfig>) =>
    request<ApiResponse<PostgresConfigState & { applyError: string | null }>>('/postgres/config', {
      method: 'PUT',
      body: JSON.stringify({ serviceId, ...payload }),
    }),

  getStatus: (serviceId: string) =>
    request<ApiResponse<{
      serviceId: string;
      serviceName: string | null;
      reachable: boolean;
      managed: PostgresManagedConfig;
      metrics: PostgresMetricsSnapshot | null;
    }>>(`/postgres/status?serviceId=${encodeURIComponent(serviceId)}`),

  getRenderedConfig: (serviceId: string) =>
    request<ApiResponse<{ managed: string }>>(`/postgres/config/rendered?serviceId=${encodeURIComponent(serviceId)}`),

  reload: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/postgres/reload', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getConfigScopes: () =>
    request<ApiResponse<string[]>>('/postgres/config/scopes'),

  resetConfig: (serviceId: string) =>
    request<ApiResponse<PostgresConfigState & { applyError: string | null }>>(`/postgres/config?serviceId=${encodeURIComponent(serviceId)}`, { method: 'DELETE' }),

  getActivity: (serviceId: string) =>
    request<ApiResponse<PostgresActivityRow[]>>(`/postgres/activity?serviceId=${encodeURIComponent(serviceId)}`),

  cancelBackend: (serviceId: string, pid: number) =>
    request<ApiResponse<{ cancelled: boolean }>>('/postgres/activity/cancel', {
      method: 'POST',
      body: JSON.stringify({ serviceId, pid }),
    }),

  terminateBackend: (serviceId: string, pid: number) =>
    request<ApiResponse<{ terminated: boolean }>>('/postgres/activity/terminate', {
      method: 'POST',
      body: JSON.stringify({ serviceId, pid }),
    }),

  getLocks: (serviceId: string) =>
    request<ApiResponse<PostgresLockRow[]>>(`/postgres/locks?serviceId=${encodeURIComponent(serviceId)}`),

  vacuum: (serviceId: string, table?: string, analyze?: boolean) =>
    request<ApiResponse<{ response: string }>>('/postgres/vacuum', {
      method: 'POST',
      body: JSON.stringify({ serviceId, table, analyze }),
    }),

  analyze: (serviceId: string, table?: string) =>
    request<ApiResponse<{ response: string }>>('/postgres/analyze', {
      method: 'POST',
      body: JSON.stringify({ serviceId, table }),
    }),

  getTableSizes: (serviceId: string) =>
    request<ApiResponse<PostgresTableSizeRow[]>>(`/postgres/tables?serviceId=${encodeURIComponent(serviceId)}`),

  getStatStatements: (serviceId: string) =>
    request<ApiResponse<PostgresStatStatementsResult>>(`/postgres/statements?serviceId=${encodeURIComponent(serviceId)}`),

  resetStats: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/postgres/stats/reset', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getMetricsHistory: (serviceId: string, hours = 24) =>
    request<ApiResponse<PostgresMetricsSnapshot[]>>(`/metrics/history?serviceType=postgres&serviceId=${encodeURIComponent(serviceId)}&hours=${hours}`),

  getMetricsStats: (serviceId: string) =>
    request<ApiResponse<PostgresMetricsStats>>(`/metrics/stats?serviceType=postgres&serviceId=${encodeURIComponent(serviceId)}`),

  getMetricsRaw: async (serviceId: string) => {
    const response = await fetch(`${API_BASE}/metrics/raw?serviceType=postgres&serviceId=${encodeURIComponent(serviceId)}`, {
      credentials: 'include',
    });
    return response.text();
  },
};

const q = (serviceId: string) => `serviceId=${encodeURIComponent(serviceId)}`;

export const mariadbApi = {
  getConfig: (serviceId: string) =>
    request<ApiResponse<MariadbConfigState>>(`/mariadb/config?${q(serviceId)}`),

  updateConfig: (serviceId: string, managed: MariadbManagedConfig) =>
    request<ApiResponse<MariadbConfigState & { rendered: string; applyError: string | null }>>('/mariadb/config', {
      method: 'PUT',
      body: JSON.stringify({ serviceId, ...managed }),
    }),

  getRenderedConfig: (serviceId: string) =>
    request<ApiResponse<{ managed: string }>>(`/mariadb/config/rendered?${q(serviceId)}`),

  getConfigScopes: () =>
    request<ApiResponse<string[]>>('/mariadb/config/scopes'),

  resetConfig: (serviceId: string) =>
    request<ApiResponse<MariadbConfigState & { applyError: string | null }>>(`/mariadb/config?${q(serviceId)}`, { method: 'DELETE' }),

  /** MariaDB has no config reload: re-applies the managed variables. */
  reapply: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/mariadb/reload', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getProcesses: (serviceId: string) =>
    request<ApiResponse<MariadbProcessRow[]>>(`/mariadb/processes?${q(serviceId)}`),

  kill: (serviceId: string, id: number, scope: 'query' | 'connection') =>
    request<ApiResponse<{ killed: boolean; scope: string }>>('/mariadb/processes/kill', {
      method: 'POST',
      body: JSON.stringify({ serviceId, id, scope }),
    }),

  getTransactions: (serviceId: string) =>
    request<ApiResponse<MariadbTransactionRow[]>>(`/mariadb/transactions?${q(serviceId)}`),

  getSchemas: (serviceId: string) =>
    request<ApiResponse<MariadbSchemaRow[]>>(`/mariadb/schemas?${q(serviceId)}`),

  getTables: (serviceId: string, schema?: string) =>
    request<ApiResponse<MariadbTableRow[]>>(`/mariadb/tables?${q(serviceId)}${schema ? `&schema=${encodeURIComponent(schema)}` : ''}`),

  analyze: (serviceId: string, table: string) =>
    request<ApiResponse<{ response: string }>>('/mariadb/analyze', {
      method: 'POST',
      body: JSON.stringify({ serviceId, table }),
    }),

  getStatements: (serviceId: string) =>
    request<ApiResponse<MariadbStatementsResult>>(`/mariadb/statements?${q(serviceId)}`),

  resetStats: (serviceId: string) =>
    request<ApiResponse<{ response: string }>>('/mariadb/stats/reset', {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  getMetricsHistory: (serviceId: string, hours = 24) =>
    request<ApiResponse<MariadbMetricsSnapshot[]>>(`/metrics/history?serviceType=mariadb&${q(serviceId)}&hours=${hours}`),

  getMetricsStats: (serviceId: string) =>
    request<ApiResponse<MariadbMetricsStats>>(`/metrics/stats?serviceType=mariadb&${q(serviceId)}`),

  getMetricsRaw: async (serviceId: string) => {
    const response = await fetch(`${API_BASE}/metrics/raw?serviceType=mariadb&${q(serviceId)}`, {
      credentials: 'include',
    });
    return response.text();
  },
};

// Recent-logs API. `capabilities` reports which service types have READABLE logs
// in this deployment (drives the conditional sidebar Logs item).
export const logsApi = {
  get: (serviceType: FleetServiceType, serviceId: string, lines = 200) =>
    request<ApiResponse<ServiceLogs>>(
      `/logs?serviceType=${encodeURIComponent(serviceType)}&serviceId=${encodeURIComponent(serviceId)}&lines=${lines}`
    ),

};

// Fleet config-sync: status, audit log, and agent pull token.
export const fleetSyncApi = {
  getSync: (serviceId: string) =>
    request<ApiResponse<{ status: FleetServiceSyncStatus | null; log: FleetServiceSyncLogEntry[] }>>(
      `/fleet/services/${encodeURIComponent(serviceId)}/sync`
    ),

  getSyncLog: (serviceId: string, limit = 100) =>
    request<ApiResponse<{ log: FleetServiceSyncLogEntry[] }>>(
      `/fleet/services/${encodeURIComponent(serviceId)}/sync/log?limit=${limit}`
    ),

  requestSync: (serviceId: string) =>
    request<ApiResponse<FleetServiceSyncStatus | null>>(
      `/fleet/services/${encodeURIComponent(serviceId)}/sync/request`,
      { method: 'POST' }
    ),
};

// TLSRPT API
export const tlsrptApi = {
  listReports: (page = 1, limit = 50, filters?: { 
    domain?: string; 
    organization?: string;
    startDate?: string; 
    endDate?: string;
    sortBy?: TlsrptSortKey;
    sortOrder?: SortDirection;
  }) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filters?.domain) params.set('domain', filters.domain);
    if (filters?.organization) params.set('organization', filters.organization);
    if (filters?.startDate) params.set('startDate', filters.startDate);
    if (filters?.endDate) params.set('endDate', filters.endDate);
    if (filters?.sortBy) params.set('sortBy', filters.sortBy);
    if (filters?.sortOrder) params.set('sortOrder', filters.sortOrder);
    return request<PaginatedResponse<TlsrptReport>>(`/tlsrpt/reports?${params}`);
  },

  getReport: (id: number) =>
    request<ApiResponse<TlsrptReportDetail>>(`/tlsrpt/reports/${id}`),

  getChartData: (startDate?: string, endDate?: string, domain?: string) => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (domain) params.set('domain', domain);
    return request<ApiResponse<TlsrptChartData[]>>(`/tlsrpt/chart?${params}`);
  },

  getDomains: () =>
    request<ApiResponse<TlsrptDomain[]>>('/tlsrpt/domains'),

  getStats: () =>
    request<ApiResponse<TlsrptStats>>('/tlsrpt/stats'),
};

// Forensic API
export const forensicApi = {
  listReports: (page = 1, limit = 50, filters?: { 
    domain?: string;
    feedbackType?: string;
    authFailure?: string;
    sourceIp?: string;
    startDate?: string; 
    endDate?: string;
    sortBy?: ForensicSortKey;
    sortOrder?: SortDirection;
  }) => {
    const params = new URLSearchParams({ page: String(page), limit: String(limit) });
    if (filters?.domain) params.set('domain', filters.domain);
    if (filters?.feedbackType) params.set('feedbackType', filters.feedbackType);
    if (filters?.authFailure) params.set('authFailure', filters.authFailure);
    if (filters?.sourceIp) params.set('sourceIp', filters.sourceIp);
    if (filters?.startDate) params.set('startDate', filters.startDate);
    if (filters?.endDate) params.set('endDate', filters.endDate);
    if (filters?.sortBy) params.set('sortBy', filters.sortBy);
    if (filters?.sortOrder) params.set('sortOrder', filters.sortOrder);
    return request<PaginatedResponse<ForensicReport>>(`/forensic/reports?${params}`);
  },

  getReport: (id: number) =>
    request<ApiResponse<ForensicReport>>(`/forensic/reports/${id}`),

  getChartData: (startDate?: string, endDate?: string, groupBy?: 'date' | 'type' | 'domain') => {
    const params = new URLSearchParams();
    if (startDate) params.set('startDate', startDate);
    if (endDate) params.set('endDate', endDate);
    if (groupBy) params.set('groupBy', groupBy);
    return request<ApiResponse<ForensicChartData[]>>(`/forensic/chart?${params}`);
  },

  getFeedbackTypes: () =>
    request<ApiResponse<string[]>>('/forensic/feedback-types'),

  getAuthFailureTypes: () =>
    request<ApiResponse<string[]>>('/forensic/auth-failure-types'),

  getStats: () =>
    request<ApiResponse<ForensicStats>>('/forensic/stats'),
};

// Robin Metrics API
export const metricsApi = {
  getLive: <T = MetricsSnapshot | null>(scope?: string | MetricsScopeOptions) =>
    request<ApiResponse<T>>(withQueryString('/metrics/live', buildMetricsSearchParams(scope))),

  getRaw: async (scope?: string | MetricsScopeOptions) => {
    const response = await fetch(`${API_BASE}${withQueryString('/metrics/raw', buildMetricsSearchParams(scope))}`, {
      credentials: 'include',
    });
    return response.text();
  },

  getHistory: <T = MetricsSnapshot[]>(hours = 24, scope?: string | MetricsScopeOptions) =>
    request<ApiResponse<T>>(withQueryString('/metrics/history', buildMetricsSearchParams(scope, { hours }))),

  getStats: <T = MetricsStats>(scope?: string | MetricsScopeOptions) =>
    request<ApiResponse<T>>(withQueryString('/metrics/stats', buildMetricsSearchParams(scope))),
};

/**
 * Fleet services API.
 */
export const agentsApi = {
  list: () => request<ApiResponse<FleetAgent[]>>('/fleet/agents'),

  get: (agentId: string) => request<ApiResponse<FleetAgent>>(`/fleet/agents/${agentId}`),

  create: (data: { name: string; labels?: Record<string, unknown>; enrollmentTtlHours?: number }) =>
    request<ApiResponse<CreatedFleetAgent>>('/fleet/agents', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  rotateEnrollment: (agentId: string) =>
    request<ApiResponse<{ enrollment: FleetAgentEnrollment }>>(`/fleet/agents/${agentId}/enrollment/rotate`, {
      method: 'POST',
    }),

  remove: (agentId: string) =>
    request<ApiResponse<{ deleted: boolean }>>(`/fleet/agents/${agentId}`, {
      method: 'DELETE',
    }),

  listServices: (agentId: string) =>
    request<ApiResponse<AgentServiceResponsibility[]>>(`/fleet/agents/${agentId}/services`),

  assignService: (agentId: string, serviceId: string) =>
    request<ApiResponse<FleetService>>(`/fleet/agents/${agentId}/services`, {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  releaseService: (agentId: string, serviceId: string) =>
    request<ApiResponse<FleetService>>(`/fleet/agents/${agentId}/services/${serviceId}`, {
      method: 'DELETE',
    }),

  // Logs-only association: this agent ships the service's logs while its metrics
  // stay in whatever mode they're in (does not switch collection_mode).
  assignLogService: (agentId: string, serviceId: string) =>
    request<ApiResponse<FleetService>>(`/fleet/agents/${agentId}/log-services`, {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  releaseLogService: (agentId: string, serviceId: string) =>
    request<ApiResponse<FleetService>>(`/fleet/agents/${agentId}/log-services/${serviceId}`, {
      method: 'DELETE',
    }),

  // Config-only association: this agent applies + reloads the service's config
  // while metrics/logs stay in whatever mode they're in.
  assignConfigService: (agentId: string, serviceId: string) =>
    request<ApiResponse<FleetService>>(`/fleet/agents/${agentId}/config-services`, {
      method: 'POST',
      body: JSON.stringify({ serviceId }),
    }),

  releaseConfigService: (agentId: string, serviceId: string) =>
    request<ApiResponse<FleetService>>(`/fleet/agents/${agentId}/config-services/${serviceId}`, {
      method: 'DELETE',
    }),
};

export const fleetCapabilitiesApi = {
  get: () => request<ApiResponse<import('../types').FleetCapabilities>>('/fleet/capabilities'),
  matrix: () => request<ApiResponse<import('../types').CapabilityMatrix>>('/fleet/capabilities/matrix'),
};

export const fleetServicesApi = {
  list: (options: { serviceType?: FleetServiceType; enabled?: boolean } = {}) => {
    const params = new URLSearchParams();
    if (options.serviceType) params.set('serviceType', options.serviceType);
    if (options.enabled !== undefined) params.set('enabled', String(options.enabled));
    return request<ApiResponse<FleetService[]>>(withQueryString('/fleet/services', params));
  },

  listEnabled: (serviceType?: FleetServiceType) => {
    const params = new URLSearchParams();
    if (serviceType) params.set('serviceType', serviceType);
    return request<ApiResponse<FleetService[]>>(withQueryString('/fleet/services/enabled', params));
  },

  get: (serviceId: string) =>
    request<ApiResponse<FleetService>>(`/fleet/services/${serviceId}`),

  create: (data: {
    serviceId: string;
    serviceType: FleetServiceType;
    name: string;
    description?: string;
    apiUrl: string;
    healthUrl?: string;
    metricsUrl?: string;
    controllerUrl?: string;
    normalUrl?: string;
    telemetrySource?: string;
    enabled?: boolean;
  }) =>
    request<ApiResponse<FleetService>>('/fleet/services', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  update: (serviceId: string, data: {
    serviceId?: string;
    name?: string;
    description?: string | null;
    apiUrl?: string | null;
    healthUrl?: string | null;
    metricsUrl?: string | null;
    controllerUrl?: string | null;
    normalUrl?: string | null;
    telemetrySource?: string | null;
    enabled?: boolean;
  }) =>
    request<ApiResponse<FleetService>>(`/fleet/services/${serviceId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  delete: (serviceId: string) =>
    request<ApiResponse<void>>(`/fleet/services/${serviceId}`, {
      method: 'DELETE',
    }),

  health: (serviceId: string) =>
    request<ApiResponse<FleetServiceHealth>>(`/fleet/services/${serviceId}/health`),

  count: (serviceType?: FleetServiceType) => {
    const params = new URLSearchParams();
    if (serviceType) params.set('serviceType', serviceType);
    return request<ApiResponse<FleetServiceCounts | { serviceType: FleetServiceType; total: number; enabled: number }>>(
      withQueryString('/fleet/services/count', params),
    );
  },
};

export const alertsApi = {
  listWebhooks: () =>
    request<ApiResponse<AlertWebhookResponse>>('/alert-webhooks'),

  createWebhook: (data: {
    name: string;
    adapter: AlertWebhookAdapter;
    webhookUrl: string;
    enabled: boolean;
    subscriptions: AlertSubscription[];
    consecutiveFailures: number;
    repeatIntervalSeconds: number | null;
    notifyRecovery: boolean;
    sentryOrg?: string | null;
    sentryApiUrl?: string | null;
    sentryApiToken?: string | null;
  }) =>
    request<ApiResponse<AlertWebhook>>('/alert-webhooks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateWebhook: (id: number, data: Partial<{
    name: string;
    adapter: AlertWebhookAdapter;
    webhookUrl: string;
    enabled: boolean;
    subscriptions: AlertSubscription[];
    consecutiveFailures: number;
    repeatIntervalSeconds: number | null;
    notifyRecovery: boolean;
    sentryOrg: string | null;
    sentryApiUrl: string | null;
    sentryApiToken: string | null;
  }>) =>
    request<ApiResponse<AlertWebhook>>(`/alert-webhooks/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(data),
    }),

  deleteWebhook: (id: number) =>
    request<ApiResponse<void>>(`/alert-webhooks/${id}`, { method: 'DELETE' }),

  pauseWebhook: (id: number, data: { pausedUntil?: string; reason?: string }) =>
    request<ApiResponse<AlertWebhook>>(`/alert-webhooks/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  resumeWebhook: (id: number) =>
    request<ApiResponse<AlertWebhook>>(`/alert-webhooks/${id}/resume`, { method: 'POST' }),

  previewWebhook: (id: number) =>
    request<ApiResponse<{ payload: AlertJson; networkEffect: boolean }>>(`/alert-webhooks/${id}/preview`, { method: 'POST' }),

  testWebhook: (id: number) =>
    request<ApiResponse<AlertDelivery>>(`/alert-webhooks/${id}/test`, {
      method: 'POST',
      body: JSON.stringify({ confirmLiveSend: true }),
    }),

  listDeliveries: () =>
    request<ApiResponse<AlertDelivery[]>>('/alert-deliveries'),

  listTelemetryRules: () =>
    request<ApiResponse<TelemetryAlertRule[]>>('/telemetry-alert-rules'),

  listTelemetryIssues: (status: TelemetryAlertIssueStatus, limit = 100, offset = 0) => {
    const params = new URLSearchParams({ status, limit: String(limit), offset: String(offset) });
    return request<ApiResponse<{ issues: TelemetryAlertIssue[]; total: number }>>(`/telemetry-alert-issues?${params}`);
  },

  getTelemetryIssue: (id: string) =>
    request<ApiResponse<TelemetryAlertIssue>>(`/telemetry-alert-issues/${encodeURIComponent(id)}`),

  dismissTelemetryIssue: (id: string, data: { expectedRevision: number; reason: string | null; until: string | null }) =>
    request<ApiResponse<TelemetryAlertIssue>>(`/telemetry-alert-issues/${encodeURIComponent(id)}/dismiss`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  resumeTelemetryIssue: (id: string, data: { expectedRevision: number }) =>
    request<ApiResponse<TelemetryAlertIssue>>(`/telemetry-alert-issues/${encodeURIComponent(id)}/resume`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  createTelemetryRule: (data: TelemetryAlertRuleInput) =>
    request<ApiResponse<TelemetryAlertRule>>('/telemetry-alert-rules', { method: 'POST', body: JSON.stringify(data) }),

  updateTelemetryRule: (id: number, data: TelemetryAlertRuleInput) =>
    request<ApiResponse<TelemetryAlertRule>>(`/telemetry-alert-rules/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  deleteTelemetryRule: (id: number) =>
    request<ApiResponse<void>>(`/telemetry-alert-rules/${id}`, { method: 'DELETE' }),

  previewTelemetryRule: (data: Pick<TelemetryAlertRuleInput, 'query' | 'comparator' | 'threshold'>) =>
    request<ApiResponse<TelemetryAlertPreview>>('/telemetry-alert-rules/preview', { method: 'POST', body: JSON.stringify(data) }),
};

export const monitoringApi = {
  summary: () =>
    request<ApiResponse<MonitoringSummary>>('/monitoring'),

  getPushUrl: (checkId: number) =>
    request<ApiResponse<{ url: string }>>(`/monitoring/checks/${checkId}/push-url`),

  rotatePushUrl: (checkId: number) =>
    request<ApiResponse<{ url: string }>>(`/monitoring/checks/${checkId}/push-url/rotate`, { method: 'POST' }),

  listLocations: () =>
    request<ApiResponse<MonitoringProbeLocationsResponse>>('/monitoring/locations'),

  grantLocation: (data: { agentId: string; name?: string; region?: string | null; probeConcurrency?: number }) =>
    request<ApiResponse<MonitoringProbeLocation>>('/monitoring/locations', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateLocation: (id: number, data: Partial<{ name: string; region: string | null; enabled: boolean; shadow: boolean; probeConcurrency: number }>) =>
    request<ApiResponse<MonitoringProbeLocation>>(`/monitoring/locations/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  revokeLocation: (id: number) =>
    request<ApiResponse<void>>(`/monitoring/locations/${id}`, { method: 'DELETE' }),

  listHeartbeats: () =>
    request<ApiResponse<MonitoringHeartbeat[]>>('/monitoring/heartbeats'),

  heartbeatHealth: () =>
    request<ApiResponse<MonitoringHeartbeatHealth>>('/monitoring/heartbeats/health'),

  createHeartbeat: (data: {
    name: string; format?: MonitoringHeartbeat['format']; pingUrl: string; failureUrl?: string | null; intervalSeconds: number; minimumFreshLocations?: number; enabled?: boolean;
  }) => request<ApiResponse<MonitoringHeartbeat>>('/monitoring/heartbeats', {
    method: 'POST', body: JSON.stringify(data),
  }),

  updateHeartbeat: (id: number, data: Partial<{
    name: string; format: MonitoringHeartbeat['format']; pingUrl: string; failureUrl: string | null; intervalSeconds: number; minimumFreshLocations: number; enabled: boolean;
  }>) => request<ApiResponse<MonitoringHeartbeat>>(`/monitoring/heartbeats/${id}`, {
    method: 'PUT', body: JSON.stringify(data),
  }),

  deleteHeartbeat: (id: number) =>
    request<ApiResponse<void>>(`/monitoring/heartbeats/${id}`, { method: 'DELETE' }),

  testHeartbeat: (id: number) =>
    request<ApiResponse<{ accepted: boolean }>>(`/monitoring/heartbeats/${id}/test`, { method: 'POST', body: '{}' }),

  exportConfiguration: () =>
    request<ApiResponse<MonitoringConfiguration>>('/monitoring/export'),

  importConfiguration: (configuration: unknown, dryRun: boolean) =>
    request<ApiResponse<MonitoringImportReport>>('/monitoring/import', {
      method: 'POST',
      body: JSON.stringify({ configuration, dryRun }),
    }),

  createTarget: (data: {
    name: string;
    targetType: MonitoringTargetType;
    environment?: string;
    description?: string | null;
    enabled?: boolean;
  }) =>
    request<ApiResponse<MonitoringTarget>>('/monitoring/targets', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateTarget: (id: number, data: Partial<{
    name: string;
    targetType: MonitoringTargetType;
    environment: string;
    description: string | null;
    enabled: boolean;
  }>) =>
    request<ApiResponse<MonitoringTarget>>(`/monitoring/targets/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  deleteTarget: (id: number) =>
    request<ApiResponse<void>>(`/monitoring/targets/${id}`, { method: 'DELETE' }),

  createCheck: (data: {
    targetId: number;
    name: string;
    checkType: MonitoringCheckType;
    endpoint: string;
    port?: number | null;
    intervalSeconds?: number;
    timeoutSeconds?: number;
    confirmationSeconds?: number;
    recoverySeconds?: number;
    placementMode?: MonitoringCheck['placementMode'];
    locationIds?: number[];
    quorum?: number;
    certExpiryDays?: number | null;
    tlsMode?: MonitoringCheck['tlsMode'];
    certificateErrorMode?: MonitoringCheck['certificateErrorMode'];
    allowPrivate?: boolean;
    options?: MonitoringCheck['options'];
    secretHeaders?: Record<string, string | null>;
    enabled?: boolean;
  }) =>
    request<ApiResponse<MonitoringCheck>>('/monitoring/checks', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  updateCheck: (id: number, data: Partial<{
    targetId: number;
    name: string;
    checkType: MonitoringCheckType;
    endpoint: string;
    port: number | null;
    intervalSeconds: number;
    timeoutSeconds: number;
    confirmationSeconds: number;
    recoverySeconds: number;
    placementMode: MonitoringCheck['placementMode'];
    locationIds: number[];
    quorum: number;
    certExpiryDays: number | null;
    tlsMode: MonitoringCheck['tlsMode'];
    certificateErrorMode: MonitoringCheck['certificateErrorMode'];
    allowPrivate: boolean;
    options: MonitoringCheck['options'];
    secretHeaders: Record<string, string | null>;
    enabled: boolean;
  }>) =>
    request<ApiResponse<MonitoringCheck>>(`/monitoring/checks/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  pauseCheck: (id: number, reason?: string) =>
    request<ApiResponse<MonitoringCheck>>(`/monitoring/checks/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ reason }),
    }),

  resumeCheck: (id: number) =>
    request<ApiResponse<MonitoringCheck>>(`/monitoring/checks/${id}/resume`, { method: 'POST' }),

  runCheck: (id: number) =>
    request<ApiResponse<MonitoringObservation>>(`/monitoring/checks/${id}/run`, { method: 'POST' }),

  checkHistory: (id: number, days = 90) =>
    request<ApiResponse<MonitoringCheckDay[]>>(`/monitoring/checks/${id}/history?days=${days}`),

  checkLocationHistory: (id: number, days = 90) =>
    request<ApiResponse<MonitoringLocationDay[]>>(`/monitoring/checks/${id}/location-history?days=${days}`),

  checkObservations: (id: number) =>
    request<ApiResponse<MonitoringObservation[]>>(`/monitoring/checks/${id}/observations`),

  closeStaleIssue: (id: number) =>
    request<ApiResponse<MonitoringIssue>>(`/monitoring/issues/${id}/close-stale`, { method: 'POST' }),

  deleteIssue: (id: number) =>
    request<ApiResponse<void>>(`/monitoring/issues/${id}`, { method: 'DELETE' }),

  deleteCheck: (id: number) =>
    request<ApiResponse<void>>(`/monitoring/checks/${id}`, { method: 'DELETE' }),
};

function telemetryParams(
  base: Record<string, string | number | undefined>,
  values: TelemetryVariableValues = {},
): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined && value !== '') params.set(key, String(value));
  }
  for (const [name, list] of Object.entries(values)) {
    for (const value of list) params.append(`var-${name}`, value);
  }
  return params;
}

/**
 * Telemetry API: dashboards and PromQL reads over the time-series store.
 * Times are Unix seconds.
 */
export const telemetryApi = {
  status: () =>
    request<ApiResponse<TelemetryStatus>>('/telemetry/status'),

  dashboards: () =>
    request<ApiResponse<TelemetryDashboardSummary[]>>('/telemetry/dashboards'),

  dashboard: (uid: string) =>
    request<ApiResponse<TelemetryDashboard>>(`/telemetry/dashboards/${encodeURIComponent(uid)}`),

  /** Create from content (blank or imported), a template, or a copy of another dashboard. */
  createDashboard: (body: TelemetryDashboardContent | { templateKey: string } | { duplicateOf: string }) =>
    request<ApiResponse<TelemetryDashboard>>('/telemetry/dashboards', { method: 'POST', body: JSON.stringify(body) }),

  /** Save content edited from `version`; a 409 means someone else saved first. */
  saveDashboard: (uid: string, content: TelemetryDashboardContent, version: number) =>
    request<ApiResponse<TelemetryDashboard>>(`/telemetry/dashboards/${encodeURIComponent(uid)}`, {
      method: 'PUT',
      body: JSON.stringify({ ...content, version }),
    }),

  deleteDashboard: (uid: string) =>
    request<ApiResponse<void>>(`/telemetry/dashboards/${encodeURIComponent(uid)}`, { method: 'DELETE' }),

  restoreDefault: (uid: string) =>
    request<ApiResponse<TelemetryDashboard>>(`/telemetry/dashboards/${encodeURIComponent(uid)}/restore-default`, { method: 'POST' }),

  keepDashboard: (uid: string) =>
    request<ApiResponse<TelemetryDashboard>>(`/telemetry/dashboards/${encodeURIComponent(uid)}/keep`, { method: 'POST' }),

  versions: (uid: string) =>
    request<ApiResponse<TelemetryDashboardVersion[]>>(`/telemetry/dashboards/${encodeURIComponent(uid)}/versions`),

  version: (uid: string, version: number) =>
    request<ApiResponse<TelemetryDashboardContent>>(`/telemetry/dashboards/${encodeURIComponent(uid)}/versions/${version}`),

  /** A saved panel's PromQL with variables filled in, for Explore. */
  panelQueries: (
    dashboardUid: string,
    panelId: string,
    range: { start: number; end: number },
    values: TelemetryVariableValues,
  ) =>
    request<ApiResponse<TelemetryPanelQueries>>(withQueryString(
      `/telemetry/dashboards/${encodeURIComponent(dashboardUid)}/panels/${encodeURIComponent(panelId)}/queries`,
      telemetryParams(range, values),
    )),

  sources: () =>
    request<ApiResponse<import('../types/telemetry').TelemetrySources>>('/telemetry/sources'),
  sourceQuery: (name: string) =>
    request<ApiResponse<{ query: string }>>(`/telemetry/source-query?name=${encodeURIComponent(name)}`),

  store: () =>
    request<ApiResponse<TelemetryStoreHealth>>('/telemetry/store'),

  annotations: (range: { start: number; end: number }) =>
    request<ApiResponse<TelemetryAnnotation[]>>(withQueryString('/telemetry/annotations', telemetryParams(range))),

  labelNames: (options: { match?: string; start?: number; end?: number } = {}) =>
    request<ApiResponse<string[]>>(withQueryString('/telemetry/labels', telemetryParams(options))),

  restoreVersion: (uid: string, version: number) =>
    request<ApiResponse<TelemetryDashboard>>(`/telemetry/dashboards/${encodeURIComponent(uid)}/versions/${version}/restore`, { method: 'POST' }),

  reorderDashboards: (uids: string[]) =>
    request<ApiResponse<TelemetryDashboardSummary[]>>('/telemetry/dashboard-order', { method: 'PUT', body: JSON.stringify({ uids }) }),

  templates: () =>
    request<ApiResponse<TelemetryTemplate[]>>('/telemetry/templates'),

  panel: (
    dashboardUid: string,
    panelId: string,
    range: { start: number; end: number; step?: number },
    values: TelemetryVariableValues,
  ) =>
    request<ApiResponse<TelemetryRangeData>>(withQueryString(
      `/telemetry/dashboards/${encodeURIComponent(dashboardUid)}/panels/${encodeURIComponent(panelId)}`,
      telemetryParams(range, values),
    )),

  /** Run a panel from the editor before it is saved. */
  previewPanel: (body: {
    panel: TelemetryPanel;
    variables: TelemetryVariable[];
    values: TelemetryVariableValues;
    start: number;
    end: number;
  }) =>
    request<ApiResponse<TelemetryRangeData>>('/telemetry/preview/panel', { method: 'POST', body: JSON.stringify(body) }),

  variableOptions: (
    dashboardUid: string,
    name: string,
    range: { start: number; end: number },
    values: TelemetryVariableValues,
  ) =>
    request<ApiResponse<string[]>>(withQueryString(
      `/telemetry/dashboards/${encodeURIComponent(dashboardUid)}/variables/${encodeURIComponent(name)}`,
      telemetryParams(range, values),
    )),

  /** Options for a variable from the editor before it is saved. */
  previewVariable: (body: {
    variables: TelemetryVariable[];
    name: string;
    values: TelemetryVariableValues;
    start: number;
    end: number;
  }) =>
    request<ApiResponse<string[]>>('/telemetry/preview/variable', { method: 'POST', body: JSON.stringify(body) }),

  queryRange: (query: string, range: { start: number; end: number; step?: number }) =>
    request<ApiResponse<TelemetryRangeData>>(withQueryString('/telemetry/query_range', telemetryParams({ query, ...range }))),

  labelValues: (name: string, options: { match?: string; start?: number; end?: number } = {}) =>
    request<ApiResponse<string[]>>(withQueryString(
      `/telemetry/labels/${encodeURIComponent(name)}/values`,
      telemetryParams(options),
    )),
};

/** The absolute URL of the public status page's RSS or JSON feed. */
export function statusPageFeedUrl(kind: 'rss' | 'json'): string {
  return `${window.location.origin}${API_BASE}/status-page/public/feed.${kind}`;
}

export const statusPageApi = {
  publicPage: () =>
    request<ApiResponse<PublicStatusPage>>('/status-page/public'),

  incidentArchive: (month?: string) =>
    request<ApiResponse<PublicIncidentArchive>>(`/status-page/public/incidents${month ? `?month=${encodeURIComponent(month)}` : ''}`),

  incident: (id: number) =>
    request<ApiResponse<PublicStatusPageReport>>(`/status-page/public/incidents/${id}`),

  maintenanceSchedule: (month?: string) =>
    request<ApiResponse<PublicMaintenanceSchedule>>(`/status-page/public/maintenance${month ? `?month=${encodeURIComponent(month)}` : ''}`),

  adminSummary: () =>
    request<ApiResponse<StatusPageAdminSummary>>('/status-page/admin'),

  updateSettings: (data: Partial<{
    companyName: string;
    companyUrl: string | null;
    logoUrl: string | null;
    customDomain: string | null;
    published: boolean;
    historyDays: number;
    timezone: string;
    theme: StatusPageSettings['theme'];
    announcement: string | null;
    subscribable: boolean;
    incidentHistoryEnabled: boolean;
    maintenancePageEnabled: boolean;
    feedsEnabled: boolean;
    incidentGroupingMinutes: number;
    homeIncidentDays: number;
  }>) =>
    request<ApiResponse<StatusPageSettings>>('/status-page/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  saveSection: (data: {
    id?: number | null;
    name: string;
    position: number;
    enabled: boolean;
  }) =>
    request<ApiResponse<StatusPageSection>>('/status-page/admin/sections', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteSection: (id: number) =>
    request<ApiResponse<void>>(`/status-page/admin/sections/${id}`, { method: 'DELETE' }),

  saveComponent: (data: {
    id?: number | null;
    sectionId: number;
    publicName: string;
    description: string | null;
    position: number;
    enabled: boolean;
    showHistory: boolean;
    checkIds: number[];
  }) =>
    request<ApiResponse<StatusPageComponent>>('/status-page/admin/components', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteComponent: (id: number) =>
    request<ApiResponse<void>>(`/status-page/admin/components/${id}`, { method: 'DELETE' }),

  createReport: (data: {
    title: string;
    impact: StatusPageReportImpact;
    componentIds: number[];
    message: string;
  }) =>
    request<ApiResponse<StatusPageReport>>('/status-page/admin/reports', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteReport: (id: number) =>
    request<ApiResponse<void>>(`/status-page/admin/reports/${id}`, { method: 'DELETE' }),

  importReports: (reports: unknown[]) =>
    request<ApiResponse<StatusPageReportImportResult>>('/status-page/admin/reports/import', {
      method: 'POST',
      body: JSON.stringify({ reports }),
    }),

  addReportUpdate: (id: number, data: { status: StatusPageUpdateStatus; message: string }) =>
    request<ApiResponse<StatusPageReportUpdate>>(`/status-page/admin/reports/${id}/updates`, {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  saveMaintenance: (data: {
    id?: number | null;
    title: string;
    message: string;
    status: StatusPageMaintenanceStatus;
    startsAt: string;
    endsAt: string;
    componentIds: number[];
  }) =>
    request<ApiResponse<StatusPageMaintenance>>('/status-page/admin/maintenances', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteMaintenance: (id: number) =>
    request<ApiResponse<void>>(`/status-page/admin/maintenances/${id}`, { method: 'DELETE' }),
};

export const emailApi = {
  transport: () =>
    request<ApiResponse<EmailTransportAdminView>>('/email/admin/transport'),

  notificationRecipients: () =>
    request<ApiResponse<AdminEmailSubscription[]>>('/email/admin/notification-recipients'),

  statusSubscribers: () =>
    request<ApiResponse<StatusPageSubscriber[]>>('/email/admin/status-subscribers'),

  deliveries: () =>
    request<ApiResponse<EmailDelivery[]>>('/email/admin/deliveries'),

  saveRelay: (data: {
    id?: number | null;
    name: string;
    relayType: EmailRelayType;
    enabled: boolean;
    priority: number;
    smtpHost: string | null;
    smtpPort: number | null;
    smtpSecurity: EmailSmtpSecurity;
    tlsMode: EmailTlsMode;
    username: string | null;
    password?: string | null;
    robinServiceId: string | null;
    postfixServiceId: string | null;
  }) =>
    request<ApiResponse<EmailRelay>>('/email/admin/relays', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteRelay: (id: number) =>
    request<ApiResponse<void>>(`/email/admin/relays/${id}`, { method: 'DELETE' }),

  updateSender: (profileKey: EmailSenderProfileKey, data: {
    fromName: string;
    fromEmail: string;
    replyTo: string | null;
    envelopeFrom: string | null;
    enabled: boolean;
    relayIds: number[];
  }) =>
    request<ApiResponse<EmailSenderProfile>>(`/email/admin/senders/${profileKey}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  updateAdminSubscription: (adminId: number, data: {
    monitoringIssueOpened: boolean;
    monitoringIssueRecovered: boolean;
    statusPageReports: boolean;
    emailDeliveryFailure: boolean;
  }) =>
    request<ApiResponse<AdminEmailSubscription>>(`/email/admin/notification-recipients/${adminId}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    }),

  sendTest: (data: { profileKey: EmailSenderProfileKey; recipientEmail?: string; subject?: string }) =>
    request<ApiResponse<void>>('/email/admin/test', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  deleteStatusSubscriber: (id: number) =>
    request<ApiResponse<void>>(`/email/admin/status-subscribers/${id}`, { method: 'DELETE' }),

  subscribeToStatusPage: (data: { email: string; allComponents: boolean; componentIds: number[] }) =>
    request<ApiResponse<void>>('/email/public/status-subscriptions', {
      method: 'POST',
      body: JSON.stringify(data),
    }),

  confirmStatusSubscription: (token: string) =>
    request<ApiResponse<{ confirmed: boolean }>>('/email/public/status-subscriptions/confirm', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),

  unsubscribeStatusSubscription: (token: string) =>
    request<ApiResponse<{ unsubscribed: boolean }>>('/email/public/status-subscriptions/unsubscribe', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
};

// =============================================================================
// REPORTING INTELLIGENCE API
// =============================================================================

import type {
  ComplianceClass,
  DomainAggregate,
  DomainSort,
  DomainWorkspace,
  IssueSeverity,
  RecordRow,
  RecordSort,
  ReportingIssue,
  ReportingOverview,
  SortDirection as ReportingSortDirection,
  SourceAggregate,
  SourceBucket,
  SourceBucketCounts,
  SourceReviewState,
  SourceSort,
  TimeframeInfo,
  TimeframeQuery,
} from '../types/reporting';

/**
 * Serialise reporting query parameters, dropping anything unset so the server
 * can tell "not filtered" from "filtered to false".
 */
function buildReportingQuery(query: object): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.append(key, String(value));
  }
  const qs = params.toString();
  return qs ? `?${qs}` : '';
}

/** Dashboard reporting widgets */
export const dashboardReportingApi = {
  get: () =>
    request<ApiResponse<{
      issuesBySeverity: Record<IssueSeverity, number>;
      latestIssues: ReportingIssue[];
      topProblematicDomains: Array<{
        domain: string;
        openIssues: number;
        criticalIssues: number;
        riskScore: number;
        trend: 'improving' | 'stable' | 'degrading' | 'unknown';
      }>;
      senderClassificationMix: Array<{ classification: string; count: number; volume: number }>;
      dmarcPassRate7d: Array<{ day: string; rate: number }>;
      tlsSuccessRate7d: Array<{ day: string; rate: number }>;
    }>>(`/dashboard/reporting`),
};

/**
 * Reporting API — every call carries the timeframe.
 *
 * The timeframe is an explicit parameter on every call and is echoed back in
 * the response, so the UI can always state what period it is showing.
 */
export const reportingApi = {
  /** True extent of the report data plus the resolved window. */
  getTimeframe: (query: TimeframeQuery = {}) =>
    request<ApiResponse<TimeframeInfo>>(`/reporting/timeframe${buildReportingQuery(query)}`),

  getOverview: (query: TimeframeQuery = {}) =>
    request<ApiResponse<ReportingOverview>>(`/reporting/overview${buildReportingQuery(query)}`),

  getSources: (
    query: TimeframeQuery & {
      bucket?: SourceBucket | 'all';
      search?: string;
      sort?: SourceSort;
      direction?: ReportingSortDirection;
      limit?: number;
      offset?: number;
    } = {}
  ) =>
    request<
      PaginatedResponse<SourceAggregate> & { meta: { timeframe: TimeframeInfo; buckets: SourceBucketCounts } }
    >(`/reporting/sources${buildReportingQuery(query)}`),

  /** Record an operator decision about a service, across every domain it sends for. */
  reviewSource: (key: string, state: SourceReviewState, note?: string) =>
    request<ApiResponse<{ key: string; state: SourceReviewState; note: string | null }>>(
      `/reporting/sources/${encodeURIComponent(key)}/review`,
      { method: 'POST', body: JSON.stringify({ state, note }) }
    ),

  /** Refresh IP-to-service identification. */
  resolveSources: (limit?: number) =>
    request<ApiResponse<{ considered: number; resolved: number; identified: number; failed: number }>>(
      '/reporting/sources/resolve',
      { method: 'POST', body: JSON.stringify({ limit }) }
    ),

  getDomains: (
    query: TimeframeQuery & {
      search?: string;
      sort?: DomainSort;
      direction?: ReportingSortDirection;
      limit?: number;
      offset?: number;
    } = {}
  ) =>
    request<
      PaginatedResponse<DomainAggregate> & {
        meta: {
          timeframe: TimeframeInfo;
          fleet: { complianceRate: number; totalVolume: number; actionableFailureVolume: number };
        };
      }
    >(`/reporting/domains${buildReportingQuery(query)}`),

  getDomain: (domain: string, query: TimeframeQuery = {}) =>
    request<ApiResponse<DomainWorkspace>>(
      `/reporting/domains/${encodeURIComponent(domain)}${buildReportingQuery(query)}`
    ),

  getRecords: (
    query: TimeframeQuery & {
      class?: ComplianceClass;
      disposition?: string;
      reason?: string;
      spfAligned?: boolean;
      dkimAligned?: boolean;
      search?: string;
      sort?: RecordSort;
      direction?: ReportingSortDirection;
      limit?: number;
      offset?: number;
    } = {}
  ) =>
    request<PaginatedResponse<RecordRow> & { meta: { timeframe: TimeframeInfo } }>(
      `/reporting/records${buildReportingQuery(query)}`
    ),
};

export type {
  FleetDashboard,
  FleetService,
  FleetServiceHealth,
  FleetServiceType,
  RobinInstance,
  RspamdMetricsSnapshot,
  RspamdMetricsStats,
};

export { ApiError };
