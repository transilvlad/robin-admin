import { query } from '../connection.js';
import type { FleetServiceType } from '../../services/service-types.js';

export type MetricsServiceType = FleetServiceType;

export interface MetricsFleetService {
  id: number;
  serviceId: string;
  serviceType: MetricsServiceType;
  name: string;
  description: string | null;
  apiUrl: string | null;
  healthUrl: string | null;
  metricsUrl: string | null;
  controllerUrl: string | null;
  normalUrl: string | null;
  enabled: boolean;
  agentId: string | null;
  collectionMode: 'direct' | 'agent';
}

interface MetricsFleetServiceRow {
  id: number;
  service_id: string;
  service_type: MetricsServiceType;
  name: string;
  description: string | null;
  api_url: string | null;
  health_url: string | null;
  metrics_url: string | null;
  controller_url: string | null;
  normal_url: string | null;
  enabled: boolean;
  agent_id: string | null;
  collection_mode: 'direct' | 'agent';
}

function mapMetricsFleetService(row: MetricsFleetServiceRow): MetricsFleetService {
  return {
    id: row.id,
    serviceId: row.service_id,
    serviceType: row.service_type,
    name: row.name,
    description: row.description,
    apiUrl: row.api_url,
    healthUrl: row.health_url,
    metricsUrl: row.metrics_url,
    controllerUrl: row.controller_url,
    normalUrl: row.normal_url,
    enabled: row.enabled,
    agentId: row.agent_id,
    collectionMode: row.collection_mode,
  };
}

export async function getEnabledMetricsFleetServices(
  serviceType?: MetricsServiceType
): Promise<MetricsFleetService[]> {
  const params: string[] = [];
  const whereParts = ['enabled = true'];

  if (serviceType) {
    params.push(serviceType);
    whereParts.push(`service_type = $${params.length}`);
  }

  const result = await query<MetricsFleetServiceRow>(
    `SELECT id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, enabled, agent_id, collection_mode
     FROM fleet_services
     WHERE ${whereParts.join(' AND ')}
     ORDER BY service_type ASC, name ASC, service_id ASC`,
    params
  );

  return result.rows.map(mapMetricsFleetService);
}

export async function getMetricsFleetServiceById(
  serviceId: string,
  serviceType?: MetricsServiceType
): Promise<MetricsFleetService | null> {
  const params: string[] = [serviceId];
  const whereParts = ['service_id = $1'];

  if (serviceType) {
    params.push(serviceType);
    whereParts.push(`service_type = $${params.length}`);
  }

  const result = await query<MetricsFleetServiceRow>(
    `SELECT id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, enabled, agent_id, collection_mode
     FROM fleet_services
     WHERE ${whereParts.join(' AND ')}
     LIMIT 1`,
    params
  );

  return result.rows[0] ? mapMetricsFleetService(result.rows[0]) : null;
}

export async function getPrimaryMetricsFleetService(
  serviceType: MetricsServiceType
): Promise<MetricsFleetService | null> {
  const result = await query<MetricsFleetServiceRow>(
    `SELECT id, service_id, service_type, name, description, api_url, health_url, metrics_url, controller_url, normal_url, enabled, agent_id, collection_mode
     FROM fleet_services
     WHERE service_type = $1 AND enabled = true
     ORDER BY updated_at DESC, created_at DESC, service_id ASC
     LIMIT 1`,
    [serviceType]
  );

  return result.rows[0] ? mapMetricsFleetService(result.rows[0]) : null;
}
