import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../logger.js';
import { logAgentCommandLifecycle } from './agent-commands.js';

describe('command diagnostics', () => {
  it('projects only correlation, lifecycle and timing fields from a command row', () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);
    const at = new Date('2026-10-02T00:00:00Z');
    const row = {
      id: 'command', agent_id: 'agent', service_id: 'service', action: 'postfix.queue.list',
      status: 'expired' as const, created_at: at, sent_at: at, acknowledged_at: at, expires_at: at,
      args_json: { password: 'secret-arguments' }, result_output: 'secret-output', result_error: 'secret-error',
    };
    logAgentCommandLifecycle('expired', row);
    const metadata = info.mock.calls[0][1];
    expect(metadata).toMatchObject({ commandId: 'command', agentId: 'agent', event: 'expired', acknowledgedAt: at.toISOString() });
    expect(JSON.stringify(metadata)).not.toContain('secret');
    expect(Object.keys(metadata as object).sort()).toEqual(['acknowledgedAt', 'action', 'agentId', 'commandId', 'elapsedMs', 'event', 'expiresAt', 'sentAt', 'serviceId', 'status']);
    info.mockRestore();
  });
});
