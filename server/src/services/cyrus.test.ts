import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildCyrusSnapshotFromRaw, getCyrusQuota, listCyrusSessions, lookupCyrusUser, parseCyrusProc, parseCyrusPrometheus, parseCyrusQuota } from './cyrus.js';
import { getFleetServiceById } from '../db/queries/fleet-services.js';
import { commandAgentFor, runAgentCommand } from './agent-commands.js';

vi.mock('../db/queries/fleet-services.js', () => ({ getFleetServiceById: vi.fn() }));
vi.mock('./agent-commands.js', () => ({ commandAgentFor: vi.fn(), runAgentCommand: vi.fn() }));

const prometheus = `# HELP cyrus_imap_connections_total The total number of IMAP connections
# TYPE cyrus_imap_connections_total counter
cyrus_imap_connections_total 12 1761140000000
# TYPE cyrus_imap_active_connections gauge
cyrus_imap_active_connections 1 1761140000000
cyrus_imap_authenticate_total{result="yes"} 10 1761140000000
cyrus_imap_authenticate_total{result="no"} 2 1761140000000
cyrus_imap_select_total 30 1761140000000
cyrus_imap_fetch_total 80 1761140000000
cyrus_imap_append_total 5 1761140000000
cyrus_imap_idle_total 3 1761140000000
cyrus_lmtp_connections_total 4 1761140000000
cyrus_lmtp_active_connections 0 1761140000000
cyrus_lmtp_received_messages_total 4 1761140000000
cyrus_lmtp_received_recipients_total 4 1761140000000
cyrus_lmtp_received_bytes_total 20480 1761140000000
cyrus_lmtp_sieve_redirect_total 0 1761140000000
cyrus_usage_users{partition="default"} 4 1761140000000
cyrus_usage_mailboxes{partition="default"} 20 1761140000000
cyrus_usage_quota_commitment{partition="default"} 83886080 1761140000000`;
const proc = '101 imap suite-imap-proxy.suite [172.20.0.10] happy@example.com example.com!user.happy Idle';
const quota = `   Quota   % Used     Used             Resource Root
 20971520        0       15              STORAGE user/happy@example.com
                        15              MESSAGE user/happy@example.com
                         0 X-ANNOTATION-STORAGE user/happy@example.com
                         5        X-NUM-FOLDERS user/happy@example.com
 20971520        0     5736              STORAGE user/pepper@example.com
                     10589              MESSAGE user/pepper@example.com`;

