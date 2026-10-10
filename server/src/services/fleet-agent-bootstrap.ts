/**
 * Provision fleet agents declaratively from FLEET_AGENTS_BOOTSTRAP_JSON on
 * startup — the agent analogue of MODULES_BOOTSTRAP_JSON. Each entry names an
 * agent with a KNOWN id + credential so a co-located agent (a docker-compose
 * sidecar, an ansible-rendered systemd unit) can come up pre-enrolled via
 * ROBIN_AGENT_ID + ROBIN_AGENT_CREDENTIAL, with no interactive one-time-token
 * step. Idempotent: re-running never churns an unchanged credential.
 *
 * This only PROVISIONS the agents (which depend on nothing). The per-service
 * axis assignments (agent_id / config_agent_id / log_agent_id) are applied
 * separately in SQL seeding, which runs after the fleet_services rows exist.
 */

import { provisionFleetAgent } from '../db/queries/fleet-agents.js';
import { logger } from '../logger.js';

interface AgentBootstrapEntry {
  agentId: string;
  name: string;
  credential: string;
  os?: string;
  arch?: string;
  labels?: Record<string, unknown>;
}

function parseEntries(raw: string): AgentBootstrapEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    logger.error('FLEET_AGENTS_BOOTSTRAP_JSON is not valid JSON; skipping', { error: (error as Error).message });
    return [];
  }
  if (!Array.isArray(parsed)) {
    logger.error('FLEET_AGENTS_BOOTSTRAP_JSON must be a JSON array; skipping');
    return [];
  }
  const entries: AgentBootstrapEntry[] = [];
  for (const item of parsed) {
    if (
      item && typeof item === 'object'
      && typeof (item as Record<string, unknown>).agentId === 'string'
      && typeof (item as Record<string, unknown>).name === 'string'
      && typeof (item as Record<string, unknown>).credential === 'string'
    ) {
      const rec = item as Record<string, unknown>;
      entries.push({
        agentId: rec.agentId as string,
        name: rec.name as string,
        credential: rec.credential as string,
        os: typeof rec.os === 'string' ? rec.os : undefined,
        arch: typeof rec.arch === 'string' ? rec.arch : undefined,
        labels: rec.labels && typeof rec.labels === 'object' && !Array.isArray(rec.labels)
          ? (rec.labels as Record<string, unknown>)
          : undefined,
      });
    } else {
      logger.warn('Skipping FLEET_AGENTS_BOOTSTRAP_JSON entry missing agentId/name/credential');
    }
  }
  return entries;
}

export async function bootstrapFleetAgentsFromConfig(): Promise<void> {
  const raw = process.env.FLEET_AGENTS_BOOTSTRAP_JSON?.trim();
  if (!raw) {
    return;
  }
  const entries = parseEntries(raw);
  for (const entry of entries) {
    try {
      await provisionFleetAgent(entry);
      logger.info('Provisioned fleet agent from bootstrap config', { agentId: entry.agentId, name: entry.name });
    } catch (error) {
      logger.error('Failed to provision bootstrap fleet agent', { agentId: entry.agentId, error: (error as Error).message });
    }
  }
}
