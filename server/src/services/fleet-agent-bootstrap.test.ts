import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { provisionFleetAgent } = vi.hoisted(() => ({ provisionFleetAgent: vi.fn() }));
vi.mock('../db/queries/fleet-agents.js', () => ({ provisionFleetAgent }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { bootstrapFleetAgentsFromConfig } from './fleet-agent-bootstrap.js';

describe('bootstrapFleetAgentsFromConfig', () => {
  const ORIGINAL = process.env.FLEET_AGENTS_BOOTSTRAP_JSON;
  beforeEach(() => {
    vi.clearAllMocks();
    provisionFleetAgent.mockResolvedValue({});
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FLEET_AGENTS_BOOTSTRAP_JSON;
    else process.env.FLEET_AGENTS_BOOTSTRAP_JSON = ORIGINAL;
  });

  it('does nothing when the env var is unset', async () => {
    delete process.env.FLEET_AGENTS_BOOTSTRAP_JSON;
    await bootstrapFleetAgentsFromConfig();
    expect(provisionFleetAgent).not.toHaveBeenCalled();
  });

  it('provisions each valid entry with id/name/credential', async () => {
    process.env.FLEET_AGENTS_BOOTSTRAP_JSON = JSON.stringify([
      { agentId: 'a1', name: 'Agent One', credential: 'cred-1', os: 'linux', arch: 'amd64' },
      { agentId: 'a2', name: 'Agent Two', credential: 'cred-2' },
    ]);
    await bootstrapFleetAgentsFromConfig();
    expect(provisionFleetAgent).toHaveBeenCalledTimes(2);
    expect(provisionFleetAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1', name: 'Agent One', credential: 'cred-1', os: 'linux', arch: 'amd64' }));
    expect(provisionFleetAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a2', name: 'Agent Two', credential: 'cred-2' }));
  });

  it('skips entries missing required fields but provisions the valid ones', async () => {
    process.env.FLEET_AGENTS_BOOTSTRAP_JSON = JSON.stringify([
      { agentId: 'a1', name: 'ok', credential: 'c1' },
      { agentId: 'a2', name: 'no-credential' },
      { name: 'no-id', credential: 'c3' },
    ]);
    await bootstrapFleetAgentsFromConfig();
    expect(provisionFleetAgent).toHaveBeenCalledTimes(1);
    expect(provisionFleetAgent).toHaveBeenCalledWith(expect.objectContaining({ agentId: 'a1' }));
  });

  it('ignores malformed JSON without throwing', async () => {
    process.env.FLEET_AGENTS_BOOTSTRAP_JSON = '{not json';
    await expect(bootstrapFleetAgentsFromConfig()).resolves.toBeUndefined();
    expect(provisionFleetAgent).not.toHaveBeenCalled();
  });

  it('ignores a non-array payload', async () => {
    process.env.FLEET_AGENTS_BOOTSTRAP_JSON = JSON.stringify({ agentId: 'a1', name: 'x', credential: 'c' });
    await bootstrapFleetAgentsFromConfig();
    expect(provisionFleetAgent).not.toHaveBeenCalled();
  });

  it('continues past a provisioning failure', async () => {
    provisionFleetAgent.mockRejectedValueOnce(new Error('db down'));
    process.env.FLEET_AGENTS_BOOTSTRAP_JSON = JSON.stringify([
      { agentId: 'a1', name: 'one', credential: 'c1' },
      { agentId: 'a2', name: 'two', credential: 'c2' },
    ]);
    await bootstrapFleetAgentsFromConfig();
    expect(provisionFleetAgent).toHaveBeenCalledTimes(2);
  });
});
