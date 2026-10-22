/**
 * Agent command channel: robin-admin queues a typed action for the agent that
 * owns a service, the agent picks it up over its outbound long-poll, runs the
 * matching allowlisted command locally, and posts the output back.
 *
 * robin-admin never sends argv -- only an action name plus validated arguments.
 * The agent maps each action to a fixed command, so a compromised admin can't
 * turn the channel into arbitrary remote execution.
 *
 * Each poll confirms the commands the previous poll returned (it sends their
 * ids), and anything unconfirmed is re-sent, so a command handed to a poll
 * whose response never arrived isn't lost. Agents skip ids they have already
 * run, so a re-send never runs twice.
 *
 * Commands are persisted in PostgreSQL, so queued work survives server restarts
 * until its command timeout expires and API replicas share the same queue.
 */

import type { FleetService } from '../db/queries/fleet-services.js';
import { operationsPolicy } from './operations-settings.js';
import {
  acknowledgeAgentCommands,
  agentRecentlyAdvertisedAction,
  completeAgentCommandResult,
  createAgentCommand,
  expireDueAgentCommands,
  getAgentCommand,
  leaseQueuedAgentCommands,
  markAgentCommandExpired,
  requeueAgentCommandsForAgent,
  requeueUnackedSentCommands,
  type AgentCommandRecord,
} from '../db/queries/agent-commands.js';

export const AGENT_COMMAND_ACTIONS = [
  'postfix.queue.list',
  'postfix.queue.show',
  'postfix.queue.hold',
  'postfix.queue.release',
  'postfix.queue.requeue',
  'postfix.queue.delete',
  'postfix.queue.deliver',
  'postfix.queue.flush',
  'postfix.reload',
  'dovecot.reload',
  'rspamd.reload',
  'dovecot.who',
  'dovecot.kick',
  'dovecot.quota',
  'dovecot.user',
  'cyrus.sessions',
  'cyrus.quota',
  'cyrus.user',
] as const;

export type AgentCommandAction = typeof AGENT_COMMAND_ACTIONS[number];

export interface AgentCommand {
  id: string;
  serviceId: string;
  serviceType: string;
  action: AgentCommandAction;
  args: Record<string, unknown>;
}

interface AgentPoller {
  actions: Set<string>;
  lastPollAt: number;
  cancelOpenPoll: (() => void) | null;
  wakeOpenPoll: (() => void) | null;
}

// An agent counts as connected while it has polled within this window. Agents
// re-poll immediately after each long-poll returns, so a live agent is never
// more than one poll-wait (~25s) stale.
const POLL_SLEEP_MS = 500;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const pollers = new Map<string, AgentPoller>();

function isAction(value: string): value is AgentCommandAction {
  return (AGENT_COMMAND_ACTIONS as readonly string[]).includes(value);
}

function normalizeCommandIds(ids: string[]): string[] {
  return ids.filter((id) => UUID_RE.test(id));
}

function toAgentCommand(record: AgentCommandRecord): AgentCommand {
  return {
    id: record.id,
    serviceId: record.serviceId,
    serviceType: record.serviceType,
    action: record.action as AgentCommandAction,
    args: record.args,
  };
}

function delay(ms: number, wake: (resume: () => void) => void): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    wake(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function wakePoller(agentId: string): void {
  const poller = pollers.get(agentId);
  const wake = poller?.wakeOpenPoll;
  if (wake) {
    poller.wakeOpenPoll = null;
    wake();
  }
}

/**
 * The agent that runs host commands for a service. Operational actions go to
 * the service's full (metrics) agent; reloads go to whichever agent applies its
 * config.
 */
export function commandAgentFor(service: FleetService, axis: 'metrics' | 'config'): string | null {
  const metricsAgent = service.collectionMode === 'agent' ? service.agentId : null;
  return axis === 'config' ? service.configAgentId ?? metricsAgent : metricsAgent;
}

export function agentSupports(agentId: string | null, action: AgentCommandAction): boolean {
  if (!agentId) return false;
  const poller = pollers.get(agentId);
  return Boolean(poller && Date.now() - poller.lastPollAt < operationsPolicy().fleetAgentOnlineThresholdMs && poller.actions.has(action));
}

async function waitForCommandResult(command: AgentCommandRecord, timeoutMs: number): Promise<string> {
  const timeoutMessage = `Agent ${command.agentId} did not answer ${command.action} within ${Math.round(timeoutMs / 1000)}s`;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await getAgentCommand(command.id);
    if (!current) {
      throw new Error(`${command.action} was not found`);
    }
    if (current.status === 'succeeded') {
      return current.resultOutput ?? '';
    }
    if (current.status === 'failed') {
      throw new Error(current.resultError?.trim() || `${command.action} failed`);
    }
    if (current.status === 'expired') {
      throw new Error(current.resultError?.trim() || timeoutMessage);
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(250, Math.max(1, deadline - Date.now()))));
  }
  const expired = await markAgentCommandExpired(command.id, timeoutMessage);
  // A result can be recorded between our last read and the conditional expiry.
  const final = expired ?? await getAgentCommand(command.id);
  if (final?.status === 'succeeded') return final.resultOutput ?? '';
  throw new Error(final?.resultError?.trim() || timeoutMessage);
}

