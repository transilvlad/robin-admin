import { beforeEach, describe, expect, it, vi } from 'vitest';

const { getFleetServiceById, runAgentCommand } = vi.hoisted(() => ({
  getFleetServiceById: vi.fn(),
  runAgentCommand: vi.fn(),
}));
vi.mock('../db/queries/fleet-services.js', () => ({ getFleetServiceById }));
vi.mock('./agent-commands.js', async (original) => ({
  ...await original<typeof import('./agent-commands.js')>(), runAgentCommand,
}));

import { manageDovecotAcl, parseDovecotAcl } from './dovecot.js';

const target = { owner: 'owner@example.test', mailbox: 'INBOX', member: 'member@example.test', rights: ['lookup', 'read'] };
const header = 'ID\tGlobal\tRights\n';
const row = 'user=member@example.test\t\tlookup read\n';

beforeEach(() => {
  vi.clearAllMocks();
  getFleetServiceById.mockResolvedValue({
    serviceId: 'dc1', serviceType: 'dovecot', enabled: true, collectionMode: 'agent', agentId: 'agent1',
  });
  runAgentCommand.mockResolvedValue(header + row);
});

describe('Dovecot ACL readback', () => {
  it('parses tab-delimited local/global entries and permits a header-only empty ACL', () => {
    expect(parseDovecotAcl(header + row)).toEqual([{ identifier: 'user=member@example.test', global: false, rights: ['lookup', 'read'] }]);
    expect(parseDovecotAcl('ID\tGlobal\tRights\nuser=bob@example.test\t\tlookup read write-seen\n')).toEqual([
      { identifier: 'user=bob@example.test', global: false, rights: ['lookup', 'read', 'write-seen'] },
    ]);
    expect(parseDovecotAcl(header)).toEqual([]);
    expect(parseDovecotAcl(header + 'anyone\t1\tlookup\n')).toEqual([{ identifier: 'anyone', global: true, rights: ['lookup'] }]);
    expect(parseDovecotAcl(header + 'user=member@example.test\t\t\n')[0]?.rights).toEqual([]);
  });

  it.each(['', 'OK\n', 'ID Global Rights\n', header + 'broken\n', header + row + row, header + 'owner\t\tread read\n'])(
    'rejects unrecognized or ambiguous readback %j', (raw) => expect(() => parseDovecotAcl(raw)).toThrow(),
  );
});

describe('Dovecot ACL operations', () => {
  it('normalizes exact addresses and returns actual backend readback', async () => {
    const state = await manageDovecotAcl('dc1', 'set', { ...target, owner: ' OWNER@EXAMPLE.TEST ' });
    expect(state.entries[0]?.rights).toEqual(['lookup', 'read']);
    expect(runAgentCommand).toHaveBeenCalledWith('agent1', expect.objectContaining({ serviceId: 'dc1' }), 'dovecot.acl.set', {
      user: target.owner, mailbox: 'INBOX', member: target.member, rights: target.rights,
    });
  });

  it.each([
    { owner: '-A' }, { owner: 'a@b@example.test' }, { member: 'anyone' },
    { member: 'owner@example.test' }, { member: 'a;id@example.test' },
    { mailbox: '*' }, { mailbox: '../INBOX' }, { mailbox: 'INBOX//Child' },
    { rights: ['admin'] }, { rights: [] }, { rights: ['read', 'read'] }, { rights: ['read;id'] },
  ])('rejects unsafe or overprivileged changes before dispatch: %j', async (override) => {
    await expect(manageDovecotAcl('dc1', 'set', { ...target, ...override })).rejects.toMatchObject({ status: 400, outcomeUnknown: false });
    expect(runAgentCommand).not.toHaveBeenCalled();
  });

  it('refuses disabled, direct-only or wrong-backend targets', async () => {
    getFleetServiceById.mockResolvedValueOnce({ serviceType: 'dovecot', enabled: false });
    await expect(manageDovecotAcl('dc1', 'get', target)).rejects.toThrow(/disabled/);
    getFleetServiceById.mockResolvedValueOnce({ serviceType: 'dovecot', enabled: true, collectionMode: 'direct' });
    await expect(manageDovecotAcl('dc1', 'get', target)).rejects.toThrow(/assigned/);
    getFleetServiceById.mockResolvedValueOnce({ serviceType: 'cyrus', enabled: true });
    await expect(manageDovecotAcl('dc1', 'get', target)).rejects.toThrow(/not found/);
    expect(runAgentCommand).not.toHaveBeenCalled();
  });

  it.each([
    header,
    header + 'user=member@example.test\t\tlookup read insert\n',
    header + 'user=member@example.test\t1\tlookup read\n',
    'OK\n',
  ])('never confirms a set without exact named-user rights: %j', async (output) => {
    runAgentCommand.mockResolvedValue(output);
    await expect(manageDovecotAcl('dc1', 'set', target)).rejects.toMatchObject({ status: 502, outcomeUnknown: true });
  });

  it('requires the named entry to be absent on delete; does not hide partial failures', async () => {
    await expect(manageDovecotAcl('dc1', 'delete', target)).rejects.toThrow(/may already have taken effect/);
    runAgentCommand.mockRejectedValueOnce(new Error('readback unavailable'));
    await expect(manageDovecotAcl('dc1', 'set', target)).rejects.toThrow(/Read back before retrying/);
    runAgentCommand.mockResolvedValueOnce(header);
    expect((await manageDovecotAcl('dc1', 'delete', target)).entries).toEqual([]);
  });

  it('dispatches only a read for inspection', async () => {
    await manageDovecotAcl('dc1', 'get', target);
    expect(runAgentCommand).toHaveBeenCalledWith('agent1', expect.anything(), 'dovecot.acl.get', {
      user: target.owner, mailbox: target.mailbox,
    });
  });
});
