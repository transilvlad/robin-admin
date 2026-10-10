import { describe, it, expect } from 'vitest';
import { DOVECOT_MANAGED_FILES, DOVECOT_MANAGED_FILES_BY_KEY } from './dovecot-config-files.js';

describe('dovecot managed config files', () => {
  it('each file normalizes {} to defaults and renders the managed marker', () => {
    for (const def of DOVECOT_MANAGED_FILES) {
      expect(def.normalize({})).toEqual(def.defaults);
      expect(def.render(def.normalize({}))).toContain('# Managed by Robin Admin');
    }
  });

  it('logging renders yes/no booleans and quotes the timestamp', () => {
    const logging = DOVECOT_MANAGED_FILES_BY_KEY.logging;
    const out = logging.render(logging.normalize({ authVerbose: true, mailDebug: false, logTimestamp: '%H:%M ' }));
    expect(out).toContain('auth_verbose = yes');
    expect(out).toContain('mail_debug = no');
    expect(out).toContain('log_timestamp = "%H:%M "');
  });

  it('limits emits service blocks only when a per-service limit is set', () => {
    const limits = DOVECOT_MANAGED_FILES_BY_KEY.limits;
    const base = limits.render(limits.normalize({ imapProcessLimit: 0, imapLoginProcessLimit: 0 }));
    expect(base).not.toContain('service imap');
    const withLimits = limits.render(limits.normalize({ imapProcessLimit: 512 }));
    expect(withLimits).toContain('service imap {');
    expect(withLimits).toContain('process_limit = 512');
  });

  it('mail validates the fsync enum', () => {
    const mail = DOVECOT_MANAGED_FILES_BY_KEY.mail;
    expect(mail.normalize({ mailFsync: 'always' }).mailFsync).toBe('always');
    expect(mail.normalize({ mailFsync: 'bogus' }).mailFsync).toBe('optimized');
  });

  it('lmtp renders the protocol block and optional postmaster/hostname', () => {
    const lmtp = DOVECOT_MANAGED_FILES_BY_KEY.lmtp;
    const out = lmtp.render(lmtp.normalize({ postmasterAddress: 'pm@x.com', lmtpRcptCheckQuota: true }));
    // Inside the lmtp block, where a host's own lmtp section can't shadow it.
    expect(out).toContain('protocol lmtp {\n  postmaster_address = pm@x.com\n');
    expect(out).toContain('protocol lmtp {');
    expect(out).toContain('lmtp_rcpt_check_quota = yes');
  });
});
