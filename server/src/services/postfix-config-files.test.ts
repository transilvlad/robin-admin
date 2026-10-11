import { describe, it, expect } from 'vitest';
import { POSTFIX_MANAGED_FILES, POSTFIX_MANAGED_FILES_BY_KEY } from './postfix-config-files.js';

describe('postfix managed config files', () => {
  it('each file normalizes {} to defaults and renders the managed marker', () => {
    for (const def of POSTFIX_MANAGED_FILES) {
      expect(def.normalize({})).toEqual(def.defaults);
      expect(def.render(def.normalize({}))).toContain('# Managed by Robin Admin');
    }
  });

  it('tls validates security levels and omits blank cert/key', () => {
    const tls = POSTFIX_MANAGED_FILES_BY_KEY.tls;
    const out = tls.render(tls.normalize({ smtpdTlsSecurityLevel: 'encrypt', smtpTlsSecurityLevel: 'bogus' }));
    expect(out).toContain('smtpd_tls_security_level = encrypt');
    expect(out).toContain('smtp_tls_security_level = may'); // bogus → default
    expect(out).not.toContain('smtpd_tls_cert_file');
    const withCert = tls.render(tls.normalize({ smtpdTlsCertFile: '/c.pem', smtpdTlsKeyFile: '/k.pem' }));
    expect(withCert).toContain('smtpd_tls_cert_file = /c.pem');
  });

  it('restrictions render helo flag + restriction lists', () => {
    const r = POSTFIX_MANAGED_FILES_BY_KEY.restrictions;
    const out = r.render(r.normalize({ smtpdHeloRequired: false, smtpdRelayRestrictions: 'permit_mynetworks' }));
    expect(out).toContain('smtpd_helo_required = no');
    expect(out).toContain('smtpd_relay_restrictions = permit_mynetworks');
  });

  it('milters validate action/protocol enums', () => {
    const m = POSTFIX_MANAGED_FILES_BY_KEY.milters;
    const v = m.normalize({ smtpdMilters: 'inet:localhost:11332', milterDefaultAction: 'tempfail', milterProtocol: '9' });
    expect(v.milterDefaultAction).toBe('tempfail');
    expect(v.milterProtocol).toBe('6'); // 9 invalid → default
    expect(m.render(v)).toContain('smtpd_milters = inet:localhost:11332');
  });
});