describe('Cyrus parsers', () => {
  it('parses timestamped Prometheus metrics and excludes logins and connections from commands', () => {
    expect(parseCyrusPrometheus(prometheus)).toEqual({ imapConnections: 12, activeConnections: 1, authSuccess: 10, authFailure: 2, loginCount: 10, imapCommands: 118, lmtpConnections: 4, mailDeliveries: 4, lmtpRecipients: 4, lmtpBytes: 20480, userCount: 4, mailboxCount: 20, quotaCommitment: 83886080 });
  });
  it('sums across partitions and label sets and tolerates missing or invalid metrics', () => {
    expect(parseCyrusPrometheus(`cyrus_usage_users{partition="one"} 2
cyrus_usage_users{partition="two"} 3
cyrus_imap_authenticate_total{mechanism="plain",result="yes"} 2
cyrus_imap_authenticate_total{result="yes",mechanism="login"} 4
cyrus_imap_authenticate_total 5
cyrus_imap_authenticate_total{status="failure"} 3
cyrus_imap_fetch_total{command="quoted } text"} 1e2
cyrus_imap_connections_total NaN
not metrics`)).toMatchObject({ userCount: 5, authSuccess: 11, authFailure: 3, imapCommands: 100, imapConnections: 0 });
    expect(parseCyrusPrometheus('')).toMatchObject({ imapCommands: 0, userCount: 0 });
  });
  it('parses process rows including idle and unauthenticated processes', () => {
    expect(parseCyrusProc(proc)).toEqual([{ pid: '101', service: 'imap', host: 'suite-imap-proxy.suite', ip: '172.20.0.10', user: 'happy@example.com', mailbox: 'example.com!user.happy', state: 'Idle' }]);
    expect(parseCyrusProc('102 imap client [::1] Login')).toEqual([{ pid: '102', service: 'imap', host: 'client', ip: '::1', user: '', mailbox: '', state: 'Login' }]);
    expect(parseCyrusProc('103 imap client [::1] happy@example.com NOOP')).toMatchObject([{ user: 'happy@example.com', mailbox: '', state: 'NOOP' }]);
    expect(parseCyrusProc('105 imap client [::1] happy@example.com INBOX Fetch 1:*')).toMatchObject([{ user: 'happy@example.com', mailbox: 'INBOX', state: 'Fetch 1:*' }]);
    expect(parseCyrusProc('106 imap client [::1] Authenticating via PLAIN')).toMatchObject([{ user: '', mailbox: '', state: 'Authenticating via PLAIN' }]);
    expect(parseCyrusProc('104 imap client')).toMatchObject([{ user: '', mailbox: '', state: '' }]);
    expect(parseCyrusProc('\ninvalid\n')).toEqual([]);
  });
  it('groups quota resources by root without converting KiB into bytes', () => {
    expect(parseCyrusQuota(quota)).toEqual([
      { root: 'user/happy@example.com', user: 'happy@example.com', storageUsedKiB: 15, storageLimitKiB: 20971520, storagePercent: 0, messages: 15, folders: 5 },
      { root: 'user/pepper@example.com', user: 'pepper@example.com', storageUsedKiB: 5736, storageLimitKiB: 20971520, storagePercent: 0, messages: 10589, folders: 0 },
    ]);
    expect(parseCyrusQuota('12 STORAGE user/free')).toMatchObject([{ storageUsedKiB: 12, storageLimitKiB: null, storagePercent: null }]);
    expect(parseCyrusQuota('Quota % Used Used Resource Root')).toEqual([]);
  });
  it('builds snapshots with process counts and bounded raw output', () => {
    expect(buildCyrusSnapshotFromRaw('imap', prometheus, proc)).toMatchObject({ serviceId: 'imap', serviceType: 'cyrus', reachable: true, sessionCount: 1, userCount: 4 });
    expect(buildCyrusSnapshotFromRaw('imap', 'x'.repeat(9000)).rawStats).toHaveLength(8000);
    expect(buildCyrusSnapshotFromRaw('imap', prometheus, '').sessionCount).toBe(0);
  });
});

describe('Cyrus agent operations', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(getFleetServiceById).mockResolvedValue({ serviceId: 'imap', serviceType: 'cyrus', collectionMode: 'agent' } as never);
    vi.mocked(commandAgentFor).mockReturnValue('agent');
  });
  it('runs the typed sessions and quota actions', async () => {
    vi.mocked(runAgentCommand).mockResolvedValueOnce(proc).mockResolvedValueOnce(quota);
    expect(await listCyrusSessions('imap')).toHaveLength(1);
    expect((await getCyrusQuota('imap', 'happy@example.com')).rows).toHaveLength(2);
    expect(runAgentCommand).toHaveBeenLastCalledWith('agent', expect.anything(), 'cyrus.quota', { user: 'happy@example.com' });
  });
  it('returns mailbox paths and distinguishes missing users from operational errors', async () => {
    vi.mocked(runAgentCommand).mockResolvedValueOnce('/var/spool/cyrus/user/happy\n');
    expect(await lookupCyrusUser('imap', 'happy@example.com')).toEqual({ path: '/var/spool/cyrus/user/happy' });
    vi.mocked(runAgentCommand).mockRejectedValueOnce(new Error("exit status 65: Invalid mailbox name: 'nobody@example.com'"));
    expect(await lookupCyrusUser('imap', 'nobody@example.com')).toBeNull();
    vi.mocked(runAgentCommand).mockRejectedValueOnce(new Error('permission denied'));
    await expect(lookupCyrusUser('imap', 'happy@example.com')).rejects.toThrow('permission denied');
  });
  it('rejects services of the wrong type and services without an assigned metrics agent', async () => {
    vi.mocked(getFleetServiceById).mockResolvedValueOnce({ serviceType: 'dovecot' } as never);
    await expect(listCyrusSessions('other')).rejects.toThrow('not found');
    vi.mocked(commandAgentFor).mockReturnValue(null);
    await expect(listCyrusSessions('imap')).rejects.toThrow('metrics agent');
    expect(runAgentCommand).not.toHaveBeenCalled();
  });
});
