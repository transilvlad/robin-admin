import { beforeEach, describe, it, expect, vi } from 'vitest';

const { execFileImpl, getFleetServiceById, getRspamdAuthHeaders, getAgentServiceLogs, storeAgentServiceLogs, getConfig } = vi.hoisted(() => ({
  execFileImpl: vi.fn(),
  getFleetServiceById: vi.fn(),
  getRspamdAuthHeaders: vi.fn(),
  getAgentServiceLogs: vi.fn(),
  storeAgentServiceLogs: vi.fn(),
  getConfig: vi.fn(),
}));

// Mock execFile so promisify(execFile) resolves `{ stdout }` (object = single
// callback result) on success, or rejects on error.
vi.mock('node:child_process', () => ({
  execFile: (cmd: string, args: string[], _opts: unknown, cb: (e: Error | null, r?: unknown) => void) =>
    execFileImpl(cmd, args, cb),
}));

vi.mock('../db/queries/fleet-services.js', () => ({ getFleetServiceById }));
vi.mock('../db/queries/fleet-agent-logs.js', () => ({ getAgentServiceLogs, storeAgentServiceLogs }));
vi.mock('../db/queries/config.js', () => ({ getConfig }));
vi.mock('./metrics-poller.js', () => ({ getRspamdAuthHeaders }));

import { getServiceLogs, getServiceLogsAvailability, ingestAgentLogs } from './service-logs.js';

function svc(serviceType: string, extra: Record<string, unknown> = {}) {
  return { id: 1, serviceId: 's1', serviceType, name: 'S', metricsUrl: null, controllerUrl: null, apiUrl: null, ...extra };
}

