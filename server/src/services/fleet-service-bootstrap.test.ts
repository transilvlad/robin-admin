import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const {
  createFleetService,
  updateFleetService,
  getFleetServiceById,
  assignFleetServiceAgent,
  assignFleetServiceLogAgent,
  assignFleetServiceConfigAgent,
  getFleetAgentById,
} = vi.hoisted(() => ({
  createFleetService: vi.fn(),
  updateFleetService: vi.fn(),
  getFleetServiceById: vi.fn(),
  assignFleetServiceAgent: vi.fn(),
  assignFleetServiceLogAgent: vi.fn(),
  assignFleetServiceConfigAgent: vi.fn(),
  getFleetAgentById: vi.fn(),
}));

vi.mock('../db/queries/fleet-services.js', () => ({
  createFleetService,
  updateFleetService,
  getFleetServiceById,
  assignFleetServiceAgent,
  assignFleetServiceLogAgent,
  assignFleetServiceConfigAgent,
}));
vi.mock('../db/queries/fleet-agents.js', () => ({ getFleetAgentById }));
vi.mock('../logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { bootstrapFleetServicesFromConfig } from './fleet-service-bootstrap.js';

describe('bootstrapFleetServicesFromConfig', () => {
  const ORIGINAL = process.env.FLEET_SERVICES_BOOTSTRAP_JSON;
  beforeEach(() => {
    vi.clearAllMocks();
    getFleetServiceById.mockResolvedValue(null); // service absent by default
    getFleetAgentById.mockResolvedValue({ agentId: 'x' }); // agent present by default
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.FLEET_SERVICES_BOOTSTRAP_JSON;
    else process.env.FLEET_SERVICES_BOOTSTRAP_JSON = ORIGINAL;
  });

  it('does nothing when the env var is unset', async () => {
    delete process.env.FLEET_SERVICES_BOOTSTRAP_JSON;
    await bootstrapFleetServicesFromConfig();
    expect(createFleetService).not.toHaveBeenCalled();
  });

  it('registers a new fully-specified service and applies axis wiring', async () => {
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = JSON.stringify([
      { serviceId: 'suite-dovecot', serviceType: 'dovecot', name: 'Suite Dovecot', agentId: 'dovecot-agent', logAgentId: null },
    ]);
    await bootstrapFleetServicesFromConfig();
    expect(createFleetService).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'suite-dovecot', serviceType: 'dovecot', name: 'Suite Dovecot' }));
    expect(assignFleetServiceAgent).toHaveBeenCalledWith('suite-dovecot', 'dovecot-agent');
    expect(assignFleetServiceLogAgent).toHaveBeenCalledWith('suite-dovecot', null);
  });

  it('upserts (updates, not re-creates) an existing service and still applies wiring', async () => {
    getFleetServiceById.mockResolvedValue({ serviceId: 'suite-clamav' });
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = JSON.stringify([
      { serviceId: 'suite-clamav', serviceType: 'clamav', name: 'Suite ClamAV', apiUrl: 'http://antivirus-backend:3310', logAgentId: 'suite-log-agent' },
    ]);
    await bootstrapFleetServicesFromConfig();
    expect(createFleetService).not.toHaveBeenCalled();
    expect(updateFleetService).toHaveBeenCalledWith('suite-clamav', expect.objectContaining({ name: 'Suite ClamAV', apiUrl: 'http://antivirus-backend:3310' }));
    expect(assignFleetServiceLogAgent).toHaveBeenCalledWith('suite-clamav', 'suite-log-agent');
  });

  it('supports wiring-only entries (no serviceType/name)', async () => {
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = JSON.stringify([
      { serviceId: 'rspamd', configAgentId: 'rspamd-agent' },
    ]);
    await bootstrapFleetServicesFromConfig();
    expect(createFleetService).not.toHaveBeenCalled();
    expect(assignFleetServiceConfigAgent).toHaveBeenCalledWith('rspamd', 'rspamd-agent');
  });

  it('skips axis wiring when the referenced agent is not provisioned (FK guard)', async () => {
    getFleetAgentById.mockResolvedValue(null); // agent missing
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = JSON.stringify([
      { serviceId: 'suite-postfix', serviceType: 'postfix', name: 'Suite Postfix', agentId: 'postfix-agent' },
    ]);
    await bootstrapFleetServicesFromConfig();
    expect(createFleetService).toHaveBeenCalled();
    expect(assignFleetServiceAgent).not.toHaveBeenCalled();
  });

  it('clears an axis with null without consulting the agent table', async () => {
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = JSON.stringify([
      { serviceId: 'suite-x', logAgentId: null },
    ]);
    await bootstrapFleetServicesFromConfig();
    expect(getFleetAgentById).not.toHaveBeenCalled();
    expect(assignFleetServiceLogAgent).toHaveBeenCalledWith('suite-x', null);
  });

  it('skips entries missing serviceId and unknown service types', async () => {
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = JSON.stringify([
      { serviceType: 'redis', name: 'no id' },
      { serviceId: 'bad', serviceType: 'not-a-type', name: 'x' },
      { serviceId: 'ok', serviceType: 'redis', name: 'Redis' },
    ]);
    await bootstrapFleetServicesFromConfig();
    expect(createFleetService).toHaveBeenCalledTimes(1);
    expect(createFleetService).toHaveBeenCalledWith(expect.objectContaining({ serviceId: 'ok' }));
  });

  it('ignores malformed JSON and non-array payloads without throwing', async () => {
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = '{not json';
    await expect(bootstrapFleetServicesFromConfig()).resolves.toBeUndefined();
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = JSON.stringify({ serviceId: 'x' });
    await bootstrapFleetServicesFromConfig();
    expect(createFleetService).not.toHaveBeenCalled();
  });

  it('continues past a per-entry failure', async () => {
    createFleetService.mockRejectedValueOnce(new Error('db down'));
    process.env.FLEET_SERVICES_BOOTSTRAP_JSON = JSON.stringify([
      { serviceId: 's1', serviceType: 'redis', name: 'one' },
      { serviceId: 's2', serviceType: 'postgres', name: 'two' },
    ]);
    await bootstrapFleetServicesFromConfig();
    expect(createFleetService).toHaveBeenCalledTimes(2);
  });
});
