import { describe, expect, it } from 'vitest';
import {
  classifyForensicReport,
  normalizeForensicReport,
  parseRawHeaders,
} from './forensic-parser.js';

describe('forensic-parser', () => {
  it('parses embedded headers, unfolded auth results, and DKIM signature evidence', () => {
    const parsed = parseRawHeaders(
      [
        'From: "Payroll" <alerts@example.com>',
        'To: admin@example.net',
        'Subject: Monthly payroll',
        'Authentication-Results: mx.example.net;',
        '  spf=fail smtp.mailfrom=mailer.bad.example;',
        '  dkim=fail header.d=example.com;',
        '  dmarc=fail header.from=example.com',
        'DKIM-Signature: v=1; a=rsa-sha256; d=example.com; s=selector1;',
        'Received-SPF: fail (mx.example.net: domain of mailer.bad.example does not designate 203.0.113.25 as permitted sender) client-ip=203.0.113.25;',
      ].join('\n')
    );

    expect(parsed.fromDomain).toBe('example.com');
    expect(parsed.fromAddress).toBe('alerts@example.com');
    expect(parsed.toAddress).toBe('admin@example.net');
    expect(parsed.subject).toBe('Monthly payroll');
    expect(parsed.sourceIp).toBe('203.0.113.25');
    expect(parsed.authResults).toEqual([
      expect.objectContaining({ axis: 'spf', result: 'fail' }),
      expect.objectContaining({ axis: 'dkim', result: 'fail' }),
      expect.objectContaining({ axis: 'dmarc', result: 'fail' }),
    ]);
    expect(parsed.dkimSignature).toEqual({ domain: 'example.com', selector: 'selector1' });
  });

  it('normalizes forensic evidence into actionable failures', () => {
    const normalized = normalizeForensicReport({
      originalHeaders: [
        'From: Security <security@example.com>',
        'Authentication-Results: mx.receiver.test; spf=fail smtp.mailfrom=mail.bad.example; dkim=fail header.d=example.com; dmarc=fail header.from=example.com',
        'Received: from unknown ([198.51.100.44]) by mx.receiver.test with ESMTPS;',
      ].join('\n'),
      originalMailFrom: 'bounce@example.com',
      originalRcptTo: 'postmaster@example.com',
      sourceIp: '198.51.100.44',
      authFailure: 'dmarc',
      subject: 'Suspicious payroll message',
    });

    expect(normalized.domain).toBe('example.com');
    expect(normalized.primaryFailure).toBe('dmarc');
    expect(normalized.sourceIp).toBe('198.51.100.44');
    expect(normalized.interpretation.severity).toBe('urgent');
    expect(normalized.interpretation.verdict).toContain('Both SPF and DKIM failed');
  });

  it('treats DMARC-pass forensic samples as non-actionable receiver noise', () => {
    const interpretation = classifyForensicReport({
      sourceIp: '203.0.113.10',
      fromDomain: 'example.com',
      authResults: [
        { axis: 'spf', result: 'pass' },
        { axis: 'dkim', result: 'pass' },
        { axis: 'dmarc', result: 'pass' },
      ],
      reporterAuthFailure: 'dmarc',
    });

    expect(interpretation.severity).toBe('info');
    expect(interpretation.verdict).toContain('receiver policy noise');
    expect(interpretation.recommendation).toContain('No action');
  });
});
