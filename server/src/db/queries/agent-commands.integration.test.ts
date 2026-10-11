/**
 * Integration test for the DB-backed agent command queue against a REAL
 * Postgres. Skipped by default; run like the other *.integration.test.ts files,
 * one at a time with ROLLUP_IT_DB=1.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { initializeSchema } from '../schema.js';
import { closePool, query } from '../connection.js';
import {
  acknowledgeAgentCommands,
  agentRecentlyAdvertisedAction,
  completeAgentCommandResult,
  createAgentCommand,
  expireDueAgentCommands,
  getAgentCommand,
  leaseQueuedAgentCommands,
  markAgentCommandExpired,
  requeueUnackedSentCommands,
} from './agent-commands.js';

const RUN = process.env.ROLLUP_IT_DB === '1';
const AGENT_ID = 'it-agent-commands';

describe.skipIf(!RUN)('agent command queue (integration)', () => {
  beforeAll(async () => {
    await initializeSchema();
  });

  beforeEach(async () => {
    await query(`TRUNCATE fleet_agent_commands, fleet_agents RESTART IDENTITY CASCADE`);
    await query(
      `INSERT INTO fleet_agents (agent_id, name, status, enrolled_at, last_seen_at, services_json)
       VALUES ($1, 'Integration Agent', 'online', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP, $2::jsonb)`,
      [AGENT_ID, JSON.stringify({ pf1: { access: 'local', fileDelivery: true, applyOnly: false, actions: ['postfix.queue.flush'] } })]
    );
  });

  afterAll(async () => {
    await closePool();
  });

  it('cannot expire before the DB deadline or overwrite a recorded result', async () => {
    const command = await createAgentCommand({
      agentId: AGENT_ID, serviceId: 'pf1', serviceType: 'postfix', action: 'postfix.queue.flush',
    }, 60_000);
    await expect(markAgentCommandExpired(command.id, 'early caller timeout')).resolves.toBeNull();
    expect((await getAgentCommand(command.id))?.status).toBe('queued');
    await completeAgentCommandResult(AGENT_ID, command.id, { ok: true, output: 'completed' });
    await query(`UPDATE fleet_agent_commands SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`, [command.id]);
    await expect(markAgentCommandExpired(command.id, 'late timeout')).resolves.toBeNull();
    expect(await getAgentCommand(command.id)).toMatchObject({ status: 'succeeded', resultOutput: 'completed' });

    const overdue = await createAgentCommand({
      agentId: AGENT_ID, serviceId: 'pf1', serviceType: 'postfix', action: 'postfix.queue.flush',
    }, 60_000);
    await query(`UPDATE fleet_agent_commands SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`, [overdue.id]);
    await expect(markAgentCommandExpired(overdue.id, 'overdue')).resolves.toMatchObject({ status: 'expired', resultError: 'overdue' });
  });

  it('leases, requeues, acknowledges, completes, and expires commands durably', async () => {
    await expect(agentRecentlyAdvertisedAction(AGENT_ID, 'postfix.queue.flush')).resolves.toBe(true);
    await expect(agentRecentlyAdvertisedAction(AGENT_ID, 'postfix.queue.delete')).resolves.toBe(false);

    const command = await createAgentCommand({
      agentId: AGENT_ID,
      serviceId: 'pf1',
      serviceType: 'postfix',
      action: 'postfix.queue.flush',
      args: { dryRun: true },
    }, 60_000);
    expect(command.status).toBe('queued');

    const leases = await Promise.all([
      leaseQueuedAgentCommands(AGENT_ID, ['postfix.queue.flush'], 30_000),
      leaseQueuedAgentCommands(AGENT_ID, ['postfix.queue.flush'], 30_000),
    ]);
    expect(leases.flat()).toHaveLength(1);
    expect((await getAgentCommand(command.id))?.status).toBe('sent');

    await requeueUnackedSentCommands(AGENT_ID, []);
    expect((await getAgentCommand(command.id))?.status).toBe('queued');

    const [leasedAgain] = await leaseQueuedAgentCommands(AGENT_ID, ['postfix.queue.flush'], 30_000);
    expect(leasedAgain.id).toBe(command.id);
    await acknowledgeAgentCommands(AGENT_ID, [command.id]);
    expect((await getAgentCommand(command.id))?.status).toBe('acknowledged');

    const completed = await completeAgentCommandResult(AGENT_ID, command.id, { ok: true, output: 'flushed' });
    expect(completed).toMatchObject({ status: 'succeeded', resultOutput: 'flushed' });
    await requeueUnackedSentCommands(AGENT_ID, []);
    expect((await getAgentCommand(command.id))?.status).toBe('succeeded');

    const expiring = await createAgentCommand({
      agentId: AGENT_ID,
      serviceId: 'pf1',
      serviceType: 'postfix',
      action: 'postfix.queue.flush',
    }, 60_000);
    await query(`UPDATE fleet_agent_commands SET expires_at = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE id = $1`, [expiring.id]);
    await expireDueAgentCommands();
    expect(await getAgentCommand(expiring.id)).toMatchObject({
      status: 'expired',
      resultError: 'Command expired before completion',
    });
  });
});