describe('getServiceLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ logDefaultLines: 200, logMaxLines: 1000 });
  });

  it('returns journald lines when the unit is readable', async () => {
    getFleetServiceById.mockResolvedValue(svc('postfix'));
    execFileImpl.mockImplementation((cmd: string, _args: string[], cb: (e: Error | null, r?: unknown) => void) => {
      if (cmd === 'journalctl') cb(null, { stdout: '2026-01-01 postfix/smtpd: connect\n2026-01-01 postfix/qmgr: removed', stderr: '' });
      else cb(new Error('unexpected'));
    });
    const out = await getServiceLogs('postfix', 's1', 50);
    expect(out.available).toBe(true);
    expect(out.source).toContain('journalctl');
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toContain('postfix/smtpd');
  });

  it('falls back to the log file when journald fails', async () => {
    getFleetServiceById.mockResolvedValue(svc('dovecot'));
    execFileImpl.mockImplementation((cmd: string, _args: string[], cb: (e: Error | null, r?: unknown) => void) => {
      if (cmd === 'journalctl') cb(new Error('no journald'));
      else cb(null, { stdout: 'dovecot: imap-login: Login\n', stderr: '' }); // sh -c "tail ... | grep dovecot"
    });
    const out = await getServiceLogs('dovecot', 's1', 50);
    expect(out.available).toBe(true);
    expect(out.source).toBe('/var/log/mail.log');
    expect(out.lines[0]).toContain('dovecot');
  });

  it('tails the newest file in the log dir for robin (date-rotated logs)', async () => {
    getFleetServiceById.mockResolvedValue(svc('robin'));
    execFileImpl.mockImplementation((cmd: string, args: string[], cb: (e: Error | null, r?: unknown) => void) => {
      if (cmd === 'journalctl') return cb(new Error('no journald')); // no systemd in this env
      // readLatestInDir issues `sh -c "f=$(ls -1t <dir>/<glob> ...); ... tail ..."`.
      const script = args[args.indexOf('-c') + 1];
      if (cmd === 'sh' && /ls -1t .*\/\*\.log/.test(script)) {
        return cb(null, { stdout: 'INFO |0901-120000|main|Robin started\n', stderr: '' });
      }
      cb(new Error('unexpected'));
    });
    const out = await getServiceLogs('robin', 's1', 50);
    expect(out.available).toBe(true);
    expect(out.source).toMatch(/latest/);
    expect(out.lines[0]).toContain('Robin started');
  });

  it('prefers a configured <TYPE>_LOG_URL sidecar endpoint over co-located files', async () => {
    getFleetServiceById.mockResolvedValue(svc('dovecot'));
    process.env.DOVECOT_LOG_URL = 'http://dovecot-logtail:9099/';
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => 'line-a\nline-b\nline-c\n' });
    vi.stubGlobal('fetch', fetchMock);
    try {
      const out = await getServiceLogs('dovecot', 's1', 2);
      expect(fetchMock).toHaveBeenCalledWith('http://dovecot-logtail:9099/', expect.anything());
      expect(out.available).toBe(true);
      expect(out.source).toBe('http://dovecot-logtail:9099/');
      expect(out.lines).toEqual(['line-b', 'line-c']); // last N
      expect(execFileImpl).not.toHaveBeenCalled(); // endpoint short-circuits file reads
    } finally {
      delete process.env.DOVECOT_LOG_URL;
      vi.unstubAllGlobals();
    }
  });

  it('reports unavailable when neither source is readable (not co-located)', async () => {
    getFleetServiceById.mockResolvedValue(svc('clamav'));
    execFileImpl.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(new Error('ENOENT')));
    const out = await getServiceLogs('clamav', 's1', 50);
    expect(out.available).toBe(false);
    expect(out.lines).toEqual([]);
    expect(out.error).toMatch(/co-located/i);
  });

  it('throws when the service is missing or the wrong type', async () => {
    getFleetServiceById.mockResolvedValue(null);
    await expect(getServiceLogs('postfix', 's1', 50)).rejects.toThrow(/not found/);
    getFleetServiceById.mockResolvedValue(svc('dovecot'));
    await expect(getServiceLogs('postfix', 's1', 50)).rejects.toThrow(/not found/);
  });

  it('clamps lines to the [1,1000] range', async () => {
    getFleetServiceById.mockResolvedValue(svc('postfix'));
    let seenN = -1;
    execFileImpl.mockImplementation((cmd: string, args: string[], cb: (e: Error | null, r?: unknown) => void) => {
      if (cmd === 'journalctl') { seenN = Number(args[args.indexOf('-n') + 1]); cb(null, { stdout: '', stderr: '' }); }
      else cb(new Error('no'));
    });
    await getServiceLogs('postfix', 's1', 99999);
    expect(seenN).toBe(1000);
  });

  it('reads rspamd logs from the controller /errors endpoint (cross-container http)', async () => {
    getFleetServiceById.mockResolvedValue(svc('rspamd', { controllerUrl: 'http://rspamd:11334' }));
    getRspamdAuthHeaders.mockResolvedValue({ Password: 'secret' });
    const errors = [
      { ts: 1700000000, type: 'lua', module: 'dmarc', id: 'abc', message: 'boom' },
      { ts: 1700000001, type: 'cfg', module: 'rbl', id: 'def', message: 'bad map' },
    ];
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => JSON.stringify(errors) });
    vi.stubGlobal('fetch', fetchMock);

    const out = await getServiceLogs('rspamd', 's1', 50);
    expect(fetchMock).toHaveBeenCalledWith('http://rspamd:11334/errors', expect.objectContaining({ headers: { Password: 'secret' } }));
    expect(out.available).toBe(true);
    expect(out.source).toContain('/errors');
    expect(out.lines).toHaveLength(2);
    expect(out.lines[0]).toContain('dmarc');
    expect(out.lines[0]).toContain('boom');
    vi.unstubAllGlobals();
  });

  it('reports rspamd logs unavailable when the controller rejects (no password)', async () => {
    getFleetServiceById.mockResolvedValue(svc('rspamd', { controllerUrl: 'http://rspamd:11334' }));
    getRspamdAuthHeaders.mockResolvedValue(undefined);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => '' }));
    const out = await getServiceLogs('rspamd', 's1', 50);
    expect(out.available).toBe(false);
    expect(out.error).toMatch(/403|password/i);
    vi.unstubAllGlobals();
  });

  it('getServiceLogsAvailability reflects readability', async () => {
    getFleetServiceById.mockResolvedValue(svc('clamav'));
    execFileImpl.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(new Error('ENOENT')));
    expect(await getServiceLogsAvailability('clamav', 's1')).toBe(false);
  });

  it('serves the stored buffer for an agent-mode service (never touches files)', async () => {
    getFleetServiceById.mockResolvedValue(svc('dovecot', { collectionMode: 'agent', agentId: 'a1' }));
    getAgentServiceLogs.mockResolvedValue({
      source: '/var/log/mail.log',
      lines: ['l1', 'l2', 'l3'],
      capturedAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    const out = await getServiceLogs('dovecot', 's1', 2);
    expect(out.available).toBe(true);
    expect(out.source).toContain('/var/log/mail.log');
    expect(out.source).toContain('agent');
    expect(out.lines).toEqual(['l2', 'l3']); // last N of the stored buffer
    expect(execFileImpl).not.toHaveBeenCalled(); // agent-mode never reads local files
  });

  it('serves the agent buffer for a DIRECT-metrics service that has a log agent (decoupled)', async () => {
    // collection_mode stays 'direct' (metrics via robin-admin) but a log agent
    // ships the root-owned logs — the buffer must win over any file read.
    getFleetServiceById.mockResolvedValue(svc('postgres', { collectionMode: 'direct', logAgentId: 'log-agent-1' }));
    getAgentServiceLogs.mockResolvedValue({
      source: '/var/log/postgresql/postgresql.log',
      lines: ['pg1', 'pg2'],
      capturedAt: new Date('2026-09-07T12:00:00.000Z'),
    });
    const out = await getServiceLogs('postgres', 's1', 50);
    expect(out.available).toBe(true);
    expect(out.source).toContain('agent');
    expect(out.lines).toEqual(['pg1', 'pg2']);
    expect(execFileImpl).not.toHaveBeenCalled();
  });

  it('does NOT serve an orphaned buffer for a direct service with no log agent', async () => {
    getFleetServiceById.mockResolvedValue(svc('clamav', { collectionMode: 'direct', logAgentId: null }));
    execFileImpl.mockImplementation((_cmd: string, _args: string[], cb: (e: Error | null) => void) => cb(new Error('ENOENT')));
    const out = await getServiceLogs('clamav', 's1', 50);
    // Falls through to the co-located file path (unavailable here); never reads the stored buffer.
    expect(getAgentServiceLogs).not.toHaveBeenCalled();
    expect(out.available).toBe(false);
  });

  it('reports agent-mode unavailable until the agent has pushed a tail', async () => {
    getFleetServiceById.mockResolvedValue(svc('postgres', { collectionMode: 'agent', agentId: 'a1' }));
    getAgentServiceLogs.mockResolvedValue(null);
    const out = await getServiceLogs('postgres', 's1', 50);
    expect(out.available).toBe(false);
    expect(out.lines).toEqual([]);
    expect(out.error).toMatch(/agent/i);
  });
});

describe('ingestAgentLogs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getConfig.mockResolvedValue({ logDefaultLines: 200, logMaxLines: 1000 });
  });

  it('replaces the buffer with a reset batch, dropping blank lines', async () => {
    const n = await ingestAgentLogs('s1', '/var/log/mail.log', ['a', '', 'b', 'c'], true);
    expect(n).toBe(3);
    expect(getAgentServiceLogs).not.toHaveBeenCalled();
    expect(storeAgentServiceLogs).toHaveBeenCalledWith('s1', '/var/log/mail.log', ['a', 'b', 'c']);
  });

  it('appends incremental batches, keeping the newest logMaxLines', async () => {
    getConfig.mockResolvedValue({ logDefaultLines: 200, logMaxLines: 3 });
    getAgentServiceLogs.mockResolvedValue({ source: 'x', lines: ['a', 'b'], capturedAt: new Date() });
    await ingestAgentLogs('s1', '', ['c', 'd'], false);
    expect(storeAgentServiceLogs).toHaveBeenCalledWith('s1', 'agent', ['b', 'c', 'd']);
  });
});
