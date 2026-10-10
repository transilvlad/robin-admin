import { beforeEach, describe, it, expect, vi } from 'vitest';

const { getFleetServiceById } = vi.hoisted(() => ({
  getFleetServiceById: vi.fn(),
}));

vi.mock('../db/queries/fleet-services.js', () => ({ getFleetServiceById }));

vi.mock('../db/queries/agent-commands.js', async () => (await import('../../tests/agent-command-query-mock.js')).agentCommandQueryMock);

// Avoid pulling the real db connection through config-store.js (unused on the
// metrics/queue paths, but imported by the module under test).
vi.mock('../db/queries/config-store.js', () => ({
  POSTFIX_CONFIG_STORE_TABLE: 'postfix_config_store',
  getConfigStorePayload: vi.fn(),
  upsertConfigStorePayload: vi.fn(),
}));

import { resetAgentCommandQueryMock } from '../../tests/agent-command-query-mock.js';
import { completeAgentCommand, pollAgentCommands, resetAgentCommandsForTests, type AgentCommand } from './agent-commands.js';
import { applyPostfixQueueAction, flushPostfixQueue, getPostfixLiveMetrics, listPostfixQueue } from './postfix.js';

function svc(overrides: Record<string, unknown> = {}) {
  return { id: 1, serviceId: 'pf1', serviceType: 'postfix', name: 'Postfix', metricsUrl: null, ...overrides };
}

describe('getPostfixLiveMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports unreachable without a metrics URL (agent-collected services push instead)', async () => {
    getFleetServiceById.mockResolvedValue(svc());
    const out = await getPostfixLiveMetrics('pf1');
    expect(out.reachable).toBe(false);
    expect(out.queueTotal).toBe(0);
  });

  describe('HTTP mode (remote postfix_exporter)', () => {
    it('scrapes the exporter showq counts and postfix_up reachability', async () => {
      getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'https://exporter.test/metrics' }));
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => [
          'postfix_up 1',
          'postfix_showq_message_size_bytes_count{queue="deferred"} 5',
          'postfix_showq_message_size_bytes_count{queue="active"} 2',
        ].join('\n'),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const out = await getPostfixLiveMetrics('pf1');
      expect(out.reachable).toBe(true);
      expect(out.queueDeferred).toBe(5);
      expect(out.queueActive).toBe(2);
      expect(out.queueTotal).toBe(7);
      expect(mockFetch).toHaveBeenCalledWith('https://exporter.test/metrics', expect.objectContaining({ signal: expect.anything() }));
    });
  });

  it('throws when the resolved service is missing or the wrong type', async () => {
    getFleetServiceById.mockResolvedValue(null);
    await expect(getPostfixLiveMetrics('pf1')).rejects.toThrow(/not found/);
    getFleetServiceById.mockResolvedValue(svc({ serviceType: 'dovecot' }));
    await expect(getPostfixLiveMetrics('pf1')).rejects.toThrow(/not found/);
  });
});

// Stand in for a connected robin-agent: poll once, answer the command with `reply`.
async function agentAnswers(reply: (cmd: AgentCommand) => { ok: boolean; output?: string; error?: string }) {
  const poll = pollAgentCommands('agent-1', ['postfix.queue.list', 'postfix.queue.delete', 'postfix.queue.flush', 'postfix.reload'], 5000, []);
  return poll.commands.then(async (cmds) => {
    await Promise.all(cmds.map((cmd) => completeAgentCommand('agent-1', cmd.id, reply(cmd))));
    return cmds;
  });
}

describe('agent-backed queue operations', () => {
  const agentSvc = () => svc({ agentId: 'agent-1', collectionMode: 'agent', configAgentId: null });

  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentCommandsForTests();
    resetAgentCommandQueryMock();
  });

  it('lists the queue from postqueue -j output', async () => {
    getFleetServiceById.mockResolvedValue(agentSvc());
    const answered = agentAnswers(() => ({
      ok: true,
      output: JSON.stringify({
        queue_name: 'deferred', queue_id: '4F1A2B3C4D', arrival_time: 1_700_000_000, message_size: 2048,
        sender: 'a@example.com', recipients: [{ address: 'b@example.org', delay_reason: 'connect timed out' }],
      }),
    }));
    const [messages, cmds] = await Promise.all([listPostfixQueue('pf1'), answered]);
    expect(cmds.map((c) => c.action)).toEqual(['postfix.queue.list']);
    expect(messages).toEqual([{
      queueId: '4F1A2B3C4D', queueName: 'deferred', arrivalTime: '2023-11-14T22:13:20.000Z', size: 2048,
      sender: 'a@example.com', recipients: [{ address: 'b@example.org', delayReason: 'connect timed out' }], forcedExpire: false,
    }]);
  });

  it('sends queue actions with their queue IDs and surfaces agent errors', async () => {
    getFleetServiceById.mockResolvedValue(agentSvc());
    const answered = agentAnswers((cmd) => ({ ok: true, output: `postsuper: Deleted: ${(cmd.args.queueIds as string[]).length} messages\n` }));
    const [out, cmds] = await Promise.all([applyPostfixQueueAction('pf1', 'delete', ['AAAAA1', 'BBBBB2']), answered]);
    expect(cmds[0]).toMatchObject({ serviceId: 'pf1', serviceType: 'postfix', action: 'postfix.queue.delete', args: { queueIds: ['AAAAA1', 'BBBBB2'] } });
    expect(out).toBe('postsuper: Deleted: 2 messages');

    const failed = agentAnswers(() => ({ ok: false, error: 'postqueue: fatal: Queue flush not permitted' }));
    await expect(Promise.all([flushPostfixQueue('pf1'), failed])).rejects.toThrow(/not permitted/);
  });

  it('refuses when the service has no agent', async () => {
    getFleetServiceById.mockResolvedValue(svc({ collectionMode: 'direct', agentId: null, configAgentId: null }));
    await expect(flushPostfixQueue('pf1')).rejects.toThrow(/no robin-agent/);
  });
});
