import { beforeEach, describe, it, expect, vi } from 'vitest';

const { getFleetServiceById } = vi.hoisted(() => ({
  getFleetServiceById: vi.fn(),
}));

vi.mock('../db/queries/fleet-services.js', () => ({ getFleetServiceById }));

vi.mock('../db/queries/agent-commands.js', async () => (await import('../../tests/agent-command-query-mock.js')).agentCommandQueryMock);

vi.mock('../db/queries/config-store.js', () => ({
  DOVECOT_CONFIG_STORE_TABLE: 'dovecot_config_store',
  getConfigStorePayload: vi.fn(),
  upsertConfigStorePayload: vi.fn(),
}));

import { resetAgentCommandQueryMock } from '../../tests/agent-command-query-mock.js';
import { completeAgentCommand, pollAgentCommands, resetAgentCommandsForTests, type AgentCommand } from './agent-commands.js';
import { getDovecotLiveMetrics, getDovecotQuota, lookupDovecotUser, reloadDovecot } from './dovecot.js';

function svc(overrides: Record<string, unknown> = {}) {
  return { id: 1, serviceId: 'dc1', serviceType: 'dovecot', name: 'Dovecot', metricsUrl: null, agentId: null, collectionMode: 'direct', configAgentId: null, ...overrides };
}

// Stand in for a connected robin-agent: poll once, answer each command with `reply`.
function agentAnswers(agentId: string, reply: (cmd: AgentCommand) => { ok: boolean; output?: string; error?: string }) {
  const poll = pollAgentCommands(agentId, ['dovecot.reload', 'dovecot.who', 'dovecot.kick', 'dovecot.quota', 'dovecot.user'], 5000, []);
  return poll.commands.then(async (cmds) => {
    await Promise.all(cmds.map((cmd) => completeAgentCommand(agentId, cmd.id, reply(cmd))));
    return cmds;
  });
}

describe('getDovecotLiveMetrics', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports unreachable without a metrics URL (agent-collected services push instead)', async () => {
    getFleetServiceById.mockResolvedValue(svc());
    const out = await getDovecotLiveMetrics('dc1');
    expect(out.reachable).toBe(false);
  });

  describe('HTTP mode (remote OpenMetrics exporter)', () => {
    it('scrapes OpenMetrics counters and marks reachable', async () => {
      getFleetServiceById.mockResolvedValue(svc({ metricsUrl: 'https://dovecot.test/metrics' }));
      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        text: async () => [
          'dovecot_auth_successes_total 12',
          'dovecot_auth_failures_total 3',
        ].join('\n'),
      });
      global.fetch = mockFetch as unknown as typeof fetch;

      const out = await getDovecotLiveMetrics('dc1');
      expect(out.reachable).toBe(true);
      expect(out.authSuccess).toBe(12);
      expect(out.authFailure).toBe(3);
    });
  });

  it('throws when the resolved service is missing or the wrong type', async () => {
    getFleetServiceById.mockResolvedValue(null);
    await expect(getDovecotLiveMetrics('dc1')).rejects.toThrow(/not found/);
    getFleetServiceById.mockResolvedValue(svc({ serviceType: 'postfix' }));
    await expect(getDovecotLiveMetrics('dc1')).rejects.toThrow(/not found/);
  });
});

describe('agent-backed operations', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetAgentCommandsForTests();
    resetAgentCommandQueryMock();
  });

  it('reloads through a config-only agent', async () => {
    getFleetServiceById.mockResolvedValue(svc({ configAgentId: 'config-agent' }));
    const answered = agentAnswers('config-agent', () => ({ ok: true, output: '' }));
    const [out, cmds] = await Promise.all([reloadDovecot('dc1'), answered]);
    expect(cmds.map((c) => c.action)).toEqual(['dovecot.reload']);
    expect(out).toBe('Reload signal sent');
  });

  it('treats an unknown user and a disabled quota plugin as answers, not errors', async () => {
    getFleetServiceById.mockResolvedValue(svc({ agentId: 'agent-1', collectionMode: 'agent' }));
    const missing = agentAnswers('agent-1', () => ({ ok: false, error: "doveadm user x: exit status 67: userdb lookup: user x doesn't exist" }));
    expect((await Promise.all([lookupDovecotUser('dc1', 'x'), missing]))[0]).toBeNull();

    const noQuota = agentAnswers('agent-1', () => ({ ok: false, error: "Fatal: Unknown command 'quota', but plugin quota exists." }));
    const [quota] = await Promise.all([getDovecotQuota('dc1'), noQuota]);
    expect(quota).toEqual({ available: false, reason: expect.stringContaining('quota plugin'), rows: [] });
  });

  it('refuses when the service has no agent', async () => {
    getFleetServiceById.mockResolvedValue(svc());
    await expect(reloadDovecot('dc1')).rejects.toThrow(/no robin-agent/);
  });
});
