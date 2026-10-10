/**
 * Provision fleet SERVICES declaratively from FLEET_SERVICES_BOOTSTRAP_JSON on
 * startup — the service analogue of FLEET_AGENTS_BOOTSTRAP_JSON. Each entry
 * registers a fleet service (idempotent: inserted only when absent) and applies
 * its collection-axis wiring: metrics agent (agentId → collection_mode 'agent'),
 * log agent, config agent.
 *
 * Runs AFTER the agents bootstrap so the axis FKs resolve; each axis assignment
 * is guarded on the referenced agent existing, so a partial config never throws.
 * An entry may also be wiring-only (serviceId + an axis, no serviceType/name) to
 * bind an agent onto a service registered elsewhere (e.g. rspamd's config agent).
 *
 * Replaces the suite's one-shot db-seed container + seed-fleet-services.sql — and
 * seeds NO managed-config rows: an unset scope already resolves to the code
 * defaults, and per-instance overrides store only deltas, so seeding
 * default-valued rows was redundant.
 */

import {
  assignFleetServiceAgent,
  assignFleetServiceConfigAgent,
  assignFleetServiceLogAgent,
  createFleetService,
  getFleetServiceById,
  updateFleetService,
} from '../db/queries/fleet-services.js';
import { getFleetAgentById } from '../db/queries/fleet-agents.js';
import { FLEET_SERVICE_TYPES, type FleetServiceType } from './service-types.js';
import { logger } from '../logger.js';

interface ServiceBootstrapEntry {
  serviceId: string;
  serviceType?: FleetServiceType;
  name?: string;
  description?: string | null;
  apiUrl?: string | null;
  healthUrl?: string | null;
  metricsUrl?: string | null;
  controllerUrl?: string | null;
  normalUrl?: string | null;
  enabled?: boolean;
  /** Metrics agent — sets collection_mode to 'agent'. `null` releases to direct. */
  agentId?: string | null;
  /** Log-shipping agent. `null` clears it. */
  logAgentId?: string | null;
  /** Config-applying agent. `null` clears it. */
  configAgentId?: string | null;
}

const SERVICE_TYPES = new Set<string>(FLEET_SERVICE_TYPES);
const optStr = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
const optStrOrNull = (v: unknown): string | null | undefined =>
  v === null ? null : typeof v === 'string' ? v : undefined;

function parseEntries(raw: string): ServiceBootstrapEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.error('FLEET_SERVICES_BOOTSTRAP_JSON is not valid JSON; skipping', { error: (error as Error).message });
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.error('FLEET_SERVICES_BOOTSTRAP_JSON must be a JSON array; skipping');
    return [];
  }
  const entries: ServiceBootstrapEntry[] = [];
  for (const item of parsed) {
    const rec = item as Record<string, unknown>;
    if (!rec || typeof rec !== 'object' || typeof rec.serviceId !== 'string') {
      logger.warn('Skipping FLEET_SERVICES_BOOTSTRAP_JSON entry missing serviceId');
      continue;
    }
    const serviceType = optStr(rec.serviceType);
    if (serviceType !== undefined && !SERVICE_TYPES.has(serviceType)) {
      logger.warn('Skipping FLEET_SERVICES_BOOTSTRAP_JSON entry with unknown serviceType', { serviceType });
      continue;
    }
    entries.push({
      serviceId: rec.serviceId,
      serviceType: serviceType as FleetServiceType | undefined,
      name: optStr(rec.name),
      description: optStrOrNull(rec.description),
      apiUrl: optStrOrNull(rec.apiUrl),
      healthUrl: optStrOrNull(rec.healthUrl),
      metricsUrl: optStrOrNull(rec.metricsUrl),
      controllerUrl: optStrOrNull(rec.controllerUrl),
      normalUrl: optStrOrNull(rec.normalUrl),
      enabled: typeof rec.enabled === 'boolean' ? rec.enabled : undefined,
      agentId: optStrOrNull(rec.agentId),
      logAgentId: optStrOrNull(rec.logAgentId),
      configAgentId: optStrOrNull(rec.configAgentId),
    });
  }
  return entries;
}

// Apply one axis. Undefined → leave as-is; null → clear; a value → bind, but only
// when the agent exists (the axis columns FK to fleet_agents).
async function applyAxis(
  serviceId: string,
  agentId: string | null | undefined,
  assign: (serviceId: string, agentId: string | null) => Promise<unknown>,
  axis: string,
): Promise<void> {
  if (agentId === undefined) return;
  if (agentId !== null && !(await getFleetAgentById(agentId))) {
    logger.warn('Skipping fleet-service axis wiring; agent not provisioned', { serviceId, agentId, axis });
    return;
  }
  await assign(serviceId, agentId);
}

export async function bootstrapFleetServicesFromConfig(): Promise<void> {
  const raw = process.env.FLEET_SERVICES_BOOTSTRAP_JSON?.trim();
  if (!raw) {
    return;
  }
  for (const entry of parseEntries(raw)) {
    try {
      // Upsert the registration when fully specified: create if absent, else
      // re-assert the infra-owned fields (name/urls/enabled). This only touches
      // registration columns — never the agent-axis columns (agent_id /
      // collection_mode / log_agent_id / config_agent_id) or the config store —
      // so a UI-assigned agent or edited config is never clobbered.
      if (entry.serviceType && entry.name) {
        const existing = await getFleetServiceById(entry.serviceId);
        if (!existing) {
          await createFleetService({
            serviceId: entry.serviceId,
            serviceType: entry.serviceType,
            name: entry.name,
            description: entry.description ?? null,
            apiUrl: entry.apiUrl ?? null,
            healthUrl: entry.healthUrl ?? null,
            metricsUrl: entry.metricsUrl ?? null,
            controllerUrl: entry.controllerUrl ?? null,
            normalUrl: entry.normalUrl ?? null,
            enabled: entry.enabled ?? true,
          });
          logger.info('Registered fleet service from bootstrap config', { serviceId: entry.serviceId });
        } else {
          await updateFleetService(entry.serviceId, {
            name: entry.name,
            description: entry.description,
            apiUrl: entry.apiUrl,
            healthUrl: entry.healthUrl,
            metricsUrl: entry.metricsUrl,
            controllerUrl: entry.controllerUrl,
            normalUrl: entry.normalUrl,
            enabled: entry.enabled,
          });
        }
      }
      await applyAxis(entry.serviceId, entry.agentId, assignFleetServiceAgent, 'metrics');
      await applyAxis(entry.serviceId, entry.logAgentId, assignFleetServiceLogAgent, 'log');
      await applyAxis(entry.serviceId, entry.configAgentId, assignFleetServiceConfigAgent, 'config');
    } catch (error) {
      logger.error('Failed to bootstrap fleet service', { serviceId: entry.serviceId, error: (error as Error).message });
    }
  }
}
