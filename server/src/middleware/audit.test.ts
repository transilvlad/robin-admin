import { describe, expect, it } from 'vitest';
import { REDACTED, redactAuditValues } from './audit.js';

describe('audit value redaction', () => {
  it('replaces credential-like string fields at any depth', () => {
    expect(redactAuditValues({
      serviceId: 'rspamd',
      rspamdControllerPassword: 'hunter2',
      nested: { apiKey: 'k', webhookUrl: 'https://hooks.example.test/x', dsn: 'postgres://u:p@h/db' },
      list: [{ token: 't' }],
    })).toEqual({
      serviceId: 'rspamd',
      rspamdControllerPassword: REDACTED,
      nested: { apiKey: REDACTED, webhookUrl: REDACTED, dsn: REDACTED },
      list: [{ token: REDACTED }],
    });
  });

  it('keeps flags, counts and empty values so the entry still says what changed', () => {
    expect(redactAuditValues({ passwordChanged: true, secretCount: 2, password: '', token: null }))
      .toEqual({ passwordChanged: true, secretCount: 2, password: '', token: null });
    // A tokenizer is a setting, not a token.
    expect(redactAuditValues({ rspamdBayesTokenizer: 'osb' })).toEqual({ rspamdBayesTokenizer: 'osb' });
  });

  it('redacts a credential-named object wholesale', () => {
    expect(redactAuditValues({ credentials: { user: 'a', pass: 'b' } })).toEqual({ credentials: REDACTED });
  });
});
