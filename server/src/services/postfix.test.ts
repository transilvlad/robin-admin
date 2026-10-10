import { describe, it, expect } from 'vitest';
import {
  parsePostqueueJson,
  countPostfixLogLines,
  parsePostfixExporter,
  renderPostfixConfig,
  renderPostfixCheckFile,
  buildPostfixSnapshotFromRaw,
} from './postfix.js';

const NOW = 1_700_000_000;

describe('buildPostfixSnapshotFromRaw', () => {
  it('assembles a live snapshot from raw postqueue -j output', () => {
    const raw = [
      JSON.stringify({ queue_name: 'active' }),
      JSON.stringify({ queue_name: 'deferred', arrival_time: Math.floor(Date.now() / 1000) - 300 }),
      JSON.stringify({ queue_name: 'hold' }),
    ].join('\n');
    const snap = buildPostfixSnapshotFromRaw('pf1', raw);
    expect(snap.serviceType).toBe('postfix');
    expect(snap.serviceId).toBe('pf1');
    expect(snap.reachable).toBe(true);
    expect(snap.queueActive).toBe(1);
    expect(snap.queueDeferred).toBe(1);
    expect(snap.queueHold).toBe(1);
    expect(snap.queueTotal).toBe(3);
    expect(snap.oldestDeferredAgeSecs).toBeGreaterThanOrEqual(290);
    expect(snap.rawStats).toContain('deferred');
  });

  it('yields an empty (reachable) snapshot for an empty queue', () => {
    const snap = buildPostfixSnapshotFromRaw('pf1', '');
    expect(snap.reachable).toBe(true);
    expect(snap.queueTotal).toBe(0);
  });
});

describe('parsePostqueueJson', () => {
  it('counts messages per queue and derives the oldest deferred age', () => {
    const raw = [
      JSON.stringify({ queue_name: 'active', arrival_time: NOW - 10 }),
      JSON.stringify({ queue_name: 'deferred', arrival_time: NOW - 3600 }),
      JSON.stringify({ queue_name: 'deferred', arrival_time: NOW - 120 }),
      JSON.stringify({ queue_name: 'hold', arrival_time: NOW - 5 }),
      JSON.stringify({ queue_name: 'incoming', arrival_time: NOW - 1 }),
    ].join('\n');
    const out = parsePostqueueJson(raw, NOW);
    expect(out.queueActive).toBe(1);
    expect(out.queueDeferred).toBe(2);
    expect(out.queueHold).toBe(1);
    expect(out.queueIncoming).toBe(1);
    expect(out.queueTotal).toBe(5);
    expect(out.oldestDeferredAgeSecs).toBe(3600); // oldest deferred arrival
  });

  it('handles empty output', () => {
    const out = parsePostqueueJson('', NOW);
    expect(out.queueTotal).toBe(0);
    expect(out.oldestDeferredAgeSecs).toBe(0);
  });

  it('skips non-JSON lines', () => {
    const out = parsePostqueueJson('not json\n{"queue_name":"active"}', NOW);
    expect(out.queueActive).toBe(1);
    expect(out.queueTotal).toBe(1);
  });
});

