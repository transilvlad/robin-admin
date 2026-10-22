/**
 * Live capabilities: the facts about each registered service, run through the
 * rule table in capability-rules.ts. The client hides every feature that comes
 * back unavailable.
 */
import { config } from '../config.js';
import { listFleetAgents, type FleetAgent } from '../db/queries/fleet-agents.js';
import { getAllFleetServices, type FleetService } from '../db/queries/fleet-services.js';
import { queueTableExists } from '../db/queries/queue.js';
import { robinConfigTableHasSchema } from '../db/queries/robin-config-meta.js';
import { getRspamdSettings } from '../db/queries/rspamd.js';
import { logger } from '../logger.js';
import {
  evaluateCapabilities,
  type AgentFacts,
  type CapabilityFacts,
  type CapabilityMap,
} from './capability-rules.js';
import { clamdEndpointOf } from './clamav.js';
import { isMariadbUrl, resolveMariadbDsn } from './mariadb.js';
import { isPostgresUrl, resolvePostgresDsn } from './postgres.js';
import { isRedisUrl, resolveRedisDsn } from './redis.js';
import { agentLogsLive, getServiceLogsAvailability } from './service-logs.js';
import { DSN_PROTOCOLS, FLEET_SERVICE_TYPES, type FleetServiceType } from './service-types.js';

export interface ServiceCapabilities {
  serviceId: string;
  serviceType: FleetServiceType;
  name: string;
  enabled: boolean;
  features: CapabilityMap;
}

export interface FleetCapabilities {
  services: ServiceCapabilities[];
  /** Per type, the features at least one enabled service has. */
  byType: Record<FleetServiceType, Record<string, boolean>>;
}

function isHttpUrl(value: string | null | undefined): boolean {
  return typeof value === 'string' && /^https?:\/\//i.test(value.trim());
}

function agentFacts(agents: Map<string, FleetAgent>, agentId: string | null, serviceId: string): AgentFacts | null {
  if (!agentId) return null;
  const agent = agents.get(agentId);
  if (!agent) return null;
  const report = agent.serviceReports[serviceId];
  if (!report) {
    // Until the agent reports, assume it runs next to the service.
    return { access: 'local', fileDelivery: true, actions: null };
  }
  return { access: report.access, fileDelivery: report.fileDelivery, actions: new Set(report.actions) };
}

function directEndpoint(service: FleetService): boolean {
  switch (service.serviceType) {
    case 'robin': return Boolean(service.metricsUrl || service.apiUrl);
    case 'rspamd': return Boolean(service.controllerUrl);
    case 'clamav': return clamdEndpointOf(service) !== null;
    case 'cyrus': return false;
    case 'dovecot':
    case 'postfix': return isHttpUrl(service.metricsUrl);
    case 'redis': return isRedisUrl(resolveRedisDsn(service));
    case 'postgres': return isPostgresUrl(resolvePostgresDsn(service));
    case 'mariadb': return isMariadbUrl(resolveMariadbDsn(service));
  }
}

interface SharedFacts {
  agents: Map<string, FleetAgent>;
  robinQueueTable: boolean;
  robinConfigStore: boolean;
}

export async function serviceFacts(service: FleetService, shared: SharedFacts): Promise<CapabilityFacts> {
  const metricsAgentId = service.collectionMode === 'agent' ? service.agentId : null;
  const logAgentId = service.logAgentId ?? metricsAgentId;
  const [logsLive, logsDirect, rspamdSettings] = await Promise.all([
    logAgentId ? agentLogsLive(service.serviceId) : Promise.resolve(false),
    logAgentId ? Promise.resolve(false) : getServiceLogsAvailability(service.serviceType, service.serviceId),
    service.serviceType === 'rspamd' ? getRspamdSettings(service.serviceId) : Promise.resolve(null),
  ]);
  const endpoint = directEndpoint(service);
  return {
    serviceType: service.serviceType,
    metricsMode: service.collectionMode,
    metricsAgent: agentFacts(shared.agents, metricsAgentId, service.serviceId),
    configAgent: agentFacts(shared.agents, service.configAgentId ?? metricsAgentId, service.serviceId),
    logs: logsLive || logsDirect,
    logsLive,
    endpoint,
    adminDsn: Boolean(DSN_PROTOCOLS[service.serviceType]) && endpoint,
    robinApi: config.robin.enabled !== false,
    robinQueueTable: shared.robinQueueTable,
    robinConfigStore: shared.robinConfigStore,
    rspamdController: Boolean(service.controllerUrl),
    rspamdNormal: Boolean(service.normalUrl || service.apiUrl),
    rspamdTrainingDir: Boolean(rspamdSettings?.rspamdTrainingDir.trim()),
    clamdAddress: clamdEndpointOf(service) !== null,
  };
}

async function computeFleetCapabilities(): Promise<FleetCapabilities> {
  const [services, agents, robinQueueTable, robinConfigStore] = await Promise.all([
    getAllFleetServices(),
    listFleetAgents(),
    queueTableExists().catch(() => false),
    robinConfigTableHasSchema().catch(() => false),
  ]);
  const shared: SharedFacts = {
    agents: new Map(agents.map((agent) => [agent.agentId, agent])),
    robinQueueTable,
    robinConfigStore,
  };

  const evaluated = await Promise.all(services.map(async (service): Promise<ServiceCapabilities> => {
    let features: CapabilityMap;
    try {
      features = evaluateCapabilities(await serviceFacts(service, shared));
    } catch (error) {
      logger.warn('Capability facts failed; hiding the service features', { serviceId: service.serviceId, error: (error as Error).message });
      features = {};
    }
    return { serviceId: service.serviceId, serviceType: service.serviceType, name: service.name, enabled: service.enabled, features };
  }));

  const byType = Object.fromEntries(FLEET_SERVICE_TYPES.map((type) => [type, {}])) as FleetCapabilities['byType'];
  for (const service of evaluated) {
    if (!service.enabled) continue;
    const typeFeatures = byType[service.serviceType];
    for (const [id, state] of Object.entries(service.features)) {
      typeFeatures[id] = (typeFeatures[id] ?? false) || state.available;
    }
  }
  return { services: evaluated, byType };
}

// Pages ask on every navigation; log probes shell out, so answers are shared briefly.
const CACHE_MS = 15_000;
let cached: { at: number; value: Promise<FleetCapabilities> } | null = null;

export function getFleetCapabilities(): Promise<FleetCapabilities> {
  if (!cached || Date.now() - cached.at > CACHE_MS) {
    const value = computeFleetCapabilities();
    cached = { at: Date.now(), value };
    value.catch(() => { cached = null; });
  }
  return cached.value;
}

/** Drop the cached answer after a change that alters capabilities (service or agent edits). */
export function invalidateFleetCapabilities(): void {
  cached = null;
}

export async function getServiceCapabilities(serviceId: string): Promise<ServiceCapabilities | null> {
  return (await getFleetCapabilities()).services.find((service) => service.serviceId === serviceId) ?? null;
}
