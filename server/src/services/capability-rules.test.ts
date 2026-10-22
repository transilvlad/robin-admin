import { describe, expect, it } from 'vitest';
import {
  CAPABILITY_RULES,
  SETUP_CHOICES,
  evaluateCapabilities,
  setupFacts,
  type CapabilityFacts,
} from './capability-rules.js';
import { FLEET_SERVICE_TYPES } from './service-types.js';

function available(facts: CapabilityFacts): string[] {
  return Object.entries(evaluateCapabilities(facts)).filter(([, state]) => state.available).map(([id]) => id).sort();
}

describe('capability rules', () => {
  it('keeps Cyrus agent-only and never offers config, reload or disconnect', () => {
    const direct = evaluateCapabilities(setupFacts('cyrus', { agent: 'none', reachable: true }));
    expect(direct.metrics.available).toBe(false);
    expect(direct.raw.available).toBe(false);
    const caps = evaluateCapabilities(setupFacts('cyrus', { agent: 'container', reachable: false }));
    for (const id of ['metrics', 'raw', 'sessions', 'quota', 'user']) expect(caps[id].available).toBe(true);
    expect(caps.config.available).toBe(false);
    expect(caps.reload.available).toBe(false);
    expect(caps.kick).toBeUndefined();
    expect(caps.configSync).toBeUndefined();
    const facts = setupFacts('cyrus', { agent: 'local', reachable: false });
    facts.metricsAgent = { ...facts.metricsAgent!, actions: new Set(['cyrus.sessions']) };
    expect(evaluateCapabilities(facts).quota.available).toBe(false);
    expect(evaluateCapabilities(facts).user.available).toBe(false);
  });
  it('gives every hidden feature a reason', () => {
    for (const type of FLEET_SERVICE_TYPES) {
      for (const setup of SETUP_CHOICES) {
        for (const [id, state] of Object.entries(evaluateCapabilities(setupFacts(type, setup)))) {
          if (!state.available) expect(state.reason, `${type}/${id}`).toBeTruthy();
        }
      }
    }
  });

  it('covers every type with the shared features', () => {
    for (const id of ['metrics', 'raw', 'logs', 'config', 'reload']) {
      expect(CAPABILITY_RULES.find((rule) => rule.id === id)?.types).toEqual(expect.arrayContaining([...FLEET_SERVICE_TYPES]));
    }
  });

  it('keeps Postfix queue and counters to agent setups', () => {
    const direct = available(setupFacts('postfix', { agent: 'none', reachable: true }));
    expect(direct).toEqual(['metrics', 'raw']);
    const container = available(setupFacts('postfix', { agent: 'container', reachable: false }));
    expect(container).toEqual(expect.arrayContaining(['postfixQueue', 'flush', 'messageCounters', 'deferredAge', 'config', 'reload']));
  });

  it('hides config file features over ssh but keeps commands', () => {
    const ssh = evaluateCapabilities(setupFacts('dovecot', { agent: 'ssh', reachable: false }));
    expect(ssh.config).toEqual({ available: false, reason: 'An agent reaching the service over ssh cannot place config files' });
    expect(ssh.sessions.available).toBe(true);
    expect(ssh.reload.available).toBe(true);
  });

  it('needs robin-admin to reach Redis for its admin tools, whatever the agent', () => {
    expect(evaluateCapabilities(setupFacts('redis', { agent: 'local', reachable: false })).admin.available).toBe(false);
    expect(evaluateCapabilities(setupFacts('redis', { agent: 'local', reachable: true })).admin.available).toBe(true);
  });

  it('hides an action whose tool the agent reported missing', () => {
    const facts = setupFacts('dovecot', { agent: 'container', reachable: false });
    facts.metricsAgent = { ...facts.metricsAgent!, actions: new Set(['dovecot.who']) };
    const caps = evaluateCapabilities(facts);
    expect(caps.sessions.available).toBe(true);
    expect(caps.quota).toEqual({ available: false, reason: 'Needs the Dovecot quota plugin (mail_plugins = quota)' });
  });

  it('serves raw output from agent snapshots only where they keep it', () => {
    expect(evaluateCapabilities(setupFacts('clamav', { agent: 'local', reachable: false })).raw.available).toBe(true);
    expect(evaluateCapabilities(setupFacts('rspamd', { agent: 'local', reachable: false })).raw.available).toBe(false);
  });

  it('keeps Rspamd scanning and training to setups where robin-admin reaches Rspamd', () => {
    const agentOnly = evaluateCapabilities(setupFacts('rspamd', { agent: 'container', reachable: false }));
    expect(agentOnly.scan.available).toBe(false);
    expect(agentOnly.training.available).toBe(false);
    expect(agentOnly.dkim.available).toBe(true);
    const direct = evaluateCapabilities(setupFacts('rspamd', { agent: 'none', reachable: true }));
    expect(direct.scan.available).toBe(true);
    expect(direct.dkim.available).toBe(false);
  });
});
