import { describe, it, expect } from 'vitest';
import {
  parseStatsDump,
  parseOpenMetrics,
  parseQuota,
  parseUserLookup,
  parseWho,
  parseWhoSessions,
  renderDovecotConfig,
  dovecotConfigVersionOf,
} from './dovecot.js';

describe('parseStatsDump', () => {
  it('reads the count column (3rd) per metric, skipping the header', () => {
    const raw = [
      'metric_name\tfield\tcount\tsum\tmin\tmax\tavg\tmedian\tstddev\t%95',
      'auth_successes\tduration\t5\t0\t0\t0\t0\t0\t0\t0',
      'auth_failures\tduration\t2\t0\t0\t0\t0\t0\t0\t0',
      'imap_commands\tduration\t9\t0\t0\t0\t0\t0\t0\t0',
      'mail_deliveries\tduration\t3\t0\t0\t0\t0\t0\t0\t0',
      'imap_login\tduration\t4\t0\t0\t0\t0\t0\t0\t0',
    ].join('\n');
    const out = parseStatsDump(raw);
    expect(out.authSuccess).toBe(5);
    expect(out.authFailure).toBe(2);
    expect(out.imapCommands).toBe(9);
    expect(out.mailDeliveries).toBe(3);
    expect(out.loginCount).toBe(4);
  });

  it('takes the max count across a metric\'s multiple field rows', () => {
    const raw = [
      'metric_name\tfield\tcount',
      'mail_user_session_finished\tduration\t7',
      'mail_user_session_finished\trss\t7',
    ].join('\n');
    // no auth/login/imap-command/deliver match here → empty
    expect(parseStatsDump(raw)).toEqual({});
  });

  it('returns empty for header-only output', () => {
    expect(parseStatsDump('metric_name\tfield\tcount')).toEqual({});
  });
});

describe('parseOpenMetrics', () => {
  it('parses _total and _count counters and ignores duration series', () => {
    const raw = [
      '# HELP dovecot_auth_successes_total',
      'dovecot_auth_successes_total 12',
      'dovecot_auth_successes_duration_seconds_total 0.5',
      'dovecot_auth_failures_total 1',
      'dovecot_imap_commands_count 34',
      'dovecot_imap_login_total 8',
    ].join('\n');
    const out = parseOpenMetrics(raw);
    expect(out.authSuccess).toBe(12);
    expect(out.authFailure).toBe(1);
    expect(out.imapCommands).toBe(34);
    expect(out.loginCount).toBe(8);
  });

  it('reads a histogram total from the +Inf bucket', () => {
    const raw = [
      'dovecot_mail_deliveries_bucket{le="0.01"} 2',
      'dovecot_mail_deliveries_bucket{le="+Inf"} 5',
    ].join('\n');
    expect(parseOpenMetrics(raw).mailDeliveries).toBe(5);
  });
});

describe('parseWho', () => {
  it('counts sessions and distinct users, dropping the header', () => {
    const raw = [
      'username # proto (pids) (ips)',
      'alice@example.com 2 imap (100 101) (10.0.0.1)',
      'alice@example.com 1 imap (102) (10.0.0.2)',
      'bob@example.com 1 imap (103) (10.0.0.3)',
    ].join('\n');
    const out = parseWho(raw);
    // The # column is the connection count for that user+service row.
    expect(out.sessionCount).toBe(4);
    expect(out.userCount).toBe(2);
  });
});

describe('parseWhoSessions', () => {
  it('reads one row per connection from doveadm who -1', () => {
    const raw = 'username                         service pid ip dest_ip\nalice@example.com imap 100 10.0.0.1 10.0.0.9\n';
    expect(parseWhoSessions(raw)).toEqual([{ user: 'alice@example.com', service: 'imap', pid: '100', ip: '10.0.0.1', destIp: '10.0.0.9' }]);
  });
});

