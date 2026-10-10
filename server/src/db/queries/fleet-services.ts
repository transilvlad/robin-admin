/**
 * Database queries for fleet service management, over the generic
 * fleet_services registry. Also exposes a typed Robin-instance accessor
 * (`getInstanceById`) that maps a Robin fleet service to the connection shape
 * robin-api needs.
 */

import { config } from '../../config.js';
import { query } from '../connection.js';
import { DSN_PROTOCOLS, FLEET_SERVICE_TYPES, type FleetServiceType } from '../../services/service-types.js';
import { decryptStoredSecret, encryptStoredSecret } from './secret-crypto.js';
import { logger } from '../../logger.js';

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
  /** The identity matched by Telemetry's configured source label. */
  telemetrySource: string | null;
  enabled: boolean;
  agentId: string | null;
  collectionMode: 'direct' | 'agent';
  logAgentId: string | null;
  configAgentId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * The Robin-connection view of a fleet service — the shape
 * services/robin-api.ts uses to reach a Robin instance. Every instance uses
 * the configured Robin API credentials (ROBIN_API_AUTH).
 */
export interface RobinInstance extends FleetService {
  serviceType: 'robin';
  apiUrl: string;
  apiAuth: string | null;
  metricsUrl: string | null;
}

export interface CreateFleetServiceInput {
  serviceId: string;
  serviceType: FleetServiceType;
  name: string;
  description?: string | null;
  apiUrl?: string | null;
  healthUrl?: string | null;
  metricsUrl?: string | null;
  controllerUrl?: string | null;
  normalUrl?: string | null;
  telemetrySource?: string | null;
  enabled?: boolean;
}

export interface UpdateFleetServiceInput {
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
}

export interface FleetServiceFilters {
  serviceType?: FleetServiceType;
  enabled?: boolean;
}

export interface FleetServiceCount {
  total: number;
  enabled: number;
  byType: Record<FleetServiceType, {
    total: number;
    enabled: number;
  }>;
}

