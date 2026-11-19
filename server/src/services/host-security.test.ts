import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { HostSecuritySections, HostSecuritySnapshot } from '../types/host-security.js';
import { hostSecurityDriftSignals, unusualHostAuthRate } from './alerts/host-security.js';
import { applyHostSecurityApproval, diffHostSecurity, hostSecuritySections } from './host-security.js';

function snapshot(): HostSecuritySnapshot {
  const sections = Object.fromEntries(hostSecuritySections.map(name => [name, { status: 'ok', complete: true, items: [] }])) as HostSecuritySections;
  return { id: '1', hostId: 'test-host', hash: '0'.repeat(64), receivedAt: '2026-11-19T10:00:00Z', observedAt: '2026-11-19T10:00:00Z', sections };
}

describe('host security baseline', () => {
  it('uses the same contract in both container build contexts', () => {
    const canonical = readFileSync(new URL('../../../contracts/host-security-v1.ts', import.meta.url), 'utf8').trim();
    const server = readFileSync(new URL('../types/host-security.ts', import.meta.url), 'utf8').trim();
    const client = readFileSync(new URL('../../../client/src/types/host-security.ts', import.meta.url), 'utf8').trim();
    expect(server).toBe(canonical);
    expect(client).toBe(canonical);
  });
  it('detects key, configuration, listener, privilege and integrity changes', () => {
    const previous = snapshot();
    const current = snapshot();
    current.sections.sshKeys.items.push({
      id: 'fingerprint',
      value: { user: 'test', file: '/fixture', fingerprint: 'SHA256:fixture', type: 'ssh-ed25519', bits: 256, options: [], comment: 'fixture' },
    });
    current.sections.sshd.items.push({ id: 'passwordauthentication', value: { name: 'passwordauthentication', value: 'yes' } });
    current.sections.listeners.items.push({ id: 'tcp|0.0.0.0|42', value: { protocol: 'tcp', address: '0.0.0.0', port: 42, process: null } });
    current.sections.accounts.items.push({ id: 'fixture', value: { user: 'fixture', uid: 1000, shell: '/bin/bash', home: '/home/fixture' } });
    current.sections.integrity.items.push({ id: '/fixture', value: { path: '/fixture', sha256: '1'.repeat(64) } });
    const diff = diffHostSecurity(current, previous.sections, 1);
    expect(hostSecurityDriftSignals(diff).map(signal => signal.type)).toEqual([
      'host_ssh_keys', 'host_sshd', 'host_privilege', 'host_network', 'host_integrity',
    ]);
    const accepted = applyHostSecurityApproval(current, previous.sections, diff, ['sshKeys:fingerprint']);
    const followUp = diffHostSecurity(current, accepted, 2);
    expect(hostSecurityDriftSignals(followUp)).toHaveLength(4);
    expect(hostSecurityDriftSignals(diffHostSecurity(current, applyHostSecurityApproval(current, accepted, followUp), 3))).toEqual([]);
  });

  it('retains baseline items when an incomplete read cannot prove removal', () => {
    const previous = snapshot();
    previous.sections.integrity.items.push({ id: '/fixture', value: { path: '/fixture', sha256: '0'.repeat(64) } });
    const current = snapshot();
    current.sections.integrity = { status: 'not_permitted', complete: false, items: [] };
    const diff = diffHostSecurity(current, previous.sections, 1);
    expect(diff.items).toEqual([]);
    expect(applyHostSecurityApproval(current, previous.sections, diff).integrity).toEqual(previous.sections.integrity);
  });

  it('suppresses drift signals before explicit approval and compares auth rates relative to history', () => {
    const current = snapshot();
    current.sections.firewall.items.push({ id: 'default', value: { backend: 'nftables', inbound: 'accept' } });
    expect(hostSecurityDriftSignals(diffHostSecurity(current, {}, 0))).toEqual([]);
    expect(unusualHostAuthRate(20, 20, 60)).toBe(true);
    expect(unusualHostAuthRate(20, 60, 60)).toBe(false);
    expect(unusualHostAuthRate(100, 10, 3)).toBe(false);
  });
});