/** Queue an action for an agent and wait for its output. */
export async function runAgentCommand(
  agentId: string,
  service: Pick<FleetService, 'serviceId' | 'serviceType'>,
  action: AgentCommandAction,
  args: Record<string, unknown> = {},
  timeoutMs = operationsPolicy().fleetCommandTimeoutMs,
): Promise<string> {
  const supported = agentSupports(agentId, action) || await agentRecentlyAdvertisedAction(agentId, action);
  if (!supported) {
    throw new Error(`Agent ${agentId} is not connected or does not support ${action}`);
  }
  const command = await createAgentCommand({
    agentId,
    serviceId: service.serviceId,
    serviceType: service.serviceType,
    action,
    args,
  }, timeoutMs);
  wakePoller(agentId);
  return waitForCommandResult(command, timeoutMs);
}

/**
 * Long-poll handler: returns queued commands immediately, otherwise waits up to
 * `waitMs` for one. `cancel` ends the wait early when the agent disconnects.
 * `acked` lists the command ids the agent received from its previous poll.
 */
export function pollAgentCommands(
  agentId: string,
  actions: string[],
  waitMs: number,
  acked: string[],
): { commands: Promise<AgentCommand[]>; cancel: () => void } {
  const poller = pollers.get(agentId) ?? { actions: new Set<string>(), lastPollAt: 0, cancelOpenPoll: null, wakeOpenPoll: null };
  poller.cancelOpenPoll?.();
  poller.actions = new Set(actions.filter(isAction));
  poller.lastPollAt = Date.now();
  poller.cancelOpenPoll = null;
  poller.wakeOpenPoll = null;
  pollers.set(agentId, poller);

  let cancelled = false;
  const validActions = [...poller.actions];
  const validAcked = normalizeCommandIds(acked);
  let wakeCurrent: (() => void) | null = null;
  function cancel(): void {
    cancelled = true;
    const wake = wakeCurrent;
    wakeCurrent = null;
    if (wake) wake();
  }

  const commands = (async (): Promise<AgentCommand[]> => {
    try {
      await acknowledgeAgentCommands(agentId, validAcked);
      await requeueUnackedSentCommands(agentId, validAcked);
      const deadline = Date.now() + waitMs;
      while (!cancelled && Date.now() < deadline) {
        poller.lastPollAt = Date.now();
        await expireDueAgentCommands();
        const policy = operationsPolicy();
        const leased = await leaseQueuedAgentCommands(agentId, validActions, policy.fleetCommandLeaseMs, policy.fleetCommandBatchSize);
        if (leased.length > 0) {
          return leased.map(toAgentCommand);
        }
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) break;
        await delay(Math.min(POLL_SLEEP_MS, remainingMs), (wake) => {
          wakeCurrent = wake;
          poller.wakeOpenPoll = wake;
        });
        if (poller.wakeOpenPoll === wakeCurrent) {
          poller.wakeOpenPoll = null;
        }
      }
      return [];
    } finally {
      if (poller.cancelOpenPoll === cancel) {
        poller.cancelOpenPoll = null;
      }
      if (poller.wakeOpenPoll === wakeCurrent) {
        poller.wakeOpenPoll = null;
      }
      poller.lastPollAt = Date.now();
    }
  })();

  poller.cancelOpenPoll = cancel;

  return { commands, cancel };
}

/** Put commands back when the poll that took them disconnected before delivery. */
export async function requeueAgentCommands(agentId: string, commands: AgentCommand[]): Promise<void> {
  await requeueAgentCommandsForAgent(agentId, normalizeCommandIds(commands.map((command) => command.id)));
}

/** Record an agent's result. Only the agent the command was queued for may answer it. */
export async function completeAgentCommand(
  agentId: string,
  commandId: string,
  result: { ok: boolean; output?: string; error?: string },
): Promise<boolean> {
  if (!UUID_RE.test(commandId)) return false;
  const accepted = await completeAgentCommandResult(agentId, commandId, result);
  return Boolean(accepted);
}

/** Test hook: forget all process-local agent channel state. */
export function resetAgentCommandsForTests(): void {
  for (const poller of pollers.values()) {
    poller.cancelOpenPoll?.();
  }
  pollers.clear();
}