interface DbFleetService {
  id: number;
  service_id: string;
  service_type: FleetServiceType;
  name: string;
  description: string | null;
  api_url: string | null;
  health_url: string | null;
  metrics_url: string | null;
  controller_url: string | null;
  normal_url: string | null;
  telemetry_source: string | null;
  enabled: boolean;
  agent_id: string | null;
  collection_mode: 'direct' | 'agent';
  log_agent_id: string | null;
  config_agent_id: string | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Metrics URLs with a DSN scheme are stored encrypted (see encodeMetricsUrl),
 * whatever the service type, so decode by the stored shape. A value that does
 * not decrypt yields null instead of failing every fleet service listing.
 */
function decodeMetricsUrl(row: DbFleetService): string | null {
  const stored = row.metrics_url;
  if (!stored || !stored.startsWith('{')) return stored;
  try {
    return decryptStoredSecret(stored);
  } catch (error) {
    logger.error('Fleet service metrics URL could not be decrypted', { serviceId: row.service_id, error: (error as Error).message });
    return null;
  }
}

function mapFleetService(row: DbFleetService): FleetService {
  return {
    id: row.id,
    serviceId: row.service_id,
    serviceType: row.service_type,
    name: row.name,
    description: row.description,
    apiUrl: row.api_url,
    healthUrl: row.health_url,
    metricsUrl: decodeMetricsUrl(row),
    controllerUrl: row.controller_url,
    normalUrl: row.normal_url,
    telemetrySource: row.telemetry_source,
    enabled: row.enabled,
    agentId: row.agent_id,
    collectionMode: row.collection_mode,
    logAgentId: row.log_agent_id,
    configAgentId: row.config_agent_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapRobinInstance(service: FleetService): RobinInstance {
  if (service.serviceType !== 'robin') {
    throw new Error(`Service ${service.serviceId} is not a Robin service`);
  }

  return {
    ...service,
    serviceType: 'robin',
    apiUrl: service.apiUrl ?? '',
    apiAuth: config.robin.apiAuth ?? null,
    metricsUrl: service.metricsUrl ?? service.apiUrl,
  };
}

function buildFleetServiceFilterSql(filters: FleetServiceFilters = {}): {
  whereClause: string;
  params: Array<string | boolean>;
} {
  const conditions: string[] = [];
  const params: Array<string | boolean> = [];

  if (filters.serviceType) {
    params.push(filters.serviceType);
    conditions.push(`service_type = $${params.length}`);
  }

  if (filters.enabled !== undefined) {
    params.push(filters.enabled);
    conditions.push(`enabled = $${params.length}`);
  }

  return {
    whereClause: conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '',
    params,
  };
}

/**
 * Get fleet services with optional filters.
 */
export async function getFleetServices(filters: FleetServiceFilters = {}): Promise<FleetService[]> {
  const { whereClause, params } = buildFleetServiceFilterSql(filters);
  const result = await query<DbFleetService>(
    `SELECT id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at
     FROM fleet_services${whereClause}
     ORDER BY name ASC`,
    params
  );

  return result.rows.map(mapFleetService);
}

/**
 * Get all fleet services.
 */
export async function getAllFleetServices(): Promise<FleetService[]> {
  return getFleetServices();
}

/**
 * Get all enabled fleet services, optionally filtered by type.
 */
export async function getEnabledFleetServices(serviceType?: FleetServiceType): Promise<FleetService[]> {
  return getFleetServices({
    serviceType,
    enabled: true,
  });
}

/**
 * Get all fleet services of a given type.
 */
export async function getFleetServicesByType(serviceType: FleetServiceType): Promise<FleetService[]> {
  return getFleetServices({ serviceType });
}

/**
 * Get a single fleet service by service_id.
 */
export async function getFleetServiceById(serviceId: string): Promise<FleetService | null> {
  const result = await query<DbFleetService>(
    `SELECT id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at
     FROM fleet_services
     WHERE service_id = $1`,
    [serviceId]
  );

  return result.rows.length > 0 ? mapFleetService(result.rows[0]) : null;
}

/**
 * Get a single fleet service by service_id and service_type.
 */
export async function getFleetServiceByIdAndType(
  serviceId: string,
  serviceType: FleetServiceType
): Promise<FleetService | null> {
  const result = await query<DbFleetService>(
    `SELECT id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at
     FROM fleet_services
     WHERE service_id = $1 AND service_type = $2`,
    [serviceId, serviceType]
  );

  return result.rows.length > 0 ? mapFleetService(result.rows[0]) : null;
}

/**
 * The primary (preferred) fleet service of a type — enabled first, then most
 * recently updated. Used where a single service of a type is needed.
 */
export async function getPrimaryFleetService(serviceType: FleetServiceType): Promise<FleetService | null> {
  const result = await query<DbFleetService>(
    `SELECT id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at
     FROM fleet_services
     WHERE service_type = $1
     ORDER BY enabled DESC, updated_at DESC, created_at DESC, service_id ASC
     LIMIT 1`,
    [serviceType]
  );

  return result.rows.length > 0 ? mapFleetService(result.rows[0]) : null;
}

/**
 * Create a new fleet service.
 */
export async function createFleetService(data: CreateFleetServiceInput): Promise<FleetService> {
  const result = await query<DbFleetService>(
    `INSERT INTO fleet_services (service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at`,
    [
      data.serviceId,
      data.serviceType,
      data.name,
      data.description ?? null,
      data.apiUrl ?? null,
      data.healthUrl ?? null,
      encodeMetricsUrl(data.metricsUrl ?? data.apiUrl ?? null),
      data.controllerUrl ?? null,
      data.normalUrl ?? null,
      normalizeOptionalString(data.telemetrySource ?? null),
      data.enabled ?? true,
    ]
  );

  return mapFleetService(result.rows[0]);
}

function normalizeOptionalString(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? '';
  return trimmed ? trimmed : null;
}

function encodeMetricsUrl(value: string | null | undefined): string | null {
  const url = normalizeOptionalString(value);
  const scheme = url ? /^([a-z][a-z0-9+.-]*:)\/\//i.exec(url)?.[1]?.toLowerCase() : undefined;
  return url && scheme && Object.values(DSN_PROTOCOLS).some(protocols => protocols?.includes(scheme)) ? encryptStoredSecret(url) : url;
}

/**
 * Update an existing fleet service.
 */
export async function updateFleetService(
  serviceId: string,
  data: UpdateFleetServiceInput
): Promise<FleetService | null> {
  const sets: string[] = [];
  const values: Array<string | boolean | null> = [];
  let paramIndex = 1;

  if (data.serviceId !== undefined) {
    sets.push(`service_id = $${paramIndex++}`);
    values.push(data.serviceId);
  }

  if (data.name !== undefined) {
    sets.push(`name = $${paramIndex++}`);
    values.push(data.name);
  }

  if (data.description !== undefined) {
    sets.push(`description = $${paramIndex++}`);
    values.push(normalizeOptionalString(data.description));
  }

  if (data.apiUrl !== undefined) {
    sets.push(`api_url = $${paramIndex++}`);
    values.push(normalizeOptionalString(data.apiUrl));
  }

  if (data.healthUrl !== undefined) {
    sets.push(`health_url = $${paramIndex++}`);
    values.push(normalizeOptionalString(data.healthUrl));
  }

  if (data.metricsUrl !== undefined) {
    sets.push(`metrics_url = $${paramIndex++}`);
    values.push(encodeMetricsUrl(data.metricsUrl));
  }

  if (data.controllerUrl !== undefined) {
    sets.push(`controller_url = $${paramIndex++}`);
    values.push(normalizeOptionalString(data.controllerUrl));
  }

  if (data.normalUrl !== undefined) {
    sets.push(`normal_url = $${paramIndex++}`);
    values.push(normalizeOptionalString(data.normalUrl));
  }

  if (data.telemetrySource !== undefined) {
    sets.push(`telemetry_source = $${paramIndex++}`);
    values.push(normalizeOptionalString(data.telemetrySource));
  }

  if (data.enabled !== undefined) {
    sets.push(`enabled = $${paramIndex++}`);
    values.push(data.enabled);
  }

  if (sets.length === 0) {
    return getFleetServiceById(serviceId);
  }

  sets.push('updated_at = CURRENT_TIMESTAMP');
  values.push(serviceId);

  const result = await query<DbFleetService>(
    `UPDATE fleet_services
     SET ${sets.join(', ')}
     WHERE service_id = $${paramIndex}
     RETURNING id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at`,
    values
  );

  return result.rows.length > 0 ? mapFleetService(result.rows[0]) : null;
}

/**
 * Delete a fleet service.
 */
export async function deleteFleetService(serviceId: string): Promise<boolean> {
  const result = await query(
    `DELETE FROM fleet_services WHERE service_id = $1`,
    [serviceId]
  );

  return (result.rowCount ?? 0) > 0;
}

/**
 * Check if a fleet service exists.
 */
export async function fleetServiceExists(
  serviceId: string,
  serviceType?: FleetServiceType
): Promise<boolean> {
  const result = serviceType
    ? await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM fleet_services WHERE service_id = $1 AND service_type = $2)`,
      [serviceId, serviceType]
    )
    : await query<{ exists: boolean }>(
      `SELECT EXISTS(SELECT 1 FROM fleet_services WHERE service_id = $1)`,
      [serviceId]
    );

  return result.rows[0]?.exists ?? false;
}

/**
 * Get fleet service counts with per-type breakdowns.
 */
export async function getFleetServiceCount(): Promise<FleetServiceCount> {
  // Build the per-type FILTER columns from the registry so a new service type is
  // counted automatically. `service_type` is constrained by a CHECK to the same
  // list, so interpolating the literal here is safe.
  const perTypeColumns = FLEET_SERVICE_TYPES.map((type) =>
    `COUNT(*) FILTER (WHERE service_type = '${type}') AS ${type}_total,
       COUNT(*) FILTER (WHERE service_type = '${type}' AND enabled = true) AS ${type}_enabled`
  ).join(',\n       ');

  const result = await query<Record<string, string>>(
    `SELECT
       COUNT(*) AS total,
       COUNT(*) FILTER (WHERE enabled = true) AS enabled,
       ${perTypeColumns}
     FROM fleet_services`
  );

  const row = result.rows[0] ?? {};

  const byType = Object.fromEntries(
    FLEET_SERVICE_TYPES.map((type) => [type, {
      total: parseInt(row[`${type}_total`] ?? '0', 10),
      enabled: parseInt(row[`${type}_enabled`] ?? '0', 10),
    }])
  ) as FleetServiceCount['byType'];

  return {
    total: parseInt(row.total ?? '0', 10),
    enabled: parseInt(row.enabled ?? '0', 10),
    byType,
  };
}

/**
 * Bind a service to an agent (collection_mode → 'agent') or release it back to
 * direct mode (agentId = null → collection_mode 'direct').
 */
export async function assignFleetServiceAgent(serviceId: string, agentId: string | null): Promise<FleetService | null> {
  const collectionMode = agentId ? 'agent' : 'direct';
  const result = await query<DbFleetService>(
    `UPDATE fleet_services
     SET agent_id = $2, collection_mode = $3, updated_at = CURRENT_TIMESTAMP
     WHERE service_id = $1
     RETURNING id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at`,
    [serviceId, agentId, collectionMode]
  );
  return result.rows.length > 0 ? mapFleetService(result.rows[0]) : null;
}

/**
 * Bind (or release, id = null) the agent that ships a service's LOGS. Independent
 * of collection_mode: a direct-metrics service can still have a co-located agent
 * tail its root-owned logs. A metrics agent (agent_id) is already the implicit
 * log agent, so setting log_agent_id to the same value is redundant but harmless.
 */
export async function assignFleetServiceLogAgent(serviceId: string, logAgentId: string | null): Promise<FleetService | null> {
  const result = await query<DbFleetService>(
    `UPDATE fleet_services
     SET log_agent_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE service_id = $1
     RETURNING id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at`,
    [serviceId, logAgentId]
  );
  return result.rows.length > 0 ? mapFleetService(result.rows[0]) : null;
}

/**
 * Bind (or release, id = null) the agent that applies a service's managed CONFIG.
 * Independent of collection_mode: a direct-metrics service can still have a
 * co-located agent write + reload its config in-process (rspamd's case). A
 * metrics agent (agent_id) is already the implicit config agent.
 */
/** The service's version as its agent last reported it, or null. */
export async function getFleetServiceSoftwareVersion(serviceId: string): Promise<string | null> {
  const result = await query<{ software_version: string | null }>(
    'SELECT software_version FROM fleet_services WHERE service_id = $1',
    [serviceId]
  );
  return result.rows[0]?.software_version ?? null;
}

/** Record an agent-reported version; a no-op when it hasn't changed. */
export async function setFleetServiceSoftwareVersion(fleetServiceId: number, version: string): Promise<void> {
  await query(
    `UPDATE fleet_services SET software_version = $2
     WHERE id = $1 AND software_version IS DISTINCT FROM $2`,
    [fleetServiceId, version]
  );
}

export async function assignFleetServiceConfigAgent(serviceId: string, configAgentId: string | null): Promise<FleetService | null> {
  const result = await query<DbFleetService>(
    `UPDATE fleet_services
     SET config_agent_id = $2, updated_at = CURRENT_TIMESTAMP
     WHERE service_id = $1
     RETURNING id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at`,
    [serviceId, configAgentId]
  );
  return result.rows.length > 0 ? mapFleetService(result.rows[0]) : null;
}

/**
 * A service the agent is responsible for, with the per-axis capability flags the
 * agent uses to decide what to collect. A metrics agent (collection_mode='agent'
 * & agent_id=X) does metrics+config+logs; a logs-only agent (log_agent_id=X)
 * does logs alone.
 */
export interface AgentServiceResponsibility extends FleetService {
  collectMetrics: boolean;
  collectConfig: boolean;
  collectLogs: boolean;
}

/**
 * Every service this agent must act on: those it collects metrics/config for
 * (agent_id = X) UNION those it only tails logs for (log_agent_id = X).
 */
export async function getAgentServiceResponsibilities(agentId: string): Promise<AgentServiceResponsibility[]> {
  const result = await query<DbFleetService>(
    `SELECT id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, telemetry_source, enabled, agent_id, collection_mode, log_agent_id, config_agent_id, created_at, updated_at
     FROM fleet_services
     WHERE agent_id = $1 OR log_agent_id = $1 OR config_agent_id = $1
     ORDER BY name ASC`,
    [agentId]
  );
  return result.rows.map((row) => {
    const service = mapFleetService(row);
    return { ...service, ...agentAxesFor(service, agentId) };
  });
}

/**
 * Which axes an agent works for a service. A full metrics agent
 * (collection_mode='agent' & agent_id=X) also does config and logs, unless
 * config_agent_id / log_agent_id hand that axis to a named agent: then only
 * that agent does it, so two agents never both apply one service's config or
 * ship its logs twice.
 */
export function agentAxesFor(
  service: Pick<FleetService, 'collectionMode' | 'agentId' | 'configAgentId' | 'logAgentId'>,
  agentId: string,
): Pick<AgentServiceResponsibility, 'collectMetrics' | 'collectConfig' | 'collectLogs'> {
  const metricsOwned = service.collectionMode === 'agent' && service.agentId === agentId;
  return {
    collectMetrics: metricsOwned,
    collectConfig: service.configAgentId ? service.configAgentId === agentId : metricsOwned,
    collectLogs: service.logAgentId ? service.logAgentId === agentId : metricsOwned,
  };
}

/**
 * Fetch a Robin fleet service as a `RobinInstance` (apiUrl/metricsUrl/…),
 * the shape services/robin-api.ts talks to Robin with.
 */
export async function getInstanceById(instanceId: string): Promise<RobinInstance | null> {
  const service = await getFleetServiceByIdAndType(instanceId, 'robin');
  return service ? mapRobinInstance(service) : null;
}