describe('countPostfixLogLines', () => {
  it('counts per-recipient delivery outcomes and rejections, ignoring other lines', () => {
    const lines = [
      'Sep 25 10:00:01 mx postfix/smtp[123]: 4F1A2B3C4D: to=<a@example.org>, relay=mx.example.org[1.2.3.4]:25, delay=1, status=sent (250 2.0.0 OK)',
      'Sep 25 10:00:02 mx postfix/lmtp[124]: 5A1B2C3D4E: to=<b@example.com>, relay=dovecot[private/lmtp], status=sent (250 2.0.0 Saved)',
      'Sep 25 10:00:03 mx postfix-out/smtp[125]: 6A1B2C3D4E: to=<c@example.net>, relay=none, delay=30, status=deferred (connect timed out)',
      'Sep 25 10:00:04 mx postfix/error[126]: 7A1B2C3D4E: to=<d@example.net>, relay=none, status=bounced (Host not found)',
      'Sep 25 10:00:05 mx postfix/smtpd[127]: NOQUEUE: reject: RCPT from unknown[5.6.7.8]: 554 5.7.1 Relay access denied',
      'Sep 25 10:00:06 mx postfix/postscreen[128]: NOQUEUE: reject: RCPT from [9.9.9.9]:4000: 550 5.7.1 blocked using zen',
      'Sep 25 10:00:07 mx postfix/cleanup[129]: 8A1B2C3D4E: reject: header Subject: spam from local; from=<x@y>',
      'Sep 25 10:00:08 mx postfix/qmgr[130]: 4F1A2B3C4D: removed',
      'Sep 25 10:00:09 mx dovecot: imap-login: Login: user=<a@example.com>, status=sent',
    ];
    expect(countPostfixLogLines(lines)).toEqual({ messagesDelivered: 2, messagesDeferred: 1, messagesBounced: 1, messagesRejected: 3 });
  });

  it('skips content-filter hops but keeps local LMTP delivery', () => {
    const lines = [
      'Sep 25 10:00:01 mx postfix/smtp[1]: AAAAA1: to=<a@example.org>, relay=127.0.0.1[127.0.0.1]:10025, delay=0.1, status=sent (250 2.0.0 Ok: queued as BBBBB2)',
      'Sep 25 10:00:02 mx postfix-out/smtp[2]: BBBBB2: to=<a@example.org>, relay=mx.example.org[1.2.3.4]:25, delay=1, status=sent (250 OK)',
      'Sep 25 10:00:03 mx postfix/lmtp[3]: CCCCC3: to=<b@example.com>, relay=127.0.0.1[127.0.0.1]:24, delay=0.1, status=sent (250 2.0.0 Saved)',
      'Sep 25 10:00:04 mx postfix/smtp[4]: DDDDD4: to=<c@example.org>, relay=none, delay=30, status=deferred (connect to 127.0.0.1[127.0.0.1]:10025: Connection refused)',
    ];
    expect(countPostfixLogLines(lines)).toEqual({ messagesDelivered: 2, messagesDeferred: 1, messagesBounced: 0, messagesRejected: 0 });
  });
});

describe('parsePostfixExporter', () => {
  it('reads queue depth from showq histogram counts', () => {
    const raw = [
      'postfix_up 1',
      'postfix_showq_message_size_bytes_count{queue="active"} 3',
      'postfix_showq_message_size_bytes_count{queue="deferred"} 7',
      'postfix_showq_message_size_bytes_count{queue="hold"} 1',
    ].join('\n');
    const out = parsePostfixExporter(raw);
    expect(out.queueActive).toBe(3);
    expect(out.queueDeferred).toBe(7);
    expect(out.queueHold).toBe(1);
    expect(out.queueTotal).toBe(11);
  });
});

describe('renderPostfixConfig', () => {
  it('emits postconf key=value lines and check-map references only when rules exist', () => {
    const base = {
      messageSizeLimit: 20480000,
      mailboxSizeLimit: 0,
      maximalQueueLifetime: '1h',
      bounceQueueLifetime: '1h',
      defaultProcessLimit: 300,
      defaultDestinationConcurrencyLimit: 50,
      smtpdClientConnectionCountLimit: 0,
      smtpdClientConnectionRateLimit: 0,
      smtpdClientMessageRateLimit: 0,
      smtpdClientRecipientRateLimit: 0,
      smtpdClientAuthRateLimit: 0,
      notifyClasses: 'resource, software',
      headerChecks: [] as string[],
      bodyChecks: [] as string[],
    };
    const noChecks = renderPostfixConfig(base);
    expect(noChecks).toContain('message_size_limit = 20480000');
    expect(noChecks).toContain('notify_classes = resource, software');
    expect(noChecks).not.toContain('header_checks =');
    expect(noChecks).not.toContain('body_checks =');

    const withChecks = renderPostfixConfig({ ...base, headerChecks: ['/^X-Spam:/ REJECT'], bodyChecks: ['/viagra/ DISCARD'] });
    expect(withChecks).toMatch(/header_checks = regexp:.*robin-header_checks/);
    expect(withChecks).toMatch(/body_checks = regexp:.*robin-body_checks/);

    expect(renderPostfixCheckFile('header', { ...base, headerChecks: ['/^X-Spam:/ REJECT'] })).toContain('/^X-Spam:/ REJECT');
  });
});
