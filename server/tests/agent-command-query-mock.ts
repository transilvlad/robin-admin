import { randomUUID } from 'node:crypto';
import { vi } from 'vitest';
import type {
  AgentCommandRecord,
  AgentCommandStatus,
  CreateAgentCommandInput,
} from '../src/db/queries/agent-commands.js';

const records = new Map<string, AgentCommandRecord>();
let recentlyAdvertised = new Map<string, Set<string>>();

function clone(record: AgentCommandRecord): AgentCommandRecord {
  return { ...record, args: { ...record.args } };
}

function createRecord(input: CreateAgentCommandInput, timeoutMs: number): AgentCommandRecord {
  const now = new Date();
  return {
    id: randomUUID(),
    agentId: input.agentId,
    serviceId: input.serviceId,
    serviceType: input.serviceType,
    action: input.action,
    args: input.args ?? {},
    status: 'queued',
    resultOutput: null,
    resultError: null,
    sentAt: null,
    acknowledgedAt: null,
    completedAt: null,
    expiresAt: new Date(Date.now() + timeoutMs),
    leaseExpiresAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

function setStatus(record: AgentCommandRecord, status: AgentCommandStatus): void {
  record.status = status;
  record.updatedAt = new Date();
}

export const agentCommandQueryMock = {
  createAgentCommand: vi.fn(async (input: CreateAgentCommandInput, timeoutMs: number) => {
    const record = createRecord(input, timeoutMs);
    records.set(record.id, record);
    return clone(record);
  }),
  getAgentCommand: vi.fn(async (commandId: string) => {
    const record = records.get(commandId);
    return record ? clone(record) : null;
  }),
  agentRecentlyAdvertisedAction: vi.fn(async (agentId: string, action: string) => recentlyAdvertised.get(agentId)?.has(action) ?? false),
  acknowledgeAgentCommands: vi.fn(async (agentId: string, commandIds: string[]) => {
    const ids = new Set(commandIds);
    for (const record of records.values()) {
      if (record.agentId === agentId && ids.has(record.id) && ['queued', 'sent', 'acknowledged'].includes(record.status)) {
        setStatus(record, 'acknowledged');
        record.acknowledgedAt ??= new Date();
        record.leaseExpiresAt = null;
      }
    }
  }),
  requeueUnackedSentCommands: vi.fn(async (agentId: string, ackedCommandIds: string[]) => {
    const acked = new Set(ackedCommandIds);
    for (const record of records.values()) {
      if (record.agentId === agentId && record.status === 'sent' && record.expiresAt.getTime() > Date.now() && !acked.has(record.id)) {
        setStatus(record, 'queued');
        record.leaseExpiresAt = null;
      }
    }
  }),
  requeueAgentCommandsForAgent: vi.fn(async (agentId: string, commandIds: string[]) => {
    const ids = new Set(commandIds);
    for (const record of records.values()) {
      if (record.agentId === agentId && ids.has(record.id) && record.status === 'sent' && record.expiresAt.getTime() > Date.now()) {
        setStatus(record, 'queued');
        record.leaseExpiresAt = null;
      }
    }
  }),
  expireDueAgentCommands: vi.fn(async () => {
    for (const record of records.values()) {
      if (['queued', 'sent', 'acknowledged'].includes(record.status) && record.expiresAt.getTime() <= Date.now()) {
        setStatus(record, 'expired');
        record.resultError ??= 'Command expired before completion';
        record.completedAt ??= new Date();
      }
    }
  }),
  markAgentCommandExpired: vi.fn(async (commandId: string, error: string) => {
    const record = records.get(commandId);
    if (!record || !['queued', 'sent', 'acknowledged'].includes(record.status) || record.expiresAt.getTime() > Date.now()) return null;
    setStatus(record, 'expired');
    record.resultError = error;
    record.completedAt ??= new Date();
    return clone(record);
  }),
  leaseQueuedAgentCommands: vi.fn(async (agentId: string, actions: string[], leaseMs: number, limit = 20) => {
    const actionSet = new Set(actions);
    const leased = [...records.values()]
      .filter((record) => record.agentId === agentId && record.status === 'queued' && actionSet.has(record.action) && record.expiresAt.getTime() > Date.now())
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())
      .slice(0, limit);
    for (const record of leased) {
      setStatus(record, 'sent');
      record.sentAt ??= new Date();
      record.leaseExpiresAt = new Date(Date.now() + leaseMs);
    }
    return leased.map(clone);
  }),
  completeAgentCommandResult: vi.fn(async (agentId: string, commandId: string, result: { ok: boolean; output?: string; error?: string }) => {
    const record = records.get(commandId);
    if (!record || record.agentId !== agentId || !['queued', 'sent', 'acknowledged'].includes(record.status) || record.expiresAt.getTime() <= Date.now()) {
      return null;
    }
    setStatus(record, result.ok ? 'succeeded' : 'failed');
    record.resultOutput = result.ok ? result.output ?? '' : null;
    record.resultError = result.ok ? null : result.error ?? null;
    record.completedAt = new Date();
    record.leaseExpiresAt = null;
    return clone(record);
  }),
};

export function resetAgentCommandQueryMock(): void {
  records.clear();
  recentlyAdvertised = new Map();
  for (const value of Object.values(agentCommandQueryMock)) {
    if (typeof value === 'function' && 'mockClear' in value) value.mockClear();
  }
}

export function advertiseAgentActions(agentId: string, actions: string[]): void {
  recentlyAdvertised.set(agentId, new Set(actions));
}
