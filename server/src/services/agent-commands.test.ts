import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../db/queries/agent-commands.js', async () => (await import('../../tests/agent-command-query-mock.js')).agentCommandQueryMock);

import { advertiseAgentActions, agentCommandQueryMock, resetAgentCommandQueryMock } from '../../tests/agent-command-query-mock.js';
import { agentSupports, completeAgentCommand, pollAgentCommands, resetAgentCommandsForTests, runAgentCommand } from './agent-commands.js';

afterEach(() => {
  resetAgentCommandsForTests();
  resetAgentCommandQueryMock();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('result at the timeout boundary', () => {
  it.each([
    { ok: true, output: 'completed at boundary', error: undefined },
    { ok: false, output: undefined, error: 'execution failed at boundary' },
  ])('returns the recorded result when expiry loses the race (ok=$ok)', async (result) => {
    vi.useFakeTimers({ toFake: ['Date'] });
    advertiseAgentActions('agent-boundary', ['postfix.queue.flush']);
    const getRecord = agentCommandQueryMock.getAgentCommand.getMockImplementation()!;
    agentCommandQueryMock.getAgentCommand.mockImplementationOnce(async (id) => {
      const record = await getRecord(id);
      // The DB accepts the result after this read but before the final expiry CAS.
      await agentCommandQueryMock.completeAgentCommandResult('agent-boundary', id, result);
      vi.setSystemTime(Date.now() + 1000);
      return record;
    });
    const promise = runAgentCommand('agent-boundary', { serviceId: 'pf1', serviceType: 'postfix' }, 'postfix.queue.flush', {}, 100);
    if (result.ok) await expect(promise).resolves.toBe(result.output);
    else await expect(promise).rejects.toThrow(result.error);
  });
});

describe('pollAgentCommands', () => {
  it('settles an idle poll with no commands when cancelled, idempotently', async () => {
    const poll = pollAgentCommands('agent-1', ['postfix.queue.flush'], 60_000, []);
    poll.cancel();
    poll.cancel();
    await expect(poll.commands).resolves.toEqual([]);
  });

  it('does not hand commands to a cancelled poll', async () => {
    const poll = pollAgentCommands('agent-1', ['postfix.queue.flush'], 60_000, []);
    poll.cancel();
    await poll.commands;

    // Still connected (polled recently), so the command queues for the next poll.
    expect(agentSupports('agent-1', 'postfix.queue.flush')).toBe(true);
    const result = runAgentCommand('agent-1', { serviceId: 'pf1', serviceType: 'postfix' }, 'postfix.queue.flush', {}, 1000);
    const next = pollAgentCommands('agent-1', ['postfix.queue.flush'], 60_000, []);
    await expect(next.commands).resolves.toEqual([expect.objectContaining({ action: 'postfix.queue.flush' })]);
    result.catch(() => {}); // times out unanswered; not under test
  });

  it('settles a superseded poll when the same agent polls again', async () => {
    const first = pollAgentCommands('agent-1', [], 60_000, []);
    const second = pollAgentCommands('agent-1', [], 60_000, []);
    await expect(first.commands).resolves.toEqual([]);
    second.cancel();
    await expect(second.commands).resolves.toEqual([]);
  });
});

describe('delivery confirmation', () => {
  const service = { serviceId: 'pf1', serviceType: 'postfix' };
  const actions = ['postfix.queue.flush'];

  async function sendOne() {
    pollAgentCommands('agent-1', actions, 60_000, []).cancel();
    const result = runAgentCommand('agent-1', service, 'postfix.queue.flush', {}, 5000);
    result.catch(() => {});
    const poll = pollAgentCommands('agent-1', actions, 60_000, []);
    const [command] = await poll.commands;
    return { command, result };
  }

  it('re-sends a command the next poll does not confirm', async () => {
    const { command } = await sendOne();
    const next = pollAgentCommands('agent-1', actions, 60_000, []);
    await expect(next.commands).resolves.toEqual([command]);
  });

  it('does not re-send confirmed commands', async () => {
    const { command } = await sendOne();
    const next = pollAgentCommands('agent-1', actions, 60_000, [command.id]);
    next.cancel();
    await expect(next.commands).resolves.toEqual([]);
  });

  it('does not re-send commands that already have a result', async () => {
    const { command, result } = await sendOne();
    await completeAgentCommand('agent-1', command.id, { ok: true, output: 'done' });
    await expect(result).resolves.toBe('done');
    const next = pollAgentCommands('agent-1', actions, 60_000, []);
    next.cancel();
    await expect(next.commands).resolves.toEqual([]);
  });
});