describe('parseQuota', () => {
  it('reads tab output, treating "-" as unlimited', () => {
    const raw = 'Username\tQuota name\tType\tValue\tLimit\t%\nalice@example.com\tUser quota\tSTORAGE\t512\t1024\t50\nalice@example.com\tUser quota\tMESSAGE\t20\t-\t0\n';
    expect(parseQuota(raw)).toEqual([
      { user: 'alice@example.com', quotaName: 'User quota', type: 'STORAGE', value: 512, limit: 1024, percent: 50 },
      { user: 'alice@example.com', quotaName: 'User quota', type: 'MESSAGE', value: 20, limit: null, percent: 0 },
    ]);
  });
});

describe('parseUserLookup', () => {
  it('returns userdb fields, or null for an unknown user', () => {
    expect(parseUserLookup('field\tvalue\nuid\t5000\nhome\t/var/mail/alice\n')).toEqual({ uid: '5000', home: '/var/mail/alice' });
    expect(parseUserLookup("field\tvalue\n\nuserdb lookup: user x@example.com doesn't exist")).toBeNull();
  });
});

describe('renderDovecotConfig', () => {
  it('renders managed knobs and omits empty optional ones', () => {
    const rendered = renderDovecotConfig({
      dovecotVersion: '2.3',
      authCacheSize: '',
      authCacheTtl: '1 hour',
      authCacheNegativeTtl: '1 hour',
      authFailureDelay: '2 secs',
      disablePlaintextAuth: true,
      mailMaxUseripConnections: 15,
      imapIdleNotifyInterval: '2 mins',
      imapMaxLineLength: '64k',
      mailMaxLockTimeout: '',
      protocols: 'imap lmtp',
      mailRetentionDays: 0,
    });
    expect(rendered).toContain('disable_plaintext_auth = yes');
    expect(rendered).toContain('auth_failure_delay = 2 secs');
    expect(rendered).toContain('mail_max_userip_connections = 15');
    expect(rendered).toContain('imap_max_line_length = 64k');
    expect(rendered).not.toContain('auth_cache_size'); // empty → omitted
    expect(rendered).not.toContain('mail_max_lock_timeout'); // empty → omitted
    // The counters the Metrics page reads are always defined.
    expect(rendered).toContain('metric robin_auth_failure {\n  filter = event=auth_request_finished AND NOT success=yes\n}');
    expect(rendered).toContain('metric robin_mail_delivery {');
  });

  it('emits 2.4 auth_allow_cleartext (inverted) instead of disable_plaintext_auth', () => {
    const base = {
      authCacheSize: '', authCacheTtl: '1 hour', authCacheNegativeTtl: '1 hour',
      authFailureDelay: '2 secs', mailMaxUseripConnections: 10, imapIdleNotifyInterval: '2 mins',
      imapMaxLineLength: '', mailMaxLockTimeout: '', protocols: 'imap lmtp', mailRetentionDays: 0,
    } as const;

    const disabled = renderDovecotConfig({ ...base, dovecotVersion: '2.4', disablePlaintextAuth: true });
    expect(disabled).toContain('auth_allow_cleartext = no');
    expect(disabled).not.toContain('disable_plaintext_auth');

    const allowed = renderDovecotConfig({ ...base, dovecotVersion: '2.4', disablePlaintextAuth: false });
    expect(allowed).toContain('auth_allow_cleartext = yes');
  });
});

describe('dovecotConfigVersionOf', () => {
  it('maps a reported `dovecot --version` to its config syntax line', () => {
    expect(dovecotConfigVersionOf('2.3.21 (47349e2482)')).toBe('2.3');
    expect(dovecotConfigVersionOf('2.4.2')).toBe('2.4');
    expect(dovecotConfigVersionOf('2.5.0')).toBe('2.4');
    expect(dovecotConfigVersionOf('3.0.0')).toBe('2.4');
    expect(dovecotConfigVersionOf('2.2.36')).toBeNull();
    expect(dovecotConfigVersionOf('')).toBeNull();
    expect(dovecotConfigVersionOf(null)).toBeNull();
  });
});
